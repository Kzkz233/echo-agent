import test from 'node:test';
import assert from 'node:assert/strict';
import { messageTime, messageDay } from '../apps/workbench/src/message-time-format.ts';

const options = { language: 'zh-CN', timezone: 'Asia/Shanghai', now: new Date('2026-11-15T02:00:00Z') };
test('conversation timestamps distinguish the same clock time on different days', () => {
  assert.equal(messageTime('2026-11-14T23:00:00Z', options).label, '07:00');
  assert.equal(messageTime('2026-11-13T23:00:00Z', options).label, '昨天 07:00');
  assert.equal(messageTime('2026-11-12T23:00:00Z', options).label, '11/13 07:00');
  const old = messageTime('2025-11-13T23:00:00Z', options);
  assert.equal(old.label, '2025/11/14 07:00');
  assert.match(old.title, /2025/); assert.match(old.title, /07:00:00/); assert.match(old.title, /GMT\+8/);
});
test('day boundaries use the application timezone, not the browser timezone', () => {
  const at = '2026-11-14T16:05:00Z';
  assert.equal(messageDay(new Date(at), options.timezone), '2026-11-15');
  assert.equal(messageTime(at, options).label, '00:05');
  assert.equal(messageTime(at, { ...options, timezone: 'UTC' }).label, '昨天 16:05');
  assert.match(messageTime('2026-11-13T23:00:00Z', { ...options, language: 'en' }).label, /^Yesterday /);
});
test('yesterday is a calendar day across DST and January boundaries', () => {
  assert.match(messageTime('2026-11-01T04:15:00Z', { ...options, timezone: 'America/New_York', now: new Date('2026-11-02T05:10:00Z') }).label, /^昨天 /);
  assert.match(messageTime('2026-12-31T23:00:00Z', { ...options, timezone: 'UTC', now: new Date('2027-01-01T12:00:00Z') }).label, /^昨天 /);
});
test('invalid timestamps and stale timezone settings cannot crash a conversation', () => {
  assert.deepEqual(messageTime('bad', options), { label: '—', title: '', day: '' });
  assert.doesNotThrow(() => messageTime('2026-11-14T23:00:00Z', { ...options, timezone: 'invalid' }));
});
