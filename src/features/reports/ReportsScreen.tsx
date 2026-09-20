import AsyncStorage from '@react-native-async-storage/async-storage';
import DateTimePicker, { type DateTimePickerEvent } from '@react-native-community/datetimepicker';
import { useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, Platform, Pressable, ScrollView, Share, StyleSheet, Text, View } from 'react-native';
import { colors, spacing } from '../../shared/theme';
import { useAuth } from '../auth/AuthProvider';
import { useTenant } from '../tenancy/TenantProvider';
import { loadReport, reportCacheKey, reportToCsv, type ReportData, type ReportTransactionType } from './reportsApi';
import { resolveCustomReportRange, resolveReportRange, type ReportPeriod, type ReportRange } from './reportRange';

const periods: Array<{ key: ReportPeriod; label: string }> = [{ key: 'today', label: 'Today' }, { key: '7d', label: '7 days' }, { key: '30d', label: '30 days' }];
const types: ReportTransactionType[] = ['ALL', 'RECEIPT', 'SALE', 'DAMAGE', 'EXPIRED', 'ADJUSTMENT'];
type PeriodSelection = ReportPeriod | 'custom';
type PickerTarget = 'from' | 'to';

export function ReportsScreen({ onBack }: { onBack: () => void }) {
  const { session } = useAuth();
  const { context, locations } = useTenant();
  const [period, setPeriod] = useState<PeriodSelection>('7d');
  const [appliedPeriod, setAppliedPeriod] = useState<PeriodSelection>('7d');
  const [appliedRange, setAppliedRange] = useState<ReportRange>(() => resolveReportRange('7d'));
  const [draftFrom, setDraftFrom] = useState(() => new Date(resolveReportRange('7d').from));
  const [draftTo, setDraftTo] = useState(() => inclusiveEndDate(resolveReportRange('7d')));
  const [pickerTarget, setPickerTarget] = useState<PickerTarget | null>(null);
  const [rangeError, setRangeError] = useState<string | null>(null);
  const [type, setType] = useState<ReportTransactionType>('ALL');
  const [report, setReport] = useState<ReportData | null>(null);
  const [cached, setCached] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const location = useMemo(() => locations.find(item => item.id === context?.locationId), [context, locations]);

  useEffect(() => {
    if (!context || !session) return;
    let active = true;
    setError(null);
    const key = reportCacheKey(session.user.id, context.tenant.id, context.locationId, appliedRange, type);
    void loadReport(context.tenant.id, context.locationId, appliedRange, type).then(async next => {
      await AsyncStorage.setItem(key, JSON.stringify(next));
      if (active) { setReport(next); setCached(false); }
    }).catch(async caught => {
      const stored = await AsyncStorage.getItem(key);
      if (!active) return;
      if (stored) { setReport(JSON.parse(stored) as ReportData); setCached(true); }
      else setError(caught instanceof Error ? caught.message : 'Unable to load report.');
    });
    return () => { active = false; };
  }, [appliedRange, context, session, type]);

  function selectPreset(nextPeriod: ReportPeriod) {
    const nextRange = resolveReportRange(nextPeriod);
    setPeriod(nextPeriod);
    setAppliedPeriod(nextPeriod);
    setAppliedRange(nextRange);
    setDraftFrom(new Date(nextRange.from));
    setDraftTo(inclusiveEndDate(nextRange));
    setPickerTarget(null);
    setRangeError(null);
  }

  function showCustomRange() {
    setPeriod('custom');
    setPickerTarget(null);
    setRangeError(null);
  }

  function updateDraftDate(event: DateTimePickerEvent, selectedDate?: Date) {
    if (Platform.OS === 'android') setPickerTarget(null);
    if (event.type === 'dismissed' || !selectedDate || !pickerTarget) return;
    if (pickerTarget === 'from') setDraftFrom(selectedDate);
    else setDraftTo(selectedDate);
    setRangeError(null);
  }

  function applyCustomRange() {
    try {
      setAppliedRange(resolveCustomReportRange(draftFrom, draftTo));
      setAppliedPeriod('custom');
      setPickerTarget(null);
      setRangeError(null);
    } catch (caught) {
      setRangeError(caught instanceof Error ? caught.message : 'Choose a valid report range.');
    }
  }

  function clearCustomRange() {
    selectPreset('7d');
  }

  if (!context) return null;
  return <ScrollView contentContainerStyle={styles.container}>
    <Pressable onPress={onBack}><Text style={styles.link}>← Back</Text></Pressable>
    <Text style={styles.title}>Reports</Text>
    <Text style={styles.subtitle}>{context.tenant.name} · {location?.name}</Text>
    <View style={styles.chips}>
      {periods.map(item => <Chip key={item.key} label={item.label} active={period === item.key} onPress={() => selectPreset(item.key)} />)}
      <Chip label="Custom" active={period === 'custom'} onPress={showCustomRange} />
    </View>
    {period === 'custom' ? <View style={styles.rangeCard}>
      <View style={styles.dateFields}>
        <DateField label="From" value={draftFrom} onPress={() => setPickerTarget('from')} />
        <DateField label="To" value={draftTo} onPress={() => setPickerTarget('to')} />
      </View>
      {pickerTarget ? <View style={styles.pickerPanel}>
        <DateTimePicker
          display={Platform.OS === 'ios' ? 'inline' : 'default'}
          maximumDate={new Date()}
          mode="date"
          onChange={updateDraftDate}
          value={pickerTarget === 'from' ? draftFrom : draftTo}
        />
        {Platform.OS === 'ios' ? <Pressable onPress={() => setPickerTarget(null)} style={styles.doneButton}><Text style={styles.doneText}>Done</Text></Pressable> : null}
      </View> : null}
      {rangeError ? <Text style={styles.error}>{rangeError}</Text> : null}
      <View style={styles.rangeActions}>
        <Pressable onPress={clearCustomRange} style={styles.clearButton}><Text style={styles.clearText}>Clear</Text></Pressable>
        <Pressable onPress={applyCustomRange} style={styles.applyButton}><Text style={styles.applyText}>Apply</Text></Pressable>
      </View>
    </View> : null}
    <Text style={styles.activeRange}>Active range: {formatRange(appliedRange, appliedPeriod)}</Text>
    <View style={styles.chips}>{types.map(item => <Chip key={item} label={item === 'ALL' ? 'All' : item} active={type === item} onPress={() => setType(item)} />)}</View>
    {!report && !error ? <ActivityIndicator color={colors.primary} style={styles.loader} /> : null}
    {error ? <Text style={styles.error}>{error}</Text> : null}
    {cached && report ? <Text style={styles.offline}>Offline report · updated {new Date(report.fetchedAt).toLocaleString()}</Text> : null}
    {report ? <>
      <View style={styles.grid}>
        <Metric label="Current units" value={report.summary.currentUnits} />
        <Metric label="Received" value={report.summary.stockReceived} />
        <Metric label="Issued" value={report.summary.stockIssued} />
      </View>
      <Text style={styles.section}>Transactions ({report.summary.totalTransactions})</Text>
      {report.transactions.map(item => <View key={item.id} style={styles.card}>
        <View style={styles.row}><Text style={styles.cardTitle}>{item.productName}</Text><Text style={styles.type}>{item.type}</Text></View>
        <Text style={styles.body}>{item.quantity > 0 ? '+' : ''}{item.quantity} · {item.previousStock ?? '—'} → {item.newStock ?? '—'}</Text>
        <Text style={styles.body}>{item.performerName} · {new Date(item.createdAt).toLocaleString()}</Text>
        {item.remarks ? <Text style={styles.body}>{item.remarks}</Text> : null}
      </View>)}
      {!report.transactions.length ? <Text style={styles.body}>No transactions match the selected date range.</Text> : null}
      <Pressable style={styles.outline} onPress={() => void Share.share({ title: 'Inventory report.csv', message: reportToCsv(report) })}><Text style={styles.outlineText}>Share CSV</Text></Pressable>
    </> : null}
  </ScrollView>;
}

