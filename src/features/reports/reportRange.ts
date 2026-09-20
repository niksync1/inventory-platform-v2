export type ReportPeriod = 'today' | '7d' | '30d';

export interface ReportRange {
  from: string;
  toExclusive: string;
}

const MAX_CUSTOM_RANGE_DAYS = 366;

export function resolveReportRange(period: ReportPeriod, now = new Date()): ReportRange {
  const to = new Date(now);
  const from = new Date(now);
  if (period === 'today') {
    from.setHours(0, 0, 0, 0);
    to.setHours(24, 0, 0, 0);
  } else {
    from.setDate(from.getDate() - (period === '7d' ? 7 : 30));
  }
  return { from: from.toISOString(), toExclusive: to.toISOString() };
}

export function resolveCustomReportRange(fromDate: Date, toDate: Date, now = new Date()): ReportRange {
  const from = startOfLocalDay(fromDate);
  const to = startOfLocalDay(toDate);
  const today = startOfLocalDay(now);

  if (!Number.isFinite(from.getTime()) || !Number.isFinite(to.getTime())) {
    throw new Error('Choose valid From and To dates.');
  }
  if (from > today || to > today) {
    throw new Error('Report dates cannot be in the future.');
  }
  if (to < from) {
    throw new Error('The To date must be on or after the From date.');
  }

  const inclusiveDays = calendarDayNumber(to) - calendarDayNumber(from) + 1;
  if (inclusiveDays > MAX_CUSTOM_RANGE_DAYS) {
    throw new Error(`Custom reports cannot exceed ${MAX_CUSTOM_RANGE_DAYS} days.`);
  }

  const toExclusive = new Date(to);
  toExclusive.setDate(toExclusive.getDate() + 1);
  return { from: from.toISOString(), toExclusive: toExclusive.toISOString() };
}

function startOfLocalDay(value: Date): Date {
  const date = new Date(value);
  date.setHours(0, 0, 0, 0);
  return date;
}

function calendarDayNumber(value: Date): number {
  return Date.UTC(value.getFullYear(), value.getMonth(), value.getDate()) / 86_400_000;
}
