begin;

set local search_path = pg_catalog, public, pg_temp;

create table public.inventory_batches (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  location_id uuid not null,
  product_id uuid not null,
  batch_number text not null check (length(btrim(batch_number)) between 1 and 120),
  expiry_date date,
  quantity integer not null default 0 check (quantity >= 0),
  received_at timestamptz not null default now(),
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint inventory_batches_tenant_location_fkey
    foreign key (tenant_id, location_id)
    references public.locations (tenant_id, id) on delete cascade,
  constraint inventory_batches_tenant_product_fkey
    foreign key (tenant_id, product_id)
    references public.products (tenant_id, id) on delete cascade,
  constraint inventory_batches_tenant_id_id_key unique (tenant_id, id)
);

create unique index inventory_batches_identity_uidx
  on public.inventory_batches (
    tenant_id,
    location_id,
    product_id,
    lower(batch_number),
    coalesce(expiry_date, 'infinity'::date)
  );
create index inventory_batches_fefo_idx
  on public.inventory_batches (tenant_id, location_id, product_id, expiry_date, received_at, id)
  where quantity > 0;
create index inventory_batches_expiry_idx
  on public.inventory_batches (tenant_id, location_id, expiry_date)
  where quantity > 0 and expiry_date is not null;

alter table public.inventory_transactions
  add constraint inventory_transactions_tenant_id_id_key unique (tenant_id, id);

create table public.inventory_transaction_batches (
  tenant_id uuid not null,
  transaction_id uuid not null,
  batch_id uuid not null,
  quantity integer not null check (quantity > 0),
  created_at timestamptz not null default now(),
  primary key (transaction_id, batch_id),
  constraint inventory_transaction_batches_transaction_fkey
    foreign key (tenant_id, transaction_id)
    references public.inventory_transactions (tenant_id, id) on delete cascade,
  constraint inventory_transaction_batches_batch_fkey
    foreign key (tenant_id, batch_id)
    references public.inventory_batches (tenant_id, id) on delete restrict
);

create index inventory_transaction_batches_batch_idx
  on public.inventory_transaction_batches (tenant_id, batch_id, created_at desc);

create table public.tenant_inventory_settings (
  tenant_id uuid primary key references public.tenants(id) on delete cascade,
  expiry_warning_days integer not null default 90 check (expiry_warning_days between 31 and 730),
  expiry_critical_days integer not null default 30 check (expiry_critical_days between 1 and 30),
  updated_at timestamptz not null default now(),
  constraint tenant_inventory_settings_warning_order_check
    check (expiry_warning_days > expiry_critical_days)
);

insert into public.tenant_inventory_settings (tenant_id)
select id from public.tenants
on conflict (tenant_id) do nothing;

create function public.create_default_tenant_inventory_settings()
returns trigger language plpgsql security definer
set search_path = pg_catalog, public, pg_temp
as $$
begin
  insert into public.tenant_inventory_settings (tenant_id) values (new.id)
  on conflict (tenant_id) do nothing;
  return new;
end;
$$;
create trigger create_default_tenant_inventory_settings
after insert on public.tenants
for each row execute function public.create_default_tenant_inventory_settings();

-- Existing balances cannot be assigned a real lot retrospectively. Preserve them
-- in an explicitly untracked batch so all stock remains available to FEFO.
insert into public.inventory_batches (
  tenant_id, location_id, product_id, batch_number, expiry_date, quantity, received_at
)
select
  tenant_id,
  location_id,
  product_id,
  'LEGACY-UNTRACKED',
  null,
  quantity,
  updated_at
from public.inventory_levels
where quantity > 0;

alter table public.inventory_alerts
  add column batch_id uuid,
  add constraint inventory_alerts_tenant_batch_fkey
    foreign key (tenant_id, batch_id)
    references public.inventory_batches (tenant_id, id) on delete cascade;

alter table public.inventory_alerts
  drop constraint inventory_alerts_alert_type_check;
alter table public.inventory_alerts
  add constraint inventory_alerts_alert_type_check check (
    alert_type in (
      'LOW_STOCK', 'OUT_OF_STOCK', 'DAMAGE', 'EXPIRED',
      'EXPIRING_90_DAYS', 'EXPIRING_30_DAYS', 'BATCH_EXPIRED'
    )
  );

create unique index inventory_alerts_open_batch_expiry_uidx
  on public.inventory_alerts (tenant_id, batch_id, alert_type)
  where status in ('active', 'acknowledged')
    and batch_id is not null
    and alert_type in ('EXPIRING_90_DAYS', 'EXPIRING_30_DAYS', 'BATCH_EXPIRED');

