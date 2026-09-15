import { useState } from 'react';
import { ActivityIndicator, SafeAreaView, StyleSheet } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { AuthProvider, useAuth } from './src/features/auth/AuthProvider';
import { SignInScreen } from './src/features/auth/SignInScreen';
import { HomeScreen } from './src/features/home/HomeScreen';
import { BarcodeScannerScreen } from './src/features/inventory/BarcodeScannerScreen';
import { InventoryScreen } from './src/features/inventory/InventoryScreen';
import { ProductDetailScreen } from './src/features/inventory/ProductDetailScreen';
import { StockMovementScreen } from './src/features/inventory/StockMovementScreen';
import { findProductByBarcode } from './src/features/inventory/inventoryApi';
import { TenantProvider, useTenant } from './src/features/tenancy/TenantProvider';
import { TenantSelectionScreen } from './src/features/tenancy/TenantSelectionScreen';
import { colors } from './src/shared/theme';

type Route = { name: 'home' } | { name: 'inventory' } | { name: 'scanner' } | { name: 'product'; productId: string } | { name: 'movement'; productId: string; type: 'in' | 'out' };

export default function App() { return <AuthProvider><SafeAreaView style={styles.screen}><StatusBar style="dark" /><AppContent /></SafeAreaView></AuthProvider>; }
function AppContent() { const { session, loading } = useAuth(); if (loading) return <ActivityIndicator color={colors.primary} style={styles.loader} />; if (!session) return <SignInScreen />; return <TenantProvider key={session.user.id}><AuthenticatedApp /></TenantProvider>; }

function AuthenticatedApp() {
  const { loading, context } = useTenant(); const [choosing, setChoosing] = useState(false); const [route, setRoute] = useState<Route>({ name: 'home' }); const [refreshKey, setRefreshKey] = useState(0);
  if (loading) return <ActivityIndicator color={colors.primary} style={styles.loader} />;
  if (!context || choosing) return <TenantSelectionScreen onDone={() => { setChoosing(false); setRoute({ name: 'home' }); }} />;
  if (route.name === 'inventory') return <InventoryScreen onBack={() => setRoute({ name: 'home' })} onProduct={productId => setRoute({ name: 'product', productId })} onScan={() => setRoute({ name: 'scanner' })} />;
  if (route.name === 'scanner') return <BarcodeScannerScreen onBack={() => setRoute({ name: 'inventory' })} onBarcode={async barcode => { const product = await findProductByBarcode(context.tenant.id, context.locationId, barcode); if (!product) return false; setRoute({ name: 'product', productId: product.id }); return true; }} />;
  if (route.name === 'product') return <ProductDetailScreen productId={route.productId} refreshKey={refreshKey} onBack={() => setRoute({ name: 'inventory' })} onMove={type => setRoute({ name: 'movement', productId: route.productId, type })} />;
  if (route.name === 'movement') return <StockMovementScreen productId={route.productId} type={route.type} onBack={() => setRoute({ name: 'product', productId: route.productId })} onSuccess={() => { setRefreshKey(value => value + 1); setRoute({ name: 'product', productId: route.productId }); }} />;
  return <HomeScreen onChangeContext={() => setChoosing(true)} onInventory={() => setRoute({ name: 'inventory' })} />;
}

const styles = StyleSheet.create({ screen: { backgroundColor: colors.background, flex: 1 }, loader: { flex: 1 } });
