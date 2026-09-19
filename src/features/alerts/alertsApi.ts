import { supabase } from '../../shared/supabase';
export type AlertStatus = 'active' | 'acknowledged';
export interface InventoryAlert { id: string; productId: string; type: string; severity: string; status: string; quantity: number | null; threshold: number | null; message: string; triggeredAt: string; acknowledgedAt: string | null; }

export async function listAlerts(tenantId: string, locationId: string, status: AlertStatus): Promise<InventoryAlert[]> {
  const result = await supabase.from('inventory_alerts')
    .select('id,product_id,alert_type,severity,status,quantity,threshold,message,triggered_at,acknowledged_at')
    .eq('tenant_id', tenantId).eq('location_id', locationId).eq('status', status)
    .order('triggered_at', { ascending: false }).limit(100);
  if (result.error) throw result.error;
  return (result.data ?? []).map(row => ({ id: row.id, productId: row.product_id, type: row.alert_type, severity: row.severity, status: row.status, quantity: row.quantity, threshold: row.threshold, message: row.message, triggeredAt: row.triggered_at, acknowledgedAt: row.acknowledged_at }));
}
export async function countActiveAlerts(tenantId: string, locationId: string): Promise<number> {
  const result = await supabase.from('inventory_alerts').select('id', { count: 'exact', head: true }).eq('tenant_id', tenantId).eq('location_id', locationId).eq('status', 'active');
  if (result.error) throw result.error;
  return result.count ?? 0;
}
export async function acknowledgeAlert(alertId: string): Promise<void> {
  const result = await supabase.rpc('acknowledge_inventory_alert', { p_alert_id: alertId });
  if (result.error) throw result.error;
}
