begin;
set local search_path = pg_catalog, public, pg_temp;

-- Supplier records are read-only to tenant-scoped mobile clients. Supplier
-- writes are available only through the authenticated admin-dashboard API,
-- which performs tenant authorization before using its server-side service role.
drop policy if exists "Tenant purchasing managers create suppliers" on public.suppliers;
drop policy if exists "Tenant purchasing managers update suppliers" on public.suppliers;
drop policy if exists "Tenant admins deactivate suppliers" on public.suppliers;
revoke insert, update, delete on public.suppliers from authenticated;
grant select on public.suppliers to authenticated;

create function public.update_purchase_order(
  p_purchase_order_id uuid,
  p_supplier_id uuid,
  p_location_id uuid,
  p_currency text,
  p_notes text,
  p_items jsonb
) returns uuid
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_po public.purchase_orders%rowtype;
  v_item jsonb;
  v_product public.products%rowtype;
  v_qty integer;
  v_cost numeric(14,2);
  v_total numeric(14,2) := 0;
begin
  select * into v_po
  from public.purchase_orders
  where id = p_purchase_order_id
  for update;

  if not found then raise exception 'Purchase order not found'; end if;
  if not public.has_tenant_role(v_po.tenant_id, array['owner','admin','manager'])
    or not public.can_access_location(v_po.tenant_id, v_po.location_id)
    or not public.can_access_location(v_po.tenant_id, p_location_id) then
    raise exception 'Not authorized to edit this purchase order';
  end if;

  if v_po.status <> 'ordered'
    or exists (select 1 from public.purchase_order_items i
      where i.tenant_id=v_po.tenant_id and i.purchase_order_id=v_po.id and i.quantity_received > 0)
    or exists (select 1 from public.purchase_receipts r
      where r.tenant_id=v_po.tenant_id and r.purchase_order_id=v_po.id)
    or exists (select 1 from public.supplier_payments p
      where p.tenant_id=v_po.tenant_id and p.purchase_order_id=v_po.id) then
    raise exception 'Only orders with no receipts or payments can be edited';
  end if;

  if p_currency is null or upper(trim(p_currency)) !~ '^[A-Z]{3}$' then
    raise exception 'A valid ISO currency code is required';
  end if;
  if p_items is null or jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then
    raise exception 'At least one product line is required';
  end if;
  if not exists (select 1 from public.suppliers
    where tenant_id=v_po.tenant_id and id=p_supplier_id and is_active) then
    raise exception 'Active supplier not found';
  end if;

  for v_item in select value from jsonb_array_elements(p_items) loop
    if coalesce(v_item->>'product_id','') = '' then raise exception 'Product is required'; end if;
    v_qty := (v_item->>'quantity')::integer;
    v_cost := (v_item->>'unit_cost')::numeric;
    if v_qty <= 0 or v_cost < 0 then
      raise exception 'Quantity must be positive and cost cannot be negative';
    end if;
    select * into v_product from public.products
    where tenant_id=v_po.tenant_id and id=(v_item->>'product_id')::uuid and is_active;
    if not found then raise exception 'Each purchase order item must be an active existing product'; end if;
    v_total := v_total + (v_qty * v_cost);
  end loop;

  delete from public.purchase_order_items
  where tenant_id=v_po.tenant_id and purchase_order_id=v_po.id;

  update public.purchase_orders
  set supplier_id=p_supplier_id,
      location_id=p_location_id,
      currency=upper(trim(p_currency)),
      notes=nullif(btrim(p_notes),''),
      total_amount=v_total,
      updated_at=now()
  where id=v_po.id;

  for v_item in select value from jsonb_array_elements(p_items) loop
    select * into v_product from public.products
    where tenant_id=v_po.tenant_id and id=(v_item->>'product_id')::uuid and is_active;
    insert into public.purchase_order_items(
      tenant_id,purchase_order_id,product_id,product_name,quantity_ordered,unit_cost
    ) values (
      v_po.tenant_id,v_po.id,v_product.id,v_product.name,
      (v_item->>'quantity')::integer,(v_item->>'unit_cost')::numeric
    );
  end loop;

  return v_po.id;
end;
$$;

create function public.delete_purchase_order(p_purchase_order_id uuid)
returns void
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_po public.purchase_orders%rowtype;
begin
  select * into v_po
  from public.purchase_orders
  where id=p_purchase_order_id
  for update;

  if not found then raise exception 'Purchase order not found'; end if;
  if not public.has_tenant_role(v_po.tenant_id, array['owner','admin','manager'])
    or not public.can_access_location(v_po.tenant_id, v_po.location_id) then
    raise exception 'Not authorized to delete this purchase order';
  end if;
  if v_po.status <> 'ordered'
    or exists (select 1 from public.purchase_order_items i
      where i.tenant_id=v_po.tenant_id and i.purchase_order_id=v_po.id and i.quantity_received > 0)
    or exists (select 1 from public.purchase_receipts r
      where r.tenant_id=v_po.tenant_id and r.purchase_order_id=v_po.id)
    or exists (select 1 from public.supplier_payments p
      where p.tenant_id=v_po.tenant_id and p.purchase_order_id=v_po.id) then
    raise exception 'Only orders with no receipts or payments can be deleted';
  end if;

  delete from public.purchase_orders where id=v_po.id;
end;
$$;

grant execute on function public.has_tenant_role(uuid,text[]) to inventory_rpc_executor;
grant execute on function public.can_access_location(uuid,uuid) to inventory_rpc_executor;
grant execute on function public.update_purchase_order(uuid,uuid,uuid,text,text,jsonb) to authenticated, service_role;
grant execute on function public.delete_purchase_order(uuid) to authenticated, service_role;

-- Match the established executor-owner transfer pattern: grant schema CREATE
-- only for the ownership change, then immediately revoke it again.
grant create on schema public to inventory_rpc_executor;
alter function public.update_purchase_order(uuid,uuid,uuid,text,text,jsonb) owner to inventory_rpc_executor;
alter function public.delete_purchase_order(uuid) owner to inventory_rpc_executor;
revoke create on schema public from inventory_rpc_executor;

commit;
