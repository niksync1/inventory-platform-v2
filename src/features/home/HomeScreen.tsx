import { Ionicons } from '@expo/vector-icons';
import { useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, Alert, Linking, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { canManageInventory, canOpenAdminDashboard } from '../../core/tenancy/permissions';
import { colors, spacing } from '../../shared/theme';
import { useAuth } from '../auth/AuthProvider';
import { countActiveAlerts } from '../alerts/alertsApi';
import { loadInventorySummary, type InventorySummary } from '../inventory/inventoryApi';
import { useTenant } from '../tenancy/TenantProvider';
import { useOfflineSync } from '../offline/OfflineSyncProvider';

interface HomeScreenProps {
  onChangeContext: () => void;
  onInventory: () => void;
  onReports: () => void;
  onAlerts: () => void;
  onTransfers: () => void;
  onOfflineSync: () => void;
  onNotifications: () => void;
  onSignOut: () => Promise<void>;
}

export function HomeScreen({ onChangeContext, onInventory, onReports, onAlerts, onTransfers, onOfflineSync, onNotifications, onSignOut }: HomeScreenProps) {
  const { session } = useAuth();
  const { context, locations } = useTenant();
  const { pendingCount, failedCount, syncing } = useOfflineSync();
  const [summary, setSummary] = useState<InventorySummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [signingOut, setSigningOut] = useState(false);
  const [activeAlerts, setActiveAlerts] = useState(0);
  const location = useMemo(() => locations.find(item => item.id === context?.locationId), [context, locations]);
  const profileName = useMemo(() => {
    const candidate = session?.user.user_metadata?.full_name ?? session?.user.user_metadata?.name;
    return typeof candidate === 'string' && candidate.trim() ? candidate.trim() : session?.user.email ?? 'Signed-in user';
  }, [session]);
  const dashboardUrl = process.env.EXPO_PUBLIC_ADMIN_DASHBOARD_URL?.trim();

  useEffect(() => {
    if (!context) return;
    setSummary(null);
    setError(null);
    void loadInventorySummary(context.tenant.id, context.locationId)
      .then(setSummary)
      .catch(caught => setError(caught instanceof Error ? caught.message : 'Unable to load inventory.'));
    void countActiveAlerts(context.tenant.id, context.locationId).then(setActiveAlerts).catch(() => setActiveAlerts(0));
  }, [context]);

  if (!context) return null;

  const openAdminDashboard = async () => {
    if (!dashboardUrl) return;
    const canOpen = await Linking.canOpenURL(dashboardUrl);
    if (!canOpen) {
      Alert.alert('Dashboard unavailable', 'The administrator dashboard link is not available on this device.');
      return;
    }
    await Linking.openURL(dashboardUrl);
  };

  const handleSignOut = async () => {
    if (signingOut) return;
    setSigningOut(true);
    try {
      await onSignOut();
    } catch (caught) {
      Alert.alert('Unable to sign out', caught instanceof Error ? caught.message : 'Please try again.');
      setSigningOut(false);
    }
  };

  const isOwner = canOpenAdminDashboard(context.membership.role);

  return <ScrollView contentContainerStyle={styles.container}>
    <Text style={styles.eyebrow}>ACTIVE PROFILE</Text>
    <View style={styles.profileCard}>
      <Text style={styles.profileName}>{profileName}</Text>
      {session?.user.email && session.user.email !== profileName ? <Text style={styles.email}>{session.user.email}</Text> : null}
      <Text style={styles.role}>{context.membership.role.toUpperCase()}</Text>
    </View>

    <Text style={styles.eyebrow}>CURRENT WORKSPACE</Text>
    <Text style={styles.title}>{context.tenant.name}</Text>
    <Text style={styles.subtitle}>{location?.name} · {context.membership.role}</Text>
    <Pressable accessibilityRole="button" onPress={onChangeContext} style={styles.menuItem}>
      <Text style={styles.menuLabel}>Change business or location</Text>
      <Text style={styles.menuMeta}>Selected context is retained while you navigate.</Text>
    </Pressable>

    <View style={styles.grid}>
      <Metric label="Products" value={summary?.products} />
      <Metric label="Units here" value={summary?.unitsAtLocation} />
      <Metric label="Transactions" value={summary?.transactionsAtLocation} />
    </View>
    {!summary && !error ? <ActivityIndicator color={colors.primary} style={styles.loader} /> : null}
    {error ? <Text style={styles.error}>{error}</Text> : null}

    <Text style={styles.sectionTitle}>MENU</Text>
    <View style={styles.menuGrid}>
      <MenuAction icon="cube-outline" title="Inventory" onPress={onInventory} primary={canManageInventory(context.membership.role)} />
      <MenuAction icon="bar-chart-outline" title="Reports" onPress={onReports} />
      <MenuAction icon="notifications-outline" title={activeAlerts ? 'Alerts (' + activeAlerts + ')' : 'Alerts'} onPress={onAlerts} />
      <MenuAction icon="swap-horizontal-outline" title="Transfers" onPress={onTransfers} />
      <MenuAction icon="cloud-offline-outline" title={pendingCount || failedCount ? 'Offline sync (' + (pendingCount + failedCount) + ')' : 'Offline sync'} onPress={onOfflineSync} />
      <MenuAction icon="settings-outline" title="Notifications" onPress={onNotifications} />
      {isOwner && dashboardUrl ? <MenuAction icon="shield-checkmark-outline" title="Admin dashboard" onPress={() => void openAdminDashboard()} /> : null}
    </View>

    <View style={styles.card}>
      <Text style={styles.cardTitle}>Tenant isolation active</Text>
      <Text style={styles.cardBody}>Data is scoped to {context.tenant.slug} and {location?.code}.</Text>
    </View>

    <Pressable accessibilityRole="button" disabled={signingOut} onPress={() => void handleSignOut()} style={[styles.signOut, signingOut && styles.disabled]}>
      <Text style={styles.signOutText}>{signingOut ? 'Signing out…' : 'Sign out'}</Text>
    </Pressable>
  </ScrollView>;
}

function Metric({ label, value }: { label: string; value: number | undefined }) {
  return <View style={styles.metric}><Text style={styles.metricValue}>{value ?? '—'}</Text><Text style={styles.meta}>{label}</Text></View>;
}

function MenuAction({ icon, title, onPress, primary = false }: { icon: React.ComponentProps<typeof Ionicons>['name']; title: string; onPress: () => void; primary?: boolean }) {
  return <Pressable accessibilityRole="button" onPress={onPress} style={[styles.menuAction, primary && styles.menuActionPrimary]}>
    <Ionicons name={icon} size={28} color={primary ? '#fff' : colors.primary} />
    <Text style={[styles.menuActionText, primary && styles.menuActionTextPrimary]} numberOfLines={2}>{title}</Text>
  </Pressable>;
}

const styles = StyleSheet.create({
  container: { padding: spacing.xl },
  eyebrow: { color: colors.primary, fontSize: 12, fontWeight: '700', letterSpacing: 1.5, marginTop: spacing.lg },
  profileCard: { backgroundColor: colors.surface, borderColor: colors.border, borderRadius: 16, borderWidth: 1, marginTop: spacing.sm, padding: spacing.lg },
  profileName: { color: colors.text, fontSize: 18, fontWeight: '700' },
  email: { color: colors.textMuted, marginTop: spacing.xs },
  role: { color: colors.primary, fontSize: 12, fontWeight: '700', letterSpacing: 1, marginTop: spacing.sm },
  title: { color: colors.text, fontSize: 32, fontWeight: '700', marginTop: spacing.sm },
  subtitle: { color: colors.textMuted, fontSize: 16, marginTop: spacing.xs },
  menuItem: { borderBottomColor: colors.border, borderBottomWidth: 1, marginTop: spacing.md, paddingBottom: spacing.md },
  menuLabel: { color: colors.primary, fontWeight: '700' },
  menuMeta: { color: colors.textMuted, fontSize: 12, marginTop: spacing.xs },
  grid: { flexDirection: 'row', gap: spacing.sm, marginTop: spacing.xl },
  metric: { backgroundColor: colors.surface, borderColor: colors.border, borderRadius: 12, borderWidth: 1, flex: 1, padding: spacing.md },
  metricValue: { color: colors.text, fontSize: 24, fontWeight: '700' },
  meta: { color: colors.textMuted, fontSize: 12, marginTop: spacing.xs },
  loader: { marginTop: spacing.lg },
  error: { color: '#B42318', marginTop: spacing.md },
  sectionTitle: { color: colors.text, fontSize: 16, fontWeight: '700', marginTop: spacing.xl },
  menuGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm, marginTop: spacing.md },
  menuAction: { alignItems: 'center', backgroundColor: colors.surface, borderColor: colors.border, borderRadius: 14, borderWidth: 1, flexBasis: '48%', flexGrow: 1, justifyContent: 'center', minHeight: 108, padding: spacing.md },
  menuActionPrimary: { backgroundColor: colors.primary, borderColor: colors.primary },
  menuActionText: { color: colors.text, fontSize: 14, fontWeight: '700', marginTop: spacing.sm, textAlign: 'center' },
  menuActionTextPrimary: { color: '#fff' },
  primary: { alignItems: 'center', backgroundColor: colors.primary, borderRadius: 12, marginTop: spacing.md, padding: spacing.md },
  primaryText: { color: '#fff', fontWeight: '700' },
  primaryMeta: { color: '#fff', fontSize: 12, marginTop: spacing.xs, opacity: 0.85, textAlign: 'center' },
  outline: { alignItems: 'center', borderColor: colors.primary, borderRadius: 12, borderWidth: 1, marginTop: spacing.md, padding: spacing.md },
  outlineText: { color: colors.primary, fontWeight: '700' },
  outlineMeta: { color: colors.textMuted, fontSize: 12, marginTop: spacing.xs, textAlign: 'center' },
  card: { backgroundColor: colors.surface, borderColor: colors.border, borderRadius: 16, borderWidth: 1, marginTop: spacing.xl, padding: spacing.lg },
  cardTitle: { color: colors.text, fontSize: 16, fontWeight: '700' },
  cardBody: { color: colors.textMuted, lineHeight: 21, marginTop: spacing.sm },
  signOut: { alignItems: 'center', borderColor: colors.primary, borderRadius: 12, borderWidth: 1, marginTop: spacing.xl, padding: spacing.md },
  signOutText: { color: colors.primary, fontWeight: '700' },
  disabled: { opacity: 0.55 },
});
