import { useState } from 'react';
import { ActivityIndicator, SafeAreaView, StyleSheet } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { AuthProvider, useAuth } from './src/features/auth/AuthProvider';
import { SignInScreen } from './src/features/auth/SignInScreen';
import { HomeScreen } from './src/features/home/HomeScreen';
import { AlertsScreen } from './src/features/alerts/AlertsScreen';
import { ReportsScreen } from './src/features/reports/ReportsScreen';
import { BarcodeScannerScreen } from './src/features/inventory/BarcodeScannerScreen';
import { InventoryScreen } from './src/features/inventory/InventoryScreen';
import { ProductDetailScreen } from './src/features/inventory/ProductDetailScreen';
import { StockMovementScreen } from './src/features/inventory/StockMovementScreen';
import { CreateTransferScreen } from './src/features/transfers/CreateTransferScreen';
import { TransfersScreen } from './src/features/transfers/TransfersScreen';
import { findProductByBarcode } from './src/features/inventory/inventoryApi';
import { TenantProvider, useTenant } from './src/features/tenancy/TenantProvider';
import { TenantSelectionScreen } from './src/features/tenancy/TenantSelectionScreen';
import { colors } from './src/shared/theme';

type Route = { name: 'home' } | { name: 'reports' } | { name: 'alerts' } | { name: 'transfers' } | { name: 'inventory' } | { name: 'scanner' } | { name: 'product'; productId: string } | { name: 'movement'; productId: string; type: 'in' | 'out' } | { name: 'transfer-create'; productId: string; batchId: string };

export default function App() {
  return <AuthProvider><SafeAreaView style={styles.screen}><StatusBar style="dark" /><AppContent /></SafeAreaView></AuthProvider>;
}

function AppContent() {
  const { session, loading } = useAuth();
  if (loading) return <ActivityIndicator color={colors.primary} style={styles.loader} />;
  if (!session) return <SignInScreen />;
  return <TenantProvider key={session.user.id}><AuthenticatedApp /></TenantProvider>;
}

function AuthenticatedApp() {
  const { loading, context } = useTenant();
  const { signOut } = useAuth();
  const [choosing, setChoosing] = useState(false);
  const [route, setRoute] = useState<Route>({ name: 'home' });
  const [refreshKey, setRefreshKey] = useState(0);

  const resetNavigation = () => {
    setChoosing(false);
    setRefreshKey(0);
    setRoute({ name: 'home' });
  };

  if (loading) return <ActivityIndicator color={colors.primary} style={styles.loader} />;
  if (!context || choosing) {
    return <TenantSelectionScreen onDone={() => {
      setChoosing(false);
      setRoute({ name: 'home' });
    }} />;
  }

  if (route.name === 'reports') return <ReportsScreen onBack={() => setRoute({ name: 'home' })} />;
  if (route.name === 'alerts') return <AlertsScreen onBack={() => setRoute({ name: 'home' })} />;
  if (route.name === 'transfers') return <TransfersScreen onBack={() => setRoute({ name: 'home' })} />;
  if (route.name === 'inventory') {
    return <InventoryScreen onBack={() => setRoute({ name: 'home' })} onProduct={productId => setRoute({ name: 'product', productId })} onScan={() => setRoute({ name: 'scanner' })} />;
  }
  if (route.name === 'scanner') {
    return <BarcodeScannerScreen onBack={() => setRoute({ name: 'inventory' })} onBarcode={async barcode => {
      const product = await findProductByBarcode(context.tenant.id, context.locationId, barcode);
      if (!product) return false;
      setRoute({ name: 'product', productId: product.id });
      return true;
    }} />;
  }
  if (route.name === 'product') {
    return <ProductDetailScreen productId={route.productId} refreshKey={refreshKey} onBack={() => setRoute({ name: 'inventory' })} onMove={type => setRoute({ name: 'movement', productId: route.productId, type })} onTransfer={batchId => setRoute({ name: 'transfer-create', productId: route.productId, batchId })} />;
  }
  if (route.name === 'transfer-create') {
    return <CreateTransferScreen productId={route.productId} batchId={route.batchId} onBack={() => setRoute({ name: 'product', productId: route.productId })} onSuccess={() => setRoute({ name: 'transfers' })} />;
  }
  if (route.name === 'movement') {
    return <StockMovementScreen productId={route.productId} type={route.type} onBack={() => setRoute({ name: 'product', productId: route.productId })} onSuccess={() => {
      setRefreshKey(value => value + 1);
      setRoute({ name: 'product', productId: route.productId });
    }} />;
  }

  return <HomeScreen
    onChangeContext={() => {
      setRoute({ name: 'home' });
      setChoosing(true);
    }}
    onInventory={() => setRoute({ name: 'inventory' })}
    onReports={() => setRoute({ name: 'reports' })}
    onAlerts={() => setRoute({ name: 'alerts' })}
    onTransfers={() => setRoute({ name: 'transfers' })}
    onSignOut={async () => {
      resetNavigation();
      await signOut();
    }}
  />;
}

const styles = StyleSheet.create({ screen: { backgroundColor: colors.background, flex: 1 }, loader: { flex: 1 } });