alter table public.inventory_batches enable row level security;
alter table public.inventory_transaction_batches enable row level security;
alter table public.tenant_inventory_settings enable row level security;

create policy "Assigned members can read inventory batches"
on public.inventory_batches for select to authenticated
using (public.can_access_location(tenant_id, location_id));

create policy "Assigned members can read transaction batches"
on public.inventory_transaction_batches for select to authenticated
using (exists (
  select 1
  from public.inventory_transactions transaction
  where transaction.tenant_id = inventory_transaction_batches.tenant_id
    and transaction.id = inventory_transaction_batches.transaction_id
    and public.can_access_location(transaction.tenant_id, transaction.location_id)
));

create policy "Members can read inventory settings"
on public.tenant_inventory_settings for select to authenticated
using (public.is_tenant_member(tenant_id));
create policy "Tenant admins can update inventory settings"
on public.tenant_inventory_settings for update to authenticated
using (public.has_tenant_role(tenant_id, array['owner', 'admin']))
with check (public.has_tenant_role(tenant_id, array['owner', 'admin']));

create function public.guard_batch_writes()
returns trigger language plpgsql security invoker
set search_path = pg_catalog, public, pg_temp
as $$
begin
  if current_user <> 'inventory_rpc_executor' then
    raise exception 'Inventory batches may only be changed through stock RPCs';
  end if;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$$;

create trigger guard_inventory_batch_writes
before insert or update or delete on public.inventory_batches
for each row execute function public.guard_batch_writes();
create trigger guard_inventory_transaction_batch_writes
before insert or update or delete on public.inventory_transaction_batches
for each row execute function public.guard_batch_writes();

create function public.stock_in_batch(
  p_tenant_id uuid,
  p_location_id uuid,
  p_product_id uuid,
  p_quantity integer,
  p_batch_number text,
  p_expiry_date date,
  p_remarks text default null,
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
  ) then
    raise exception 'Not authorized to manage inventory for this tenant';
  end if;
  if p_quantity is null or p_quantity <= 0 then
    raise exception 'Quantity must be a positive integer';
  end if;
  if p_batch_number is null or length(btrim(p_batch_number)) not between 1 and 120 then
    raise exception 'Batch number is required and must not exceed 120 characters';
  end if;
  if upper(btrim(p_batch_number)) <> 'LEGACY-UNTRACKED' and p_expiry_date is null then
    raise exception 'Expiry date is required for tracked stock';
  end if;
  if p_expiry_date is not null and p_expiry_date < current_date then
    raise exception 'Cannot receive an already expired batch';
  end if;

  if p_operation_id is not null then
    perform pg_advisory_xact_lock(hashtextextended(p_tenant_id::text || ':' || p_operation_id, 0));
    select * into existing_operation from public.inventory_transactions
    where tenant_id = p_tenant_id and operation_id = p_operation_id;
    if found then
      if row(existing_operation.location_id, existing_operation.product_id,
             existing_operation.quantity, existing_operation.transaction_type)
         is distinct from row(p_location_id, p_product_id, p_quantity, 'RECEIPT'::text) then
        raise exception 'Operation ID conflicts with an existing inventory request';
      end if;
      if exists (
        select 1 from public.inventory_transaction_batches
        where inventory_transaction_batches.transaction_id = existing_operation.id
      ) and not exists (
        select 1
        from public.inventory_transaction_batches allocation
        join public.inventory_batches batch on batch.id = allocation.batch_id
        where allocation.transaction_id = existing_operation.id
          and lower(batch.batch_number) = lower(btrim(p_batch_number))
          and batch.expiry_date is not distinct from p_expiry_date
      ) then
        raise exception 'Operation ID conflicts with an existing batch request';
      end if;
      return;
    end if;
  end if;

  if not exists (
    select 1 from public.locations
    where id = p_location_id and tenant_id = p_tenant_id and is_active
  ) then
    raise exception 'Active location not found in tenant';
  end if;
  select barcode into product_barcode from public.products
  where id = p_product_id and tenant_id = p_tenant_id and is_active;
  if not found then raise exception 'Active product not found in tenant'; end if;

  insert into public.inventory_levels (tenant_id, location_id, product_id, quantity)
  values (p_tenant_id, p_location_id, p_product_id, 0)
  on conflict (tenant_id, location_id, product_id) do nothing;
  select quantity into previous_quantity from public.inventory_levels
  where tenant_id = p_tenant_id and location_id = p_location_id and product_id = p_product_id
  for update;

  perform pg_advisory_xact_lock(hashtextextended(
    p_tenant_id::text || ':' || p_location_id::text || ':' || p_product_id::text || ':' ||
    lower(btrim(p_batch_number)) || ':' || coalesce(p_expiry_date::text, 'none'), 0
  ));
  select * into batch_record from public.inventory_batches
  where tenant_id = p_tenant_id and location_id = p_location_id and product_id = p_product_id
    and lower(batch_number) = lower(btrim(p_batch_number))
    and expiry_date is not distinct from p_expiry_date
  for update;
  if found then
    update public.inventory_batches
    set quantity = quantity + p_quantity, updated_at = now()
    where id = batch_record.id;
  else
    insert into public.inventory_batches (
      tenant_id, location_id, product_id, batch_number, expiry_date, quantity, created_by
    ) values (
      p_tenant_id, p_location_id, p_product_id, btrim(p_batch_number), p_expiry_date,
      p_quantity, (request_context->>'user_id')::uuid
    ) returning * into batch_record;
  end if;

  resulting_quantity := previous_quantity + p_quantity;
  update public.inventory_levels set quantity = resulting_quantity, updated_at = now()
  where tenant_id = p_tenant_id and location_id = p_location_id and product_id = p_product_id;
  update public.products set stock_quantity = stock_quantity + p_quantity, updated_at = now()
  where tenant_id = p_tenant_id and id = p_product_id;

  insert into public.inventory_transactions (
    tenant_id, location_id, product_id, barcode, transaction_type, quantity,
    previous_stock, new_stock, remarks, created_by, operation_id
  ) values (
    p_tenant_id, p_location_id, p_product_id, product_barcode, 'RECEIPT', p_quantity,
    previous_quantity, resulting_quantity, p_remarks,
    (request_context->>'user_id')::uuid, p_operation_id
  ) returning id into transaction_id;
  insert into public.inventory_transaction_batches (tenant_id, transaction_id, batch_id, quantity)
  values (p_tenant_id, transaction_id, batch_record.id, p_quantity);
