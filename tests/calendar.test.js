import test from 'node:test';
import assert from 'node:assert/strict';
import {bounds,metrics} from '../backend/calendar.js';
test('calendar boundaries follow DST and week begins Monday',()=>{
 const spring=bounds('2026-03-29','Europe/Berlin');assert.equal(spring.end-spring.start,23*3600000);
 const fall=bounds('2026-10-25','Europe/Berlin');assert.equal(fall.end-fall.start,25*3600000);
 assert.equal(bounds('2026-11-15','Europe/Moscow','week').from,'2026-11-09');
});
test('intervals are clipped to the day and strict overlap excludes touching endpoints',()=>{
 const b=bounds('2026-11-16','Europe/Moscow');const mk=(a,z)=>({started_at:b.start+a,ended_at:b.start+z});
 const e=[mk(-600000,600000),mk(600000,1200000),mk(1170000,1500000)];
 const m=metrics(e,[],b,'Europe/Moscow');assert.equal(m.started_count,2);assert.equal(m.total_duration_ms,1530000);assert.equal(m.overlaps,1);
});
