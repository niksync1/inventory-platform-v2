import { useMemo, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { createTenantRequestId } from '../../core/tenancy/requestId';
import { colors, spacing } from '../../shared/theme';
import { useTenant } from './TenantProvider';

export function TenantSelectionScreen({ onDone }: { onDone?: () => void }) {
  const { accesses, locations, context, choose, createTenant, error: loadError, reload } = useTenant();
  const [tenantId, setTenantId] = useState(context?.tenant.id ?? accesses[0]?.tenant.id ?? '');
  const [locationId, setLocationId] = useState(context?.locationId ?? '');
  const [businessName, setBusinessName] = useState('');
  const [businessType, setBusinessType] = useState('');
  const [locationName, setLocationName] = useState('');
  const [locationAddress, setLocationAddress] = useState('');
  const [requestId, setRequestId] = useState(() => createTenantRequestId());
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const available = useMemo(() => locations.filter(location => location.tenantId === tenantId), [locations, tenantId]);

  async function selectContext() {
    const selected = locationId || available[0]?.id;
    if (!tenantId || !selected) return;
    setSubmitting(true); setError(null);
    try { await choose(tenantId, selected); onDone?.(); }
    catch (caught) { setError(caught instanceof Error ? caught.message : 'Unable to select location.'); }
    finally { setSubmitting(false); }
  }

  async function createBusiness() {
    if (!businessName.trim() || !businessType.trim() || !locationName.trim()) {
      setError('Complete all required fields.');
      return;
    }
    setSubmitting(true); setError(null);
    try {
      await createTenant({ businessName: businessName.trim(), businessType: businessType.trim(), countryCode: 'GH', timezone: 'Africa/Accra', firstLocationName: locationName.trim(), firstLocationAddress: locationAddress.trim() || undefined, idempotencyKey: requestId });
      setRequestId(createTenantRequestId());
    } catch (caught) { setError(caught instanceof Error ? caught.message : 'Unable to create business.'); }
    finally { setSubmitting(false); }
  }

  const creationDisabled = submitting || !businessName.trim() || !businessType.trim() || !locationName.trim();

  return <ScrollView contentContainerStyle={styles.container} keyboardShouldPersistTaps="handled">
    <Text style={styles.eyebrow}>WORKSPACE</Text>
    <Text style={styles.title}>{accesses.length ? 'Choose where you are working' : 'Create your first business'}</Text>
    {loadError ? <View><Text style={styles.error}>{loadError}</Text><Pressable onPress={() => void reload()}><Text style={styles.link}>Try again</Text></Pressable></View> : null}
    {accesses.map(access => <Pressable key={access.tenant.id} onPress={() => { setTenantId(access.tenant.id); setLocationId(''); }} style={[styles.option, tenantId === access.tenant.id && styles.selected]}><Text style={styles.optionTitle}>{access.tenant.name}</Text><Text style={styles.meta}>{access.membership.role} · {access.tenant.plan}</Text></Pressable>)}
    {available.length ? <Text style={styles.label}>Warehouse / location</Text> : null}
    {available.map(location => <Pressable key={location.id} onPress={() => setLocationId(location.id)} style={[styles.option, (locationId || available[0]?.id) === location.id && styles.selected]}><Text style={styles.optionTitle}>{location.name}</Text><Text style={styles.meta}>{location.code}</Text></Pressable>)}
    {accesses.length
      ? <Pressable disabled={submitting || !available.length} onPress={() => void selectContext()} style={[styles.button, (!available.length || submitting) && styles.disabled]}>{submitting ? <ActivityIndicator color="#fff" /> : <Text style={styles.buttonText}>Continue</Text>}</Pressable>
      : <View>
          <Text style={styles.intro}>Create your inventory workspace and start a secure 14-day trial. You will become the business owner.</Text>
          <Text style={styles.label}>Business name *</Text>
          <TextInput maxLength={120} placeholder="Example Pharmacy" value={businessName} onChangeText={setBusinessName} style={styles.input} />
          <Text style={styles.label}>Business type *</Text>
          <TextInput autoCapitalize="none" maxLength={60} placeholder="Pharmacy, retail, distributor…" value={businessType} onChangeText={setBusinessType} style={styles.input} />
          <Text style={styles.label}>First location name *</Text>
          <TextInput maxLength={120} placeholder="Accra" value={locationName} onChangeText={setLocationName} style={styles.input} />
          <Text style={styles.label}>Location address</Text>
          <TextInput maxLength={250} placeholder="Optional" value={locationAddress} onChangeText={setLocationAddress} style={styles.input} />
          <Text style={styles.fixed}>Country: Ghana · Timezone: Africa/Accra</Text>
          <Pressable disabled={creationDisabled} onPress={() => void createBusiness()} style={[styles.button, creationDisabled && styles.disabled]}>{submitting ? <ActivityIndicator color="#fff" /> : <Text style={styles.buttonText}>Create business and start trial</Text>}</Pressable>
        </View>}
    {error ? <Text style={styles.error}>{error}</Text> : null}
  </ScrollView>;
}

const styles = StyleSheet.create({ container: { padding: spacing.xl }, eyebrow: { color: colors.primary, fontSize: 12, fontWeight: '700', letterSpacing: 1.5 }, title: { color: colors.text, fontSize: 30, fontWeight: '700', marginBottom: spacing.lg, marginTop: spacing.sm }, intro: { color: colors.textMuted, lineHeight: 21, marginBottom: spacing.sm }, option: { backgroundColor: colors.surface, borderColor: colors.border, borderRadius: 12, borderWidth: 1, marginBottom: spacing.sm, padding: spacing.md }, selected: { borderColor: colors.primary, borderWidth: 2 }, optionTitle: { color: colors.text, fontSize: 16, fontWeight: '700' }, meta: { color: colors.textMuted, marginTop: spacing.xs }, label: { color: colors.text, fontWeight: '700', marginBottom: spacing.sm, marginTop: spacing.md }, input: { backgroundColor: colors.surface, borderColor: colors.border, borderRadius: 12, borderWidth: 1, fontSize: 16, padding: spacing.md }, fixed: { color: colors.textMuted, fontSize: 12, marginTop: spacing.md }, button: { alignItems: 'center', backgroundColor: colors.primary, borderRadius: 12, justifyContent: 'center', marginTop: spacing.lg, minHeight: 52 }, buttonText: { color: '#fff', fontWeight: '700' }, disabled: { opacity: 0.5 }, error: { color: '#B42318', marginTop: spacing.md }, link: { color: colors.primary, fontWeight: '700', marginTop: spacing.sm } });
