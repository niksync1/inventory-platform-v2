import { supabase } from '../../shared/supabase';
import type { ProductInventory } from '../inventory/inventoryApi';

export interface Supplier {
  id: string; supplierType: 'business' | 'individual'; name: string; contactPerson: string | null;
  phone: string | null; email: string | null; paymentTerms: string | null; isActive: boolean;
}
export interface PurchaseOrder {
  id: string; reference: string; supplierId: string; supplierName: string; locationId: string;
  status: 'ordered' | 'partially_received' | 'received' | 'cancelled'; currency: string;
  totalAmount: number; paidAmount: number; outstandingAmount: number; unitsOutstanding: number;
  notes: string | null; createdAt: string;
}
export interface PurchaseOrderItem {
  id: string; productId: string; productName: string; quantityOrdered: number;
  quantityReceived: number; unitCost: number;
}
export async function listSuppliers(tenantId: string): Promise<Supplier[]> {
  const result = await supabase.from('suppliers').select('id,supplier_type,name,contact_person,phone,email,payment_terms,is_active')
    .eq('tenant_id',tenantId).order('name');
  if(result.error) throw result.error;
  return (result.data??[]).map(row=>({id:row.id,supplierType:row.supplier_type,name:row.name,contactPerson:row.contact_person,phone:row.phone,email:row.email,paymentTerms:row.payment_terms,isActive:row.is_active}));
}
export async function saveSupplier(input:{tenantId:string;supplierType:'business'|'individual';name:string;contactPerson?:string;phone?:string;email?:string;paymentTerms?:string}):Promise<void>{
 const result=await supabase.from('suppliers').insert({tenant_id:input.tenantId,supplier_type:input.supplierType,name:input.name.trim(),contact_person:input.contactPerson?.trim()||null,phone:input.phone?.trim()||null,email:input.email?.trim()||null,payment_terms:input.paymentTerms?.trim()||null});
 if(result.error) throw result.error;
}
export async function listPurchaseOrders(tenantId:string,locationId:string):Promise<PurchaseOrder[]>{
 const result=await supabase.from('purchase_order_report').select('id,reference,supplier_id,supplier_name,location_id,status,currency,total_amount,paid_amount,outstanding_amount,units_outstanding,notes,created_at').eq('tenant_id',tenantId).eq('location_id',locationId).order('created_at',{ascending:false}).limit(100);
 if(result.error) throw result.error;
 return (result.data??[]).map(row=>({id:row.id,reference:row.reference,supplierId:row.supplier_id,supplierName:row.supplier_name,locationId:row.location_id,status:row.status,currency:row.currency,totalAmount:Number(row.total_amount),paidAmount:Number(row.paid_amount),outstandingAmount:Number(row.outstanding_amount),unitsOutstanding:row.units_outstanding,notes:row.notes,createdAt:row.created_at}));
}
export async function listPurchaseOrderItems(tenantId:string,orderId:string):Promise<PurchaseOrderItem[]>{
 const result=await supabase.from('purchase_order_items').select('id,product_id,product_name,quantity_ordered,quantity_received,unit_cost').eq('tenant_id',tenantId).eq('purchase_order_id',orderId).order('created_at');
 if(result.error) throw result.error;
 return (result.data??[]).map(row=>({id:row.id,productId:row.product_id,productName:row.product_name,quantityOrdered:row.quantity_ordered,quantityReceived:row.quantity_received,unitCost:Number(row.unit_cost)}));
}
export async function createPurchaseOrder(input:{tenantId:string;locationId:string;supplierId:string;currency:string;notes?:string;product:ProductInventory;quantity:number;unitCost:number}):Promise<void>{
 const result=await supabase.rpc('create_purchase_order',{p_tenant_id:input.tenantId,p_location_id:input.locationId,p_supplier_id:input.supplierId,p_currency:input.currency,p_notes:input.notes?.trim()||null,p_items:[{product_id:input.product.id,quantity:input.quantity,unit_cost:input.unitCost}]});
 if(result.error) throw result.error;
}
export async function receivePurchaseOrder(input:{orderId:string;itemId:string;quantity:number;batchNumber:string;expiryDate:string;notes?:string}):Promise<void>{
 const result=await supabase.rpc('receive_purchase_order',{p_purchase_order_id:input.orderId,p_notes:input.notes?.trim()||null,p_items:[{item_id:input.itemId,quantity:input.quantity,batch_number:input.batchNumber.trim(),expiry_date:input.expiryDate}]});
 if(result.error) throw result.error;
}
export async function recordSupplierPayment(input:{orderId:string;amount:number;method:'cash'|'bank_transfer'|'mobile_money'|'card'|'other';reference?:string;notes?:string}):Promise<void>{
 const result=await supabase.rpc('record_supplier_payment',{p_purchase_order_id:input.orderId,p_amount:input.amount,p_payment_method:input.method,p_reference:input.reference?.trim()||null,p_notes:input.notes?.trim()||null});
 if(result.error) throw result.error;
}
