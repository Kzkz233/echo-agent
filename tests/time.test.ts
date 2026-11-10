import test from 'node:test';
import assert from 'node:assert/strict';
import { localTimestamp } from '../packages/kernel/time.ts';

test('model-facing timestamps use local wall time with an explicit UTC offset', () => {
  const at = new Date('2026-11-08T05:03:04.000Z');
  assert.equal(localTimestamp(at, 'Asia/Shanghai'), '2026-11-08 13:03:04 UTC+08:00');
  assert.equal(localTimestamp(at, 'Asia/Kolkata'), '2026-11-08 10:33:04 UTC+05:30');
  assert.equal(localTimestamp(new Date('2026-11-08T16:00:00Z'), 'Asia/Shanghai'), '2026-11-09 00:00:00 UTC+08:00');
  assert.equal(at.toISOString(), '2026-11-08T05:03:04.000Z');
});

test('local timestamps respect the offset at capture time across DST changes', () => {
  assert.equal(localTimestamp(new Date('2026-11-01T05:30:00Z'), 'America/New_York'), '2026-11-01 01:30:00 UTC-04:00');
  assert.equal(localTimestamp(new Date('2026-11-01T06:30:00Z'), 'America/New_York'), '2026-11-01 01:30:00 UTC-05:00');
});
