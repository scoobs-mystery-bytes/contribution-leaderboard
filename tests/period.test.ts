import assert from 'node:assert/strict';
import { test } from 'node:test';
import { getPeriod, getReportingPeriod, inPeriod } from '../src/period.js';

test('daily reporting includes leap day and uses a half-open interval', () => {
  const period = getPeriod(new Date('2024-03-01T08:17:00Z'), 'daily');
  assert.equal(period.start.toISOString(), '2024-02-29T00:00:00.000Z');
  assert.equal(inPeriod('2024-02-29T00:00:00Z', period), true);
  assert.equal(inPeriod('2024-03-01T00:00:00Z', period), false);
  assert.equal(inPeriod(null, period), false);
});

test('weekly reports are due Monday and cover the previous Monday through Sunday', () => {
  const monday = getPeriod(new Date('2026-11-02T08:17:00Z'), 'weekly');
  assert.equal(monday.due, true);
  assert.equal(monday.start.toISOString(), '2026-10-26T00:00:00.000Z');
  assert.equal(monday.end.toISOString(), '2026-11-02T00:00:00.000Z');
  const friday = getPeriod(new Date('2026-11-06T08:17:00Z'), 'weekly');
  assert.equal(friday.due, false);
  assert.equal(friday.end.toISOString(), monday.end.toISOString());
});

test('monthly and quarterly boundaries cross years correctly', () => {
  const monthly = getPeriod(new Date('2027-01-01T08:17:00Z'), 'monthly');
  assert.equal(monthly.start.toISOString(), '2026-12-01T00:00:00.000Z');
  const quarterly = getPeriod(new Date('2027-01-01T08:17:00Z'), 'quarterly');
  assert.equal(quarterly.start.toISOString(), '2026-10-01T00:00:00.000Z');
  assert.equal(quarterly.due, true);
  assert.equal(getPeriod(new Date('2026-11-01T08:17:00Z'), 'quarterly').due, false);
});

test('custom five-month intervals continue across years from their anchor', () => {
  const period = getPeriod(new Date('2027-04-01T08:17:00Z'), 'custom', 5, '2026-01');
  assert.equal(period.due, true);
  assert.equal(period.start.toISOString(), '2026-11-01T00:00:00.000Z');
  assert.equal(period.end.toISOString(), '2027-04-01T00:00:00.000Z');
  assert.equal(getPeriod(new Date('2027-01-01T08:17:00Z'), 'custom', 5, '2026-01').due, false);
});

test('custom periods extend backwards from a future anchor', () => {
  const period = getPeriod(new Date('2025-11-01T08:17:00Z'), 'custom', 2, '2026-01');
  assert.equal(period.start.toISOString(), '2025-09-01T00:00:00.000Z');
  assert.equal(period.end.toISOString(), '2025-11-01T00:00:00.000Z');
});

test('invalid intervals and anchors fail', () => {
  assert.throws(() => getPeriod(new Date(), 'custom', 0));
  assert.throws(() => getPeriod(new Date(), 'custom', 1.5));
  assert.throws(() => getPeriod(new Date(), 'custom', 2, '2026-13'));
});

test('month-to-date resets on the first of the UTC month and ends at the run time', () => {
  const before = getReportingPeriod(new Date('2026-11-30T23:59:59Z'), 'weekly', 'month-to-date');
  const after = getReportingPeriod(new Date('2026-12-01T00:00:00Z'), 'weekly', 'month-to-date');
  assert.equal(before.start.toISOString(), '2026-11-01T00:00:00.000Z');
  assert.equal(before.end.toISOString(), '2026-11-30T23:59:59.000Z');
  assert.equal(after.start.toISOString(), '2026-12-01T00:00:00.000Z');
  assert.equal(after.end.toISOString(), '2026-12-01T00:00:00.000Z');
  assert.equal(before.due, true);
  assert.equal(after.due, false);
  assert.equal(inPeriod('2026-11-01T00:00:00Z', before), true);
  assert.equal(inPeriod('2026-10-31T23:59:59Z', before), false);
  assert.equal(inPeriod('2026-11-30T23:59:59Z', before), false);
});

