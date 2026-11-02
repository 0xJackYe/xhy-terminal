import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';

const {scheduleAt,TIME_ZONE}=createRequire(import.meta.url)('../../frontend/work-schedule.js');

test('Denver local 09:00–17:00 includes opening and excludes closing in both seasons',()=>{
  for(const [at,working,next] of [
    ['2026-03-09T14:59:59Z',false,'2026-03-09T15:00:00Z'],
    ['2026-03-09T15:00:00Z',true,'2026-03-09T23:00:00Z'],
    ['2026-03-09T22:59:59Z',true,'2026-03-09T23:00:00Z'],
    ['2026-03-09T23:00:00Z',false,'2026-03-10T15:00:00Z'],
    ['2026-11-02T15:59:59Z',false,'2026-11-02T16:00:00Z'],
    ['2026-11-02T16:00:00Z',true,'2026-11-03T00:00:00Z'],
    ['2026-11-02T23:59:59Z',true,'2026-11-03T00:00:00Z'],
    ['2026-11-03T00:00:00Z',false,'2026-11-03T16:00:00Z'],
  ]){
    const result=scheduleAt(new Date(at));
    assert.equal(result.timeZone,TIME_ZONE);assert.equal(result.working,working,at);
    assert.equal(result.label,working?'工作中':'休息时间',at);
    assert.equal(result.nextChangeAt,Date.parse(next),at);
  }
});

test('weekend countdown measures 63 hours across spring DST and 65 across fall DST',()=>{
  for(const [at,next,hours] of [
    ['2026-03-07T00:00:00Z','2026-03-09T15:00:00Z',63],
    ['2026-10-30T23:00:00Z','2026-11-02T16:00:00Z',65],
  ]){
    const result=scheduleAt(Date.parse(at));
    assert.equal(result.working,false);assert.equal(result.label,'休息时间');
    assert.equal(result.nextChangeAt,Date.parse(next));assert.equal(result.remainingSeconds,hours*3600);
  }
});

test('countdown stays continuous through the skipped and repeated Sunday hour',()=>{
  for(const [before,after,next,hours] of [
    ['2026-03-08T08:59:59Z','2026-03-08T09:00:00Z','2026-03-09T15:00:00Z',30],
    ['2026-11-01T07:59:59Z','2026-11-01T08:00:00Z','2026-11-02T16:00:00Z',32],
  ]){
    const first=scheduleAt(Date.parse(before)),second=scheduleAt(Date.parse(after));
    assert.equal(first.label,'周末');assert.equal(second.label,'周末');
    assert.equal(first.nextChangeAt,Date.parse(next));assert.equal(second.nextChangeAt,Date.parse(next));
    assert.equal(first.remainingSeconds,hours*3600+1);assert.equal(second.remainingSeconds,hours*3600);
  }
});

test('weekday and weekend follow Denver civil dates rather than Beijing or UTC',()=>{
  assert.equal(scheduleAt(Date.parse('2026-11-07T00:30:00Z')).label,'休息时间'); // Friday in Denver, Saturday in Beijing.
  assert.equal(scheduleAt(Date.parse('2026-11-02T00:30:00Z')).label,'周末'); // Monday in Beijing, Sunday in Denver.
  assert.equal(scheduleAt(Date.parse('2026-11-02T16:00:00Z')).weekday,1); // Tuesday in Beijing, Monday in Denver.
});
