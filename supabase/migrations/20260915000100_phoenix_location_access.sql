begin;

set local search_path = pg_catalog, public, pg_temp;

-- Convert the audited bootstrap tenant into the primary demonstration business.
update public.tenants
set name = 'Phoenix Pharmacy', slug = 'phoenix-pharmacy', updated_at = now()
where id = '00000000-0000-4000-8000-000000000001';

update public.locations
set name = 'Accra', code = 'ACC', updated_at = now()
where id = '00000000-0000-4000-8000-000000000002'
  and tenant_id = '00000000-0000-4000-8000-000000000001';

insert into public.locations (id, tenant_id, name, code)
values
  ('00000000-0000-4000-8000-000000000003', '00000000-0000-4000-8000-000000000001', 'Kaneshie', 'KAN'),
  ('00000000-0000-4000-8000-000000000004', '00000000-0000-4000-8000-000000000001', 'Achimota', 'ACH')
on conflict (tenant_id, code) do update
set name = excluded.name, is_active = true, updated_at = now();

create table public.location_memberships (
  tenant_id uuid not null,
  location_id uuid not null,
  user_id uuid not null,
  created_at timestamptz not null default now(),
  primary key (tenant_id, location_id, user_id),
  constraint location_memberships_tenant_location_fkey
    foreign key (tenant_id, location_id)
    references public.locations (tenant_id, id) on delete cascade,
  constraint location_memberships_tenant_user_fkey
    foreign key (tenant_id, user_id)
    references public.tenant_memberships (tenant_id, user_id) on delete cascade
);

create index location_memberships_user_tenant_idx
  on public.location_memberships (user_id, tenant_id);
alter table public.location_memberships enable row level security;

create or replace function public.can_access_location(p_tenant_id uuid, p_location_id uuid)
returns boolean language sql stable security definer
set search_path = pg_catalog, public, pg_temp
as $$
  select exists (
    select 1 from public.tenants where id = p_tenant_id and status in ('trial', 'active')
  ) and (
    public.is_platform_admin()
    or exists (
      select 1 from public.tenant_memberships
      where tenant_id = p_tenant_id and user_id = auth.uid()
        and status = 'active' and role in ('owner', 'admin')
    )
    or exists (
      select 1
      from public.tenant_memberships membership
      join public.location_memberships assignment
        on assignment.tenant_id = membership.tenant_id
       and assignment.user_id = membership.user_id
      join public.locations location
        on location.tenant_id = assignment.tenant_id
       and location.id = assignment.location_id
      where membership.tenant_id = p_tenant_id
        and membership.user_id = auth.uid()
        and membership.status = 'active'
        and assignment.location_id = p_location_id
        and location.is_active
    )
  );
$$;

create or replace function public.can_manage_inventory_at_location(p_tenant_id uuid, p_location_id uuid)
returns boolean language sql stable security definer
set search_path = pg_catalog, public, pg_temp
as $$
  select public.can_access_location(p_tenant_id, p_location_id)
    and public.has_tenant_role(p_tenant_id, array['owner', 'admin', 'manager', 'warehouse']);
$$;

create or replace function public.can_manage_orders_at_location(p_tenant_id uuid, p_location_id uuid)
returns boolean language sql stable security definer
set search_path = pg_catalog, public, pg_temp
as $$
  select public.can_access_location(p_tenant_id, p_location_id)
    and public.has_tenant_role(p_tenant_id, array['owner', 'admin', 'manager']);
$$;

drop policy if exists "Members can read locations" on public.locations;
create policy "Assigned members can read locations"
on public.locations for select to authenticated
using (public.can_access_location(tenant_id, id));

drop policy if exists "Members can read inventory levels" on public.inventory_levels;
create policy "Assigned members can read inventory levels"
on public.inventory_levels for select to authenticated
using (public.can_access_location(tenant_id, location_id));

drop policy if exists "Members can read inventory transactions" on public.inventory_transactions;
create policy "Assigned members can read inventory transactions"
on public.inventory_transactions for select to authenticated
using (public.can_access_location(tenant_id, location_id));

drop policy if exists "Order managers can read tenant orders" on public.orders;
create policy "Assigned order managers can read orders"
on public.orders for select to authenticated
using (location_id is not null and public.can_manage_orders_at_location(tenant_id, location_id));

drop policy if exists "Order managers can read tenant tracking" on public.order_tracking;
create policy "Assigned order managers can read tracking"
on public.order_tracking for select to authenticated
using (exists (
  select 1 from public.orders
  where orders.id = order_tracking.order_id
    and orders.tenant_id = order_tracking.tenant_id
    and orders.location_id is not null
    and public.can_manage_orders_at_location(orders.tenant_id, orders.location_id)
));

create policy "Members can read location assignments"
on public.location_memberships for select to authenticated
using (user_id = auth.uid() or public.has_tenant_role(tenant_id, array['owner', 'admin']));
create policy "Tenant admins can insert location assignments"
on public.location_memberships for insert to authenticated
with check (public.has_tenant_role(tenant_id, array['owner', 'admin']));
create policy "Tenant admins can delete location assignments"
on public.location_memberships for delete to authenticated
using (public.has_tenant_role(tenant_id, array['owner', 'admin']));

grant select, insert, delete on public.location_memberships to authenticated;
grant execute on function public.can_access_location(uuid, uuid) to authenticated;
grant execute on function public.can_manage_inventory_at_location(uuid, uuid) to authenticated;
grant execute on function public.can_manage_orders_at_location(uuid, uuid) to authenticated;

grant all on public.location_memberships to service_role;
grant execute on function public.can_access_location(uuid, uuid),
  public.can_manage_inventory_at_location(uuid, uuid),
  public.can_manage_orders_at_location(uuid, uuid) to service_role;

grant select on public.location_memberships to inventory_rpc_executor;
grant execute on function public.can_access_location(uuid, uuid),
  public.can_manage_inventory_at_location(uuid, uuid) to inventory_rpc_executor;

-- The existing stock RPCs validate an active location before touching balances.
-- Restrict that lookup so tenant membership alone cannot operate another branch.
drop policy if exists "Inventory RPC reads locations" on public.locations;
create policy "Inventory RPC reads authorized locations"
on public.locations for select to inventory_rpc_executor
using (
  coalesce(auth.role() = 'service_role', false)
  or public.can_manage_inventory_at_location(tenant_id, id)
);

-- Owners and admins are represented explicitly for auditing even though their
-- role grants all-location access automatically.
insert into public.location_memberships (tenant_id, location_id, user_id)
select membership.tenant_id, location.id, membership.user_id
from public.tenant_memberships membership
join public.locations location on location.tenant_id = membership.tenant_id
where membership.tenant_id = '00000000-0000-4000-8000-000000000001'
  and membership.status = 'active'
  and membership.role in ('owner', 'admin')
on conflict do nothing;

commit;
