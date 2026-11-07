export type Cadence = 'daily' | 'weekly' | 'monthly' | 'quarterly' | 'custom';
export type ReportingPeriod = 'previous' | 'day-to-date' | 'week-to-date' | 'weeks-to-date' | 'month-to-date' | 'all-time';
export interface Period {
  start: Date;
  end: Date;
  due: boolean;
  kind?: ReportingPeriod;
}

export function getPeriod(now: Date, cadence: Cadence, interval = 2, anchor = '2026-01'): Period {
  const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  if (cadence === 'daily') {
    return { start: new Date(today.getTime() - 86_400_000), end: today, due: true };
  }
  if (cadence === 'weekly') {
    const daysSinceMonday = (today.getUTCDay() + 6) % 7;
    const end = new Date(today.getTime() - daysSinceMonday * 86_400_000);
    return { start: new Date(end.getTime() - 7 * 86_400_000), end, due: daysSinceMonday === 0 };
  }
  const months = cadence === 'quarterly' ? 3 : cadence === 'monthly' ? 1 : interval;
  if (!Number.isInteger(months) || months < 1 || months > 120) {
    throw new Error('interval-months must be an integer between 1 and 120.');
  }
  if (!/^(20\d{2})-(0[1-9]|1[0-2])$/.test(anchor)) {
    throw new Error('anchor-month must use YYYY-MM format with a year from 2000 to 2099.');
  }
  const anchorIndex = cadence === 'custom'
    ? Number(anchor.slice(0, 4)) * 12 + Number(anchor.slice(5)) - 1
    : 0;
  const currentIndex = today.getUTCFullYear() * 12 + today.getUTCMonth();
  const boundary = anchorIndex + Math.floor((currentIndex - anchorIndex) / months) * months;
  const end = new Date(Date.UTC(Math.floor(boundary / 12), boundary % 12, 1));
  const startIndex = boundary - months;
  const start = new Date(Date.UTC(Math.floor(startIndex / 12), startIndex % 12, 1));
  return { start, end, due: today.getTime() === end.getTime() };
}

export function getReportingPeriod(now: Date, cadence: Cadence, kind: ReportingPeriod, interval = 2, anchor = '2026-01', intervalWeeks = 3, anchorWeek = '2026-01-05'): Period {
  const scheduled = getPeriod(now, cadence, interval, anchor);
  if (kind === 'previous') return { ...scheduled, kind };
  const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  if (kind === 'day-to-date') return { start: today, end: new Date(now), due: scheduled.due, kind };
  if (kind === 'week-to-date') {
    const daysSinceMonday = (today.getUTCDay() + 6) % 7;
    return { start: new Date(today.getTime() - daysSinceMonday * 86_400_000), end: new Date(now), due: scheduled.due, kind };
  }
  if (kind === 'weeks-to-date') {
    if (!Number.isInteger(intervalWeeks) || intervalWeeks < 1 || intervalWeeks > 520) {
      throw new Error('interval-weeks must be an integer between 1 and 520.');
    }
    const anchorDate = new Date(`${anchorWeek}T00:00:00.000Z`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(anchorWeek) || Number.isNaN(anchorDate.getTime())
      || anchorDate.toISOString().slice(0, 10) !== anchorWeek || anchorDate.getUTCFullYear() < 2000
      || anchorDate.getUTCFullYear() > 2099 || anchorDate.getUTCDay() !== 1) {
      throw new Error('anchor-week must be a valid Monday in YYYY-MM-DD format, with a year from 2000 to 2099.');
    }
    const length = intervalWeeks * 7 * 86_400_000;
    const start = new Date(anchorDate.getTime() + Math.floor((now.getTime() - anchorDate.getTime()) / length) * length);
    return { start, end: new Date(now), due: scheduled.due, kind };
  }
  if (kind === 'month-to-date') {
    return { start: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)), end: new Date(now), due: scheduled.due, kind };
  }
  if (kind === 'all-time') return { start: new Date(0), end: new Date(now), due: scheduled.due, kind };
  throw new Error('period must be previous, day-to-date, week-to-date, weeks-to-date, month-to-date, or all-time.');
}

export function inPeriod(timestamp: string | null, period: Period): boolean {
  if (!timestamp) return false;
  const time = Date.parse(timestamp);
  return time >= period.start.getTime() && time < period.end.getTime();
}