end;
$$;

create function public.stock_out_fefo(
  p_tenant_id uuid,
  p_location_id uuid,
  p_product_id uuid,
  p_quantity integer,
  p_transaction_type text,
  p_remarks text default null,
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
  remaining integer := p_quantity;
  take_quantity integer;
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
  ) then
    raise exception 'Not authorized to manage inventory for this tenant';
  end if;
  if p_quantity is null or p_quantity <= 0 then raise exception 'Quantity must be a positive integer'; end if;
  if p_transaction_type is null or p_transaction_type not in ('DAMAGE', 'EXPIRED', 'ADJUSTMENT', 'SALE') then
    raise exception 'Invalid stock-out transaction type: %', p_transaction_type;
  end if;
  if p_operation_id is not null then
    perform pg_advisory_xact_lock(hashtextextended(p_tenant_id::text || ':' || p_operation_id, 0));
    select * into existing_operation from public.inventory_transactions
    where tenant_id = p_tenant_id and operation_id = p_operation_id;
    if found then
      if row(existing_operation.location_id, existing_operation.product_id,
             existing_operation.quantity, existing_operation.transaction_type)
         is distinct from row(p_location_id, p_product_id, -p_quantity, p_transaction_type) then
        raise exception 'Operation ID conflicts with an existing inventory request';
      end if;
      return;
    end if;
  end if;
  if not exists (
    select 1 from public.locations
    where id = p_location_id and tenant_id = p_tenant_id and is_active
  ) then raise exception 'Active location not found in tenant'; end if;
  select barcode into product_barcode from public.products
  where id = p_product_id and tenant_id = p_tenant_id and is_active;
  if not found then raise exception 'Active product not found in tenant'; end if;

  select quantity into previous_quantity from public.inventory_levels
  where tenant_id = p_tenant_id and location_id = p_location_id and product_id = p_product_id
  for update;
  if not found or previous_quantity < p_quantity then raise exception 'Insufficient stock at location'; end if;

  resulting_quantity := previous_quantity - p_quantity;
  insert into public.inventory_transactions (
    tenant_id, location_id, product_id, barcode, transaction_type, quantity,
    previous_stock, new_stock, remarks, created_by, operation_id
  ) values (
    p_tenant_id, p_location_id, p_product_id, product_barcode, p_transaction_type, -p_quantity,
    previous_quantity, resulting_quantity, p_remarks,
    (request_context->>'user_id')::uuid, p_operation_id
  ) returning id into transaction_id;

  for batch_record in
    select * from public.inventory_batches
    where tenant_id = p_tenant_id and location_id = p_location_id
      and product_id = p_product_id and quantity > 0
    order by expiry_date asc nulls last, received_at asc, id asc
    for update
  loop
    exit when remaining = 0;
    take_quantity := least(remaining, batch_record.quantity);
    update public.inventory_batches
    set quantity = quantity - take_quantity, updated_at = now()
    where id = batch_record.id;
    insert into public.inventory_transaction_batches (tenant_id, transaction_id, batch_id, quantity)
    values (p_tenant_id, transaction_id, batch_record.id, take_quantity);
    remaining := remaining - take_quantity;
  end loop;
  if remaining <> 0 then raise exception 'Batch stock is inconsistent with location stock'; end if;

  update public.inventory_levels set quantity = resulting_quantity, updated_at = now()
  where tenant_id = p_tenant_id and location_id = p_location_id and product_id = p_product_id;
  update public.products set stock_quantity = stock_quantity - p_quantity, updated_at = now()
  where tenant_id = p_tenant_id and id = p_product_id and stock_quantity >= p_quantity;
  if not found then raise exception 'Aggregate stock is inconsistent'; end if;
