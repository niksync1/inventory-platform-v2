import Constants from 'expo-constants';
import * as Device from 'expo-device';
import { Platform } from 'react-native';
import { supabase } from '../../shared/supabase';

let notificationHandlerConfigured = false;

export function isExpoGo(): boolean {
  return Constants.appOwnership === 'expo';
}

export function canRegisterRemotePush(): boolean {
  return !isExpoGo() && Device.isDevice && (Platform.OS === 'android' || Platform.OS === 'ios');
}

async function loadNotifications() {
  if (isExpoGo()) {
    throw new Error('Remote push notifications require a development or production build. Expo Go can still be used to test the rest of the app.');
  }

  const Notifications = await import('expo-notifications');
  if (!notificationHandlerConfigured) {
    Notifications.setNotificationHandler({ handleNotification: async () => ({ shouldShowBanner: true, shouldShowList: true, shouldPlaySound: true, shouldSetBadge: false }) });
    notificationHandlerConfigured = true;
  }
  return Notifications;
}
export interface NotificationPreferences { pushEnabled: boolean; emailEnabled: boolean; stockAlerts: boolean; expiryAlerts: boolean; damageAlerts: boolean; transferAlerts: boolean; syncFailureAlerts: boolean; }
export const DEFAULT_NOTIFICATION_PREFERENCES: NotificationPreferences = { pushEnabled: true, emailEnabled: false, stockAlerts: true, expiryAlerts: true, damageAlerts: true, transferAlerts: true, syncFailureAlerts: true };
export async function loadNotificationPreferences(tenantId: string, userId: string): Promise<NotificationPreferences> {
  const result = await supabase.from('inventory_notification_preferences').select('push_enabled,email_enabled,stock_alerts,expiry_alerts,damage_alerts,transfer_alerts,sync_failure_alerts').eq('tenant_id', tenantId).eq('user_id', userId).maybeSingle();
  if (result.error) throw result.error; if (!result.data) return DEFAULT_NOTIFICATION_PREFERENCES;
  return { pushEnabled: result.data.push_enabled, emailEnabled: result.data.email_enabled, stockAlerts: result.data.stock_alerts, expiryAlerts: result.data.expiry_alerts, damageAlerts: result.data.damage_alerts, transferAlerts: result.data.transfer_alerts, syncFailureAlerts: result.data.sync_failure_alerts };
}
export async function saveNotificationPreferences(tenantId: string, userId: string, value: NotificationPreferences): Promise<void> {
  const result = await supabase.from('inventory_notification_preferences').upsert({ tenant_id: tenantId, user_id: userId, push_enabled: value.pushEnabled, email_enabled: value.emailEnabled, stock_alerts: value.stockAlerts, expiry_alerts: value.expiryAlerts, damage_alerts: value.damageAlerts, transfer_alerts: value.transferAlerts, sync_failure_alerts: value.syncFailureAlerts, updated_at: new Date().toISOString() }, { onConflict: 'tenant_id,user_id' }); if (result.error) throw result.error;
}
export async function registerExpoPushToken(tenantId: string, userId: string): Promise<string> {
  if (isExpoGo()) throw new Error('Remote push notifications require a development or production build. Expo Go can still be used to test the rest of the app.');
  if (!Device.isDevice) throw new Error('Push notifications require a physical device.');
  if (Platform.OS !== 'android' && Platform.OS !== 'ios') throw new Error('Push notifications are available on Android and iOS.');
  const Notifications = await loadNotifications();
  if (Platform.OS === 'android') await Notifications.setNotificationChannelAsync('inventory-alerts', { name: 'Inventory alerts', importance: Notifications.AndroidImportance.HIGH });
  const current = await Notifications.getPermissionsAsync(); const permission = current.status === 'granted' ? current : await Notifications.requestPermissionsAsync();
  if (permission.status !== 'granted') throw new Error('Notification permission was not granted.');
  const projectId = process.env.EXPO_PUBLIC_EAS_PROJECT_ID?.trim() || Constants.easConfig?.projectId || Constants.expoConfig?.extra?.eas?.projectId;
  if (!projectId) throw new Error('Configure the Expo EAS project ID before registering push notifications.');
  const token = (await Notifications.getExpoPushTokenAsync({ projectId })).data;
  const result = await supabase.from('expo_push_tokens').upsert({ tenant_id: tenantId, user_id: userId, token, platform: Platform.OS, is_active: true, last_seen_at: new Date().toISOString() }, { onConflict: 'tenant_id,user_id,token' });
  if (result.error) throw result.error; return token;
}
export async function reportSyncFailure(input: { tenantId: string; locationId: string; productId: string; operationId: string; message: string }): Promise<void> {
  const result = await supabase.rpc('report_inventory_sync_failure', { p_tenant_id: input.tenantId, p_location_id: input.locationId, p_product_id: input.productId, p_operation_id: input.operationId, p_message: input.message }); if (result.error) throw result.error;
}
