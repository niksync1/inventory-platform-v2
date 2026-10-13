import AsyncStorage from '@react-native-async-storage/async-storage';
import DateTimePicker, { type DateTimePickerEvent } from '@react-native-community/datetimepicker';
import { useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, Alert, Modal, Platform, Pressable, ScrollView, StyleSheet, Switch, Text, TextInput, View, type StyleProp, type ViewStyle } from 'react-native';
import { colors, spacing } from '../../shared/theme';
import { useAuth } from '../auth/AuthProvider';
import { useTenant } from '../tenancy/TenantProvider';
import { expiryReportToCsv, loadExpirySettings, loadReport, reportCacheKey, reportToCsv, updateExpirySettings, type ReportData, type ReportTransactionType } from './reportsApi';
import { MAX_RELATIVE_AMOUNT, resolveCustomReportRange, resolveRelativeReportRange, resolveReportRange, type RelativeUnit, type ReportRange } from './reportRange';
import { exportCsvToDevice, exportPdfToDevice, expiryReportToPdfHtml, reportExportFileName, reportToPdfHtml } from './reportExport';

const typeOptions: Array<{ value: ReportTransactionType; label: string }> = [{ value: 'ALL', label: 'All' }, { value: 'RECEIPT', label: 'Receipt' }, { value: 'SALE', label: 'Sale' }, { value: 'DAMAGE', label: 'Damaged' }, { value: 'EXPIRED', label: 'Expired' }, { value: 'ADJUSTMENT', label: 'Adjustment' }, { value: 'TRANSFER_OUT', label: 'Transfer out' }, { value: 'TRANSFER_IN', label: 'Transfer in' }, { value: 'TRANSFER_RETURN', label: 'Transfer return' }];
const unitOptions: Array<{ value: RelativeUnit; label: string }> = [{ value: 'days', label: 'Days' }, { value: 'weeks', label: 'Weeks' }, { value: 'months', label: 'Months' }, { value: 'custom', label: 'Custom' }];
type PickerTarget = 'from' | 'to';

