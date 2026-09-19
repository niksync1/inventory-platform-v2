export type ReportPeriod = 'today' | '7d' | '30d';

export interface ReportRange {
  from: string;
  toExclusive: string;
}

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
