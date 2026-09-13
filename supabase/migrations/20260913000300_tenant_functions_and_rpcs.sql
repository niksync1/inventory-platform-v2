create or replace function public.is_platform_admin()
returns boolean
language sql
stable
security definer
set search_path = public
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
set search_path = public
as $$
  select public.is_platform_admin() or exists (
    select 1
    from public.tenant_memberships
    where tenant_id = p_tenant_id
      and user_id = auth.uid()
      and status = 'active'
      and role = any (p_roles)
  );
$$;

create or replace function public.is_tenant_member(p_tenant_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
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
set search_path = public
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
    );
$$;

create or replace function public.can_manage_inventory(p_tenant_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
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
set search_path = public
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
set search_path = public
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
set search_path = public
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
set search_path = public
as $$
declare
  previous_quantity integer;
  resulting_quantity integer;
  product_barcode text;
begin
  if not public.can_manage_inventory(p_tenant_id) then
    raise exception 'Not authorized to manage inventory for this tenant';
  end if;
  if p_quantity is null or p_quantity <= 0 then
    raise exception 'Quantity must be a positive integer';
  end if;
  if p_operation_id is not null and exists (
    select 1 from public.inventory_transactions
    where tenant_id = p_tenant_id and operation_id = p_operation_id
  ) then
    return;
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
    previous_quantity, resulting_quantity, p_remarks, auth.uid(), p_operation_id
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
set search_path = public
as $$
declare
  previous_quantity integer;
  resulting_quantity integer;
  product_barcode text;
begin
  if not public.can_manage_inventory(p_tenant_id) then
    raise exception 'Not authorized to manage inventory for this tenant';
  end if;
  if p_quantity is null or p_quantity <= 0 then
    raise exception 'Quantity must be a positive integer';
  end if;
  if p_transaction_type not in ('DAMAGE', 'EXPIRED', 'ADJUSTMENT', 'SALE') then
    raise exception 'Invalid stock-out transaction type: %', p_transaction_type;
  end if;
  if p_operation_id is not null and exists (
    select 1 from public.inventory_transactions
    where tenant_id = p_tenant_id and operation_id = p_operation_id
  ) then
    return;
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
    previous_quantity, resulting_quantity, p_remarks, auth.uid(), p_operation_id
  );
end;
$$;
