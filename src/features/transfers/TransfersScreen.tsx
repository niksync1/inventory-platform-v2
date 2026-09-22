import { useCallback, useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, Alert, Pressable, RefreshControl, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { createOperationId } from '../../core/inventory/operationId';
import { validateQuantity } from '../../core/inventory/quantity';
import { canManageTransfers, canReceiveTransfers } from '../../core/tenancy/permissions';
import { colors, spacing } from '../../shared/theme';
import { useTenant } from '../tenancy/TenantProvider';
import { cancelTransfer, dispatchTransfer, listTransfers, receiveTransfer, type InventoryTransfer } from './transfersApi';

type Action = { transferId: string; type: 'receive' | 'cancel' } | null;

export function TransfersScreen({ onBack }: { onBack: () => void }) {
  const { context, locations } = useTenant();
  const [transfers, setTransfers] = useState<InventoryTransfer[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [action, setAction] = useState<Action>(null);
  const [quantity, setQuantity] = useState('');
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const location = useMemo(() => locations.find(item => item.id === context?.locationId), [context, locations]);
  const load = useCallback(async () => {
    if (!context) return;
    setError(null);
    try { setTransfers(await listTransfers(context.tenant.id, context.locationId)); }
    catch (caught) { setError(caught instanceof Error ? caught.message : 'Unable to load transfers.'); }
    finally { setLoading(false); setRefreshing(false); }
  }, [context]);
  useEffect(() => { void load(); }, [load]);
  if (!context) return null;
  const mayManage = canManageTransfers(context.membership.role);
  const mayReceive = canReceiveTransfers(context.membership.role);

  function confirmDispatch(transfer: InventoryTransfer) {
    Alert.alert('Dispatch transfer?', `${transfer.quantityRequested} unit(s) will leave ${transfer.sourceLocationName} and remain in transit until received.`, [
      { text: 'Keep draft', style: 'cancel' },
      { text: 'Dispatch', onPress: () => void run(transfer.id, () => dispatchTransfer(transfer.id, createOperationId())) },
    ]);
  }

  async function run(id: string, operation: () => Promise<void>) {
    if (busyId) return;
    setBusyId(id); setError(null);
    try { await operation(); setAction(null); setQuantity(''); setReason(''); await load(); }
    catch (caught) { setError(caught instanceof Error ? caught.message : 'The transfer action failed.'); }
    finally { setBusyId(null); }
  }

  function submitReceive(transfer: InventoryTransfer) {
    const checked = validateQuantity(quantity);
    if (!checked.valid) { setError(checked.reason); return; }
    if (checked.quantity > transfer.quantityOutstanding) { setError(`Only ${transfer.quantityOutstanding} unit(s) remain in transit.`); return; }
    void run(transfer.id, () => receiveTransfer(transfer.id, checked.quantity, createOperationId()));
  }

  function submitCancel(transfer: InventoryTransfer) {
    if (reason.trim().length < 3) { setError('Enter a cancellation reason of at least 3 characters.'); return; }
    void run(transfer.id, () => cancelTransfer(transfer.id, reason.trim(), createOperationId()));
  }

  return <ScrollView contentContainerStyle={styles.container} refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); void load(); }} />}>
    <Pressable onPress={onBack}><Text style={styles.link}>← Back</Text></Pressable>
    <Text style={styles.title}>Transfers</Text><Text style={styles.subtitle}>{context.tenant.name} · {location?.name}</Text>
    <Text style={styles.intro}>Outgoing stock leaves this location when dispatched. Incoming stock becomes available only after receipt.</Text>
    {loading ? <ActivityIndicator color={colors.primary} style={styles.loader} /> : null}{error ? <Text style={styles.error}>{error}</Text> : null}
    {!loading && !transfers.length ? <Text style={styles.empty}>No transfers involve this location yet.</Text> : null}
    {transfers.map(transfer => {
      const outgoing = transfer.sourceLocationId === context.locationId;
      const incoming = transfer.destinationLocationId === context.locationId;
      const canDispatch = mayManage && outgoing && transfer.status === 'draft';
      const canReceive = mayReceive && incoming && (transfer.status === 'dispatched' || transfer.status === 'partially_received');
      const canCancel = mayManage && outgoing && ['draft', 'dispatched', 'partially_received'].includes(transfer.status);
      return <View key={transfer.id} style={styles.card}>
        <View style={styles.row}><Text style={styles.reference}>{transfer.reference}</Text><Text style={[styles.status, statusStyle(transfer.status)]}>{transfer.status.replaceAll('_', ' ').toUpperCase()}</Text></View>
        <Text style={styles.product}>{transfer.productName}</Text><Text style={styles.body}>Batch {transfer.batchNumber}{transfer.expiryDate ? ` · Expires ${formatDate(transfer.expiryDate)}` : ''}</Text>
        <Text style={styles.body}>{transfer.sourceLocationName} → {transfer.destinationLocationName}</Text>
        <Text style={styles.body}>Requested {transfer.quantityRequested} · Dispatched {transfer.quantityDispatched} · Received {transfer.quantityReceived}</Text>
        <Text style={styles.direction}>{outgoing ? 'OUTGOING' : 'INCOMING'}{transfer.quantityOutstanding > 0 && transfer.status !== 'draft' ? ` · ${transfer.quantityOutstanding} in transit` : ''}</Text>
        {transfer.remarks ? <Text style={styles.body}>{transfer.remarks}</Text> : null}
        {canDispatch ? <Pressable disabled={busyId === transfer.id} onPress={() => confirmDispatch(transfer)} style={styles.primary}><Text style={styles.primaryText}>{busyId === transfer.id ? 'Dispatching…' : 'Dispatch'}</Text></Pressable> : null}
        {canReceive ? <Pressable onPress={() => { setAction({ transferId: transfer.id, type: 'receive' }); setQuantity(String(transfer.quantityOutstanding)); setReason(''); }} style={styles.outline}><Text style={styles.outlineText}>Receive stock</Text></Pressable> : null}
        {canCancel ? <Pressable onPress={() => { setAction({ transferId: transfer.id, type: 'cancel' }); setReason(''); setQuantity(''); }} style={styles.cancel}><Text style={styles.cancelText}>Cancel outstanding transfer</Text></Pressable> : null}
        {action?.transferId === transfer.id && action.type === 'receive' ? <View style={styles.actionPanel}><Text style={styles.actionLabel}>Quantity received now</Text><TextInput keyboardType="number-pad" onChangeText={setQuantity} style={styles.input} value={quantity} /><Pressable disabled={busyId === transfer.id} onPress={() => submitReceive(transfer)} style={styles.primary}><Text style={styles.primaryText}>{busyId === transfer.id ? 'Receiving…' : 'Confirm receipt'}</Text></Pressable></View> : null}
        {action?.transferId === transfer.id && action.type === 'cancel' ? <View style={styles.actionPanel}><Text style={styles.actionLabel}>Cancellation reason</Text><TextInput multiline onChangeText={setReason} placeholder="Why is this transfer being cancelled?" style={[styles.input, styles.reasonInput]} value={reason} /><Pressable disabled={busyId === transfer.id} onPress={() => submitCancel(transfer)} style={styles.cancelConfirm}><Text style={styles.primaryText}>{busyId === transfer.id ? 'Cancelling…' : 'Confirm cancellation'}</Text></Pressable></View> : null}
      </View>;
    })}
  </ScrollView>;
}

