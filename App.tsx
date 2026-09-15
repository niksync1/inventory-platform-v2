import { useState } from 'react';
import { ActivityIndicator, SafeAreaView, StyleSheet } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { AuthProvider, useAuth } from './src/features/auth/AuthProvider';
import { SignInScreen } from './src/features/auth/SignInScreen';
import { HomeScreen } from './src/features/home/HomeScreen';
import { TenantProvider, useTenant } from './src/features/tenancy/TenantProvider';
import { TenantSelectionScreen } from './src/features/tenancy/TenantSelectionScreen';
import { colors } from './src/shared/theme';
export default function App() { return <AuthProvider><SafeAreaView style={styles.screen}><StatusBar style="dark" /><AppContent /></SafeAreaView></AuthProvider>; }
function AppContent() { const { session, loading } = useAuth(); if (loading) return <ActivityIndicator color={colors.primary} style={styles.loader} />; if (!session) return <SignInScreen />; return <TenantProvider key={session.user.id}><AuthenticatedApp /></TenantProvider>; }
function AuthenticatedApp() { const { loading, context } = useTenant(); const [choosing, setChoosing] = useState(false); if (loading) return <ActivityIndicator color={colors.primary} style={styles.loader} />; if (!context || choosing) return <TenantSelectionScreen onDone={() => setChoosing(false)} />; return <HomeScreen onChangeContext={() => setChoosing(true)} />; }
const styles = StyleSheet.create({ screen: { backgroundColor: colors.background, flex: 1 }, loader: { flex: 1 } });