function Chip({ label, active, onPress }: { label: string; active: boolean; onPress: () => void }) { return <Pressable onPress={onPress} style={[styles.chip, active && styles.chipActive]}><Text style={[styles.chipText, active && styles.chipTextActive]}>{label}</Text></Pressable>; }
function DateField({ label, value, onPress }: { label: string; value: Date; onPress: () => void }) { return <Pressable accessibilityRole="button" onPress={onPress} style={styles.dateField}><Text style={styles.dateLabel}>{label}</Text><Text style={styles.dateValue}>{formatDate(value)}</Text></Pressable>; }
function Metric({ label, value }: { label: string; value: number }) { return <View style={styles.metric}><Text style={styles.metricValue}>{value}</Text><Text style={styles.meta}>{label}</Text></View>; }

function inclusiveEndDate(range: ReportRange): Date {
  const date = new Date(range.toExclusive);
  date.setDate(date.getDate() - 1);
  return date;
}

function formatDate(value: Date): string {
  return value.toLocaleDateString(undefined, { day: '2-digit', month: 'short', year: 'numeric' });
}

function formatRange(range: ReportRange, period: PeriodSelection): string {
  const end = period === 'today' || period === 'custom'
    ? inclusiveEndDate(range)
    : new Date(range.toExclusive);
  return `${formatDate(new Date(range.from))} – ${formatDate(end)}`;
}

