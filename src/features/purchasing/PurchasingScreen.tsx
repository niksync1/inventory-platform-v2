import { useCallback, useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, Alert, Pressable, RefreshControl, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { canManageOrders, canReceiveTransfers } from '../../core/tenancy/permissions';
import { createOperationId } from '../../core/inventory/operationId';
import { colors, spacing } from '../../shared/theme';
import { useTenant } from '../tenancy/TenantProvider';
import { listProducts, type ProductInventory } from '../inventory/inventoryApi';
import { createPurchaseOrder, deletePurchaseOrder, listPurchaseOrderItems, listPurchaseOrders, listSuppliers, receivePurchaseOrder, recordSupplierPayment, updatePurchaseOrder, type PurchaseOrder, type PurchaseOrderItem, type Supplier } from './purchasingApi';

type OrderAction = { order: PurchaseOrder; action: 'receive' | 'payment'; item?: PurchaseOrderItem; operationId: string } | null;
type DraftLine = { product: ProductInventory; quantity: string; unitCost: string };

export function PurchasingScreen({ onBack }: { onBack: () => void }) {
  const { context, locations } = useTenant();
  const [tab,setTab]=useState<'orders'|'suppliers'>('orders');
  const [suppliers,setSuppliers]=useState<Supplier[]>([]);
  const [products,setProducts]=useState<ProductInventory[]>([]);
  const [orders,setOrders]=useState<PurchaseOrder[]>([]);
  const [loading,setLoading]=useState(true);
  const [refreshing,setRefreshing]=useState(false);
  const [busy,setBusy]=useState(false);
  const [error,setError]=useState<string|null>(null);
  const [showOrderForm,setShowOrderForm]=useState(false);
  const [editingOrderId,setEditingOrderId]=useState<string|null>(null);
  const [selectedSupplierId,setSelectedSupplierId]=useState('');
  const [selectedProductId,setSelectedProductId]=useState('');
  const [lineQuantity,setLineQuantity]=useState('1');
  const [lineCost,setLineCost]=useState('');
  const [draftLines,setDraftLines]=useState<DraftLine[]>([]);
  const [currency,setCurrency]=useState('GHS');
  const [orderNotes,setOrderNotes]=useState('');
  const [orderOperationId,setOrderOperationId]=useState(createOperationId());
  const [action,setAction]=useState<OrderAction>(null);
  const [receiveQuantity,setReceiveQuantity]=useState('');
  const [batchNumber,setBatchNumber]=useState('');
  const [expiryDate,setExpiryDate]=useState('');
  const [paymentAmount,setPaymentAmount]=useState('');
  const [paymentMethod,setPaymentMethod]=useState<'cash'|'bank_transfer'|'mobile_money'|'card'|'other'>('mobile_money');
  const [paymentReference,setPaymentReference]=useState('');
  const [paymentNotes,setPaymentNotes]=useState('');
  const location=useMemo(()=>locations.find(item=>item.id===context?.locationId),[context,locations]);
  const selectedProduct=products.find(product=>product.id===selectedProductId)??products[0];
  const activeSuppliers=suppliers.filter(supplier=>supplier.isActive);
  const selectedSupplier=activeSuppliers.find(supplier=>supplier.id===selectedSupplierId)??activeSuppliers[0];

  const load=useCallback(async()=>{
    if(!context)return;
    setError(null);
    try{
      const [nextSuppliers,nextProducts,nextOrders]=await Promise.all([
        listSuppliers(context.tenant.id),listProducts(context.tenant.id,context.locationId),listPurchaseOrders(context.tenant.id,context.locationId)
      ]);
      setSuppliers(nextSuppliers);setProducts(nextProducts);setOrders(nextOrders);
      if(!selectedSupplierId&&nextSuppliers.length)setSelectedSupplierId(nextSuppliers[0].id);
      if(!selectedProductId&&nextProducts.length)setSelectedProductId(nextProducts[0].id);
    }catch(caught){setError(caught instanceof Error?caught.message:'Unable to load purchasing data.');}
    finally{setLoading(false);setRefreshing(false);}
  },[context,selectedProductId,selectedSupplierId]);
  useEffect(()=>{void load();},[load]);
  if(!context)return null;
  const mayManage=canManageOrders(context.membership.role);
  const mayReceive=canReceiveTransfers(context.membership.role);

  function addLine(){
    const qty=Number(lineQuantity),cost=Number(lineCost);
    if(!selectedProduct){setError('There are no active products to order.');return;}
    if(!Number.isSafeInteger(qty)||qty<=0||!Number.isFinite(cost)||cost<0||lineCost.trim()===''){setError('Enter a positive whole quantity and a valid unit cost.');return;}
    setDraftLines(current=>[...current,{product:selectedProduct,quantity:String(qty),unitCost:String(cost)}]);
    setLineQuantity('1');setLineCost('');setError(null);
  }
  async function submitOrder(){
    if(!context||!selectedSupplier){setError('Create or select an active supplier first.');return;}
    if(!draftLines.length){setError('Add at least one product line.');return;}
    if(!/^[A-Z]{3}$/.test(currency.trim().toUpperCase())){setError('Currency must be a three-letter code, e.g. GHS.');return;}
    setBusy(true);setError(null);
    try{
      const input={tenantId:context.tenant.id,locationId:context.locationId,supplierId:selectedSupplier.id,currency:currency.trim().toUpperCase(),notes:orderNotes,items:draftLines.map(line=>({product:line.product,quantity:Number(line.quantity),unitCost:Number(line.unitCost)}))};
      if(editingOrderId){
        await updatePurchaseOrder({orderId:editingOrderId,supplierId:input.supplierId,locationId:input.locationId,currency:input.currency,notes:input.notes,items:input.items});
      }else{
        await createPurchaseOrder({...input,operationId:orderOperationId});
      }
      setDraftLines([]);setOrderNotes('');setShowOrderForm(false);setEditingOrderId(null);setOrderOperationId(createOperationId());await load();
      Alert.alert(editingOrderId?'Purchase order updated':'Purchase order created',editingOrderId?'The order was updated.':'Stock has not changed. Record a goods receipt when the delivery arrives.');
    }catch(caught){setError(caught instanceof Error?caught.message:'Unable to save purchase order.');}finally{setBusy(false);}
  }
  async function openEditOrder(order:PurchaseOrder){
    if(!context)return;
    setBusy(true);setError(null);
    try{
      const lines=await listPurchaseOrderItems(context.tenant.id,order.id);
      const editableLines=lines.map(line=>{
        const product=products.find(item=>item.id===line.productId);
        if(!product)throw new Error('A product on this order is no longer available.');
        return {product,quantity:String(line.quantityOrdered),unitCost:String(line.unitCost)};
      });
      setEditingOrderId(order.id);setSelectedSupplierId(order.supplierId);setSelectedProductId(editableLines[0]?.product.id??'');
      setDraftLines(editableLines);setCurrency(order.currency);setOrderNotes(order.notes??'');setTab('orders');setShowOrderForm(true);
    }catch(caught){setError(caught instanceof Error?caught.message:'Unable to load purchase order for editing.');}
    finally{setBusy(false);}
  }
  async function confirmDeleteOrder(order:PurchaseOrder){
    Alert.alert('Delete purchase order?', 'Only an order with no receipts or supplier payments can be deleted. This action cannot be undone.',[
      {text:'Keep order',style:'cancel'},
      {text:'Delete order',style:'destructive',onPress:()=>void (async()=>{
        setBusy(true);setError(null);
        try{await deletePurchaseOrder(order.id);await load();Alert.alert('Order deleted','The purchase order was deleted.');}
        catch(caught){setError(caught instanceof Error?caught.message:'Unable to delete purchase order.');}
        finally{setBusy(false);}
      })()}
    ]);
  }
  async function openReceive(order:PurchaseOrder){
    if(!context)return;
    setBusy(true);setError(null);
    try{
      const items=await listPurchaseOrderItems(context.tenant.id,order.id);
      const item=items.find(line=>line.quantityReceived<line.quantityOrdered);
      if(!item){setError('No outstanding product quantities remain on this order.');return;}
      setAction({order,action:'receive',item,operationId:createOperationId()});setReceiveQuantity(String(item.quantityOrdered-item.quantityReceived));setBatchNumber('');setExpiryDate('');
    }catch(caught){setError(caught instanceof Error?caught.message:'Unable to load order lines.');}finally{setBusy(false);}
  }
  async function submitReceipt(){
    if(!action||action.action!=='receive'||!action.item)return;
    const qty=Number(receiveQuantity);
    if(!Number.isSafeInteger(qty)||qty<=0||qty>action.item.quantityOrdered-action.item.quantityReceived){setError('Enter a valid quantity no greater than the outstanding amount.');return;}
    if(!/^\d{4}-\d{2}-\d{2}$/.test(expiryDate)||Number.isNaN(Date.parse(expiryDate))){setError('Enter the expiry date as YYYY-MM-DD.');return;}
    setBusy(true);setError(null);
    try{await receivePurchaseOrder({orderId:action.order.id,itemId:action.item.id,quantity:qty,batchNumber,expiryDate,operationId:action.operationId});
      setAction(null);await load();Alert.alert('Stock received','The receipt and inventory transaction were recorded together.');
    }catch(caught){setError(caught instanceof Error?caught.message:'Unable to receive stock.');}finally{setBusy(false);}
  }
  async function submitPayment(){
    if(!action||action.action!=='payment')return;
    const amount=Number(paymentAmount);
    if(!Number.isFinite(amount)||amount<=0||amount>action.order.outstandingAmount){setError('Enter a payment greater than zero and no more than the outstanding balance.');return;}
    setBusy(true);setError(null);
    try{await recordSupplierPayment({orderId:action.order.id,amount,method:paymentMethod,operationId:action.operationId,reference:paymentReference,notes:paymentNotes});
      setAction(null);setPaymentAmount('');setPaymentReference('');setPaymentNotes('');await load();Alert.alert('Payment recorded','The supplier balance has been updated.');
    }catch(caught){setError(caught instanceof Error?caught.message:'Unable to record payment.');}finally{setBusy(false);}
  }

  return <ScrollView contentContainerStyle={styles.container} refreshControl={<RefreshControl refreshing={refreshing} onRefresh={()=>{setRefreshing(true);void load();}}/>} keyboardShouldPersistTaps="handled">
    <Pressable onPress={onBack}><Text style={styles.link}>← Back</Text></Pressable>
    <Text style={styles.title}>Suppliers & purchasing</Text>
    <Text style={styles.subtitle}>{context.tenant.name} · {location?.name}</Text>
    <Text style={styles.intro}>Orders do not change stock. Receiving records the delivered batch and updates inventory; supplier payments reduce the outstanding balance.</Text>
    <View style={styles.tabs}>
      <Pressable onPress={()=>{setTab('orders');setError(null);}} style={[styles.tab,tab==='orders'&&styles.activeTab]}><Text style={[styles.tabText,tab==='orders'&&styles.activeTabText]}>Purchase orders</Text></Pressable>
      <Pressable onPress={()=>{setTab('suppliers');setError(null);}} style={[styles.tab,tab==='suppliers'&&styles.activeTab]}><Text style={[styles.tabText,tab==='suppliers'&&styles.activeTabText]}>Suppliers</Text></Pressable>
    </View>
    {loading?<ActivityIndicator color={colors.primary} style={styles.loader}/>:null}
    {error?<Text style={styles.error}>{error}</Text>:null}

    {tab==='suppliers'?<>
      <Text style={styles.intro}>Supplier accounts are created and managed in the admin dashboard. This mobile view is read-only.</Text>
      {!suppliers.length&&!loading?<Text style={styles.empty}>No suppliers are available for this tenant yet. Ask an authorized dashboard administrator to add a supplier.</Text>:null}
      {suppliers.map(s=><View key={s.id} style={styles.card}>
        <View style={styles.row}><Text style={styles.cardTitle}>{s.name}</Text><Text style={styles.status}>{s.isActive?'ACTIVE':'INACTIVE'}</Text></View>
        <Text style={styles.meta}>{s.supplierType==='business'?'Business':'Individual'}{s.contactPerson?' · '+s.contactPerson:''}</Text>
        {s.phone?<Text style={styles.body}>{s.phone}</Text>:null}{s.email?<Text style={styles.body}>{s.email}</Text>:null}
        {s.paymentTerms?<Text style={styles.body}>Terms: {s.paymentTerms}</Text>:null}
      </View>)}
    </>:<>
      {mayManage?<Pressable onPress={()=>{setShowOrderForm(v=>{if(!v){setOrderOperationId(createOperationId());setEditingOrderId(null);setDraftLines([]);setOrderNotes('');}else{setEditingOrderId(null);}return !v;});}} style={styles.primary}><Text style={styles.primaryText}>{showOrderForm?'Close order form':editingOrderId?'Edit purchase order':'＋ Create purchase order'}</Text></Pressable>:null}
      {showOrderForm&&mayManage?<View style={styles.card}>
        <Text style={styles.cardTitle}>{editingOrderId?'Edit purchase order':'New purchase order'}</Text>
        <Text style={styles.label}>Supplier</Text>
        {activeSuppliers.map(s=><Choice key={s.id} label={s.name} active={selectedSupplier?.id===s.id} onPress={()=>setSelectedSupplierId(s.id)}/>)}
        {!activeSuppliers.length?<Text style={styles.meta}>Add a supplier before creating an order.</Text>:null}
        <Text style={styles.label}>Existing product</Text>
        {products.map(p=><Choice key={p.id} label={p.name} active={selectedProduct?.id===p.id} onPress={()=>setSelectedProductId(p.id)}/>)}
        <Field label="Quantity" value={lineQuantity} onChangeText={setLineQuantity} keyboardType="number-pad" placeholder="1"/>
        <Field label={'Unit cost ('+currency+')'} value={lineCost} onChangeText={setLineCost} keyboardType="decimal-pad" placeholder="0.00"/>
        <Pressable onPress={addLine} style={styles.outline}><Text style={styles.outlineText}>Add product line</Text></Pressable>
        {draftLines.map((line,index)=><View key={index} style={styles.lineRow}><Text style={styles.body}>{line.product.name} · {line.quantity} × {currency} {Number(line.unitCost).toFixed(2)}</Text><Pressable onPress={()=>setDraftLines(current=>current.filter((_,i)=>i!==index))}><Text style={styles.link}>Remove</Text></Pressable></View>)}
        <Text style={styles.total}>Order total: {currency} {draftLines.reduce((sum,line)=>sum+Number(line.quantity)*Number(line.unitCost),0).toFixed(2)}</Text>
        <Field label="Currency (3-letter code)" value={currency} onChangeText={setCurrency} placeholder="GHS"/>
        <Field label="Notes" value={orderNotes} onChangeText={setOrderNotes} placeholder="Optional order notes"/>
        <Pressable disabled={busy} onPress={()=>void submitOrder()} style={styles.primary}><Text style={styles.primaryText}>{busy?(editingOrderId?'Saving…':'Creating…'):(editingOrderId?'Save changes':'Create order')}</Text></Pressable>
      </View>:null}
      {!orders.length&&!loading?<Text style={styles.empty}>No purchase orders for this location yet.</Text>:null}
      {orders.map(order=><View key={order.id} style={styles.card}>
        <View style={styles.row}><Text style={styles.cardTitle}>{order.reference}</Text><Text style={styles.status}>{order.status.replaceAll('_',' ').toUpperCase()}</Text></View>
        <Text style={styles.product}>{order.supplierName}</Text>
        {mayManage?<><Text style={styles.body}>Total: {order.currency} {order.totalAmount.toFixed(2)} · Paid: {order.paidAmount.toFixed(2)}</Text>
        <Text style={[styles.body,order.outstandingAmount>0&&styles.balance]}>Outstanding: {order.currency} {order.outstandingAmount.toFixed(2)}</Text></>:<Text style={styles.body}>Order total: {order.currency} {order.totalAmount.toFixed(2)}</Text>}
        <Text style={styles.meta}>{order.unitsOutstanding} unit(s) still to receive</Text>
        {order.notes?<Text style={styles.body}>{order.notes}</Text>:null}
        {mayManage&&order.status==='ordered'&&order.paidAmount===0?<View style={styles.row}>
          <Pressable disabled={busy} onPress={()=>void openEditOrder(order)} style={styles.outline}><Text style={styles.outlineText}>Edit order</Text></Pressable>
          <Pressable disabled={busy} onPress={()=>confirmDeleteOrder(order)} style={styles.outline}><Text style={styles.error}>Delete order</Text></Pressable>
        </View>:null}
        {mayReceive&&order.unitsOutstanding>0&&order.status!=='cancelled'?<Pressable disabled={busy} onPress={()=>void openReceive(order)} style={styles.outline}><Text style={styles.outlineText}>Receive stock</Text></Pressable>:null}
        {mayManage&&order.outstandingAmount>0&&order.status!=='cancelled'?<Pressable onPress={()=>{setAction({order,action:'payment',operationId:createOperationId()});setPaymentAmount(order.outstandingAmount.toFixed(2));setPaymentMethod('mobile_money');}} style={styles.outline}><Text style={styles.outlineText}>Record supplier payment</Text></Pressable>:null}
        {action?.order.id===order.id&&action.action==='receive'&&action.item?<View style={styles.panel}>
          <Text style={styles.cardTitle}>Receive: {action.item.productName}</Text>
          <Text style={styles.meta}>Outstanding: {action.item.quantityOrdered-action.item.quantityReceived} units</Text>
          <Field label="Quantity delivered" value={receiveQuantity} onChangeText={setReceiveQuantity} keyboardType="number-pad" placeholder="Quantity"/>
          <Field label="Batch / lot number" value={batchNumber} onChangeText={setBatchNumber} placeholder="Supplier's batch number"/>
          <Field label="Expiry date (YYYY-MM-DD)" value={expiryDate} onChangeText={setExpiryDate} placeholder="2027-12-31"/>
          <Pressable disabled={busy} onPress={()=>void submitReceipt()} style={styles.primary}><Text style={styles.primaryText}>{busy?'Receiving…':'Confirm receipt'}</Text></Pressable>
          <Pressable onPress={()=>setAction(null)}><Text style={styles.link}>Cancel</Text></Pressable>
        </View>:null}
        {action?.order.id===order.id&&action.action==='payment'?<View style={styles.panel}>
          <Text style={styles.cardTitle}>Record payment</Text>
          <Field label={'Amount ('+order.currency+')'} value={paymentAmount} onChangeText={setPaymentAmount} keyboardType="decimal-pad" placeholder="0.00"/>
          <Text style={styles.label}>Method</Text>
          <View style={styles.row}>{(['mobile_money','cash','bank_transfer','card','other'] as const).map(method=><Choice key={method} label={method.replaceAll('_',' ')} active={paymentMethod===method} onPress={()=>setPaymentMethod(method)}/>)}</View>
          <Field label="Payment reference" value={paymentReference} onChangeText={setPaymentReference} placeholder="Optional transaction reference"/>
          <Field label="Notes" value={paymentNotes} onChangeText={setPaymentNotes} placeholder="Optional"/>
          <Pressable disabled={busy} onPress={()=>void submitPayment()} style={styles.primary}><Text style={styles.primaryText}>{busy?'Recording…':'Confirm payment'}</Text></Pressable>
          <Pressable onPress={()=>setAction(null)}><Text style={styles.link}>Cancel</Text></Pressable>
        </View>:null}
      </View>)}
    </>}
  </ScrollView>;
}

function Field({label,value,onChangeText,placeholder,keyboardType}:{label:string;value:string;onChangeText:(value:string)=>void;placeholder?:string;keyboardType?:'default'|'number-pad'|'decimal-pad'|'phone-pad'|'email-address'}){
 return <View><Text style={styles.label}>{label}</Text><TextInput value={value} onChangeText={onChangeText} placeholder={placeholder} keyboardType={keyboardType??'default'} autoCapitalize={keyboardType==='email-address'?'none':'sentences'} style={styles.input}/></View>;
}
function Choice({label,active,onPress}:{label:string;active:boolean;onPress:()=>void}){
 return <Pressable onPress={onPress} style={[styles.choice,active&&styles.choiceActive]}><Text style={[styles.choiceText,active&&styles.choiceTextActive]}>{label}</Text></Pressable>;
}
const styles=StyleSheet.create({
 container:{padding:spacing.xl,paddingBottom:48},title:{color:colors.text,fontSize:28,fontWeight:'700',marginTop:spacing.md},
 subtitle:{color:colors.textMuted,fontSize:15,marginTop:spacing.xs},intro:{color:colors.textMuted,lineHeight:21,marginTop:spacing.md},
 link:{color:colors.primary,fontWeight:'700',marginTop:spacing.md},tabs:{flexDirection:'row',gap:spacing.sm,marginTop:spacing.lg},
 tab:{flex:1,alignItems:'center',padding:spacing.md,borderRadius:10,borderWidth:1,borderColor:colors.border},activeTab:{backgroundColor:colors.primary,borderColor:colors.primary},
 tabText:{color:colors.text,fontWeight:'700'},activeTabText:{color:'#fff'},loader:{marginTop:spacing.xl},
 error:{color:'#B42318',marginTop:spacing.md},empty:{color:colors.textMuted,marginTop:spacing.xl,textAlign:'center'},
 card:{backgroundColor:colors.surface,borderColor:colors.border,borderWidth:1,borderRadius:14,padding:spacing.lg,marginTop:spacing.md},
 cardTitle:{color:colors.text,fontSize:16,fontWeight:'700',flexShrink:1},row:{flexDirection:'row',flexWrap:'wrap',alignItems:'center',justifyContent:'space-between',gap:spacing.xs},
 meta:{color:colors.textMuted,fontSize:12,marginTop:spacing.xs},body:{color:colors.text,marginTop:spacing.sm},product:{color:colors.text,fontWeight:'700',marginTop:spacing.sm},
 status:{color:colors.primary,fontSize:11,fontWeight:'700',marginLeft:spacing.sm},balance:{color:'#B42318',fontWeight:'700'},
 label:{color:colors.text,fontWeight:'600',marginTop:spacing.md,marginBottom:spacing.xs},input:{backgroundColor:colors.background,borderColor:colors.border,borderWidth:1,borderRadius:10,color:colors.text,padding:spacing.md},
 primary:{alignItems:'center',backgroundColor:colors.primary,borderRadius:10,padding:spacing.md,marginTop:spacing.md},primaryText:{color:'#fff',fontWeight:'700'},
 outline:{alignItems:'center',borderColor:colors.primary,borderWidth:1,borderRadius:10,padding:spacing.md,marginTop:spacing.md},outlineText:{color:colors.primary,fontWeight:'700'},
 choice:{borderWidth:1,borderColor:colors.border,borderRadius:9,paddingVertical:spacing.sm,paddingHorizontal:spacing.md,marginTop:spacing.xs,marginRight:spacing.xs},choiceActive:{backgroundColor:colors.primary,borderColor:colors.primary},
 choiceText:{color:colors.text},choiceTextActive:{color:'#fff'},lineRow:{flexDirection:'row',alignItems:'center',justifyContent:'space-between',gap:spacing.sm,borderBottomWidth:1,borderBottomColor:colors.border,paddingVertical:spacing.sm},
 total:{color:colors.text,fontWeight:'700',marginTop:spacing.md},panel:{backgroundColor:colors.background,borderRadius:12,padding:spacing.md,marginTop:spacing.md}
});
