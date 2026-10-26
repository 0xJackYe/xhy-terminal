"""Reproducible PCM alert audio, shared by Windows and browser playback.

Run ``python audio_assets.py`` to rebuild terminal/audio/alert.wav. This only
creates the file; it neither plays audio nor changes any system volume.
"""

import argparse
import io
import math
import os
import struct
import tempfile
import wave
from pathlib import Path


SAMPLE_RATE = 44100
PEAK_AMPLITUDE = 0.6
GROUP_SECONDS = 0.7
GAP_SECONDS = 0.35
GROUP_COUNT = 5
FADE_SECONDS = 0.015
ALERT_SOUND_PATH = Path(__file__).resolve().parent / "terminal" / "audio" / "alert.wav"
TIER_SOUND_PATHS = {1: ALERT_SOUND_PATH, 2: ALERT_SOUND_PATH.with_name('alert-2.wav'),
                    3: ALERT_SOUND_PATH.with_name('alert-3.wav')}


def alarm_wave_bytes(level=1):
    """Return a standard uncompressed, little-endian 16-bit mono RIFF/WAVE."""
    if type(level) is not int or level not in TIER_SOUND_PATHS:
        raise ValueError('invalid alarm sound level')
    frequencies, seconds, gap, count = {
        1: ((880, 1320, 880), GROUP_SECONDS, GAP_SECONDS, GROUP_COUNT),
        2: ((1046, 1568, 1046), .5, .2, 6),
        3: ((1320, 1980, 1320), .35, .12, 8),
    }[level]
    group_frames = round(SAMPLE_RATE * seconds)
    gap_frames = round(SAMPLE_RATE * gap)
    fade_frames = round(SAMPLE_RATE * FADE_SECONDS)
    samples = bytearray()
    for group in range(count):
        # Three separately faded tones make the low/high/low pattern clear,
        # while every transition reaches zero to avoid audible clicks.
        boundaries = [round(group_frames * index / 3) for index in range(4)]
        for tone, frequency in enumerate(frequencies):
            tone_frames = boundaries[tone + 1] - boundaries[tone]
            for frame in range(tone_frames):
                fade_position = min(frame, tone_frames - 1 - frame) / fade_frames
                envelope = 0.5 - 0.5 * math.cos(math.pi * min(1, fade_position))
                sample = round(32767 * PEAK_AMPLITUDE * envelope
                               * math.sin(2 * math.pi * frequency * frame / SAMPLE_RATE))
                samples.extend(struct.pack("<h", sample))
        if group + 1 < count:
            samples.extend(b"\0\0" * gap_frames)
    output = io.BytesIO()
    with wave.open(output, "wb") as sound:
        sound.setnchannels(1)
        sound.setsampwidth(2)
        sound.setframerate(SAMPLE_RATE)
        sound.writeframes(samples)
    return output.getvalue()


def write_alarm_wav(path=ALERT_SOUND_PATH, level=1):
    """Atomically write the generated asset so readers never see half a WAV."""
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary = tempfile.mkstemp(prefix=".alert-", suffix=".wav", dir=str(path.parent))
    try:
        with os.fdopen(descriptor, "wb") as handle:
            handle.write(alarm_wave_bytes(level))
        os.replace(temporary, str(path))
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)
    return path


def ensure_alarm_wav(path=ALERT_SOUND_PATH, level=1):
    """Create a missing bundled asset, then return its path and duration."""
    path = Path(path)
    if not path.exists():
        write_alarm_wav(path, level)
    with wave.open(str(path), "rb") as sound:
        if (sound.getnchannels(), sound.getsampwidth(), sound.getframerate(), sound.getcomptype()) != (
                1, 2, SAMPLE_RATE, "NONE"):
            raise ValueError("报警音文件不是有效的 44100 Hz PCM WAV")
        duration = sound.getnframes() / sound.getframerate()
        if not 0 < duration <= 10:
            raise ValueError("报警音文件时长无效")
    return path, duration


def ensure_tier_wav(level):
    if type(level) is not int or level not in TIER_SOUND_PATHS:
        raise ValueError('invalid alarm sound level')
    return ensure_alarm_wav(TIER_SOUND_PATHS[level], level)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, default=ALERT_SOUND_PATH)
    arguments = parser.parse_args()
    target = write_alarm_wav(arguments.output)
    _, seconds = ensure_alarm_wav(target)
    print("Generated {} ({:.2f} seconds; no playback)".format(target, seconds))