end;
$$;

-- Backward-compatible endpoints keep old clients consistent with the batch ledger.
create or replace function public.stock_in(
  p_tenant_id uuid, p_location_id uuid, p_product_id uuid, p_quantity integer,
  p_remarks text default null, p_operation_id text default null
)
returns void language plpgsql security definer
set search_path = pg_catalog, public, pg_temp
as $$
begin
  perform public.stock_in_batch(
    p_tenant_id, p_location_id, p_product_id, p_quantity,
    'LEGACY-UNTRACKED', null, p_remarks, p_operation_id
  );
end;
$$;

create or replace function public.stock_out(
  p_tenant_id uuid, p_location_id uuid, p_product_id uuid, p_quantity integer,
  p_transaction_type text, p_remarks text default null, p_operation_id text default null
)
returns void language plpgsql security definer
set search_path = pg_catalog, public, pg_temp
as $$
begin
  perform public.stock_out_fefo(
    p_tenant_id, p_location_id, p_product_id, p_quantity,
    p_transaction_type, p_remarks, p_operation_id
  );
end;
$$;

create function public.refresh_inventory_expiry_alerts(p_tenant_id uuid, p_location_id uuid)
returns void language plpgsql security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  warning_days integer;
  critical_days integer;
begin
  if auth.uid() is null or not public.can_access_location(p_tenant_id, p_location_id) then
    raise exception 'Not authorized to refresh alerts for this location';
  end if;
  select expiry_warning_days, expiry_critical_days into warning_days, critical_days
  from public.tenant_inventory_settings where tenant_id = p_tenant_id;
  warning_days := coalesce(warning_days, 90);
  critical_days := coalesce(critical_days, 30);

  update public.inventory_alerts alert
  set status = 'resolved', resolved_at = now()
  where alert.tenant_id = p_tenant_id and alert.location_id = p_location_id
    and alert.alert_type in ('EXPIRING_90_DAYS', 'EXPIRING_30_DAYS', 'BATCH_EXPIRED')
    and alert.status in ('active', 'acknowledged')
    and not exists (
      select 1 from public.inventory_batches batch
      where batch.id = alert.batch_id and batch.quantity > 0 and batch.expiry_date is not null
        and case alert.alert_type
          when 'BATCH_EXPIRED' then batch.expiry_date < current_date
          when 'EXPIRING_30_DAYS' then batch.expiry_date between current_date and current_date + critical_days
          else batch.expiry_date > current_date + critical_days
            and batch.expiry_date <= current_date + warning_days
        end
    );

  insert into public.inventory_alerts (
    tenant_id, location_id, product_id, batch_id, alert_type, severity,
    quantity, threshold, message
  )
  select
    batch.tenant_id, batch.location_id, batch.product_id, batch.id,
    case
      when batch.expiry_date < current_date then 'BATCH_EXPIRED'
      when batch.expiry_date <= current_date + critical_days then 'EXPIRING_30_DAYS'
      else 'EXPIRING_90_DAYS'
    end,
    case when batch.expiry_date < current_date then 'critical'
      when batch.expiry_date <= current_date + critical_days then 'critical'
      else 'warning' end,
    batch.quantity,
    case when batch.expiry_date <= current_date + critical_days then critical_days else warning_days end,
    product.name || ' batch ' || batch.batch_number ||
      case when batch.expiry_date < current_date then ' expired on '
        else ' expires on ' end || to_char(batch.expiry_date, 'YYYY-MM-DD') || '.'
  from public.inventory_batches batch
  join public.products product on product.tenant_id = batch.tenant_id and product.id = batch.product_id
  where batch.tenant_id = p_tenant_id and batch.location_id = p_location_id
    and batch.quantity > 0 and batch.expiry_date is not null
    and batch.expiry_date <= current_date + warning_days
  on conflict (tenant_id, batch_id, alert_type)
    where status in ('active', 'acknowledged') and batch_id is not null
      and alert_type in ('EXPIRING_90_DAYS', 'EXPIRING_30_DAYS', 'BATCH_EXPIRED')
  do update set quantity = excluded.quantity, message = excluded.message;
