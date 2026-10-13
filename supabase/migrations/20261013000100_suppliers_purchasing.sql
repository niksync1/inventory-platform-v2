begin;
set local search_path = pg_catalog, public, pg_temp;

create table public.suppliers (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  supplier_type text not null check (supplier_type in ('business','individual')),
  name text not null check (length(btrim(name)) between 1 and 160),
  contact_person text,
  phone text,
  email text,
  address text,
  tax_reference text,
  payment_terms text,
  notes text,
  is_active boolean not null default true,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, id)
);
create unique index suppliers_tenant_name_ci_uidx on public.suppliers(tenant_id, lower(btrim(name)));
create index suppliers_tenant_active_name_idx on public.suppliers(tenant_id, is_active, name);

create table public.purchase_orders (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  location_id uuid not null,
  supplier_id uuid not null,
  reference text not null,
  status text not null default 'ordered'
    check (status in ('ordered','partially_received','received','cancelled')),
  currency text not null default 'GHS' check (currency ~ '^[A-Z]{3}$'),
  total_amount numeric(14,2) not null default 0 check (total_amount >= 0),
  notes text,
  operation_id text not null,
  request_payload jsonb not null,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  received_at timestamptz,
  constraint purchase_orders_tenant_location_fkey foreign key (tenant_id, location_id)
    references public.locations(tenant_id,id) on delete restrict,
  constraint purchase_orders_supplier_fkey foreign key (tenant_id, supplier_id)
    references public.suppliers(tenant_id,id) on delete restrict,
  unique (tenant_id, id),
  unique (tenant_id, reference),
  unique (tenant_id, operation_id)
);
create index purchase_orders_tenant_location_status_idx
  on public.purchase_orders(tenant_id, location_id, status, created_at desc);

