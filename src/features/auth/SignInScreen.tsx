import { useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { colors, spacing } from '../../shared/theme';
import { supabase } from '../../shared/supabase';
export function SignInScreen() {
  const [email, setEmail] = useState(''); const [password, setPassword] = useState(''); const [submitting, setSubmitting] = useState(false); const [error, setError] = useState<string | null>(null);
  async function signIn() { setSubmitting(true); setError(null); const result = await supabase.auth.signInWithPassword({ email: email.trim(), password }); if (result.error) setError(result.error.message); setSubmitting(false); }
  return <View style={styles.container}>
    <Text style={styles.eyebrow}>INVENTORY PLATFORM</Text><Text style={styles.title}>Welcome back</Text><Text style={styles.subtitle}>Sign in to your business inventory.</Text>
    <TextInput autoCapitalize="none" autoComplete="email" keyboardType="email-address" placeholder="Email" style={styles.input} value={email} onChangeText={setEmail} />
    <TextInput autoCapitalize="none" autoComplete="current-password" placeholder="Password" secureTextEntry style={styles.input} value={password} onChangeText={setPassword} />
    {error ? <Text style={styles.error}>{error}</Text> : null}
    <Pressable disabled={submitting || !email.trim() || !password} onPress={() => void signIn()} style={[styles.button, (submitting || !email.trim() || !password) && styles.disabled]}>{submitting ? <ActivityIndicator color="#fff" /> : <Text style={styles.buttonText}>Sign in</Text>}</Pressable>
  </View>;
}
const styles = StyleSheet.create({ container: { flex: 1, justifyContent: 'center', padding: spacing.xl }, eyebrow: { color: colors.primary, fontSize: 12, fontWeight: '700', letterSpacing: 1.6 }, title: { color: colors.text, fontSize: 34, fontWeight: '700', marginTop: spacing.sm }, subtitle: { color: colors.textMuted, fontSize: 16, marginBottom: spacing.lg, marginTop: spacing.sm }, input: { backgroundColor: colors.surface, borderColor: colors.border, borderRadius: 12, borderWidth: 1, fontSize: 16, marginTop: spacing.md, padding: spacing.md }, error: { color: '#B42318', marginTop: spacing.md }, button: { alignItems: 'center', backgroundColor: colors.primary, borderRadius: 12, justifyContent: 'center', marginTop: spacing.lg, minHeight: 52 }, buttonText: { color: '#fff', fontWeight: '700' }, disabled: { opacity: 0.5 } });
