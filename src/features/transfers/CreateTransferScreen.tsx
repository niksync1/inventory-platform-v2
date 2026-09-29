import { useEffect, useState } from 'react';
import { ActivityIndicator, Alert, KeyboardAvoidingView, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { createOperationId } from '../../core/inventory/operationId';
import { validateQuantity } from '../../core/inventory/quantity';
import { colors, spacing } from '../../shared/theme';
import { useAuth } from '../auth/AuthProvider';
import { loadProductDetail, type ProductDetail } from '../inventory/inventoryApi';
import { useOfflineSync } from '../offline/OfflineSyncProvider';
import { useTenant } from '../tenancy/TenantProvider';
import { listTransferDestinations, type TransferDestination } from './transfersApi';

export function CreateTransferScreen({ productId, batchId, onBack, onSuccess }: { productId: string; batchId: string; onBack: () => void; onSuccess: () => void }) {
  const { session } = useAuth(); const { submit: submitOfflineOperation } = useOfflineSync();
  const { context, locations } = useTenant();
  const [product, setProduct] = useState<ProductDetail | null>(null);
  const [destinations, setDestinations] = useState<TransferDestination[]>([]);
  const [destinationId, setDestinationId] = useState<string | null>(null);
  const [quantity, setQuantity] = useState('');
  const [remarks, setRemarks] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const source = locations.find(item => item.id === context?.locationId);
  const batch = product?.batches.find(item => item.id === batchId);

  useEffect(() => {
    if (!context) return;
    setError(null);
    void Promise.all([
      loadProductDetail(context.tenant.id, context.locationId, productId),
      listTransferDestinations(context.tenant.id, context.locationId),
    ]).then(([nextProduct, nextDestinations]) => {
      setProduct(nextProduct); setDestinations(nextDestinations);
    }).catch(caught => setError(caught instanceof Error ? caught.message : 'Unable to prepare this transfer.'));
  }, [batchId, context, productId]);

  async function submit() {
    if (!context || !session || !batch || !destinationId || submitting) return;
    const checked = validateQuantity(quantity);
    if (!checked.valid) { setError(checked.reason); return; }
    if (checked.quantity > batch.quantity) { setError(`Only ${batch.quantity} units are available in this batch.`); return; }
    setSubmitting(true); setError(null);
    try {
      const result = await submitOfflineOperation({ id: createOperationId(), userId: session.user.id, tenantId: context.tenant.id, locationId: context.locationId, productId, kind: 'transfer_create', payload: { destinationLocationId: destinationId, batchId, quantity: checked.quantity, remarks: remarks.trim() || null } });
      if (result === 'queued') Alert.alert('Saved offline', 'The draft transfer will be created automatically when the connection returns.');
      onSuccess();
    } catch (caught) { setError(caught instanceof Error ? caught.message : 'Unable to create the transfer.'); }
    finally { setSubmitting(false); }
  }

  if (!context) return null;
  return <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={styles.screen}><ScrollView contentContainerStyle={styles.container} keyboardShouldPersistTaps="handled">
    <Pressable onPress={onBack}><Text style={styles.link}>‹ Product</Text></Pressable>
    <Text style={styles.eyebrow}>NEW TRANSFER</Text><Text style={styles.title}>{product?.name ?? 'Loading product…'}</Text>
    <Text style={styles.meta}>{source?.name}{batch ? ` · ${batch.batchNumber} · ${batch.quantity} available` : ''}</Text>
    {!product && !error ? <ActivityIndicator color={colors.primary} style={styles.loader} /> : null}
    {batch ? <><Text style={styles.label}>Destination</Text>{destinations.map(item => <Pressable key={item.id} onPress={() => setDestinationId(item.id)} style={[styles.option, destinationId === item.id && styles.optionActive]}><View><Text style={styles.optionTitle}>{item.name}</Text><Text style={styles.optionMeta}>{item.code}</Text></View><Text style={styles.chevron}>{destinationId === item.id ? '✓' : '›'}</Text></Pressable>)}
      {!destinations.length ? <Text style={styles.meta}>No other active locations are available.</Text> : null}
      <Text style={styles.label}>Quantity</Text><TextInput keyboardType="number-pad" maxLength={9} onChangeText={setQuantity} placeholder="0" style={styles.input} value={quantity} />
      <Text style={styles.label}>Remarks (optional)</Text><TextInput multiline onChangeText={setRemarks} placeholder="Reason or delivery reference" style={[styles.input, styles.remarks]} value={remarks} />
      <Text style={styles.note}>Creating this transfer does not move stock. Review and dispatch the draft from the Transfers screen.</Text>
      {error ? <Text style={styles.error}>{error}</Text> : null}<Pressable disabled={submitting || !destinationId} onPress={() => void submit()} style={[styles.submit, (submitting || !destinationId) && styles.disabled]}>{submitting ? <ActivityIndicator color="#fff" /> : <Text style={styles.submitText}>Create draft transfer</Text>}</Pressable></> : error ? <Text style={styles.error}>{error}</Text> : null}
  </ScrollView></KeyboardAvoidingView>;
}

const styles = StyleSheet.create({ screen: { flex: 1 }, container: { padding: spacing.xl }, link: { color: colors.primary, fontWeight: '700' }, eyebrow: { color: colors.primary, fontSize: 12, fontWeight: '700', letterSpacing: 1.5, marginTop: spacing.xl }, title: { color: colors.text, fontSize: 28, fontWeight: '700', marginTop: spacing.sm }, meta: { color: colors.textMuted, marginTop: spacing.sm }, loader: { marginTop: spacing.xl }, label: { color: colors.text, fontWeight: '700', marginBottom: spacing.sm, marginTop: spacing.xl }, option: { alignItems: 'center', backgroundColor: colors.surface, borderColor: colors.border, borderRadius: 12, borderWidth: 1, flexDirection: 'row', justifyContent: 'space-between', marginBottom: spacing.sm, padding: spacing.md }, optionActive: { borderColor: colors.primary, borderWidth: 2 }, optionTitle: { color: colors.text, fontWeight: '700' }, optionMeta: { color: colors.textMuted, fontSize: 12, marginTop: spacing.xs }, chevron: { color: colors.primary, fontSize: 20, fontWeight: '700' }, input: { backgroundColor: colors.surface, borderColor: colors.border, borderRadius: 12, borderWidth: 1, fontSize: 18, padding: spacing.md }, remarks: { minHeight: 90, textAlignVertical: 'top' }, note: { color: colors.textMuted, fontSize: 12, lineHeight: 18, marginTop: spacing.md }, error: { color: '#B42318', marginTop: spacing.md }, submit: { alignItems: 'center', backgroundColor: colors.primary, borderRadius: 12, marginTop: spacing.xl, padding: spacing.md }, submitText: { color: '#fff', fontWeight: '700' }, disabled: { opacity: 0.55 } });
