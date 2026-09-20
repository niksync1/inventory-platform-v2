begin;

set local search_path = pg_catalog, public, pg_temp;

alter table public.inventory_levels
  add column reorder_level integer not null default 5
  check (reorder_level >= 0);

create table public.inventory_alerts (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  location_id uuid not null,
  product_id uuid not null,
  source_transaction_id uuid references public.inventory_transactions(id) on delete set null,
  alert_type text not null
    check (alert_type in ('LOW_STOCK', 'OUT_OF_STOCK', 'DAMAGE', 'EXPIRED')),
  severity text not null
    check (severity in ('info', 'warning', 'critical')),
  status text not null default 'active'
    check (status in ('active', 'acknowledged', 'resolved')),
  quantity integer,
  threshold integer,
  message text not null,
  triggered_at timestamptz not null default now(),
  acknowledged_by uuid references public.profiles(id) on delete set null,
  acknowledged_at timestamptz,
  resolved_at timestamptz,
  constraint inventory_alerts_tenant_location_fkey
    foreign key (tenant_id, location_id)
    references public.locations (tenant_id, id) on delete cascade,
  constraint inventory_alerts_tenant_product_fkey
    foreign key (tenant_id, product_id)
    references public.products (tenant_id, id) on delete cascade,
  constraint inventory_alerts_acknowledgement_check check (
    (status <> 'acknowledged')
    or (acknowledged_by is not null and acknowledged_at is not null)
  )
);

create index inventory_alerts_location_status_triggered_idx
  on public.inventory_alerts (tenant_id, location_id, status, triggered_at desc);
create index inventory_alerts_product_triggered_idx
  on public.inventory_alerts (tenant_id, location_id, product_id, triggered_at desc);
create unique index inventory_alerts_open_stock_uidx
  on public.inventory_alerts (tenant_id, location_id, product_id, alert_type)
  where status in ('active', 'acknowledged')
    and alert_type in ('LOW_STOCK', 'OUT_OF_STOCK');
create unique index inventory_alerts_source_transaction_uidx
  on public.inventory_alerts (source_transaction_id)
  where source_transaction_id is not null;

create index inventory_transactions_location_type_created_at_idx
  on public.inventory_transactions (tenant_id, location_id, transaction_type, created_at desc);

alter table public.inventory_alerts enable row level security;

create policy "Assigned members can read inventory alerts"
on public.inventory_alerts for select to authenticated
using (public.can_access_location(tenant_id, location_id));

create or replace function public.sync_inventory_level_alert()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  next_type text;
  next_severity text;
  product_name text;
begin
  select name into product_name
  from public.products
  where tenant_id = new.tenant_id and id = new.product_id;

  if new.quantity <= new.reorder_level then
    next_type := case when new.quantity = 0 then 'OUT_OF_STOCK' else 'LOW_STOCK' end;
    next_severity := case when new.quantity = 0 then 'critical' else 'warning' end;

    update public.inventory_alerts
    set status = 'resolved', resolved_at = now()
    where tenant_id = new.tenant_id
      and location_id = new.location_id
      and product_id = new.product_id
      and alert_type in ('LOW_STOCK', 'OUT_OF_STOCK')
      and alert_type <> next_type
      and status in ('active', 'acknowledged');

    update public.inventory_alerts
    set quantity = new.quantity,
        threshold = new.reorder_level,
        severity = next_severity,
        message = case
          when next_type = 'OUT_OF_STOCK'
            then coalesce(product_name, 'Product') || ' is out of stock.'
          else coalesce(product_name, 'Product') || ' is below its reorder level.'
        end,
        triggered_at = case when quantity is distinct from new.quantity then now() else triggered_at end
    where tenant_id = new.tenant_id
      and location_id = new.location_id
      and product_id = new.product_id
      and alert_type = next_type
      and status in ('active', 'acknowledged');

    if not found then
      insert into public.inventory_alerts (
        tenant_id, location_id, product_id, alert_type, severity,
        quantity, threshold, message
      ) values (
        new.tenant_id, new.location_id, new.product_id, next_type, next_severity,
        new.quantity, new.reorder_level,
        case
          when next_type = 'OUT_OF_STOCK'
            then coalesce(product_name, 'Product') || ' is out of stock.'
          else coalesce(product_name, 'Product') || ' is below its reorder level.'
        end
      );
    end if;
  else
    update public.inventory_alerts
    set status = 'resolved', resolved_at = now()
    where tenant_id = new.tenant_id
      and location_id = new.location_id
      and product_id = new.product_id
      and alert_type in ('LOW_STOCK', 'OUT_OF_STOCK')
      and status in ('active', 'acknowledged');
  end if;

  return new;
end;
$$;

create or replace function public.record_inventory_transaction_alert()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  product_name text;
begin
  if new.transaction_type not in ('DAMAGE', 'EXPIRED') then
    return new;
  end if;

  select name into product_name
  from public.products
  where tenant_id = new.tenant_id and id = new.product_id;

  insert into public.inventory_alerts (
    tenant_id, location_id, product_id, source_transaction_id,
    alert_type, severity, quantity, message
  ) values (
    new.tenant_id,
    new.location_id,
    new.product_id,
    new.id,
    new.transaction_type,
    'warning',
    abs(new.quantity),
    case
      when new.transaction_type = 'DAMAGE'
        then abs(new.quantity)::text || ' damaged unit(s) recorded for ' || coalesce(product_name, 'product') || '.'
      else abs(new.quantity)::text || ' expired unit(s) recorded for ' || coalesce(product_name, 'product') || '.'
    end
  )
  on conflict (source_transaction_id) where source_transaction_id is not null do nothing;

  return new;