create table public.purchase_order_items (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  purchase_order_id uuid not null,
  product_id uuid not null,
  product_name text not null,
  quantity_ordered integer not null check (quantity_ordered > 0),
  quantity_received integer not null default 0 check (quantity_received >= 0 and quantity_received <= quantity_ordered),
  unit_cost numeric(14,2) not null check (unit_cost >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint purchase_order_items_order_fkey foreign key (tenant_id,purchase_order_id)
    references public.purchase_orders(tenant_id,id) on delete cascade,
  constraint purchase_order_items_product_fkey foreign key (tenant_id,product_id)
    references public.products(tenant_id,id) on delete restrict,
  unique (tenant_id,id)
);
create index purchase_order_items_order_idx on public.purchase_order_items(tenant_id,purchase_order_id);

create table public.purchase_receipts (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  purchase_order_id uuid not null,
  location_id uuid not null,
  reference text not null,
  received_by uuid references auth.users(id) on delete set null,
  operation_id text not null,
  request_payload jsonb not null,
  notes text,
  received_at timestamptz not null default now(),
  constraint purchase_receipts_order_fkey foreign key (tenant_id,purchase_order_id)
    references public.purchase_orders(tenant_id,id) on delete restrict,
  constraint purchase_receipts_location_fkey foreign key (tenant_id,location_id)
    references public.locations(tenant_id,id) on delete restrict,
  unique (tenant_id,id),
  unique (tenant_id,reference),
  unique (tenant_id,operation_id)
);
create table public.purchase_receipt_items (
  tenant_id uuid not null,
  receipt_id uuid not null,
  purchase_order_item_id uuid not null,
  quantity_received integer not null check (quantity_received > 0),
  batch_number text not null,
  expiry_date date not null,
  created_at timestamptz not null default now(),
  primary key (receipt_id,purchase_order_item_id),
  foreign key (tenant_id,receipt_id) references public.purchase_receipts(tenant_id,id) on delete cascade,
  foreign key (tenant_id,purchase_order_item_id) references public.purchase_order_items(tenant_id,id) on delete restrict
);

create table public.supplier_payments (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  purchase_order_id uuid not null,
  supplier_id uuid not null,
  amount numeric(14,2) not null check (amount > 0),
  currency text not null check (currency ~ '^[A-Z]{3}$'),
  payment_method text not null check (payment_method in ('cash','bank_transfer','mobile_money','card','other')),
  reference text,
  notes text,
  operation_id text not null,
  request_payload jsonb not null,
  recorded_by uuid references auth.users(id) on delete set null,
  paid_at timestamptz not null default now(),
  foreign key (tenant_id,purchase_order_id) references public.purchase_orders(tenant_id,id) on delete restrict,
  foreign key (tenant_id,supplier_id) references public.suppliers(tenant_id,id) on delete restrict,
  unique (tenant_id,operation_id)
);
create index supplier_payments_order_idx on public.supplier_payments(tenant_id,purchase_order_id,paid_at desc);

alter table public.suppliers enable row level security;
alter table public.purchase_orders enable row level security;
alter table public.purchase_order_items enable row level security;
alter table public.purchase_receipts enable row level security;
alter table public.purchase_receipt_items enable row level security;
alter table public.supplier_payments enable row level security;

create policy "Tenant members read suppliers" on public.suppliers for select to authenticated
using (public.is_tenant_member(tenant_id));
create policy "Tenant purchasing managers create suppliers" on public.suppliers for insert to authenticated
with check (public.has_tenant_role(tenant_id,array['owner','admin','manager']));
create policy "Tenant purchasing managers update suppliers" on public.suppliers for update to authenticated
using (public.has_tenant_role(tenant_id,array['owner','admin','manager']))
with check (public.has_tenant_role(tenant_id,array['owner','admin','manager']));
create policy "Tenant admins deactivate suppliers" on public.suppliers for delete to authenticated
using (public.has_tenant_role(tenant_id,array['owner','admin']));
create policy "Assigned members read purchase orders" on public.purchase_orders for select to authenticated
using (public.can_access_location(tenant_id,location_id));
create policy "Assigned members read purchase order items" on public.purchase_order_items for select to authenticated
using (exists(select 1 from public.purchase_orders po where po.tenant_id=purchase_order_items.tenant_id
  and po.id=purchase_order_items.purchase_order_id and public.can_access_location(po.tenant_id,po.location_id)));
create policy "Assigned members read receipts" on public.purchase_receipts for select to authenticated
using (public.can_access_location(tenant_id,location_id));
create policy "Assigned members read receipt items" on public.purchase_receipt_items for select to authenticated
using (exists(select 1 from public.purchase_receipts r where r.tenant_id=purchase_receipt_items.tenant_id
  and r.id=purchase_receipt_items.receipt_id and public.can_access_location(r.tenant_id,r.location_id)));
create policy "Purchasing managers read supplier payments" on public.supplier_payments for select to authenticated
using (public.can_manage_orders(tenant_id) and exists (
 select 1 from public.purchase_orders po where po.tenant_id=supplier_payments.tenant_id
 and po.id=supplier_payments.purchase_order_id and public.can_access_location(po.tenant_id,po.location_id)
));

-- The non-login inventory RPC executor is the owner of the write RPCs. These
-- policies do not expose writes to client roles; clients cannot SET ROLE to it.
create policy "RPC executor manages suppliers" on public.suppliers for all to inventory_rpc_executor using (true) with check (true);
create policy "RPC executor manages purchase orders" on public.purchase_orders for all to inventory_rpc_executor using (true) with check (true);
create policy "RPC executor manages purchase order items" on public.purchase_order_items for all to inventory_rpc_executor using (true) with check (true);
create policy "RPC executor manages purchase receipts" on public.purchase_receipts for all to inventory_rpc_executor using (true) with check (true);
create policy "RPC executor manages receipt items" on public.purchase_receipt_items for all to inventory_rpc_executor using (true) with check (true);
create policy "RPC executor manages supplier payments" on public.supplier_payments for all to inventory_rpc_executor using (true) with check (true);

grant select on public.products,public.locations to inventory_rpc_executor;
create policy "RPC executor reads products" on public.products for select to inventory_rpc_executor using (true);
grant select,insert,update,delete on public.suppliers,public.purchase_orders,public.purchase_order_items,
 public.purchase_receipts,public.purchase_receipt_items,public.supplier_payments to inventory_rpc_executor;

create view public.purchase_order_report with (security_invoker = true) as
select po.id,po.tenant_id,po.location_id,po.supplier_id,s.name as supplier_name,
 po.reference,po.status,po.currency,po.total_amount,
 coalesce(pay.paid_amount,0)::numeric(14,2) as paid_amount,
 greatest(po.total_amount-coalesce(pay.paid_amount,0),0)::numeric(14,2) as outstanding_amount,
 po.notes,po.created_at,po.updated_at,po.received_at,
 (select count(*)::integer from public.purchase_order_items i where i.tenant_id=po.tenant_id and i.purchase_order_id=po.id) as line_count,
 (select coalesce(sum(i.quantity_ordered-i.quantity_received),0)::integer from public.purchase_order_items i where i.tenant_id=po.tenant_id and i.purchase_order_id=po.id) as units_outstanding
from public.purchase_orders po
join public.suppliers s on s.tenant_id=po.tenant_id and s.id=po.supplier_id
left join lateral (select sum(p.amount) as paid_amount from public.supplier_payments p
 where p.tenant_id=po.tenant_id and p.purchase_order_id=po.id) pay on true;

create function public.create_purchase_order(
 p_tenant_id uuid,p_location_id uuid,p_supplier_id uuid,p_currency text,p_notes text,p_items jsonb,p_operation_id text
) returns uuid language plpgsql security definer set search_path=pg_catalog,public,pg_temp as $$
declare
 v_id uuid:=gen_random_uuid(); v_reference text; v_total numeric(14,2):=0; v_item jsonb; v_product public.products%rowtype; v_existing public.purchase_orders%rowtype;
 v_qty integer; v_cost numeric(14,2); v_context jsonb:=public.inventory_request_context();
begin
 if not public.has_tenant_role(p_tenant_id,array['owner','admin','manager'])
   or not public.can_access_location(p_tenant_id,p_location_id) then raise exception 'Not authorized to create purchase orders for this location'; end if;
 if p_operation_id is null or length(btrim(p_operation_id))<8 then raise exception 'Operation ID is required'; end if;
 perform pg_advisory_xact_lock(hashtextextended(p_tenant_id::text||':'||p_operation_id,0));
 select * into v_existing from public.purchase_orders where tenant_id=p_tenant_id and operation_id=p_operation_id;
 if found then
   if v_existing.request_payload is distinct from jsonb_build_object('location_id',p_location_id,'supplier_id',p_supplier_id,'currency',upper(trim(p_currency)),'notes',nullif(btrim(p_notes),''),'items',p_items) then raise exception 'Operation ID conflicts with an existing purchase order'; end if;
   return v_existing.id;
 end if;
 if p_currency is null or p_currency !~ '^[A-Z]{3}$' then raise exception 'A valid ISO currency code is required'; end if;
 if jsonb_typeof(p_items)<>'array' or jsonb_array_length(p_items)=0 then raise exception 'At least one product line is required'; end if;
 if not exists(select 1 from public.suppliers where tenant_id=p_tenant_id and id=p_supplier_id and is_active) then raise exception 'Active supplier not found'; end if;
 v_reference:='PO-'||to_char(current_date,'YYYYMMDD')||'-'||upper(left(replace(v_id::text,'-',''),8));
 for v_item in select value from jsonb_array_elements(p_items) loop
   if coalesce(v_item->>'product_id','')='' then raise exception 'Product is required'; end if;
   v_qty:=(v_item->>'quantity')::integer; v_cost:=(v_item->>'unit_cost')::numeric;
   if v_qty<=0 or v_cost<0 then raise exception 'Quantity must be positive and cost cannot be negative'; end if;
   select * into v_product from public.products where tenant_id=p_tenant_id and id=(v_item->>'product_id')::uuid and is_active;
   if not found then raise exception 'Each purchase order item must be an active existing product'; end if;
   v_total:=v_total+(v_qty*v_cost);
 end loop;
 insert into public.purchase_orders(id,tenant_id,location_id,supplier_id,reference,currency,total_amount,notes,operation_id,request_payload,created_by)
 values(v_id,p_tenant_id,p_location_id,p_supplier_id,v_reference,upper(trim(p_currency)),v_total,nullif(btrim(p_notes),''),p_operation_id,
 jsonb_build_object('location_id',p_location_id,'supplier_id',p_supplier_id,'currency',upper(trim(p_currency)),'notes',nullif(btrim(p_notes),''),'items',p_items),(v_context->>'user_id')::uuid);
 for v_item in select value from jsonb_array_elements(p_items) loop
   select * into v_product from public.products where tenant_id=p_tenant_id and id=(v_item->>'product_id')::uuid and is_active;
   insert into public.purchase_order_items(tenant_id,purchase_order_id,product_id,product_name,quantity_ordered,unit_cost)
   values(p_tenant_id,v_id,v_product.id,v_product.name,(v_item->>'quantity')::integer,(v_item->>'unit_cost')::numeric);
 end loop;
 return v_id;
end; $$;

create function public.receive_purchase_order(
 p_purchase_order_id uuid,p_items jsonb,p_notes text,p_operation_id text
) returns uuid language plpgsql security definer set search_path=pg_catalog,public,pg_temp as $$
declare
 v_po public.purchase_orders%rowtype; v_item jsonb; v_line public.purchase_order_items%rowtype;
 v_receipt_id uuid:=gen_random_uuid(); v_qty integer; v_batch text; v_expiry date; v_context jsonb:=public.inventory_request_context(); v_existing public.purchase_receipts%rowtype;
begin
 select * into v_po from public.purchase_orders where id=p_purchase_order_id for update;
 if not found then raise exception 'Purchase order not found'; end if;
 if not public.can_manage_inventory_at_location(v_po.tenant_id,v_po.location_id) then raise exception 'Not authorized to receive stock at this location'; end if;
 if p_operation_id is null or length(btrim(p_operation_id))<8 then raise exception 'Operation ID is required'; end if;
 perform pg_advisory_xact_lock(hashtextextended(v_po.tenant_id::text||':'||p_operation_id,0));
 select * into v_existing from public.purchase_receipts where tenant_id=v_po.tenant_id and operation_id=p_operation_id;
 if found then
   if v_existing.request_payload is distinct from jsonb_build_object('purchase_order_id',p_purchase_order_id,'items',p_items,'notes',nullif(btrim(p_notes),'')) then raise exception 'Operation ID conflicts with an existing goods receipt'; end if;
   return v_existing.id;
 end if;
 if not public.has_tenant_role(v_po.tenant_id,array['owner','admin','manager','warehouse']) then raise exception 'Not authorized to receive stock'; end if;
 if v_po.status in ('received','cancelled') then raise exception 'This purchase order is not open for receiving'; end if;
 if jsonb_typeof(p_items)<>'array' or jsonb_array_length(p_items)=0 then raise exception 'At least one received line is required'; end if;
 insert into public.purchase_receipts(tenant_id,purchase_order_id,location_id,reference,received_by,operation_id,request_payload,notes)
 values(v_po.tenant_id,v_po.id,v_po.location_id,'GRN-'||to_char(current_date,'YYYYMMDD')||'-'||upper(left(replace(v_receipt_id::text,'-',''),8)),(v_context->>'user_id')::uuid,p_operation_id,
 jsonb_build_object('purchase_order_id',p_purchase_order_id,'items',p_items,'notes',nullif(btrim(p_notes),'')),nullif(btrim(p_notes),''));
 for v_item in select value from jsonb_array_elements(p_items) loop
   select * into v_line from public.purchase_order_items where tenant_id=v_po.tenant_id and id=(v_item->>'item_id')::uuid and purchase_order_id=v_po.id for update;
   if not found then raise exception 'Purchase order line not found'; end if;
   v_qty:=(v_item->>'quantity')::integer; v_batch:=btrim(v_item->>'batch_number'); v_expiry:=(v_item->>'expiry_date')::date;
   if v_qty<=0 or v_qty>(v_line.quantity_ordered-v_line.quantity_received) then raise exception 'Received quantity exceeds the outstanding quantity'; end if;
   if v_batch is null or length(v_batch) not between 1 and 120 or v_expiry is null or v_expiry<current_date then raise exception 'A valid batch number and non-expired expiry date are required'; end if;
   perform public.stock_in_batch(v_po.tenant_id,v_po.location_id,v_line.product_id,v_qty,v_batch,v_expiry,
     'Purchase order '||v_po.reference||' / receipt '||v_receipt_id,
     replace(v_receipt_id::text,'-','')||replace(v_line.id::text,'-',''));
   update public.purchase_order_items set quantity_received=quantity_received+v_qty,updated_at=now() where id=v_line.id;
   insert into public.purchase_receipt_items(tenant_id,receipt_id,purchase_order_item_id,quantity_received,batch_number,expiry_date)
   values(v_po.tenant_id,v_receipt_id,v_line.id,v_qty,v_batch,v_expiry);
 end loop;
 update public.purchase_orders po set status=case
   when not exists(select 1 from public.purchase_order_items i where i.tenant_id=po.tenant_id and i.purchase_order_id=po.id and i.quantity_received<i.quantity_ordered) then 'received'
   when exists(select 1 from public.purchase_order_items i where i.tenant_id=po.tenant_id and i.purchase_order_id=po.id and i.quantity_received>0) then 'partially_received'
   else 'ordered' end,
   received_at=case when not exists(select 1 from public.purchase_order_items i where i.tenant_id=po.tenant_id and i.purchase_order_id=po.id and i.quantity_received<i.quantity_ordered) then now() else po.received_at end,
   updated_at=now() where po.id=v_po.id;
 return v_receipt_id;
end; $$;

create function public.record_supplier_payment(
 p_purchase_order_id uuid,p_amount numeric,p_payment_method text,p_reference text,p_notes text,p_operation_id text
) returns uuid language plpgsql security definer set search_path=pg_catalog,public,pg_temp as $$
declare v_po public.purchase_orders%rowtype; v_paid numeric(14,2); v_id uuid:=gen_random_uuid(); v_context jsonb:=public.inventory_request_context(); v_existing public.supplier_payments%rowtype;
begin
 select * into v_po from public.purchase_orders where id=p_purchase_order_id for update;
 if not found then raise exception 'Purchase order not found'; end if;
 if not public.has_tenant_role(v_po.tenant_id,array['owner','admin','manager'])
   or not public.can_access_location(v_po.tenant_id,v_po.location_id) then raise exception 'Not authorized to record supplier payments for this location'; end if;
 if p_operation_id is null or length(btrim(p_operation_id))<8 then raise exception 'Operation ID is required'; end if;
 perform pg_advisory_xact_lock(hashtextextended(v_po.tenant_id::text||':'||p_operation_id,0));
 select * into v_existing from public.supplier_payments where tenant_id=v_po.tenant_id and operation_id=p_operation_id;
 if found then
   if v_existing.request_payload is distinct from jsonb_build_object('purchase_order_id',p_purchase_order_id,'amount',p_amount,'payment_method',p_payment_method,'reference',nullif(btrim(p_reference),''),'notes',nullif(btrim(p_notes),'')) then raise exception 'Operation ID conflicts with an existing supplier payment'; end if;
   return v_existing.id;
 end if;
 if p_amount is null or p_amount<=0 then raise exception 'Payment amount must be positive'; end if;
 if p_payment_method not in ('cash','bank_transfer','mobile_money','card','other') then raise exception 'Invalid payment method'; end if;
 select coalesce(sum(amount),0) into v_paid from public.supplier_payments where tenant_id=v_po.tenant_id and purchase_order_id=v_po.id;
 if p_amount>v_po.total_amount-v_paid then raise exception 'Payment exceeds the outstanding purchase balance'; end if;
 insert into public.supplier_payments(id,tenant_id,purchase_order_id,supplier_id,amount,currency,payment_method,reference,notes,operation_id,request_payload,recorded_by)
 values(v_id,v_po.tenant_id,v_po.id,v_po.supplier_id,p_amount,v_po.currency,p_payment_method,nullif(btrim(p_reference),''),nullif(btrim(p_notes),''),p_operation_id,
 jsonb_build_object('purchase_order_id',p_purchase_order_id,'amount',p_amount,'payment_method',p_payment_method,'reference',nullif(btrim(p_reference),''),'notes',nullif(btrim(p_notes),'')),(v_context->>'user_id')::uuid);
 return v_id;
end; $$;

grant execute on function public.has_tenant_role(uuid,text[]) to inventory_rpc_executor;
grant execute on function public.can_access_location(uuid,uuid) to inventory_rpc_executor;
grant execute on function public.can_manage_inventory_at_location(uuid,uuid) to inventory_rpc_executor;
grant execute on function public.can_manage_orders(uuid) to inventory_rpc_executor;
grant execute on function public.inventory_request_context() to inventory_rpc_executor;
grant execute on function public.create_purchase_order(uuid,uuid,uuid,text,text,jsonb,text) to authenticated,service_role;
grant execute on function public.receive_purchase_order(uuid,jsonb,text,text) to authenticated,service_role;
grant execute on function public.record_supplier_payment(uuid,numeric,text,text,text,text) to authenticated,service_role;
grant execute on function public.stock_in_batch(uuid,uuid,uuid,integer,text,date,text,text) to inventory_rpc_executor;
grant create on schema public to inventory_rpc_executor;
alter function public.create_purchase_order(uuid,uuid,uuid,text,text,jsonb,text) owner to inventory_rpc_executor;
alter function public.receive_purchase_order(uuid,jsonb,text,text) owner to inventory_rpc_executor;
alter function public.record_supplier_payment(uuid,numeric,text,text,text,text) owner to inventory_rpc_executor;
revoke create on schema public from inventory_rpc_executor;

comment on table public.suppliers is 'Tenant-owned suppliers, including business and individual providers.';
comment on table public.purchase_orders is 'Purchase commitments. Inventory changes only when goods are received.';
comment on table public.supplier_payments is 'Payments recorded against purchase orders; this is not a full accounting ledger.';
commit;
