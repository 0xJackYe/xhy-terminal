"""WAVE format and Windows playback tests that never emit a real sound."""

import io
import struct
import sys
import tempfile
import threading
import types
import unittest
import wave
from pathlib import Path
from unittest.mock import Mock, patch

from audio_assets import (ALERT_SOUND_PATH, GAP_SECONDS, GROUP_COUNT, GROUP_SECONDS,
                          PEAK_AMPLITUDE, SAMPLE_RATE, alarm_wave_bytes,
                          ensure_alarm_wav)
from btc_alert import play_native_sound


class WaveAssetTests(unittest.TestCase):
    def test_generated_asset_is_reproducible_16_bit_pcm_with_safe_peak_and_gaps(self):
        payload = alarm_wave_bytes()
        self.assertEqual(payload, alarm_wave_bytes())
        with wave.open(io.BytesIO(payload), "rb") as audio:
            self.assertEqual((1, 2, SAMPLE_RATE, "NONE"),
                             (audio.getnchannels(), audio.getsampwidth(),
                              audio.getframerate(), audio.getcomptype()))
            frames = audio.readframes(audio.getnframes())
            duration = audio.getnframes() / audio.getframerate()
        self.assertAlmostEqual(4.9, duration)
        values = struct.unpack("<{}h".format(len(frames) // 2), frames)
        self.assertGreater(max(abs(value) for value in values), 18000)
        self.assertLessEqual(max(abs(value) for value in values), round(32767 * PEAK_AMPLITUDE))
        group_frames, gap_frames = round(SAMPLE_RATE * GROUP_SECONDS), round(SAMPLE_RATE * GAP_SECONDS)
        for group in range(GROUP_COUNT):
            start = group * (group_frames + gap_frames)
            self.assertEqual(0, values[start])
            self.assertEqual(0, values[start + group_frames - 1])
            if group + 1 < GROUP_COUNT:
                self.assertFalse(any(values[start + group_frames:start + group_frames + gap_frames]))

    def test_asset_exists_and_matches_generator(self):
        self.assertEqual(alarm_wave_bytes(), ALERT_SOUND_PATH.read_bytes())

    def test_missing_asset_is_generated_without_rewriting_existing_file(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "audio" / "alert.wav"
            found, seconds = ensure_alarm_wav(path)
            self.assertEqual(path, found)
            self.assertAlmostEqual(4.9, seconds)
            before = path.stat().st_mtime_ns
            ensure_alarm_wav(path)
            self.assertEqual(before, path.stat().st_mtime_ns)

    def test_invalid_wave_does_not_get_reported_as_playable(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "alert.wav"
            path.write_bytes(b"not a wave file")
            with self.assertRaises((wave.Error, EOFError)):
                ensure_alarm_wav(path)


class NativePlaybackTests(unittest.TestCase):
    def setUp(self):
        self.windows = types.SimpleNamespace(SND_FILENAME=0x20000, SND_ASYNC=1,
                                             SND_NODEFAULT=2, PlaySound=Mock())

    def test_filename_async_no_default_flags_and_completed_request(self):
        cancel = Mock()
        cancel.is_set.return_value = False
        cancel.wait.return_value = False
        with patch.dict(sys.modules, {"winsound": self.windows}):
            self.assertEqual("played", play_native_sound(cancel))
        self.assertEqual(str(ALERT_SOUND_PATH), self.windows.PlaySound.call_args_list[0].args[0])
        self.assertEqual(0x20003, self.windows.PlaySound.call_args_list[0].args[1])
        cancel.wait.assert_called_once()
        self.assertAlmostEqual(5.05, cancel.wait.call_args.args[0])
        self.windows.PlaySound.assert_called_with(None, 0)

    def test_cancellation_interrupts_wave_and_returns_silenced(self):
        cancel = Mock()
        cancel.is_set.return_value = False
        cancel.wait.return_value = True
        with patch.dict(sys.modules, {"winsound": self.windows}):
            self.assertEqual("silenced", play_native_sound(cancel))
        self.windows.PlaySound.assert_called_with(None, 0)

    def test_precancelled_request_does_not_start_playing(self):
        cancel = threading.Event()
        cancel.set()
        with patch.dict(sys.modules, {"winsound": self.windows}):
            self.assertEqual("silenced", play_native_sound(cancel))
        self.windows.PlaySound.assert_not_called()

    def test_windows_play_error_propagates_instead_of_claiming_played(self):
        self.windows.PlaySound.side_effect = RuntimeError("speaker unavailable")
        with patch.dict(sys.modules, {"winsound": self.windows}):
            with self.assertRaisesRegex(RuntimeError, "speaker unavailable"):
                play_native_sound(threading.Event())

    def test_missing_windows_audio_returns_unsupported(self):
        with patch.dict(sys.modules, {"winsound": None}):
            self.assertEqual("unsupported", play_native_sound(threading.Event()))


if __name__ == "__main__":
    unittest.main()