end;
$$;

create trigger sync_inventory_level_alert
after insert or update of quantity, reorder_level on public.inventory_levels
for each row execute function public.sync_inventory_level_alert();

create trigger record_inventory_transaction_alert
after insert on public.inventory_transactions
for each row execute function public.record_inventory_transaction_alert();

create view public.inventory_transaction_report
with (security_invoker = true)
as
select
  transaction.id,
  transaction.tenant_id,
  transaction.location_id,
  transaction.product_id,
  product.name as product_name,
  product.category,
  transaction.transaction_type,
  transaction.quantity,
  transaction.previous_stock,
  transaction.new_stock,
  transaction.remarks,
  transaction.created_by,
  coalesce(profile.name, profile.email, 'System') as performer_name,
  profile.email as performer_email,
  transaction.created_at
from public.inventory_transactions transaction
join public.products product
  on product.tenant_id = transaction.tenant_id
 and product.id = transaction.product_id
left join public.profiles profile
  on profile.id = transaction.created_by;

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
    coalesce((
      select sum(level.quantity)::bigint
      from public.inventory_levels level
      where level.tenant_id = p_tenant_id and level.location_id = p_location_id
    ), 0::bigint),
    coalesce((
      select count(*)::bigint
      from public.inventory_levels level
      where level.tenant_id = p_tenant_id
        and level.location_id = p_location_id
        and level.quantity > 0
    ), 0::bigint),
    coalesce((
      select sum(transaction.quantity)::bigint
      from public.inventory_transactions transaction
      where transaction.tenant_id = p_tenant_id
        and transaction.location_id = p_location_id
        and transaction.transaction_type = 'RECEIPT'
        and transaction.created_at >= p_from
        and transaction.created_at < p_to_exclusive
    ), 0::bigint),
    coalesce((
      select sum(abs(transaction.quantity))::bigint
      from public.inventory_transactions transaction
      where transaction.tenant_id = p_tenant_id
        and transaction.location_id = p_location_id
        and transaction.transaction_type <> 'RECEIPT'
        and transaction.created_at >= p_from
        and transaction.created_at < p_to_exclusive
    ), 0::bigint),
    coalesce((
      select count(*)::bigint
      from public.inventory_transactions transaction
      where transaction.tenant_id = p_tenant_id
        and transaction.location_id = p_location_id
        and transaction.created_at >= p_from
        and transaction.created_at < p_to_exclusive
    ), 0::bigint);
end;
$$;

create or replace function public.acknowledge_inventory_alert(p_alert_id uuid)
returns void
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  alert_record public.inventory_alerts%rowtype;
begin
  if auth.uid() is null then
    raise exception 'Authentication required';
  end if;

  select * into alert_record
  from public.inventory_alerts
  where id = p_alert_id;

  if not found then
    raise exception 'Alert not found';
  end if;
  if not public.can_manage_inventory_at_location(
    alert_record.tenant_id,
    alert_record.location_id
  ) then
    raise exception 'Not authorized to acknowledge this alert';
  end if;

  update public.inventory_alerts
  set status = 'acknowledged',
      acknowledged_by = auth.uid(),
      acknowledged_at = now()
  where id = p_alert_id and status = 'active';
end;
$$;

-- Seed current stock conditions without creating duplicate open alerts.
insert into public.inventory_alerts (
  tenant_id, location_id, product_id, alert_type, severity,
  quantity, threshold, message
)
select
  level.tenant_id,
  level.location_id,
  level.product_id,
  case when level.quantity = 0 then 'OUT_OF_STOCK' else 'LOW_STOCK' end,
  case when level.quantity = 0 then 'critical' else 'warning' end,
  level.quantity,
  level.reorder_level,
  case
    when level.quantity = 0 then product.name || ' is out of stock.'
    else product.name || ' is below its reorder level.'
  end
from public.inventory_levels level
join public.products product
  on product.tenant_id = level.tenant_id and product.id = level.product_id
where level.quantity <= level.reorder_level
on conflict (tenant_id, location_id, product_id, alert_type)
where status in ('active', 'acknowledged')
  and alert_type in ('LOW_STOCK', 'OUT_OF_STOCK')
do nothing;

revoke all on public.inventory_alerts from public, anon;
grant select on public.inventory_alerts to authenticated;
grant select on public.inventory_transaction_report to authenticated;

revoke all on function public.get_inventory_report_summary(uuid, uuid, timestamptz, timestamptz) from public, anon;
grant execute on function public.get_inventory_report_summary(uuid, uuid, timestamptz, timestamptz) to authenticated;

revoke all on function public.acknowledge_inventory_alert(uuid) from public, anon;
grant execute on function public.acknowledge_inventory_alert(uuid) to authenticated;

revoke all on function public.sync_inventory_level_alert() from public, anon, authenticated;
revoke all on function public.record_inventory_transaction_alert() from public, anon, authenticated;

grant all on public.inventory_alerts to service_role;
grant select on public.inventory_transaction_report to service_role;
grant execute on function public.get_inventory_report_summary(uuid, uuid, timestamptz, timestamptz),
  public.acknowledge_inventory_alert(uuid) to service_role;

comment on column public.inventory_levels.reorder_level is
  'Location-specific threshold used to create and resolve stock alerts.';
comment on table public.inventory_alerts is
  'Persistent tenant/location-scoped operational alerts derived from the inventory ledger.';

commit;