export function ReportsScreen({ onBack }: { onBack: () => void }) {
  const { session } = useAuth();
  const { context, locations } = useTenant();
  const [amount, setAmount] = useState('7');
  const [unit, setUnit] = useState<RelativeUnit>('days');
  const [appliedRange, setAppliedRange] = useState<ReportRange>(() => resolveRelativeReportRange(7, 'days'));
  const [appliedSingleDay, setAppliedSingleDay] = useState(false);
  const [draftFrom, setDraftFrom] = useState(() => new Date(resolveReportRange('7d').from));
  const [draftTo, setDraftTo] = useState(() => inclusiveEndDate(resolveReportRange('7d')));
  const [pickerTarget, setPickerTarget] = useState<PickerTarget | null>(null);
  const [rangeError, setRangeError] = useState<string | null>(null);
  const [type, setType] = useState<ReportTransactionType>('ALL');
  const [report, setReport] = useState<ReportData | null>(null);
  const [cached, setCached] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [warningDays, setWarningDays] = useState('90');
  const [criticalDays, setCriticalDays] = useState('30');
  const [settingsMessage, setSettingsMessage] = useState<string | null>(null);
  const [savingSettings, setSavingSettings] = useState(false);
  const [exporting, setExporting] = useState<string | null>(null);
  const [includeExpiry, setIncludeExpiry] = useState(true);
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

  useEffect(() => {
    if (!context) return;
    void loadExpirySettings(context.tenant.id).then(settings => {
      setWarningDays(String(settings.warningDays));
      setCriticalDays(String(settings.criticalDays));
    }).catch(() => undefined);
  }, [context]);

  async function saveExpirySettings() {
    if (!context || savingSettings) return;
    const warning = Number(warningDays); const critical = Number(criticalDays);
    if (!Number.isInteger(warning) || warning < 31 || warning > 730 || !Number.isInteger(critical) || critical < 1 || critical > 30 || warning <= critical) {
      setSettingsMessage('Use 1–30 days for critical and 31–730 days for warning.'); return;
    }
    setSavingSettings(true); setSettingsMessage(null);
    try {
      await updateExpirySettings(context.tenant.id, { warningDays: warning, criticalDays: critical });
      setReport(await loadReport(context.tenant.id, context.locationId, appliedRange, type));
      setSettingsMessage('Expiry thresholds saved.');
    } catch (caught) { setSettingsMessage(caught instanceof Error ? caught.message : 'Unable to save thresholds.'); }
    finally { setSavingSettings(false); }
  }


  async function exportReport(target: 'transactions' | 'expiry', format: 'csv' | 'pdf') {
    if (!report || !context || exporting) return;
    const exportKey = `${target}-${format}`;
    setExporting(exportKey);
    try {
      const rangeLabel = `${appliedRange.from.slice(0, 10)}-to-${appliedRange.toExclusive.slice(0, 10)}`;
      const prefix = target === 'transactions' ? 'inventory-report' : 'batch-expiry-report';
      const fileName = reportExportFileName(prefix, rangeLabel, format);
      if (format === 'csv') {
        const csv = target === 'transactions' ? reportToCsv(report, includeExpiry) : expiryReportToCsv(report);
        const saved = await exportCsvToDevice(fileName, csv);
        if (!saved) Alert.alert('Export cancelled', 'No file was saved because the folder selection was cancelled.');
        else if (Platform.OS === 'android') Alert.alert('Export saved', `Saved ${fileName} to the selected folder.`);
      } else {
        const html = target === 'transactions'
          ? reportToPdfHtml(report, context.tenant.name, location?.name ?? 'Location', formatRange(appliedRange, appliedSingleDay), includeExpiry)
          : expiryReportToPdfHtml(report, context.tenant.name, location?.name ?? 'Location');
        const saved = await exportPdfToDevice(fileName, html);
        if (!saved) Alert.alert('Export cancelled', 'No file was saved because the folder selection was cancelled.');
        else if (Platform.OS === 'android') Alert.alert('Export saved', `Saved ${fileName} to the selected folder.`);
      }
    } catch (caught) {
      Alert.alert('Export failed', caught instanceof Error ? caught.message : 'Unable to export this report.');
    } finally {
      setExporting(null);
    }
  }

  function applyToday() {
    const next = resolveReportRange('today');
    setRangeError(null);
    setAppliedSingleDay(true);
    setAppliedRange(previous => previous.from === next.from && previous.toExclusive === next.toExclusive ? previous : next);
  }

  function applyRelative(amountValue: number, target: Exclude<RelativeUnit, 'custom'>) {
    try {
      const next = resolveRelativeReportRange(amountValue, target);
      setRangeError(null);
      setAppliedSingleDay(false);
      setAppliedRange(previous => previous.from === next.from && previous.toExclusive === next.toExclusive ? previous : next);
    } catch (caught) {
      setRangeError(caught instanceof Error ? caught.message : 'Choose a valid report range.');
    }
  }

  function changeAmount(delta: number) {
    if (unit === 'custom') return;
    const parsed = Number.parseInt(amount, 10);
    const base = Number.isInteger(parsed) ? parsed : 1;
    const next = Math.min(Math.max(base + delta, 1), MAX_RELATIVE_AMOUNT[unit]);
    setAmount(String(next));
    applyRelative(next, unit);
  }

  function commitAmount() {
    if (unit === 'custom') return;
    const parsed = Number.parseInt(amount, 10);
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > MAX_RELATIVE_AMOUNT[unit]) {
      setRangeError(`Enter a whole number between 1 and ${MAX_RELATIVE_AMOUNT[unit]}.`);
      return;
    }
    setAmount(String(parsed));
    applyRelative(parsed, unit);
  }

  function changeUnit(nextUnit: RelativeUnit) {
    setUnit(nextUnit);
    setPickerTarget(null);
    setRangeError(null);
    if (nextUnit === 'custom') {
      setDraftFrom(new Date(appliedRange.from));
      setDraftTo(inclusiveEndDate(appliedRange));
      return;
    }
    const parsed = Number.parseInt(amount, 10);
    if (!Number.isInteger(parsed)) {
      setRangeError(`Enter a whole number between 1 and ${MAX_RELATIVE_AMOUNT[nextUnit]}.`);
      return;
    }
    const clamped = Math.min(Math.max(parsed, 1), MAX_RELATIVE_AMOUNT[nextUnit]);
    setAmount(String(clamped));
    applyRelative(clamped, nextUnit);
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
      const next = resolveCustomReportRange(draftFrom, draftTo);
      setAppliedRange(previous => previous.from === next.from && previous.toExclusive === next.toExclusive ? previous : next);
      setAppliedSingleDay(true);
      setPickerTarget(null);
      setRangeError(null);
    } catch (caught) {
      setRangeError(caught instanceof Error ? caught.message : 'Choose a valid report range.');
    }
  }

  if (!context) return null;
  const amountValue = Number.parseInt(amount, 10);
  const canStepDown = unit !== 'custom' && (!Number.isInteger(amountValue) || amountValue > 1);
  const canStepUp = unit !== 'custom' && (!Number.isInteger(amountValue) || amountValue < MAX_RELATIVE_AMOUNT[unit]);
  const amountMaxLength = unit === 'custom' ? 3 : String(MAX_RELATIVE_AMOUNT[unit]).length;
  return <ScrollView contentContainerStyle={styles.container}>
    <Pressable onPress={onBack}><Text style={styles.link}>← Back</Text></Pressable>
    <Text style={styles.title}>Reports</Text>
    <Text style={styles.subtitle}>{context.tenant.name} · {location?.name}</Text>
    <Pressable onPress={applyToday} style={styles.todayButton}><Text style={styles.todayText}>Today</Text></Pressable>
    <View style={styles.controlRow}>
      <View style={styles.stepper}>
        <Pressable disabled={!canStepDown} onPress={() => changeAmount(-1)} style={styles.stepButton}><Text style={[styles.stepText, !canStepDown && styles.stepDisabled]}>−</Text></Pressable>
        <TextInput keyboardType="number-pad" maxLength={amountMaxLength} onBlur={commitAmount} onChangeText={setAmount} onSubmitEditing={commitAmount} style={styles.amountInput} value={amount} />
        <Pressable disabled={!canStepUp} onPress={() => changeAmount(1)} style={styles.stepButton}><Text style={[styles.stepText, !canStepUp && styles.stepDisabled]}>+</Text></Pressable>
      </View>
      <Dropdown onChange={changeUnit} options={unitOptions} style={styles.unitDropdown} value={unit} />
    </View>
    {rangeError ? <Text style={styles.error}>{rangeError}</Text> : null}
    {unit === 'custom' ? <View style={styles.rangeCard}>
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
      <View style={styles.rangeActions}>
        <Pressable onPress={applyCustomRange} style={styles.applyButton}><Text style={styles.applyText}>Apply</Text></Pressable>
      </View>
    </View> : null}
    <Text style={styles.activeRange}>Active range: {formatRange(appliedRange, appliedSingleDay)}</Text>
    <Dropdown onChange={setType} options={typeOptions} style={styles.typeDropdown} value={type} />
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
      <Toggle label="Include batch expiry report" onChange={setIncludeExpiry} value={includeExpiry} />
      <View style={styles.exportActions}>
        <Pressable disabled={exporting !== null} style={[styles.outline, styles.exportButton, exporting !== null && styles.disabled]} onPress={() => void exportReport('transactions', 'csv')}><Text style={styles.outlineText}>{exporting === 'transactions-csv' ? 'Preparing…' : 'Download CSV'}</Text></Pressable>
        <Pressable disabled={exporting !== null} style={[styles.outline, styles.exportButton, exporting !== null && styles.disabled]} onPress={() => void exportReport('transactions', 'pdf')}><Text style={styles.outlineText}>{exporting === 'transactions-pdf' ? 'Preparing…' : 'Download PDF'}</Text></Pressable>
      </View>
      <Text style={styles.section}>Batch expiry ({report.expiryBatches.length})</Text>
      <Text style={styles.body}>Current stock batches ordered by earliest expiry. This list is independent of the transaction date range.</Text>
      {report.expiryBatches.map(batch => <View key={batch.id} style={styles.card}>
        <View style={styles.row}><Text style={styles.cardTitle}>{batch.productName}</Text><Text style={[styles.type, (batch.status === 'expired' || batch.status === 'critical') && styles.danger]}>{batch.status.toUpperCase()}</Text></View>
        <Text style={styles.body}>Batch {batch.batchNumber} · {batch.quantity} unit(s)</Text>
        <Text style={styles.body}>{batch.expiryDate ? `Expires ${formatExpiryDate(batch.expiryDate)}${batch.daysToExpiry !== null ? ` · ${formatDays(batch.daysToExpiry)}` : ''}` : 'Expiry not tracked (legacy stock)'}</Text>
      </View>)}
      {!report.expiryBatches.length ? <Text style={styles.body}>No stocked batches at this location.</Text> : null}
      <View style={styles.exportActions}>
        <Pressable disabled={exporting !== null} style={[styles.outline, styles.exportButton, exporting !== null && styles.disabled]} onPress={() => void exportReport('expiry', 'csv')}><Text style={styles.outlineText}>{exporting === 'expiry-csv' ? 'Preparing…' : 'Download expiry CSV'}</Text></Pressable>
        <Pressable disabled={exporting !== null} style={[styles.outline, styles.exportButton, exporting !== null && styles.disabled]} onPress={() => void exportReport('expiry', 'pdf')}><Text style={styles.outlineText}>{exporting === 'expiry-pdf' ? 'Preparing…' : 'Download expiry PDF'}</Text></Pressable>
      </View>
      {context.membership.role === 'owner' || context.membership.role === 'admin' ? <View style={styles.settingsCard}>
        <Text style={styles.cardTitle}>Expiry alert thresholds</Text><Text style={styles.body}>Owners and admins can configure tenant-wide warning windows.</Text>
        <View style={styles.dateFields}><View style={styles.settingField}><Text style={styles.dateLabel}>Critical days</Text><TextInput keyboardType="number-pad" onChangeText={setCriticalDays} style={styles.settingInput} value={criticalDays} /></View><View style={styles.settingField}><Text style={styles.dateLabel}>Warning days</Text><TextInput keyboardType="number-pad" onChangeText={setWarningDays} style={styles.settingInput} value={warningDays} /></View></View>
        {settingsMessage ? <Text style={styles.body}>{settingsMessage}</Text> : null}<Pressable disabled={savingSettings} onPress={() => void saveExpirySettings()} style={[styles.applyButton, styles.saveButton, savingSettings && styles.disabled]}><Text style={styles.applyText}>{savingSettings ? 'Saving…' : 'Save thresholds'}</Text></Pressable>
      </View> : null}
    </> : null}
  </ScrollView>;
}