function formatDate(value: string) { return new Date(`${value}T00:00:00`).toLocaleDateString(); }
function statusStyle(status: InventoryTransfer['status']) { if (status === 'received') return styles.success; if (status === 'cancelled') return styles.danger; if (status === 'partially_received') return styles.warning; return styles.info; }
const styles = StyleSheet.create({ container: { padding: spacing.xl }, link: { color: colors.primary, fontWeight: '700' }, title: { color: colors.text, fontSize: 32, fontWeight: '700', marginTop: spacing.lg }, subtitle: { color: colors.textMuted, marginTop: spacing.xs }, intro: { color: colors.textMuted, lineHeight: 20, marginTop: spacing.md }, loader: { marginTop: spacing.xl }, error: { color: '#B42318', marginTop: spacing.md }, empty: { color: colors.textMuted, marginTop: spacing.xl }, card: { backgroundColor: colors.surface, borderColor: colors.border, borderRadius: 14, borderWidth: 1, marginTop: spacing.md, padding: spacing.md }, row: { alignItems: 'center', flexDirection: 'row', justifyContent: 'space-between' }, reference: { color: colors.text, fontWeight: '700' }, status: { fontSize: 10, fontWeight: '700' }, success: { color: colors.primary }, danger: { color: '#B42318' }, warning: { color: '#9A6700' }, info: { color: '#175CD3' }, product: { color: colors.text, fontSize: 17, fontWeight: '700', marginTop: spacing.md }, body: { color: colors.textMuted, lineHeight: 19, marginTop: spacing.xs }, direction: { color: colors.primary, fontSize: 11, fontWeight: '700', marginTop: spacing.sm }, primary: { alignItems: 'center', backgroundColor: colors.primary, borderRadius: 10, marginTop: spacing.md, padding: spacing.sm }, primaryText: { color: '#fff', fontWeight: '700' }, outline: { alignItems: 'center', borderColor: colors.primary, borderRadius: 10, borderWidth: 1, marginTop: spacing.sm, padding: spacing.sm }, outlineText: { color: colors.primary, fontWeight: '700' }, cancel: { alignItems: 'center', marginTop: spacing.sm, padding: spacing.sm }, cancelText: { color: '#B42318', fontWeight: '700' }, actionPanel: { borderTopColor: colors.border, borderTopWidth: 1, marginTop: spacing.md, paddingTop: spacing.md }, actionLabel: { color: colors.text, fontWeight: '700', marginBottom: spacing.sm }, input: { backgroundColor: colors.background, borderColor: colors.border, borderRadius: 10, borderWidth: 1, color: colors.text, fontSize: 17, padding: spacing.md }, reasonInput: { minHeight: 80, textAlignVertical: 'top' }, cancelConfirm: { alignItems: 'center', backgroundColor: '#B42318', borderRadius: 10, marginTop: spacing.md, padding: spacing.sm } });
