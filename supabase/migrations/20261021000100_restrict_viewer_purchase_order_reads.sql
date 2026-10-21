begin;
set local search_path = pg_catalog, public, pg_temp;

-- Viewers must not be able to read purchase orders or their operational
-- details through direct table/view queries. Warehouse users retain read
-- access because they need to select orders when receiving stock.
drop policy if exists "Assigned members read purchase orders" on public.purchase_orders;
create policy "Authorized roles read purchase orders" on public.purchase_orders
for select to authenticated
using (
  public.has_tenant_role(tenant_id, array['owner','admin','manager','warehouse'])
  and public.can_access_location(tenant_id, location_id)
);

drop policy if exists "Assigned members read purchase order items" on public.purchase_order_items;
create policy "Authorized roles read purchase order items" on public.purchase_order_items
for select to authenticated
using (
  public.has_tenant_role(tenant_id, array['owner','admin','manager','warehouse'])
  and exists (
    select 1
    from public.purchase_orders po
    where po.tenant_id = purchase_order_items.tenant_id
      and po.id = purchase_order_items.purchase_order_id
      and public.can_access_location(po.tenant_id, po.location_id)
  )
);

-- Receipt details are part of the purchase-order workflow, so do not leave
-- an indirect read path for viewers.
drop policy if exists "Assigned members read receipts" on public.purchase_receipts;
create policy "Authorized roles read purchase receipts" on public.purchase_receipts
for select to authenticated
using (
  public.has_tenant_role(tenant_id, array['owner','admin','manager','warehouse'])
  and public.can_access_location(tenant_id, location_id)
  and exists (
    select 1
    from public.purchase_orders po
    where po.tenant_id = purchase_receipts.tenant_id
      and po.id = purchase_receipts.purchase_order_id
  )
);

drop policy if exists "Assigned members read receipt items" on public.purchase_receipt_items;
create policy "Authorized roles read purchase receipt items" on public.purchase_receipt_items
for select to authenticated
using (
  public.has_tenant_role(tenant_id, array['owner','admin','manager','warehouse'])
  and exists (
    select 1
    from public.purchase_receipts r
    join public.purchase_orders po
      on po.tenant_id = r.tenant_id and po.id = r.purchase_order_id
    where r.tenant_id = purchase_receipt_items.tenant_id
      and r.id = purchase_receipt_items.receipt_id
      and public.can_access_location(po.tenant_id, po.location_id)
  )
);

comment on policy "Authorized roles read purchase orders" on public.purchase_orders
  is 'Viewers cannot read purchase orders; owners, admins, managers and warehouse users need location access.';
comment on policy "Authorized roles read purchase order items" on public.purchase_order_items
  is 'Purchase order line visibility follows the parent order role and location access.';

commit;