const styles = StyleSheet.create({
  container: { padding: spacing.xl }, link: { color: colors.primary, fontWeight: '700' }, title: { color: colors.text, fontSize: 32, fontWeight: '700', marginTop: spacing.lg },
  subtitle: { color: colors.textMuted, marginTop: spacing.xs }, chips: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm, marginTop: spacing.md },
  chip: { borderColor: colors.border, borderRadius: 20, borderWidth: 1, paddingHorizontal: spacing.md, paddingVertical: spacing.sm }, chipActive: { backgroundColor: colors.primary, borderColor: colors.primary },
  chipText: { color: colors.textMuted, fontSize: 12, fontWeight: '700' }, chipTextActive: { color: '#fff' }, loader: { marginTop: spacing.xl }, error: { color: '#B42318', marginTop: spacing.lg },
  rangeCard: { backgroundColor: colors.surface, borderColor: colors.border, borderRadius: 12, borderWidth: 1, marginTop: spacing.md, padding: spacing.md },
  dateFields: { flexDirection: 'row', gap: spacing.sm }, dateField: { borderColor: colors.border, borderRadius: 10, borderWidth: 1, flex: 1, padding: spacing.md },
  dateLabel: { color: colors.textMuted, fontSize: 11, fontWeight: '700' }, dateValue: { color: colors.text, fontWeight: '700', marginTop: spacing.xs },
  pickerPanel: { marginTop: spacing.sm }, doneButton: { alignSelf: 'flex-end', paddingHorizontal: spacing.md, paddingVertical: spacing.sm }, doneText: { color: colors.primary, fontWeight: '700' },
  rangeActions: { flexDirection: 'row', gap: spacing.sm, justifyContent: 'flex-end', marginTop: spacing.md }, clearButton: { borderColor: colors.border, borderRadius: 10, borderWidth: 1, paddingHorizontal: spacing.lg, paddingVertical: spacing.sm },
  clearText: { color: colors.textMuted, fontWeight: '700' }, applyButton: { backgroundColor: colors.primary, borderRadius: 10, paddingHorizontal: spacing.lg, paddingVertical: spacing.sm }, applyText: { color: '#fff', fontWeight: '700' },
  activeRange: { color: colors.textMuted, fontSize: 12, marginTop: spacing.sm },
  offline: { color: '#9A6700', marginTop: spacing.md }, grid: { flexDirection: 'row', gap: spacing.sm, marginTop: spacing.xl }, metric: { backgroundColor: colors.surface, borderColor: colors.border, borderRadius: 12, borderWidth: 1, flex: 1, padding: spacing.md },
  metricValue: { color: colors.text, fontSize: 22, fontWeight: '700' }, meta: { color: colors.textMuted, fontSize: 11, marginTop: spacing.xs }, section: { color: colors.text, fontSize: 18, fontWeight: '700', marginTop: spacing.xl },
  card: { backgroundColor: colors.surface, borderColor: colors.border, borderRadius: 12, borderWidth: 1, marginTop: spacing.md, padding: spacing.md }, row: { flexDirection: 'row', justifyContent: 'space-between' },
  cardTitle: { color: colors.text, flex: 1, fontWeight: '700' }, type: { color: colors.primary, fontSize: 11, fontWeight: '700' }, body: { color: colors.textMuted, lineHeight: 20, marginTop: spacing.xs },
  outline: { alignItems: 'center', borderColor: colors.primary, borderRadius: 12, borderWidth: 1, marginTop: spacing.xl, padding: spacing.md }, outlineText: { color: colors.primary, fontWeight: '700' },
});