end;
$$;

create view public.inventory_expiry_report
with (security_invoker = true)
as
select
  batch.id as batch_id,
  batch.tenant_id,
  batch.location_id,
  batch.product_id,
  product.name as product_name,
  product.category,
  batch.batch_number,
  batch.expiry_date,
  batch.quantity,
  batch.received_at,
  case
    when batch.expiry_date is null then 'untracked'
    when batch.expiry_date < current_date then 'expired'
    when batch.expiry_date <= current_date + settings.expiry_critical_days then 'critical'
    when batch.expiry_date <= current_date + settings.expiry_warning_days then 'warning'
    else 'current'
  end as expiry_status,
  case when batch.expiry_date is null then null else batch.expiry_date - current_date end as days_to_expiry
from public.inventory_batches batch
join public.products product on product.tenant_id = batch.tenant_id and product.id = batch.product_id
join public.tenant_inventory_settings settings on settings.tenant_id = batch.tenant_id
where batch.quantity > 0;

grant select on public.inventory_batches, public.inventory_transaction_batches,
  public.tenant_inventory_settings, public.inventory_expiry_report to authenticated;
grant update (expiry_warning_days, expiry_critical_days, updated_at)
  on public.tenant_inventory_settings to authenticated;

grant all on public.inventory_batches, public.inventory_transaction_batches,
  public.tenant_inventory_settings to service_role;
grant select on public.inventory_expiry_report to service_role;

grant select, insert, update on public.inventory_batches to inventory_rpc_executor;
grant select, insert on public.inventory_transaction_batches to inventory_rpc_executor;
create policy "Inventory RPC manages batches" on public.inventory_batches
for all to inventory_rpc_executor using (true) with check (true);
create policy "Inventory RPC manages transaction batches" on public.inventory_transaction_batches
for all to inventory_rpc_executor using (true) with check (true);

revoke all on function public.stock_in_batch(uuid, uuid, uuid, integer, text, date, text, text)
  from public, anon;
revoke all on function public.stock_out_fefo(uuid, uuid, uuid, integer, text, text, text)
  from public, anon;
revoke all on function public.refresh_inventory_expiry_alerts(uuid, uuid)
  from public, anon;
grant execute on function public.stock_in_batch(uuid, uuid, uuid, integer, text, date, text, text),
  public.stock_out_fefo(uuid, uuid, uuid, integer, text, text, text),
  public.refresh_inventory_expiry_alerts(uuid, uuid) to authenticated, service_role;

revoke all on function public.guard_batch_writes() from public, anon, authenticated, service_role;
revoke all on function public.create_default_tenant_inventory_settings()
  from public, anon, authenticated, service_role;

grant create on schema public to inventory_rpc_executor;
alter function public.stock_in_batch(uuid, uuid, uuid, integer, text, date, text, text)
  owner to inventory_rpc_executor;
alter function public.stock_out_fefo(uuid, uuid, uuid, integer, text, text, text)
  owner to inventory_rpc_executor;
alter function public.stock_in(uuid, uuid, uuid, integer, text, text)
  owner to inventory_rpc_executor;
alter function public.stock_out(uuid, uuid, uuid, integer, text, text, text)
  owner to inventory_rpc_executor;
revoke create on schema public from inventory_rpc_executor;

comment on table public.inventory_batches is
  'Location-scoped inventory lots; null expiry is reserved for migrated or legacy untracked stock.';
comment on table public.inventory_transaction_batches is
  'Immutable allocation ledger linking each inventory transaction to the batches it changed.';

commit;
