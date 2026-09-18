import { useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, TextInput } from 'react-native';
import { colors, spacing } from '../../shared/theme';
import { supabase } from '../../shared/supabase';

export function SignInScreen() {
  const [mode, setMode] = useState<'sign-in' | 'sign-up'>('sign-in');
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  async function submit() {
    setSubmitting(true); setError(null); setMessage(null);
    try {
      if (mode === 'sign-in') {
        const result = await supabase.auth.signInWithPassword({ email: email.trim(), password });
        if (result.error) throw result.error;
      } else {
        const result = await supabase.auth.signUp({
          email: email.trim(),
          password,
          options: { data: { name: name.trim() } },
        });
        if (result.error) throw result.error;
        if (!result.data.session) {
          setMessage('Check your email and verify your account, then return here to sign in.');
          setMode('sign-in'); setPassword('');
        }
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Unable to continue.');
    } finally { setSubmitting(false); }
  }

  const disabled = submitting || !email.trim() || password.length < 8 || (mode === 'sign-up' && !name.trim());

  return <ScrollView contentContainerStyle={styles.container} keyboardShouldPersistTaps="handled">
    <Text style={styles.eyebrow}>INVENTORY PLATFORM</Text>
    <Text style={styles.title}>{mode === 'sign-in' ? 'Welcome back' : 'Create your account'}</Text>
    <Text style={styles.subtitle}>{mode === 'sign-in' ? 'Sign in to your business inventory.' : 'Verify your email before creating a business trial.'}</Text>
    {mode === 'sign-up' ? <TextInput autoComplete="name" maxLength={100} placeholder="Full name" style={styles.input} value={name} onChangeText={setName} /> : null}
    <TextInput autoCapitalize="none" autoComplete="email" keyboardType="email-address" placeholder="Email" style={styles.input} value={email} onChangeText={setEmail} />
    <TextInput autoCapitalize="none" autoComplete={mode === 'sign-in' ? 'current-password' : 'new-password'} placeholder="Password (minimum 8 characters)" secureTextEntry style={styles.input} value={password} onChangeText={setPassword} />
    {error ? <Text style={styles.error}>{error}</Text> : null}
    {message ? <Text style={styles.message}>{message}</Text> : null}
    <Pressable disabled={disabled} onPress={() => void submit()} style={[styles.button, disabled && styles.disabled]}>{submitting ? <ActivityIndicator color="#fff" /> : <Text style={styles.buttonText}>{mode === 'sign-in' ? 'Sign in' : 'Create account'}</Text>}</Pressable>
    <Pressable disabled={submitting} onPress={() => { setMode(value => value === 'sign-in' ? 'sign-up' : 'sign-in'); setError(null); setMessage(null); }}><Text style={styles.switch}>{mode === 'sign-in' ? 'New here? Create an account' : 'Already registered? Sign in'}</Text></Pressable>
  </ScrollView>;
}

const styles = StyleSheet.create({ container: { flexGrow: 1, justifyContent: 'center', padding: spacing.xl }, eyebrow: { color: colors.primary, fontSize: 12, fontWeight: '700', letterSpacing: 1.6 }, title: { color: colors.text, fontSize: 34, fontWeight: '700', marginTop: spacing.sm }, subtitle: { color: colors.textMuted, fontSize: 16, marginBottom: spacing.lg, marginTop: spacing.sm }, input: { backgroundColor: colors.surface, borderColor: colors.border, borderRadius: 12, borderWidth: 1, fontSize: 16, marginTop: spacing.md, padding: spacing.md }, error: { color: '#B42318', marginTop: spacing.md }, message: { color: '#067647', marginTop: spacing.md }, button: { alignItems: 'center', backgroundColor: colors.primary, borderRadius: 12, justifyContent: 'center', marginTop: spacing.lg, minHeight: 52 }, buttonText: { color: '#fff', fontWeight: '700' }, disabled: { opacity: 0.5 }, switch: { color: colors.primary, fontWeight: '700', marginTop: spacing.lg, textAlign: 'center' } });
