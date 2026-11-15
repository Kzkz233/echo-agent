import test from 'node:test';
import assert from 'node:assert/strict';
import { agendaDayRange, agendaOccursOn } from '../plugins/agenda/range.ts';
test('midnight ends are exclusive; actual overnight work, points and all-day ranges retain their dates', () => {
  const zone = 'Asia/Shanghai';
  const evening = { start: '2026-11-15T12:00:00Z', end: '2026-11-15T16:00:00Z' };
  assert(agendaOccursOn(evening, '2026-11-15', zone));
  assert(!agendaOccursOn(evening, '2026-11-16', zone));
  assert(agendaOccursOn({ ...evening, end: '2026-11-15T16:01:00Z' }, '2026-11-16', zone));
  assert.deepEqual(agendaDayRange({ start: evening.end }, zone), ['2026-11-16', '2026-11-16']);
  assert(agendaOccursOn({ date: '2026-11-15', dateEnd: '2026-11-16' }, '2026-11-16', zone));
  assert(!agendaOccursOn({}, '2026-11-16', zone));
});
