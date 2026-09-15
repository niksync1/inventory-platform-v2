begin;

-- Close default exposure before introducing security-definer RPCs.
alter default privileges for role postgres revoke execute on functions from public;
alter default privileges for role postgres in schema public revoke execute on functions from anon, authenticated;

-- Only these RPCs assume this non-login role; clients cannot SET ROLE to it.
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'inventory_rpc_executor') then
    if exists (select 1 from pg_roles where rolname = 'inventory_rpc_executor'
               and (rolcanlogin or rolsuper or rolbypassrls or rolcreaterole or rolcreatedb or rolinherit))
       or exists (select 1 from pg_auth_members
                  where roleid = 'inventory_rpc_executor'::regrole
                    and member <> 'postgres'::regrole) then
      raise exception 'Unsafe existing inventory_rpc_executor role';
    end if;
  else
    create role inventory_rpc_executor nologin noinherit;
  end if;
end;
$$;
grant inventory_rpc_executor to postgres;

-- The isolated RPC role has no access to Supabase's managed auth schema.
-- Only it may execute this adapter; authorization remains in the stock RPCs.
create function public.inventory_request_context()
returns jsonb language sql stable security definer
set search_path = pg_catalog, public, pg_temp
as $$
  select jsonb_build_object('user_id', auth.uid(), 'service_role', coalesce(auth.role() = 'service_role', false));
$$;

create or replace function public.is_platform_admin()
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public, pg_temp
as $$
  select exists (
    select 1 from public.platform_admins
    where user_id = auth.uid()
  );
$$;

create or replace function public.has_tenant_role(
  p_tenant_id uuid,
  p_roles text[]
)
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public, pg_temp
as $$
  select exists (
    select 1 from public.tenants
    where id = p_tenant_id and status in ('trial', 'active')
  ) and (public.is_platform_admin() or exists (
    select 1
    from public.tenant_memberships
    where tenant_id = p_tenant_id
      and user_id = auth.uid()
      and status = 'active'
      and role = any (p_roles)
  ));
$$;

create or replace function public.is_tenant_member(p_tenant_id uuid)
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public, pg_temp
as $$
  select public.has_tenant_role(
    p_tenant_id,
    array['owner', 'admin', 'manager', 'warehouse', 'viewer']
  );
$$;

create or replace function public.can_view_profile(p_profile_id uuid)
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public, pg_temp
as $$
  select p_profile_id = auth.uid()
    or public.is_platform_admin()
    or exists (
      select 1
      from public.tenant_memberships viewer_membership
      join public.tenant_memberships subject_membership
        on subject_membership.tenant_id = viewer_membership.tenant_id
      where viewer_membership.user_id = auth.uid()
        and viewer_membership.status = 'active'
        and subject_membership.user_id = p_profile_id
        and subject_membership.status = 'active'
        and public.is_tenant_member(viewer_membership.tenant_id)
    );
$$;

create or replace function public.can_manage_inventory(p_tenant_id uuid)
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public, pg_temp
as $$
  select public.has_tenant_role(
    p_tenant_id,
    array['owner', 'admin', 'manager', 'warehouse']
  );
$$;

create or replace function public.can_manage_orders(p_tenant_id uuid)
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public, pg_temp
as $$
  select public.has_tenant_role(
    p_tenant_id,
    array['owner', 'admin', 'manager']
  );
$$;

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $$
begin
  insert into public.profiles (id, email, role)
  values (new.id, new.email, 'customer')
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
after insert on auth.users
for each row execute function public.handle_new_user();

create or replace function public.create_tenant(
  p_name text,
  p_slug text
)
returns uuid
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  created_tenant_id uuid;
begin
  if auth.uid() is null then
    raise exception 'Authentication required';
  end if;
  if nullif(trim(p_name), '') is null or nullif(trim(p_slug), '') is null then
    raise exception 'Tenant name and slug are required';
  end if;

  insert into public.tenants (name, slug, status)
  values (trim(p_name), lower(trim(p_slug)), 'trial')
  returning id into created_tenant_id;

  insert into public.tenant_memberships (tenant_id, user_id, role, status)
  values (created_tenant_id, auth.uid(), 'owner', 'active');

  insert into public.locations (tenant_id, name, code)
  values (created_tenant_id, 'Main Location', 'MAIN');

  return created_tenant_id;