test('all-time keeps a fixed start across months while cadence controls due days', () => {
  const first = getReportingPeriod(new Date('2026-11-02T08:17:00Z'), 'weekly', 'all-time');
  const later = getReportingPeriod(new Date('2026-12-01T08:17:00Z'), 'weekly', 'all-time');
  assert.equal(first.start.toISOString(), '1970-01-01T00:00:00.000Z');
  assert.equal(later.start.toISOString(), first.start.toISOString());
  assert.equal(later.end.toISOString(), '2026-12-01T08:17:00.000Z');
  assert.equal(first.due, true);
  assert.equal(later.due, false);
  assert.equal(inPeriod('2009-05-01T00:00:00Z', later), true);
});

test('previous preserves cadence windows and rejects unknown period inputs', () => {
  const now = new Date('2026-11-02T08:17:00Z');
  const previous = getReportingPeriod(now, 'weekly', 'previous');
  assert.equal(previous.start.toISOString(), '2026-10-26T00:00:00.000Z');
  assert.equal(previous.end.toISOString(), '2026-11-02T00:00:00.000Z');
  assert.throws(() => getReportingPeriod(now, 'weekly', 'invalid' as never), /period must/);
});

test('day-to-date and week-to-date use UTC midnight and Monday boundaries', () => {
  const now = new Date('2027-01-03T23:59:59Z');
  const day = getReportingPeriod(now, 'daily', 'day-to-date');
  const week = getReportingPeriod(now, 'daily', 'week-to-date');
  assert.equal(day.start.toISOString(), '2027-01-03T00:00:00.000Z');
  assert.equal(week.start.toISOString(), '2026-12-28T00:00:00.000Z');
  assert.equal(week.end.toISOString(), now.toISOString());
  const next = getReportingPeriod(new Date('2027-01-04T00:00:00Z'), 'daily', 'week-to-date');
  assert.equal(next.start.toISOString(), '2027-01-04T00:00:00.000Z');
  assert.equal(inPeriod('2027-01-03T23:59:59Z', next), false);
});

test('three-week windows reset on anchored UTC Mondays, including before the anchor', () => {
  const get = (date: string) => getReportingPeriod(new Date(date), 'weekly', 'weeks-to-date', 2, '2026-01', 3, '2026-01-05');
  assert.equal(get('2026-01-25T23:59:59Z').start.toISOString(), '2026-01-05T00:00:00.000Z');
  const reset = get('2026-01-26T00:00:00Z');
  assert.equal(reset.start.toISOString(), '2026-01-26T00:00:00.000Z');
  assert.equal(reset.due, true);
  assert.equal(get('2025-12-31T12:00:00Z').start.toISOString(), '2025-12-15T00:00:00.000Z');
  assert.equal(get('2026-02-16T12:00:00Z').start.toISOString(), '2026-02-16T00:00:00.000Z');
  assert.equal(get('2026-02-17T12:00:00Z').due, false);
});

test('custom week windows reject invalid intervals, dates, and non-Monday anchors', () => {
  const get = (weeks: number, anchor: string) => getReportingPeriod(new Date(), 'daily', 'weeks-to-date', 2, '2026-01', weeks, anchor);
  assert.throws(() => get(0, '2026-01-05'), /interval-weeks/);
  assert.throws(() => get(1.5, '2026-01-05'), /interval-weeks/);
  assert.throws(() => get(521, '2026-01-05'), /interval-weeks/);
  assert.throws(() => get(3, '2026-01-06'), /anchor-week/);
  assert.throws(() => get(3, '2026-02-30'), /anchor-week/);
  assert.throws(() => get(3, 'not-a-date'), /anchor-week/);
});
