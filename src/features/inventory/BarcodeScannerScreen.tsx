import { useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import { CameraView, useCameraPermissions, type BarcodeScanningResult } from 'expo-camera';
import { colors, spacing } from '../../shared/theme';

export function BarcodeScannerScreen({ onBack, onBarcode }: { onBack: () => void; onBarcode: (barcode: string) => Promise<boolean> }) {
  const [permission, requestPermission] = useCameraPermissions();
  const [scanning, setScanning] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  async function handleScan(result: BarcodeScanningResult) {
    if (scanning) return;
    setScanning(true); setMessage(null);
    try {
      const found = await onBarcode(result.data);
      if (!found) setMessage(`No active product found for barcode ${result.data}.`);
    } catch (caught) {
      setMessage(caught instanceof Error ? caught.message : 'Unable to find this product.');
    } finally {
      setScanning(false);
    }
  }

  if (!permission) return <ActivityIndicator color={colors.primary} style={styles.loader} />;
  if (!permission.granted) return <View style={styles.permission}><Text style={styles.title}>Camera access</Text><Text style={styles.body}>Allow camera access to scan medicine barcodes.</Text><Pressable onPress={() => void requestPermission()} style={styles.primary}><Text style={styles.primaryText}>Allow camera</Text></Pressable><Pressable onPress={onBack}><Text style={styles.link}>Back to inventory</Text></Pressable></View>;

  return <View style={styles.screen}><CameraView barcodeScannerSettings={{ barcodeTypes: ['ean13', 'ean8', 'upc_a', 'upc_e', 'code128', 'code39', 'qr'] }} onBarcodeScanned={scanning ? undefined : result => void handleScan(result)} style={StyleSheet.absoluteFill} />
    <View style={styles.overlay}><View style={styles.top}><Pressable onPress={onBack} style={styles.back}><Text style={styles.backText}>‹ Inventory</Text></Pressable><Text style={styles.cameraTitle}>Scan barcode</Text><Text style={styles.cameraBody}>Place the barcode inside the frame.</Text></View><View style={styles.frame} />
      <View style={styles.bottom}>{scanning ? <ActivityIndicator color="#fff" /> : null}{message ? <><Text style={styles.message}>{message}</Text><Text style={styles.cameraBody}>Keep scanning or search by name.</Text></> : null}</View></View>
  </View>;
}

const styles = StyleSheet.create({ screen: { backgroundColor: '#000', flex: 1 }, loader: { flex: 1 }, permission: { alignItems: 'center', flex: 1, justifyContent: 'center', padding: spacing.xl }, title: { color: colors.text, fontSize: 26, fontWeight: '700' }, body: { color: colors.textMuted, lineHeight: 22, marginTop: spacing.md, textAlign: 'center' }, primary: { backgroundColor: colors.primary, borderRadius: 12, marginTop: spacing.xl, paddingHorizontal: spacing.xl, paddingVertical: spacing.md }, primaryText: { color: '#fff', fontWeight: '700' }, link: { color: colors.primary, fontWeight: '700', marginTop: spacing.lg }, overlay: { flex: 1, justifyContent: 'space-between', padding: spacing.lg }, top: { alignItems: 'center' }, back: { alignSelf: 'flex-start', backgroundColor: 'rgba(0,0,0,0.55)', borderRadius: 10, padding: spacing.sm }, backText: { color: '#fff', fontWeight: '700' }, cameraTitle: { color: '#fff', fontSize: 26, fontWeight: '700', marginTop: spacing.lg }, cameraBody: { color: '#fff', marginTop: spacing.sm, textAlign: 'center' }, frame: { alignSelf: 'center', borderColor: '#fff', borderRadius: 18, borderWidth: 3, height: 210, width: '88%' }, bottom: { alignItems: 'center', backgroundColor: 'rgba(0,0,0,0.6)', borderRadius: 12, minHeight: 72, padding: spacing.md }, message: { color: '#fff', fontWeight: '700', textAlign: 'center' } });