function DateField({ label, value, onPress }: { label: string; value: Date; onPress: () => void }) { return <Pressable accessibilityRole="button" onPress={onPress} style={styles.dateField}><Text style={styles.dateLabel}>{label}</Text><Text style={styles.dateValue}>{formatDate(value)}</Text></Pressable>; }
function Metric({ label, value }: { label: string; value: number }) { return <View style={styles.metric}><Text style={styles.metricValue}>{value}</Text><Text style={styles.meta}>{label}</Text></View>; }

function Dropdown<T extends string>({ value, options, onChange, style }: { value: T; options: Array<{ value: T; label: string }>; onChange: (next: T) => void; style?: StyleProp<ViewStyle> }) {
  const [open, setOpen] = useState(false);
  const selected = options.find(item => item.value === value);
  return <>
    <Pressable onPress={() => setOpen(true)} style={[styles.dropdown, style]}>
      <Text numberOfLines={1} style={styles.dropdownText}>{selected?.label ?? value}</Text>
      <Text style={styles.dropdownChevron}>▾</Text>
    </Pressable>
    <Modal animationType="fade" onRequestClose={() => setOpen(false)} transparent visible={open}>
      <Pressable onPress={() => setOpen(false)} style={styles.dropdownBackdrop}>
        <Pressable onPress={() => undefined} style={styles.dropdownCard}>
          <ScrollView style={styles.dropdownList}>
            {options.map(item => <Pressable key={item.value} onPress={() => { setOpen(false); onChange(item.value); }} style={[styles.dropdownOption, item.value === value && styles.dropdownOptionActive]}>
              <Text style={[styles.dropdownOptionText, item.value === value && styles.dropdownOptionTextActive]}>{item.label}</Text>
            </Pressable>)}
          </ScrollView>
        </Pressable>
      </Pressable>
    </Modal>
  </>;
}

