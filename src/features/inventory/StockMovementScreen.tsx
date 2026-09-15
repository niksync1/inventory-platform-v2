import { useEffect, useState } from 'react';
import { ActivityIndicator, KeyboardAvoidingView, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { createOperationId } from '../../core/inventory/operationId';
import { validateQuantity } from '../../core/inventory/quantity';
import { colors, spacing } from '../../shared/theme';
import { useTenant } from '../tenancy/TenantProvider';
import { loadProductDetail, stockIn, stockOut, type ProductDetail } from './inventoryApi';

type StockOutReason = 'SALE' | 'DAMAGE' | 'EXPIRED' | 'ADJUSTMENT';
const REASONS: StockOutReason[] = ['SALE', 'DAMAGE', 'EXPIRED', 'ADJUSTMENT'];

export function StockMovementScreen({ productId, type, onBack, onSuccess }: { productId: string; type: 'in' | 'out'; onBack: () => void; onSuccess: () => void }) {
  const { context, locations } = useTenant(); const [product, setProduct] = useState<ProductDetail | null>(null); const [quantity, setQuantity] = useState(''); const [remarks, setRemarks] = useState(''); const [reason, setReason] = useState<StockOutReason>('SALE'); const [submitting, setSubmitting] = useState(false); const [error, setError] = useState<string | null>(null);
  const location = locations.find(item => item.id === context?.locationId);
  useEffect(() => { if (!context) return; void loadProductDetail(context.tenant.id, context.locationId, productId).then(setProduct).catch(caught => setError(caught instanceof Error ? caught.message : 'Unable to load product.')); }, [context, productId]);

  async function submit() {
    if (!context || !product || submitting) return;
    const checked = validateQuantity(quantity); if (!checked.valid) { setError(checked.reason); return; }
    if (type === 'out' && checked.quantity > product.locationQuantity) { setError(`Only ${product.locationQuantity} units are available at ${location?.name}.`); return; }
    setSubmitting(true); setError(null);
    const common = { tenantId: context.tenant.id, locationId: context.locationId, productId, quantity: checked.quantity, remarks: remarks.trim() || undefined, operationId: createOperationId() };
    try { if (type === 'in') await stockIn(common); else await stockOut({ ...common, transactionType: reason }); onSuccess(); }
    catch (caught) { setError(caught instanceof Error ? caught.message : 'The stock movement failed.'); }
    finally { setSubmitting(false); }
  }

  return <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={styles.screen}><ScrollView contentContainerStyle={styles.container} keyboardShouldPersistTaps="handled"><Pressable onPress={onBack}><Text style={styles.link}>‹ Product</Text></Pressable><Text style={styles.eyebrow}>{type === 'in' ? 'STOCK IN' : 'STOCK OUT'}</Text><Text style={styles.title}>{product?.name ?? 'Loading product…'}</Text><Text style={styles.meta}>{location?.name}{product ? ` · ${product.locationQuantity} units available` : ''}</Text>
    {!product && !error ? <ActivityIndicator color={colors.primary} style={styles.loader} /> : null}
    {product ? <><Text style={styles.label}>Quantity</Text><TextInput autoFocus keyboardType="number-pad" maxLength={9} onChangeText={setQuantity} placeholder="0" style={styles.input} value={quantity} />
      {type === 'out' ? <><Text style={styles.label}>Reason</Text><View style={styles.reasons}>{REASONS.map(item => <Pressable key={item} onPress={() => setReason(item)} style={[styles.reason, reason === item && styles.reasonActive]}><Text style={[styles.reasonText, reason === item && styles.reasonTextActive]}>{item.charAt(0) + item.slice(1).toLowerCase()}</Text></Pressable>)}</View></> : null}
      <Text style={styles.label}>Remarks (optional)</Text><TextInput multiline onChangeText={setRemarks} placeholder={type === 'in' ? 'Supplier or delivery note' : 'Reference or explanation'} style={[styles.input, styles.remarks]} value={remarks} />
      {error ? <Text style={styles.error}>{error}</Text> : null}<Pressable disabled={submitting} onPress={() => void submit()} style={[styles.submit, submitting && styles.disabled]}>{submitting ? <ActivityIndicator color="#fff" /> : <Text style={styles.submitText}>Confirm {type === 'in' ? 'stock in' : 'stock out'}</Text>}</Pressable></> : error ? <Text style={styles.error}>{error}</Text> : null}
  </ScrollView></KeyboardAvoidingView>;
}
const styles = StyleSheet.create({ screen: { flex: 1 }, container: { padding: spacing.xl }, link: { color: colors.primary, fontWeight: '700' }, eyebrow: { color: colors.primary, fontSize: 12, fontWeight: '700', letterSpacing: 1.5, marginTop: spacing.xl }, title: { color: colors.text, fontSize: 28, fontWeight: '700', marginTop: spacing.sm }, meta: { color: colors.textMuted, marginTop: spacing.sm }, loader: { marginTop: spacing.xl }, label: { color: colors.text, fontWeight: '700', marginBottom: spacing.sm, marginTop: spacing.xl }, input: { backgroundColor: colors.surface, borderColor: colors.border, borderRadius: 12, borderWidth: 1, fontSize: 18, padding: spacing.md }, remarks: { minHeight: 96, textAlignVertical: 'top' }, reasons: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm }, reason: { borderColor: colors.border, borderRadius: 20, borderWidth: 1, paddingHorizontal: spacing.md, paddingVertical: spacing.sm }, reasonActive: { backgroundColor: colors.primary, borderColor: colors.primary }, reasonText: { color: colors.textMuted }, reasonTextActive: { color: '#fff', fontWeight: '700' }, error: { color: '#B42318', marginTop: spacing.md }, submit: { alignItems: 'center', backgroundColor: colors.primary, borderRadius: 12, marginTop: spacing.xl, padding: spacing.md }, disabled: { opacity: 0.6 }, submitText: { color: '#fff', fontWeight: '700' } });
