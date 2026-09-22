import { useEffect, useState } from 'react';
import DateTimePicker, { type DateTimePickerEvent } from '@react-native-community/datetimepicker';
import { ActivityIndicator, KeyboardAvoidingView, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { createOperationId } from '../../core/inventory/operationId';
import { validateQuantity } from '../../core/inventory/quantity';
import { colors, spacing } from '../../shared/theme';
import { useTenant } from '../tenancy/TenantProvider';
import { loadProductDetail, stockIn, stockOutBatch, stockOutSale, type ProductDetail } from './inventoryApi';

type StockOutReason = 'SALE' | 'DAMAGE' | 'EXPIRED' | 'ADJUSTMENT';
const REASONS: StockOutReason[] = ['SALE', 'DAMAGE', 'EXPIRED', 'ADJUSTMENT'];

export function StockMovementScreen({ productId, type, onBack, onSuccess }: { productId: string; type: 'in' | 'out'; onBack: () => void; onSuccess: () => void }) {
  const { context, locations } = useTenant(); const [product, setProduct] = useState<ProductDetail | null>(null); const [quantity, setQuantity] = useState(''); const [batchNumber, setBatchNumber] = useState(''); const [expiryDate, setExpiryDate] = useState(defaultExpiryDate); const [showExpiryPicker, setShowExpiryPicker] = useState(false); const [remarks, setRemarks] = useState(''); const [reason, setReason] = useState<StockOutReason>('SALE'); const [selectedBatchId, setSelectedBatchId] = useState<string | null>(null); const [submitting, setSubmitting] = useState(false); const [error, setError] = useState<string | null>(null);
  const location = locations.find(item => item.id === context?.locationId);
  useEffect(() => { if (!context) return; void loadProductDetail(context.tenant.id, context.locationId, productId).then(setProduct).catch(caught => setError(caught instanceof Error ? caught.message : 'Unable to load product.')); }, [context, productId]);

  async function submit() {
    if (!context || !product || submitting) return;
    const checked = validateQuantity(quantity); if (!checked.valid) { setError(checked.reason); return; }
    const selectedBatch = product.batches.find(batch => batch.id === selectedBatchId);
    if (type === 'out' && reason === 'SALE' && checked.quantity > product.locationQuantity) { setError(`Only ${product.locationQuantity} units are available at ${location?.name}.`); return; }
    if (type === 'out' && reason !== 'SALE' && !selectedBatch) { setError('Select the physical batch affected by this operation.'); return; }
    if (type === 'out' && selectedBatch && checked.quantity > selectedBatch.quantity) { setError(`Only ${selectedBatch.quantity} units are available in batch ${selectedBatch.batchNumber}.`); return; }
    if (type === 'out' && reason !== 'SALE' && remarks.trim().length < 3) { setError('Enter a reason of at least 3 characters.'); return; }
    if (type === 'in' && !batchNumber.trim()) { setError('Enter the supplier batch or lot number.'); return; }
    setSubmitting(true); setError(null);
    const common = { tenantId: context.tenant.id, locationId: context.locationId, productId, quantity: checked.quantity, remarks: remarks.trim() || undefined, operationId: createOperationId() };
    try {
      if (type === 'in') await stockIn({ ...common, batchNumber: batchNumber.trim(), expiryDate: toIsoDate(expiryDate) });
      else if (reason === 'SALE') await stockOutSale(common);
      else await stockOutBatch({ ...common, batchId: selectedBatchId!, transactionType: reason, remarks: remarks.trim() });
      onSuccess();
    }
    catch (caught) { setError(caught instanceof Error ? caught.message : 'The stock movement failed.'); }
    finally { setSubmitting(false); }
  }

  return <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={styles.screen}><ScrollView contentContainerStyle={styles.container} keyboardShouldPersistTaps="handled"><Pressable onPress={onBack}><Text style={styles.link}>‹ Product</Text></Pressable><Text style={styles.eyebrow}>{type === 'in' ? 'STOCK IN' : 'STOCK OUT'}</Text><Text style={styles.title}>{product?.name ?? 'Loading product…'}</Text><Text style={styles.meta}>{location?.name}{product ? ` · ${product.locationQuantity} units available` : ''}</Text>
    {!product && !error ? <ActivityIndicator color={colors.primary} style={styles.loader} /> : null}
    {product ? <><Text style={styles.label}>Quantity</Text><TextInput autoFocus keyboardType="number-pad" maxLength={9} onChangeText={setQuantity} placeholder="0" style={styles.input} value={quantity} />
      {type === 'in' ? <><Text style={styles.label}>Batch / lot number</Text><TextInput autoCapitalize="characters" maxLength={120} onChangeText={setBatchNumber} placeholder="e.g. LOT-2026-041" style={styles.input} value={batchNumber} />
        <Text style={styles.label}>Expiry date</Text><Pressable accessibilityRole="button" onPress={() => setShowExpiryPicker(true)} style={styles.input}><Text style={styles.dateValue}>{expiryDate.toLocaleDateString(undefined, { day: '2-digit', month: 'short', year: 'numeric' })}</Text></Pressable>
        {showExpiryPicker ? <View style={styles.pickerPanel}><DateTimePicker display={Platform.OS === 'ios' ? 'inline' : 'default'} minimumDate={startOfToday()} mode="date" onChange={(event: DateTimePickerEvent, date?: Date) => { if (Platform.OS === 'android') setShowExpiryPicker(false); if (event.type !== 'dismissed' && date) setExpiryDate(date); }} value={expiryDate} />{Platform.OS === 'ios' ? <Pressable onPress={() => setShowExpiryPicker(false)} style={styles.doneButton}><Text style={styles.link}>Done</Text></Pressable> : null}</View> : null}</> : null}
      {type === 'out' ? <><Text style={styles.label}>Reason</Text><View style={styles.reasons}>{REASONS.map(item => <Pressable key={item} onPress={() => { setReason(item); setSelectedBatchId(null); setError(null); }} style={[styles.reason, reason === item && styles.reasonActive]}><Text style={[styles.reasonText, reason === item && styles.reasonTextActive]}>{item.charAt(0) + item.slice(1).toLowerCase()}</Text></Pressable>)}</View></> : null}
      {type === 'out' && reason === 'SALE' ? <Text style={styles.fefoNote}>Sales are automatically issued from the earliest-expiring batches first.</Text> : null}
      {type === 'out' && reason !== 'SALE' ? <><Text style={styles.label}>Affected batch</Text>{eligibleBatches(product, reason).map(batch => <Pressable key={batch.id} onPress={() => setSelectedBatchId(batch.id)} style={[styles.batchOption, selectedBatchId === batch.id && styles.batchOptionActive]}><View><Text style={styles.batchTitle}>{batch.batchNumber}</Text><Text style={styles.batchMeta}>{batch.expiryDate ? `Expires ${formatExpiry(batch.expiryDate)}` : 'Expiry untracked'}</Text></View><Text style={styles.batchQuantity}>{batch.quantity}</Text></Pressable>)}{!eligibleBatches(product, reason).length ? <Text style={styles.fefoNote}>{reason === 'EXPIRED' ? 'No expired batches are currently available.' : 'No batches are available.'}</Text> : null}</> : null}
      <Text style={styles.label}>Remarks {type === 'out' && reason !== 'SALE' ? '(required)' : '(optional)'}</Text><TextInput multiline onChangeText={setRemarks} placeholder={type === 'in' ? 'Supplier or delivery note' : reason === 'SALE' ? 'Reference or explanation' : 'Describe why this batch is affected'} style={[styles.input, styles.remarks]} value={remarks} />
      {error ? <Text style={styles.error}>{error}</Text> : null}<Pressable disabled={submitting} onPress={() => void submit()} style={[styles.submit, submitting && styles.disabled]}>{submitting ? <ActivityIndicator color="#fff" /> : <Text style={styles.submitText}>Confirm {type === 'in' ? 'stock in' : 'stock out'}</Text>}</Pressable></> : error ? <Text style={styles.error}>{error}</Text> : null}
  </ScrollView></KeyboardAvoidingView>;
}
function startOfToday() { const value = new Date(); value.setHours(0, 0, 0, 0); return value; }
function defaultExpiryDate() { const value = startOfToday(); value.setFullYear(value.getFullYear() + 1); return value; }
function toIsoDate(value: Date) { const year = value.getFullYear(); const month = String(value.getMonth() + 1).padStart(2, '0'); const day = String(value.getDate()).padStart(2, '0'); return `${year}-${month}-${day}`; }
function eligibleBatches(product: ProductDetail, reason: StockOutReason) { return reason === 'EXPIRED' ? product.batches.filter(batch => batch.expiryStatus === 'expired') : product.batches; }
function formatExpiry(value: string) { return new Date(`${value}T00:00:00`).toLocaleDateString(); }
const styles = StyleSheet.create({ screen: { flex: 1 }, container: { padding: spacing.xl }, link: { color: colors.primary, fontWeight: '700' }, eyebrow: { color: colors.primary, fontSize: 12, fontWeight: '700', letterSpacing: 1.5, marginTop: spacing.xl }, title: { color: colors.text, fontSize: 28, fontWeight: '700', marginTop: spacing.sm }, meta: { color: colors.textMuted, marginTop: spacing.sm }, loader: { marginTop: spacing.xl }, label: { color: colors.text, fontWeight: '700', marginBottom: spacing.sm, marginTop: spacing.xl }, input: { backgroundColor: colors.surface, borderColor: colors.border, borderRadius: 12, borderWidth: 1, fontSize: 18, padding: spacing.md }, dateValue: { color: colors.text, fontSize: 18 }, pickerPanel: { marginTop: spacing.sm }, doneButton: { alignSelf: 'flex-end', padding: spacing.sm }, fefoNote: { color: colors.textMuted, fontSize: 12, lineHeight: 18, marginTop: spacing.md }, batchOption: { alignItems: 'center', backgroundColor: colors.surface, borderColor: colors.border, borderRadius: 12, borderWidth: 1, flexDirection: 'row', justifyContent: 'space-between', marginBottom: spacing.sm, padding: spacing.md }, batchOptionActive: { borderColor: colors.primary, borderWidth: 2 }, batchTitle: { color: colors.text, fontWeight: '700' }, batchMeta: { color: colors.textMuted, fontSize: 12, marginTop: spacing.xs }, batchQuantity: { color: colors.primary, fontSize: 18, fontWeight: '700' }, remarks: { minHeight: 96, textAlignVertical: 'top' }, reasons: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm }, reason: { borderColor: colors.border, borderRadius: 20, borderWidth: 1, paddingHorizontal: spacing.md, paddingVertical: spacing.sm }, reasonActive: { backgroundColor: colors.primary, borderColor: colors.primary }, reasonText: { color: colors.textMuted }, reasonTextActive: { color: '#fff', fontWeight: '700' }, error: { color: '#B42318', marginTop: spacing.md }, submit: { alignItems: 'center', backgroundColor: colors.primary, borderRadius: 12, marginTop: spacing.xl, padding: spacing.md }, disabled: { opacity: 0.6 }, submitText: { color: '#fff', fontWeight: '700' } });