end;
$$;

drop function if exists public.stock_in(uuid, integer, text, text);
drop function if exists public.stock_out(uuid, integer, text, text, text);

create function public.guard_product_stock()
returns trigger language plpgsql security invoker
set search_path = pg_catalog, public, pg_temp
as $$
begin
  if tg_op = 'INSERT' then
    if new.stock_quantity is distinct from 0 then
      raise exception 'Products must start with zero stock; use stock_in';
    end if;
  elsif new.stock_quantity is distinct from old.stock_quantity
        and current_user <> 'inventory_rpc_executor' then
    raise exception 'Stock changes require tenant-aware inventory RPCs';
  end if;
  return new;
end;
$$;
create trigger guard_product_stock before insert or update on public.products
for each row execute function public.guard_product_stock();

create function public.guard_inventory_writes()
returns trigger language plpgsql security invoker
set search_path = pg_catalog, public, pg_temp
as $$
begin
  if current_user <> 'inventory_rpc_executor' then
    raise exception 'Inventory writes require tenant-aware inventory RPCs';
  end if;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$$;
create trigger guard_inventory_writes before insert or update or delete on public.inventory_levels
for each row execute function public.guard_inventory_writes();
create trigger guard_inventory_writes before insert or update or delete on public.inventory_transactions
for each row execute function public.guard_inventory_writes();

create function public.guard_customer_update()
returns trigger language plpgsql security invoker
set search_path = pg_catalog, public, pg_temp
as $$
begin
  if current_user in ('postgres', 'service_role') then return new; end if;
  if new.id is distinct from old.id or new.tenant_id is distinct from old.tenant_id
     or new.created_at is distinct from old.created_at then
    raise exception 'Customer identity and tenant are immutable';
  end if;
  if not public.can_manage_orders(old.tenant_id)
     and (to_jsonb(new) - array['email','full_name','phone','default_address','updated_at'])
       is distinct from (to_jsonb(old) - array['email','full_name','phone','default_address','updated_at']) then
    raise exception 'Customers may only update contact and profile fields';
  end if;
  return new;
end;
$$;
create trigger guard_customer_update before update on public.customers
for each row execute function public.guard_customer_update();

create function public.guard_tenant_update()
returns trigger language plpgsql security invoker
set search_path = pg_catalog, public, pg_temp
as $$
begin
  -- Trusted backend provisioning retains access; user-facing administration
  -- requires an explicit platform_admins entry, never a tenant role.
  if current_user in ('postgres', 'service_role') then return new; end if;
  if new.id is distinct from old.id or new.created_at is distinct from old.created_at then
    raise exception 'Tenant identity is immutable';
  end if;
  if not public.is_platform_admin()
     and (to_jsonb(new) - array['name','slug','updated_at'])
       is distinct from (to_jsonb(old) - array['name','slug','updated_at']) then
    raise exception 'Only platform administrators may change tenant plan or status';
  end if;
  return new;
end;
$$;
create trigger guard_tenant_update before update on public.tenants
for each row execute function public.guard_tenant_update();

