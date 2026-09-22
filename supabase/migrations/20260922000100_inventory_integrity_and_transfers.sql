begin;

set local search_path = pg_catalog, public, pg_temp;

create table public.inventory_transfers (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  source_location_id uuid not null,
  source_location_name text not null,
  destination_location_id uuid not null,
  destination_location_name text not null,
  reference text not null,
  status text not null default 'draft'
    check (status in ('draft', 'dispatched', 'partially_received', 'received', 'cancelled')),
  remarks text,
  created_by uuid references public.profiles(id) on delete set null,
  dispatched_by uuid references public.profiles(id) on delete set null,
  received_by uuid references public.profiles(id) on delete set null,
  cancelled_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  dispatched_at timestamptz,
  received_at timestamptz,
  cancelled_at timestamptz,
  updated_at timestamptz not null default now(),
  constraint inventory_transfers_different_locations_check
    check (source_location_id <> destination_location_id),
  constraint inventory_transfers_source_location_fkey
    foreign key (tenant_id, source_location_id)
    references public.locations (tenant_id, id) on delete restrict,
  constraint inventory_transfers_destination_location_fkey
    foreign key (tenant_id, destination_location_id)
    references public.locations (tenant_id, id) on delete restrict,
  constraint inventory_transfers_tenant_id_id_key unique (tenant_id, id),
  unique (tenant_id, reference)
);

