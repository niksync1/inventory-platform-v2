import { StatusBar } from 'expo-status-bar';
import { SafeAreaView, StyleSheet, Text, View } from 'react-native';

import { colors, spacing } from './src/shared/theme';

export default function App() {
  return (
    <SafeAreaView style={styles.screen}>
      <StatusBar style="dark" />
      <View style={styles.content}>
        <Text style={styles.eyebrow}>INVENTORY PLATFORM</Text>
        <Text style={styles.title}>A clean foundation is ready.</Text>
        <Text style={styles.body}>
          Authentication, inventory, offline sync, and reporting will be rebuilt as
          isolated features against the existing Supabase data.
        </Text>
        <View style={styles.card}>
          <Text style={styles.cardTitle}>Foundation milestone</Text>
          <Text style={styles.cardBody}>
            Expo SDK 57 · strict TypeScript · validated quantities · automated CI
          </Text>
        </View>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: colors.background,
  },
  content: {
    flex: 1,
    justifyContent: 'center',
    padding: spacing.xl,
  },
  eyebrow: {
    color: colors.primary,
    fontSize: 12,
    fontWeight: '700',
    letterSpacing: 1.6,
    marginBottom: spacing.sm,
  },
  title: {
    color: colors.text,
    fontSize: 34,
    fontWeight: '700',
    lineHeight: 40,
  },
  body: {
    color: colors.textMuted,
    fontSize: 16,
    lineHeight: 24,
    marginTop: spacing.md,
  },
  card: {
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderRadius: 16,
    borderWidth: 1,
    marginTop: spacing.xl,
    padding: spacing.lg,
  },
  cardTitle: {
    color: colors.text,
    fontSize: 16,
    fontWeight: '700',
  },
  cardBody: {
    color: colors.textMuted,
    lineHeight: 21,
    marginTop: spacing.xs,
  },
});
