export type ReportPeriod = 'today' | '7d' | '30d';

export interface ReportRange {
  from: string;
  toExclusive: string;
}

const MAX_CUSTOM_RANGE_DAYS = 366;
export type RelativeDurationUnit = 'days' | 'weeks' | 'months';
export type RelativeUnit = RelativeDurationUnit | 'custom';
export const MAX_RELATIVE_AMOUNT: Record<RelativeDurationUnit, number> = { days: 366, weeks: 52, months: 12 };

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

export function resolveRelativeReportRange(amount: number, unit: RelativeDurationUnit, now = new Date()): ReportRange {
  if (!Number.isInteger(amount) || amount < 1) {
    throw new Error('Enter a whole number of days, weeks, or months.');
  }
  if (amount > MAX_RELATIVE_AMOUNT[unit]) {
    throw new Error(`Choose at most ${MAX_RELATIVE_AMOUNT[unit]} ${unit}.`);
  }
  const from = new Date(now);
  if (unit === 'days') from.setDate(from.getDate() - amount);
  else if (unit === 'weeks') from.setDate(from.getDate() - amount * 7);
  else from.setTime(subtractMonths(from, amount).getTime());
  return { from: from.toISOString(), toExclusive: now.toISOString() };
}

function subtractMonths(value: Date, months: number): Date {
  const result = new Date(value);
  const day = result.getDate();
  result.setDate(1);
  result.setMonth(result.getMonth() - months);
  const lastDay = new Date(result.getFullYear(), result.getMonth() + 1, 0).getDate();
  result.setDate(Math.min(day, lastDay));
  return result;
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