function Toggle({ label, value, onChange }: { label: string; value: boolean; onChange: (next: boolean) => void }) { return <View style={styles.toggleRow}><Text numberOfLines={2} style={styles.toggleLabel}>{label}</Text><Switch onValueChange={onChange} value={value} /></View>; }

function inclusiveEndDate(range: ReportRange): Date {
  const date = new Date(range.toExclusive);
  date.setDate(date.getDate() - 1);
  return date;
}

function formatDate(value: Date): string {
  return value.toLocaleDateString(undefined, { day: '2-digit', month: 'short', year: 'numeric' });
}

function formatRange(range: ReportRange, singleDay: boolean): string {
  const end = singleDay ? inclusiveEndDate(range) : new Date(range.toExclusive);
  return `${formatDate(new Date(range.from))} – ${formatDate(end)}`;
}
function formatExpiryDate(value: string): string { return new Date(`${value}T00:00:00`).toLocaleDateString(); }
function formatDays(days: number): string { if (days < 0) return `${Math.abs(days)} day(s) overdue`; if (days === 0) return 'expires today'; return `${days} day(s) remaining`; }

const styles = StyleSheet.create({
  container: { padding: spacing.xl }, link: { color: colors.primary, fontWeight: '700' }, title: { color: colors.text, fontSize: 32, fontWeight: '700', marginTop: spacing.lg },
  subtitle: { color: colors.textMuted, marginTop: spacing.xs },
  todayButton: { alignItems: 'center', backgroundColor: colors.primary, borderRadius: 10, marginTop: spacing.md, paddingVertical: spacing.md },
  todayText: { color: '#fff', fontWeight: '700' },
  controlRow: { alignItems: 'center', flexDirection: 'row', gap: spacing.sm, marginTop: spacing.md },
  stepper: { alignItems: 'center', backgroundColor: colors.surface, borderColor: colors.border, borderRadius: 10, borderWidth: 1, flexDirection: 'row', flex: 2 },
  stepButton: { paddingHorizontal: spacing.md, paddingVertical: spacing.sm },
  stepText: { color: colors.primary, fontSize: 20, fontWeight: '700' },
  stepDisabled: { opacity: 0.35 },
  amountInput: { color: colors.text, flex: 1, fontSize: 16, fontWeight: '700', paddingVertical: spacing.sm, textAlign: 'center' },
  unitDropdown: { flex: 1 },
  typeDropdown: { marginTop: spacing.md, width: '100%' },
  dropdown: { alignItems: 'center', backgroundColor: colors.surface, borderColor: colors.border, borderRadius: 10, borderWidth: 1, flexDirection: 'row', justifyContent: 'space-between', paddingHorizontal: spacing.md, paddingVertical: spacing.md },
  dropdownText: { color: colors.text, flex: 1, fontSize: 14, fontWeight: '700' },
  dropdownChevron: { color: colors.textMuted, fontSize: 14, marginLeft: spacing.xs },
  dropdownBackdrop: { backgroundColor: 'rgba(0,0,0,0.45)', flex: 1, justifyContent: 'center', padding: spacing.xl },
  dropdownCard: { backgroundColor: colors.surface, borderColor: colors.border, borderRadius: 12, borderWidth: 1, paddingVertical: spacing.xs },
  dropdownList: { maxHeight: 340 },
  dropdownOption: { paddingHorizontal: spacing.md, paddingVertical: spacing.md },
  dropdownOptionActive: { backgroundColor: colors.primary },
  dropdownOptionText: { color: colors.text, fontWeight: '600' },
  dropdownOptionTextActive: { color: '#fff' },
  loader: { marginTop: spacing.xl }, error: { color: '#B42318', marginTop: spacing.lg },
  rangeCard: { backgroundColor: colors.surface, borderColor: colors.border, borderRadius: 12, borderWidth: 1, marginTop: spacing.md, padding: spacing.md },
  dateFields: { flexDirection: 'row', gap: spacing.sm }, dateField: { borderColor: colors.border, borderRadius: 10, borderWidth: 1, flex: 1, padding: spacing.md },
  dateLabel: { color: colors.textMuted, fontSize: 11, fontWeight: '700' }, dateValue: { color: colors.text, fontWeight: '700', marginTop: spacing.xs },
  pickerPanel: { marginTop: spacing.sm }, doneButton: { alignSelf: 'flex-end', paddingHorizontal: spacing.md, paddingVertical: spacing.sm }, doneText: { color: colors.primary, fontWeight: '700' },
  rangeActions: { flexDirection: 'row', gap: spacing.sm, justifyContent: 'flex-end', marginTop: spacing.md },
  applyButton: { backgroundColor: colors.primary, borderRadius: 10, paddingHorizontal: spacing.lg, paddingVertical: spacing.sm }, applyText: { color: '#fff', fontWeight: '700' },
  activeRange: { color: colors.textMuted, fontSize: 12, marginTop: spacing.sm },
  offline: { color: '#9A6700', marginTop: spacing.md }, grid: { flexDirection: 'row', gap: spacing.sm, marginTop: spacing.xl }, metric: { backgroundColor: colors.surface, borderColor: colors.border, borderRadius: 12, borderWidth: 1, flex: 1, padding: spacing.md },
  metricValue: { color: colors.text, fontSize: 22, fontWeight: '700' }, meta: { color: colors.textMuted, fontSize: 11, marginTop: spacing.xs }, section: { color: colors.text, fontSize: 18, fontWeight: '700', marginTop: spacing.xl },
  card: { backgroundColor: colors.surface, borderColor: colors.border, borderRadius: 12, borderWidth: 1, marginTop: spacing.md, padding: spacing.md }, row: { flexDirection: 'row', justifyContent: 'space-between' },
  cardTitle: { color: colors.text, flex: 1, fontWeight: '700' }, type: { color: colors.primary, fontSize: 11, fontWeight: '700' }, danger: { color: '#B42318' }, body: { color: colors.textMuted, lineHeight: 20, marginTop: spacing.xs },
  exportActions: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm, marginTop: spacing.md }, exportButton: { flex: 1, marginTop: 0, minWidth: 130 },
  toggleRow: { alignItems: 'center', flexDirection: 'row', justifyContent: 'space-between', marginTop: spacing.md }, toggleLabel: { color: colors.text, flex: 1, fontWeight: '700', paddingRight: spacing.md }, outline: { alignItems: 'center', borderColor: colors.primary, borderRadius: 12, borderWidth: 1, marginTop: spacing.xl, padding: spacing.md }, outlineText: { color: colors.primary, fontWeight: '700' },
  settingsCard: { backgroundColor: colors.surface, borderColor: colors.border, borderRadius: 12, borderWidth: 1, marginTop: spacing.xl, padding: spacing.md }, settingField: { flex: 1 }, settingInput: { borderColor: colors.border, borderRadius: 10, borderWidth: 1, color: colors.text, fontSize: 18, marginTop: spacing.xs, padding: spacing.sm }, saveButton: { alignItems: 'center', marginTop: spacing.md }, disabled: { opacity: 0.6 },
});