create table public.inventory_transfer_items (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  transfer_id uuid not null,
  product_id uuid not null,
  source_batch_id uuid not null,
  batch_number text not null,
  expiry_date date,
  quantity_requested integer not null check (quantity_requested > 0),
  quantity_dispatched integer not null default 0 check (quantity_dispatched >= 0),
  quantity_received integer not null default 0 check (quantity_received >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint inventory_transfer_items_quantity_check check (
    quantity_received <= quantity_dispatched
    and quantity_dispatched <= quantity_requested
  ),
  constraint inventory_transfer_items_transfer_fkey
    foreign key (tenant_id, transfer_id)
    references public.inventory_transfers (tenant_id, id) on delete cascade,
  constraint inventory_transfer_items_product_fkey
    foreign key (tenant_id, product_id)
    references public.products (tenant_id, id) on delete restrict,
  constraint inventory_transfer_items_batch_fkey
    foreign key (tenant_id, source_batch_id)
    references public.inventory_batches (tenant_id, id) on delete restrict,
  unique (transfer_id, source_batch_id)
);

create table public.inventory_transfer_events (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  transfer_id uuid not null,
  event_type text not null check (event_type in ('CREATED', 'DISPATCHED', 'RECEIVED', 'CANCELLED')),
  quantity integer check (quantity is null or quantity > 0),
  operation_id text,
  actor_id uuid references public.profiles(id) on delete set null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  constraint inventory_transfer_events_transfer_fkey
    foreign key (tenant_id, transfer_id)
    references public.inventory_transfers (tenant_id, id) on delete cascade
);

create unique index inventory_transfer_events_operation_uidx
  on public.inventory_transfer_events (tenant_id, operation_id)
  where operation_id is not null;
create index inventory_transfers_source_status_idx
  on public.inventory_transfers (tenant_id, source_location_id, status, updated_at desc);
create index inventory_transfers_destination_status_idx
  on public.inventory_transfers (tenant_id, destination_location_id, status, updated_at desc);
create index inventory_transfer_items_transfer_idx
  on public.inventory_transfer_items (tenant_id, transfer_id);

alter table public.inventory_alerts add column transfer_id uuid;
alter table public.inventory_alerts add constraint inventory_alerts_tenant_transfer_fkey
  foreign key (tenant_id, transfer_id)
  references public.inventory_transfers (tenant_id, id) on delete cascade;
alter table public.inventory_alerts drop constraint inventory_alerts_alert_type_check;
alter table public.inventory_alerts add constraint inventory_alerts_alert_type_check check (
  alert_type in (
    'LOW_STOCK', 'OUT_OF_STOCK', 'DAMAGE', 'EXPIRED',
    'EXPIRING_90_DAYS', 'EXPIRING_30_DAYS', 'BATCH_EXPIRED',
    'TRANSFER_PENDING_RECEIPT'
  )
);
create unique index inventory_alerts_open_transfer_uidx
  on public.inventory_alerts (tenant_id, transfer_id, alert_type)
  where status in ('active', 'acknowledged')
    and transfer_id is not null
    and alert_type = 'TRANSFER_PENDING_RECEIPT';

alter table public.inventory_transfers enable row level security;
alter table public.inventory_transfer_items enable row level security;
alter table public.inventory_transfer_events enable row level security;

create policy "Assigned members can read inventory transfers"
on public.inventory_transfers for select to authenticated
using (
  public.can_access_location(tenant_id, source_location_id)
  or public.can_access_location(tenant_id, destination_location_id)
);
create policy "Assigned members can read transfer items"
on public.inventory_transfer_items for select to authenticated
using (exists (
  select 1 from public.inventory_transfers transfer
  where transfer.tenant_id = inventory_transfer_items.tenant_id
    and transfer.id = inventory_transfer_items.transfer_id
    and (
      public.can_access_location(transfer.tenant_id, transfer.source_location_id)
      or public.can_access_location(transfer.tenant_id, transfer.destination_location_id)
    )
));
create policy "Assigned members can read transfer events"
on public.inventory_transfer_events for select to authenticated
using (exists (
  select 1 from public.inventory_transfers transfer
  where transfer.tenant_id = inventory_transfer_events.tenant_id
    and transfer.id = inventory_transfer_events.transfer_id
    and (
      public.can_access_location(transfer.tenant_id, transfer.source_location_id)
      or public.can_access_location(transfer.tenant_id, transfer.destination_location_id)
    )
));

create trigger guard_inventory_transfer_writes
before insert or update or delete on public.inventory_transfers
for each row execute function public.guard_batch_writes();
create trigger guard_inventory_transfer_item_writes
before insert or update or delete on public.inventory_transfer_items
for each row execute function public.guard_batch_writes();
create trigger guard_inventory_transfer_event_writes
before insert or update or delete on public.inventory_transfer_events
for each row execute function public.guard_batch_writes();

create function public.stock_out_batch(
  p_tenant_id uuid,
  p_location_id uuid,
  p_product_id uuid,
  p_batch_id uuid,
  p_quantity integer,
  p_transaction_type text,
  p_remarks text,
  p_operation_id text default null
)
returns void
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  previous_quantity integer;
  resulting_quantity integer;
  product_barcode text;
  batch_record public.inventory_batches%rowtype;
  transaction_id uuid;
  existing_operation public.inventory_transactions%rowtype;
  request_context jsonb := public.inventory_request_context();
begin
  if not public.can_manage_inventory(p_tenant_id) and not (
    (request_context->>'service_role')::boolean and exists (
      select 1 from public.tenants where id = p_tenant_id and status in ('trial', 'active')
    )
  ) then raise exception 'Not authorized to manage inventory for this tenant'; end if;
  if p_quantity is null or p_quantity <= 0 then raise exception 'Quantity must be a positive integer'; end if;
  if p_transaction_type is null or p_transaction_type not in ('DAMAGE', 'EXPIRED', 'ADJUSTMENT') then
    raise exception 'Batch-specific stock-out type must be DAMAGE, EXPIRED, or ADJUSTMENT';
  end if;
  if p_remarks is null or length(btrim(p_remarks)) < 3 then
    raise exception 'A reason of at least 3 characters is required';
  end if;

  if p_operation_id is not null then
    perform pg_advisory_xact_lock(hashtextextended(p_tenant_id::text || ':' || p_operation_id, 0));
    select * into existing_operation from public.inventory_transactions
    where tenant_id = p_tenant_id and operation_id = p_operation_id;
    if found then
      if row(existing_operation.location_id, existing_operation.product_id,
             existing_operation.quantity, existing_operation.transaction_type)
         is distinct from row(p_location_id, p_product_id, -p_quantity, p_transaction_type)
        or not exists (
          select 1 from public.inventory_transaction_batches allocation
          where allocation.transaction_id = existing_operation.id
            and allocation.batch_id = p_batch_id
            and allocation.quantity = p_quantity
        ) then
        raise exception 'Operation ID conflicts with an existing inventory request';
      end if;
      return;
    end if;
  end if;

  if not exists (
    select 1 from public.locations
    where id = p_location_id and tenant_id = p_tenant_id and is_active
  ) then raise exception 'Active location not found in tenant'; end if;
  select * into batch_record from public.inventory_batches
  where id = p_batch_id and tenant_id = p_tenant_id
    and location_id = p_location_id and product_id = p_product_id
  for update;
  if not found then raise exception 'Batch not found at this location'; end if;
  if batch_record.quantity < p_quantity then raise exception 'Insufficient stock in selected batch'; end if;
  if p_transaction_type = 'EXPIRED'
     and (batch_record.expiry_date is null or batch_record.expiry_date >= current_date) then
    raise exception 'Only an expired batch can be disposed as expired stock';
  end if;
  select barcode into product_barcode from public.products
  where id = p_product_id and tenant_id = p_tenant_id and is_active;
  if not found then raise exception 'Active product not found in tenant'; end if;
  select quantity into previous_quantity from public.inventory_levels
  where tenant_id = p_tenant_id and location_id = p_location_id and product_id = p_product_id
  for update;
  if not found or previous_quantity < p_quantity then raise exception 'Insufficient stock at location'; end if;

  resulting_quantity := previous_quantity - p_quantity;
  update public.inventory_batches set quantity = quantity - p_quantity, updated_at = now()
  where id = p_batch_id;
  update public.inventory_levels set quantity = resulting_quantity, updated_at = now()
  where tenant_id = p_tenant_id and location_id = p_location_id and product_id = p_product_id;
  update public.products set stock_quantity = stock_quantity - p_quantity, updated_at = now()
  where tenant_id = p_tenant_id and id = p_product_id and stock_quantity >= p_quantity;
  if not found then raise exception 'Aggregate stock is inconsistent'; end if;

  insert into public.inventory_transactions (
    tenant_id, location_id, product_id, barcode, transaction_type, quantity,
    previous_stock, new_stock, remarks, created_by, operation_id
  ) values (
    p_tenant_id, p_location_id, p_product_id, product_barcode, p_transaction_type, -p_quantity,
    previous_quantity, resulting_quantity, btrim(p_remarks),
    (request_context->>'user_id')::uuid, p_operation_id
  ) returning id into transaction_id;
  insert into public.inventory_transaction_batches (tenant_id, transaction_id, batch_id, quantity)
  values (p_tenant_id, transaction_id, p_batch_id, p_quantity);
end;
$$;

create function public.stock_out_sale_fefo(
  p_tenant_id uuid,
  p_location_id uuid,
  p_product_id uuid,
  p_quantity integer,
  p_remarks text default null,
  p_operation_id text default null
)
returns void language plpgsql security definer
set search_path = pg_catalog, public, pg_temp
as $$
begin
  perform public.stock_out_fefo(
    p_tenant_id, p_location_id, p_product_id, p_quantity,
    'SALE', p_remarks, p_operation_id
  );
end;
$$;

create function public.inventory_location_is_active(p_tenant_id uuid, p_location_id uuid)
returns boolean language sql stable security definer
set search_path = pg_catalog, public, pg_temp
as $$
  select exists (
    select 1 from public.locations
    where tenant_id = p_tenant_id and id = p_location_id and is_active
  );
$$;

create function public.inventory_location_name_internal(p_tenant_id uuid, p_location_id uuid)
returns text language sql stable security definer
set search_path = pg_catalog, public, pg_temp
as $$
  select name from public.locations
  where tenant_id = p_tenant_id and id = p_location_id and is_active;
$$;

create or replace function public.stock_out(
  p_tenant_id uuid, p_location_id uuid, p_product_id uuid, p_quantity integer,
  p_transaction_type text, p_remarks text default null, p_operation_id text default null
)
returns void language plpgsql security definer
set search_path = pg_catalog, public, pg_temp
as $$
begin
  if p_transaction_type is null or p_transaction_type not in ('DAMAGE', 'EXPIRED', 'ADJUSTMENT', 'SALE') then
    raise exception 'Invalid stock-out transaction type: %', p_transaction_type;
  end if;
  if p_transaction_type <> 'SALE' then
    raise exception 'Batch selection is required for DAMAGE, EXPIRED, and ADJUSTMENT';
  end if;
  perform public.stock_out_sale_fefo(
    p_tenant_id, p_location_id, p_product_id, p_quantity, p_remarks, p_operation_id
  );
end;
$$;

revoke execute on function public.stock_out_fefo(uuid, uuid, uuid, integer, text, text, text)
  from authenticated, service_role;

create function public.create_inventory_transfer(
  p_tenant_id uuid,
  p_source_location_id uuid,
  p_destination_location_id uuid,
  p_batch_id uuid,
  p_quantity integer,
  p_remarks text default null,
  p_operation_id text default null
)
returns uuid
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  transfer_id uuid;
  transfer_reference text;
  batch_record public.inventory_batches%rowtype;
  existing_event public.inventory_transfer_events%rowtype;
  existing_transfer public.inventory_transfers%rowtype;
  existing_item public.inventory_transfer_items%rowtype;
  source_location_name text;
  destination_location_name text;
  request_context jsonb := public.inventory_request_context();
begin
  if not public.can_manage_inventory_at_location(p_tenant_id, p_source_location_id) then
    raise exception 'Not authorized to create a transfer from this location';
  end if;
  if p_source_location_id = p_destination_location_id then
    raise exception 'Source and destination locations must be different';
  end if;
  if p_quantity is null or p_quantity <= 0 then raise exception 'Quantity must be a positive integer'; end if;
  if p_operation_id is null or length(btrim(p_operation_id)) = 0 then raise exception 'Operation ID is required'; end if;

  perform pg_advisory_xact_lock(hashtextextended(p_tenant_id::text || ':' || p_operation_id, 0));
  select * into existing_event from public.inventory_transfer_events
  where tenant_id = p_tenant_id and operation_id = p_operation_id;
  if found then
    select * into existing_transfer from public.inventory_transfers where id = existing_event.transfer_id;
    select * into existing_item from public.inventory_transfer_items
    where inventory_transfer_items.transfer_id = existing_event.transfer_id;
    if existing_event.event_type <> 'CREATED'
      or existing_transfer.source_location_id <> p_source_location_id
      or existing_transfer.destination_location_id <> p_destination_location_id
      or existing_item.source_batch_id <> p_batch_id
      or existing_item.quantity_requested <> p_quantity then
      raise exception 'Operation ID conflicts with an existing transfer request';
    end if;
    return existing_event.transfer_id;
  end if;

  if not public.inventory_location_is_active(p_tenant_id, p_destination_location_id) then
    raise exception 'Active destination location not found in tenant';
  end if;
  source_location_name := public.inventory_location_name_internal(p_tenant_id, p_source_location_id);
  destination_location_name := public.inventory_location_name_internal(p_tenant_id, p_destination_location_id);
  select * into batch_record from public.inventory_batches
  where tenant_id = p_tenant_id and id = p_batch_id
    and location_id = p_source_location_id and quantity >= p_quantity;
  if not found then raise exception 'Source batch does not have enough stock'; end if;

  transfer_id := gen_random_uuid();
  transfer_reference := 'TRF-' || to_char(current_date, 'YYYYMMDD') || '-' || upper(left(replace(transfer_id::text, '-', ''), 8));
  insert into public.inventory_transfers (
    id, tenant_id, source_location_id, source_location_name,
    destination_location_id, destination_location_name,
    reference, remarks, created_by
  ) values (
    transfer_id, p_tenant_id, p_source_location_id, source_location_name,
    p_destination_location_id, destination_location_name,
    transfer_reference, nullif(btrim(p_remarks), ''), (request_context->>'user_id')::uuid
  );
  insert into public.inventory_transfer_items (
    tenant_id, transfer_id, product_id, source_batch_id,
    batch_number, expiry_date, quantity_requested
  ) values (
    p_tenant_id, transfer_id, batch_record.product_id, batch_record.id,
    batch_record.batch_number, batch_record.expiry_date, p_quantity
  );
  insert into public.inventory_transfer_events (
    tenant_id, transfer_id, event_type, operation_id, actor_id
  ) values (
    p_tenant_id, transfer_id, 'CREATED', p_operation_id,
    (request_context->>'user_id')::uuid
  );
  return transfer_id;
end;
$$;

create function public.get_inventory_transfer_destinations(
  p_tenant_id uuid,
  p_source_location_id uuid
)
returns table (id uuid, name text, code text)
language plpgsql
stable
security definer
set search_path = pg_catalog, public, pg_temp
as $$
begin
  if not public.can_manage_inventory_at_location(p_tenant_id, p_source_location_id) then
    raise exception 'Not authorized to transfer stock from this location';
  end if;
  return query
  select location.id, location.name, location.code
  from public.locations location
  where location.tenant_id = p_tenant_id
    and location.id <> p_source_location_id
    and location.is_active
  order by location.name;
end;
$$;

create function public.dispatch_inventory_transfer(p_transfer_id uuid, p_operation_id text)
returns void
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  transfer_record public.inventory_transfers%rowtype;
  item_record public.inventory_transfer_items%rowtype;
  batch_record public.inventory_batches%rowtype;
  previous_quantity integer;
  resulting_quantity integer;
  product_barcode text;
  transaction_id uuid;
  existing_event public.inventory_transfer_events%rowtype;
  request_context jsonb := public.inventory_request_context();
begin
  if p_operation_id is null or length(btrim(p_operation_id)) = 0 then raise exception 'Operation ID is required'; end if;
  select * into transfer_record from public.inventory_transfers where id = p_transfer_id for update;
  if not found then raise exception 'Transfer not found'; end if;
  if not public.can_manage_inventory_at_location(transfer_record.tenant_id, transfer_record.source_location_id) then
    raise exception 'Not authorized to dispatch this transfer';
  end if;
  perform pg_advisory_xact_lock(hashtextextended(transfer_record.tenant_id::text || ':' || p_operation_id, 0));
  select * into existing_event from public.inventory_transfer_events
  where tenant_id = transfer_record.tenant_id and operation_id = p_operation_id;
  if found then
    if existing_event.event_type <> 'DISPATCHED' or existing_event.transfer_id <> p_transfer_id then
      raise exception 'Operation ID conflicts with an existing transfer request';
    end if;
    return;
  end if;
  if transfer_record.status <> 'draft' then raise exception 'Only a draft transfer can be dispatched'; end if;
  select * into item_record from public.inventory_transfer_items where transfer_id = p_transfer_id for update;
  select * into batch_record from public.inventory_batches
  where id = item_record.source_batch_id and quantity >= item_record.quantity_requested for update;
  if not found then raise exception 'Source batch no longer has enough stock'; end if;
  select quantity into previous_quantity from public.inventory_levels
  where tenant_id = transfer_record.tenant_id and location_id = transfer_record.source_location_id
    and product_id = item_record.product_id for update;
  if not found or previous_quantity < item_record.quantity_requested then
    raise exception 'Source location no longer has enough stock';
  end if;
  select barcode into product_barcode from public.products
  where tenant_id = transfer_record.tenant_id and id = item_record.product_id;
  resulting_quantity := previous_quantity - item_record.quantity_requested;

  update public.inventory_batches set quantity = quantity - item_record.quantity_requested, updated_at = now()
  where id = item_record.source_batch_id;
  update public.inventory_levels set quantity = resulting_quantity, updated_at = now()
  where tenant_id = transfer_record.tenant_id and location_id = transfer_record.source_location_id
    and product_id = item_record.product_id;
  update public.inventory_transfer_items
  set quantity_dispatched = quantity_requested, updated_at = now() where id = item_record.id;
  update public.inventory_transfers
  set status = 'dispatched', dispatched_by = (request_context->>'user_id')::uuid,
      dispatched_at = now(), updated_at = now() where id = p_transfer_id;

  insert into public.inventory_transactions (
    tenant_id, location_id, product_id, barcode, transaction_type, quantity,
    previous_stock, new_stock, remarks, created_by, operation_id
  ) values (
    transfer_record.tenant_id, transfer_record.source_location_id, item_record.product_id,
    product_barcode, 'TRANSFER_OUT', -item_record.quantity_requested,
    previous_quantity, resulting_quantity, 'Transfer ' || transfer_record.reference,
    (request_context->>'user_id')::uuid, p_operation_id
  ) returning id into transaction_id;
  insert into public.inventory_transaction_batches (tenant_id, transaction_id, batch_id, quantity)
  values (transfer_record.tenant_id, transaction_id, item_record.source_batch_id, item_record.quantity_requested);
  insert into public.inventory_transfer_events (
    tenant_id, transfer_id, event_type, quantity, operation_id, actor_id
  ) values (
    transfer_record.tenant_id, p_transfer_id, 'DISPATCHED', item_record.quantity_requested,
    p_operation_id, (request_context->>'user_id')::uuid
  );
  insert into public.inventory_alerts (
    tenant_id, location_id, product_id, batch_id, transfer_id,
    alert_type, severity, quantity, message
  ) values (
    transfer_record.tenant_id, transfer_record.destination_location_id, item_record.product_id,
    item_record.source_batch_id, p_transfer_id, 'TRANSFER_PENDING_RECEIPT', 'info',
    item_record.quantity_requested,
    'Transfer ' || transfer_record.reference || ' is awaiting receipt.'
  );
end;
$$;

create function public.receive_inventory_transfer(
  p_transfer_id uuid,
  p_quantity integer,
  p_operation_id text
)
returns void
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  transfer_record public.inventory_transfers%rowtype;
  item_record public.inventory_transfer_items%rowtype;
  destination_batch public.inventory_batches%rowtype;
  previous_quantity integer;
  resulting_quantity integer;
  resulting_received integer;
  product_barcode text;
  transaction_id uuid;
  existing_event public.inventory_transfer_events%rowtype;
  request_context jsonb := public.inventory_request_context();
begin
  if p_quantity is null or p_quantity <= 0 then raise exception 'Quantity must be a positive integer'; end if;
  if p_operation_id is null or length(btrim(p_operation_id)) = 0 then raise exception 'Operation ID is required'; end if;
  select * into transfer_record from public.inventory_transfers where id = p_transfer_id for update;
  if not found then raise exception 'Transfer not found'; end if;
  if not public.can_manage_inventory_at_location(transfer_record.tenant_id, transfer_record.destination_location_id) then
    raise exception 'Not authorized to receive this transfer';
  end if;
  perform pg_advisory_xact_lock(hashtextextended(transfer_record.tenant_id::text || ':' || p_operation_id, 0));
  select * into existing_event from public.inventory_transfer_events
  where tenant_id = transfer_record.tenant_id and operation_id = p_operation_id;
  if found then
    if existing_event.event_type <> 'RECEIVED' or existing_event.transfer_id <> p_transfer_id
      or existing_event.quantity <> p_quantity then
      raise exception 'Operation ID conflicts with an existing transfer request';
    end if;
    return;
  end if;
  if transfer_record.status not in ('dispatched', 'partially_received') then
    raise exception 'Only a dispatched transfer can be received';
  end if;
  select * into item_record from public.inventory_transfer_items where transfer_id = p_transfer_id for update;
  if p_quantity > item_record.quantity_dispatched - item_record.quantity_received then
    raise exception 'Received quantity exceeds the outstanding transfer quantity';
  end if;

  insert into public.inventory_levels (tenant_id, location_id, product_id, quantity)
  values (transfer_record.tenant_id, transfer_record.destination_location_id, item_record.product_id, 0)
  on conflict (tenant_id, location_id, product_id) do nothing;
  select quantity into previous_quantity from public.inventory_levels
  where tenant_id = transfer_record.tenant_id and location_id = transfer_record.destination_location_id
    and product_id = item_record.product_id for update;

  perform pg_advisory_xact_lock(hashtextextended(
    transfer_record.tenant_id::text || ':' || transfer_record.destination_location_id::text || ':' ||
    item_record.product_id::text || ':' || lower(item_record.batch_number) || ':' ||
    coalesce(item_record.expiry_date::text, 'none'), 0
  ));
  select * into destination_batch from public.inventory_batches
  where tenant_id = transfer_record.tenant_id
    and location_id = transfer_record.destination_location_id
    and product_id = item_record.product_id
    and lower(batch_number) = lower(item_record.batch_number)
    and expiry_date is not distinct from item_record.expiry_date
  for update;
  if found then
    update public.inventory_batches set quantity = quantity + p_quantity, updated_at = now()
    where id = destination_batch.id;
  else
    insert into public.inventory_batches (
      tenant_id, location_id, product_id, batch_number, expiry_date, quantity, created_by
    ) values (
      transfer_record.tenant_id, transfer_record.destination_location_id, item_record.product_id,
      item_record.batch_number, item_record.expiry_date, p_quantity,
      (request_context->>'user_id')::uuid
    ) returning * into destination_batch;
  end if;

  resulting_quantity := previous_quantity + p_quantity;
  resulting_received := item_record.quantity_received + p_quantity;
  update public.inventory_levels set quantity = resulting_quantity, updated_at = now()
  where tenant_id = transfer_record.tenant_id and location_id = transfer_record.destination_location_id
    and product_id = item_record.product_id;
  update public.inventory_transfer_items
  set quantity_received = resulting_received, updated_at = now() where id = item_record.id;
  update public.inventory_transfers
  set status = case when resulting_received = item_record.quantity_dispatched
      then 'received' else 'partially_received' end,
      received_by = (request_context->>'user_id')::uuid,
      received_at = case when resulting_received = item_record.quantity_dispatched then now() else received_at end,
      updated_at = now()
  where id = p_transfer_id;
  select barcode into product_barcode from public.products
  where tenant_id = transfer_record.tenant_id and id = item_record.product_id;
  insert into public.inventory_transactions (
    tenant_id, location_id, product_id, barcode, transaction_type, quantity,
    previous_stock, new_stock, remarks, created_by, operation_id
  ) values (
    transfer_record.tenant_id, transfer_record.destination_location_id, item_record.product_id,
    product_barcode, 'TRANSFER_IN', p_quantity, previous_quantity, resulting_quantity,
    'Transfer ' || transfer_record.reference,
    (request_context->>'user_id')::uuid, p_operation_id
  ) returning id into transaction_id;
  insert into public.inventory_transaction_batches (tenant_id, transaction_id, batch_id, quantity)
  values (transfer_record.tenant_id, transaction_id, destination_batch.id, p_quantity);
  insert into public.inventory_transfer_events (
    tenant_id, transfer_id, event_type, quantity, operation_id, actor_id
  ) values (
    transfer_record.tenant_id, p_transfer_id, 'RECEIVED', p_quantity,
    p_operation_id, (request_context->>'user_id')::uuid
  );
  if resulting_received = item_record.quantity_dispatched then
    update public.inventory_alerts set status = 'resolved', resolved_at = now()
    where transfer_id = p_transfer_id and alert_type = 'TRANSFER_PENDING_RECEIPT'
      and status in ('active', 'acknowledged');
  else
    update public.inventory_alerts
    set quantity = item_record.quantity_dispatched - resulting_received,
        message = 'Transfer ' || transfer_record.reference || ' is partially received.'
    where transfer_id = p_transfer_id and alert_type = 'TRANSFER_PENDING_RECEIPT'
      and status in ('active', 'acknowledged');
  end if;
end;
$$;

create function public.cancel_inventory_transfer(p_transfer_id uuid, p_operation_id text, p_reason text)
returns void
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  transfer_record public.inventory_transfers%rowtype;
  item_record public.inventory_transfer_items%rowtype;
  source_batch public.inventory_batches%rowtype;
  return_quantity integer;
  previous_quantity integer;
  resulting_quantity integer;
  product_barcode text;
  transaction_id uuid;
  existing_event public.inventory_transfer_events%rowtype;
  request_context jsonb := public.inventory_request_context();
begin
  if p_operation_id is null or length(btrim(p_operation_id)) = 0 then raise exception 'Operation ID is required'; end if;
  if p_reason is null or length(btrim(p_reason)) < 3 then raise exception 'A cancellation reason is required'; end if;
  select * into transfer_record from public.inventory_transfers where id = p_transfer_id for update;
  if not found then raise exception 'Transfer not found'; end if;
  if not public.can_manage_inventory_at_location(transfer_record.tenant_id, transfer_record.source_location_id) then
    raise exception 'Not authorized to cancel this transfer';
  end if;
  perform pg_advisory_xact_lock(hashtextextended(transfer_record.tenant_id::text || ':' || p_operation_id, 0));
  select * into existing_event from public.inventory_transfer_events
  where tenant_id = transfer_record.tenant_id and operation_id = p_operation_id;
  if found then
    if existing_event.event_type <> 'CANCELLED' or existing_event.transfer_id <> p_transfer_id then
      raise exception 'Operation ID conflicts with an existing transfer request';
    end if;
    return;
  end if;
  if transfer_record.status not in ('draft', 'dispatched', 'partially_received') then
    raise exception 'This transfer can no longer be cancelled';
  end if;
  select * into item_record from public.inventory_transfer_items where transfer_id = p_transfer_id for update;
  return_quantity := item_record.quantity_dispatched - item_record.quantity_received;
  if return_quantity > 0 then
    select * into source_batch from public.inventory_batches where id = item_record.source_batch_id for update;
    select quantity into previous_quantity from public.inventory_levels
    where tenant_id = transfer_record.tenant_id and location_id = transfer_record.source_location_id
      and product_id = item_record.product_id for update;
    resulting_quantity := previous_quantity + return_quantity;
    update public.inventory_batches set quantity = quantity + return_quantity, updated_at = now()
    where id = item_record.source_batch_id;
    update public.inventory_levels set quantity = resulting_quantity, updated_at = now()
    where tenant_id = transfer_record.tenant_id and location_id = transfer_record.source_location_id
      and product_id = item_record.product_id;
    select barcode into product_barcode from public.products
    where tenant_id = transfer_record.tenant_id and id = item_record.product_id;
    insert into public.inventory_transactions (
      tenant_id, location_id, product_id, barcode, transaction_type, quantity,
      previous_stock, new_stock, remarks, created_by, operation_id
    ) values (
      transfer_record.tenant_id, transfer_record.source_location_id, item_record.product_id,
      product_barcode, 'TRANSFER_RETURN', return_quantity, previous_quantity, resulting_quantity,
      'Cancelled transfer ' || transfer_record.reference || ': ' || btrim(p_reason),
      (request_context->>'user_id')::uuid, p_operation_id
    ) returning id into transaction_id;
    insert into public.inventory_transaction_batches (tenant_id, transaction_id, batch_id, quantity)
    values (transfer_record.tenant_id, transaction_id, item_record.source_batch_id, return_quantity);
  end if;
  update public.inventory_transfers
  set status = 'cancelled', cancelled_by = (request_context->>'user_id')::uuid,
      cancelled_at = now(), updated_at = now() where id = p_transfer_id;
  insert into public.inventory_transfer_events (
    tenant_id, transfer_id, event_type, quantity, operation_id, actor_id, metadata
  ) values (
    transfer_record.tenant_id, p_transfer_id, 'CANCELLED', nullif(return_quantity, 0),
    p_operation_id, (request_context->>'user_id')::uuid,
    jsonb_build_object('reason', btrim(p_reason))
  );
  update public.inventory_alerts set status = 'resolved', resolved_at = now()
  where transfer_id = p_transfer_id and alert_type = 'TRANSFER_PENDING_RECEIPT'
    and status in ('active', 'acknowledged');
end;
$$;

create view public.inventory_transfer_report
with (security_invoker = true)
as
select
  transfer.id,
  transfer.tenant_id,
  transfer.reference,
  transfer.status,
  transfer.source_location_id,
  transfer.source_location_name,
  transfer.destination_location_id,
  transfer.destination_location_name,
  item.id as item_id,
  item.product_id,
  product.name as product_name,
  item.source_batch_id,
  item.batch_number,
  item.expiry_date,
  item.quantity_requested,
  item.quantity_dispatched,
  item.quantity_received,
  item.quantity_dispatched - item.quantity_received as quantity_outstanding,
  transfer.remarks,
  transfer.created_by,
  coalesce(creator.name, creator.email, 'System') as creator_name,
  transfer.created_at,
  transfer.dispatched_at,
  transfer.received_at,
  transfer.cancelled_at,
  transfer.updated_at
from public.inventory_transfers transfer
join public.inventory_transfer_items item
  on item.tenant_id = transfer.tenant_id and item.transfer_id = transfer.id
join public.products product
  on product.tenant_id = item.tenant_id and product.id = item.product_id
left join public.profiles creator on creator.id = transfer.created_by;

create or replace function public.get_inventory_report_summary(
  p_tenant_id uuid,
  p_location_id uuid,
  p_from timestamptz,
  p_to_exclusive timestamptz
)
returns table (
  current_units bigint,
  products_at_location bigint,
  stock_received bigint,
  stock_issued bigint,
  total_transactions bigint
)
language plpgsql
stable
security invoker
set search_path = pg_catalog, public, pg_temp
as $$
begin
  if auth.uid() is null or not exists (
    select 1 from public.locations
    where tenant_id = p_tenant_id and id = p_location_id and is_active
  ) or not public.can_access_location(p_tenant_id, p_location_id) then
    raise exception 'Not authorized to view reports for this location';
  end if;
  if p_from is null or p_to_exclusive is null or p_from >= p_to_exclusive then
    raise exception 'Invalid report date range';
  end if;
  if p_to_exclusive - p_from > interval '366 days' then
    raise exception 'Report date range cannot exceed 366 days';
  end if;

  return query
  select
    coalesce((select sum(level.quantity)::bigint from public.inventory_levels level
      where level.tenant_id = p_tenant_id and level.location_id = p_location_id), 0::bigint),
    coalesce((select count(*)::bigint from public.inventory_levels level
      where level.tenant_id = p_tenant_id and level.location_id = p_location_id and level.quantity > 0), 0::bigint),
    coalesce((select sum(transaction.quantity)::bigint from public.inventory_transactions transaction
      where transaction.tenant_id = p_tenant_id and transaction.location_id = p_location_id
        and transaction.transaction_type in ('RECEIPT', 'TRANSFER_IN', 'TRANSFER_RETURN')
        and transaction.created_at >= p_from and transaction.created_at < p_to_exclusive), 0::bigint),
    coalesce((select sum(abs(transaction.quantity))::bigint from public.inventory_transactions transaction
      where transaction.tenant_id = p_tenant_id and transaction.location_id = p_location_id
        and transaction.transaction_type in ('SALE', 'DAMAGE', 'EXPIRED', 'ADJUSTMENT', 'TRANSFER_OUT')
        and transaction.created_at >= p_from and transaction.created_at < p_to_exclusive), 0::bigint),
    coalesce((select count(*)::bigint from public.inventory_transactions transaction
      where transaction.tenant_id = p_tenant_id and transaction.location_id = p_location_id
        and transaction.created_at >= p_from and transaction.created_at < p_to_exclusive), 0::bigint);
end;
$$;

grant select on public.inventory_transfers, public.inventory_transfer_items,
  public.inventory_transfer_events, public.inventory_transfer_report to authenticated;
grant all on public.inventory_transfers, public.inventory_transfer_items,
  public.inventory_transfer_events to service_role;
grant select on public.inventory_transfer_report to service_role;

grant select, insert, update on public.inventory_transfers,
  public.inventory_transfer_items, public.inventory_transfer_events to inventory_rpc_executor;
grant select, insert, update on public.inventory_alerts to inventory_rpc_executor;
create policy "Inventory RPC manages transfers" on public.inventory_transfers
for all to inventory_rpc_executor using (true) with check (true);
create policy "Inventory RPC manages transfer items" on public.inventory_transfer_items
for all to inventory_rpc_executor using (true) with check (true);
create policy "Inventory RPC manages transfer events" on public.inventory_transfer_events
for all to inventory_rpc_executor using (true) with check (true);
create policy "Inventory RPC manages transfer alerts" on public.inventory_alerts
for all to inventory_rpc_executor using (true) with check (true);

revoke all on function public.stock_out_batch(uuid, uuid, uuid, uuid, integer, text, text, text)
  from public, anon;
revoke all on function public.stock_out_sale_fefo(uuid, uuid, uuid, integer, text, text)
  from public, anon;
revoke all on function public.create_inventory_transfer(uuid, uuid, uuid, uuid, integer, text, text)
  from public, anon;
revoke all on function public.get_inventory_transfer_destinations(uuid, uuid) from public, anon;
revoke all on function public.inventory_location_is_active(uuid, uuid)
  from public, anon, authenticated, service_role;
revoke all on function public.inventory_location_name_internal(uuid, uuid)
  from public, anon, authenticated, service_role;
revoke all on function public.dispatch_inventory_transfer(uuid, text) from public, anon;
revoke all on function public.receive_inventory_transfer(uuid, integer, text) from public, anon;
revoke all on function public.cancel_inventory_transfer(uuid, text, text) from public, anon;
grant execute on function public.stock_out_batch(uuid, uuid, uuid, uuid, integer, text, text, text),
  public.stock_out_sale_fefo(uuid, uuid, uuid, integer, text, text),
  public.create_inventory_transfer(uuid, uuid, uuid, uuid, integer, text, text),
  public.get_inventory_transfer_destinations(uuid, uuid),
  public.dispatch_inventory_transfer(uuid, text),
  public.receive_inventory_transfer(uuid, integer, text),
  public.cancel_inventory_transfer(uuid, text, text) to authenticated, service_role;
grant execute on function public.inventory_location_is_active(uuid, uuid) to inventory_rpc_executor;
grant execute on function public.inventory_location_name_internal(uuid, uuid) to inventory_rpc_executor;

grant create on schema public to inventory_rpc_executor;
alter function public.stock_out_batch(uuid, uuid, uuid, uuid, integer, text, text, text)
  owner to inventory_rpc_executor;
alter function public.stock_out_sale_fefo(uuid, uuid, uuid, integer, text, text)
  owner to inventory_rpc_executor;
alter function public.stock_out(uuid, uuid, uuid, integer, text, text, text)
  owner to inventory_rpc_executor;
alter function public.create_inventory_transfer(uuid, uuid, uuid, uuid, integer, text, text)
  owner to inventory_rpc_executor;
alter function public.dispatch_inventory_transfer(uuid, text) owner to inventory_rpc_executor;
alter function public.receive_inventory_transfer(uuid, integer, text) owner to inventory_rpc_executor;
alter function public.cancel_inventory_transfer(uuid, text, text) owner to inventory_rpc_executor;
revoke create on schema public from inventory_rpc_executor;

comment on table public.inventory_transfers is
  'Audited inter-location transfers; dispatched but unreceived units remain tenant-owned stock in transit.';
comment on view public.inventory_transfer_report is
  'RLS-protected transfer projection shared by the mobile app and administration dashboard.';

commit;