create or replace function public.stock_in(
  p_tenant_id uuid,
  p_location_id uuid,
  p_product_id uuid,
  p_quantity integer,
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
  if p_operation_id is not null then
    perform pg_advisory_xact_lock(hashtextextended(p_tenant_id::text || ':' || p_operation_id, 0));
    select * into existing_operation from public.inventory_transactions
    where tenant_id = p_tenant_id and operation_id = p_operation_id;
    if found then
      if row(existing_operation.tenant_id, existing_operation.location_id,
             existing_operation.product_id, existing_operation.quantity, existing_operation.transaction_type)
         is distinct from row(p_tenant_id, p_location_id, p_product_id, p_quantity, 'RECEIPT'::text) then
        raise exception 'Operation ID conflicts with an existing inventory request';
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

  select barcode into product_barcode
  from public.products
  where id = p_product_id and tenant_id = p_tenant_id and is_active;
  if not found then
    raise exception 'Active product not found in tenant';
  end if;

  insert into public.inventory_levels (tenant_id, location_id, product_id, quantity)
  values (p_tenant_id, p_location_id, p_product_id, 0)
  on conflict (tenant_id, location_id, product_id) do nothing;

  select quantity into previous_quantity
  from public.inventory_levels
  where tenant_id = p_tenant_id
    and location_id = p_location_id
    and product_id = p_product_id
  for update;

  resulting_quantity := previous_quantity + p_quantity;
  update public.inventory_levels
  set quantity = resulting_quantity, updated_at = now()
  where tenant_id = p_tenant_id
    and location_id = p_location_id
    and product_id = p_product_id;

  update public.products
  set stock_quantity = stock_quantity + p_quantity, updated_at = now()
  where id = p_product_id and tenant_id = p_tenant_id;

  insert into public.inventory_transactions (
    tenant_id, location_id, product_id, barcode, transaction_type, quantity,
    previous_stock, new_stock, remarks, created_by, operation_id
  ) values (
    p_tenant_id, p_location_id, p_product_id, product_barcode, 'RECEIPT', p_quantity,
    previous_quantity, resulting_quantity, p_remarks, (request_context->>'user_id')::uuid, p_operation_id
  );
end;
$$;

create or replace function public.stock_out(
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
  product_barcode text;
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
  if p_transaction_type is null or p_transaction_type not in ('DAMAGE', 'EXPIRED', 'ADJUSTMENT', 'SALE') then
    raise exception 'Invalid stock-out transaction type: %', p_transaction_type;
  end if;
  if p_operation_id is not null then
    perform pg_advisory_xact_lock(hashtextextended(p_tenant_id::text || ':' || p_operation_id, 0));
    select * into existing_operation from public.inventory_transactions
    where tenant_id = p_tenant_id and operation_id = p_operation_id;
    if found then
      if row(existing_operation.tenant_id, existing_operation.location_id,
             existing_operation.product_id, existing_operation.quantity, existing_operation.transaction_type)
         is distinct from row(p_tenant_id, p_location_id, p_product_id, -p_quantity, p_transaction_type) then
        raise exception 'Operation ID conflicts with an existing inventory request';
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

  select barcode into product_barcode
  from public.products
  where id = p_product_id and tenant_id = p_tenant_id and is_active;
  if not found then
    raise exception 'Active product not found in tenant';
  end if;

  select quantity into previous_quantity
  from public.inventory_levels
  where tenant_id = p_tenant_id
    and location_id = p_location_id
    and product_id = p_product_id
  for update;
  if not found or previous_quantity < p_quantity then
    raise exception 'Insufficient stock at location';
  end if;

  resulting_quantity := previous_quantity - p_quantity;
  update public.inventory_levels
  set quantity = resulting_quantity, updated_at = now()
  where tenant_id = p_tenant_id
    and location_id = p_location_id
    and product_id = p_product_id;

  update public.products
  set stock_quantity = stock_quantity - p_quantity, updated_at = now()
  where id = p_product_id
    and tenant_id = p_tenant_id
    and stock_quantity >= p_quantity;
  if not found then
    raise exception 'Aggregate stock is inconsistent';
  end if;

  insert into public.inventory_transactions (
    tenant_id, location_id, product_id, barcode, transaction_type, quantity,
    previous_stock, new_stock, remarks, created_by, operation_id
  ) values (
    p_tenant_id, p_location_id, p_product_id, product_barcode, p_transaction_type, -p_quantity,
    previous_quantity, resulting_quantity, p_remarks, (request_context->>'user_id')::uuid, p_operation_id
  );
end;
$$;

commit;
