import { useCallback, useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, Alert, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { canAcknowledgeAlerts } from '../../core/tenancy/permissions';
import { colors, spacing } from '../../shared/theme';
import { useTenant } from '../tenancy/TenantProvider';
import { acknowledgeAlert, listAlerts, type AlertStatus, type InventoryAlert } from './alertsApi';

export function AlertsScreen({ onBack }: { onBack: () => void }) {
  const { context, locations } = useTenant();
  const [status, setStatus] = useState<AlertStatus>('active');
  const [alerts, setAlerts] = useState<InventoryAlert[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const location = useMemo(() => locations.find(item => item.id === context?.locationId), [context, locations]);
  const reload = useCallback(async () => {
    if (!context) return;
    setLoading(true); setError(null);
    try { setAlerts(await listAlerts(context.tenant.id, context.locationId, status)); }
    catch (caught) { setError(caught instanceof Error ? caught.message : 'Unable to load alerts.'); }
    finally { setLoading(false); }
  }, [context, status]);
  useEffect(() => { void reload(); }, [reload]);
  if (!context) return null;
  const mayAcknowledge = canAcknowledgeAlerts(context.membership.role);
  const acknowledge = async (id: string) => {
    try { await acknowledgeAlert(id); await reload(); }
    catch (caught) { Alert.alert('Unable to acknowledge alert', caught instanceof Error ? caught.message : 'Please try again.'); }
  };
  return <ScrollView contentContainerStyle={styles.container}>
    <Pressable onPress={onBack}><Text style={styles.link}>← Back</Text></Pressable>
    <Text style={styles.title}>Alerts</Text><Text style={styles.subtitle}>{context.tenant.name} · {location?.name}</Text>
    <View style={styles.tabs}><Tab label="Active" active={status === 'active'} onPress={() => setStatus('active')} /><Tab label="Acknowledged" active={status === 'acknowledged'} onPress={() => setStatus('acknowledged')} /></View>
    {loading ? <ActivityIndicator color={colors.primary} style={styles.loader} /> : null}{error ? <Text style={styles.error}>{error}</Text> : null}
    {!loading && !alerts.length ? <Text style={styles.empty}>No {status} alerts for this location.</Text> : null}
    {alerts.map(item => <View key={item.id} style={styles.card}>
      <View style={styles.row}><Text style={styles.cardTitle}>{item.type.replaceAll('_', ' ')}</Text><Text style={[styles.severity, item.severity === 'critical' && styles.critical]}>{item.severity.toUpperCase()}</Text></View>
      <Text style={styles.body}>{item.message}</Text><Text style={styles.body}>{new Date(item.triggeredAt).toLocaleString()}</Text>
      {item.quantity !== null ? <Text style={styles.body}>Quantity: {item.quantity}{item.threshold !== null ? ` · Threshold: ${item.threshold}` : ''}</Text> : null}
      {status === 'active' && mayAcknowledge ? <Pressable style={styles.button} onPress={() => void acknowledge(item.id)}><Text style={styles.buttonText}>Acknowledge</Text></Pressable> : null}
    </View>)}
  </ScrollView>;
}
function Tab({ label, active, onPress }: { label: string; active: boolean; onPress: () => void }) { return <Pressable onPress={onPress} style={[styles.tab, active && styles.tabActive]}><Text style={[styles.tabText, active && styles.tabTextActive]}>{label}</Text></Pressable>; }
const styles = StyleSheet.create({
  container: { padding: spacing.xl }, link: { color: colors.primary, fontWeight: '700' }, title: { color: colors.text, fontSize: 32, fontWeight: '700', marginTop: spacing.lg }, subtitle: { color: colors.textMuted, marginTop: spacing.xs },
  tabs: { flexDirection: 'row', gap: spacing.sm, marginTop: spacing.lg }, tab: { borderColor: colors.border, borderRadius: 20, borderWidth: 1, paddingHorizontal: spacing.md, paddingVertical: spacing.sm }, tabActive: { backgroundColor: colors.primary, borderColor: colors.primary },
  tabText: { color: colors.textMuted, fontWeight: '700' }, tabTextActive: { color: '#fff' }, loader: { marginTop: spacing.xl }, error: { color: '#B42318', marginTop: spacing.lg }, empty: { color: colors.textMuted, marginTop: spacing.xl },
  card: { backgroundColor: colors.surface, borderColor: colors.border, borderRadius: 12, borderWidth: 1, marginTop: spacing.md, padding: spacing.md }, row: { flexDirection: 'row', justifyContent: 'space-between' },
  cardTitle: { color: colors.text, fontWeight: '700' }, severity: { color: '#9A6700', fontSize: 11, fontWeight: '700' }, critical: { color: '#B42318' }, body: { color: colors.textMuted, lineHeight: 20, marginTop: spacing.xs },
  button: { alignItems: 'center', backgroundColor: colors.primary, borderRadius: 10, marginTop: spacing.md, padding: spacing.sm }, buttonText: { color: '#fff', fontWeight: '700' },
});
