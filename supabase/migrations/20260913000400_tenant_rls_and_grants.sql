begin;

drop policy if exists "Admins can delete categories" on public.categories;
drop policy if exists "Admins can insert categories" on public.categories;
drop policy if exists "Admins can update categories" on public.categories;
drop policy if exists "Authenticated users can read categories" on public.categories;
drop policy if exists "Admins can delete products" on public.products;
drop policy if exists "Admins can insert products" on public.products;
drop policy if exists "Admins can update products" on public.products;
drop policy if exists "Products are viewable by everyone" on public.products;
drop policy if exists "Authenticated users can read all transactions" on public.inventory_transactions;
drop policy if exists "Users can view own orders" on public.orders;
drop policy if exists "Order tracking is viewable" on public.order_tracking;
drop policy if exists "Admins can read all profiles" on public.profiles;
drop policy if exists "System can insert profiles" on public.profiles;
drop policy if exists "Users can read own profile" on public.profiles;
drop policy if exists "Users can update own profile" on public.profiles;
drop policy if exists "Users can view own profile" on public.users;

-- RESTRICT is deliberate: unexpected dependencies must stop this migration.
drop function public.is_admin();
drop function public.can_manage_inventory();

create policy "Users can update own profile"
on public.profiles for update to authenticated
using (auth.uid() = id) with check (auth.uid() = id);

create policy "Members can read tenant products"
on public.products for select
to authenticated
using (public.is_tenant_member(tenant_id));
create policy "Tenant product managers can insert"
on public.products for insert to authenticated
with check (public.has_tenant_role(tenant_id, array['owner', 'admin', 'manager']));
create policy "Tenant product managers can update"
on public.products for update to authenticated
using (public.has_tenant_role(tenant_id, array['owner', 'admin', 'manager']))
with check (public.has_tenant_role(tenant_id, array['owner', 'admin', 'manager']));
create policy "Tenant admins can delete products"
on public.products for delete to authenticated
using (public.has_tenant_role(tenant_id, array['owner', 'admin']));

create policy "Members can read tenant categories"
on public.categories for select to authenticated
using (public.is_tenant_member(tenant_id));
create policy "Tenant category managers can insert"
on public.categories for insert to authenticated
with check (public.has_tenant_role(tenant_id, array['owner', 'admin', 'manager']));
create policy "Tenant category managers can update"
on public.categories for update to authenticated
using (public.has_tenant_role(tenant_id, array['owner', 'admin', 'manager']))
with check (public.has_tenant_role(tenant_id, array['owner', 'admin', 'manager']));
create policy "Tenant admins can delete categories"
on public.categories for delete to authenticated
using (public.has_tenant_role(tenant_id, array['owner', 'admin']));

create policy "Members can read inventory transactions"
on public.inventory_transactions for select to authenticated
using (public.is_tenant_member(tenant_id));
create policy "Members can read inventory levels"
on public.inventory_levels for select to authenticated
using (public.is_tenant_member(tenant_id));

create policy "Members can read their tenants"
on public.tenants for select to authenticated
using (public.is_platform_admin() or public.is_tenant_member(id));
create policy "Tenant admins can update tenants"
on public.tenants for update to authenticated
using (public.is_platform_admin() or public.has_tenant_role(id, array['owner', 'admin']))
with check (public.is_platform_admin() or public.has_tenant_role(id, array['owner', 'admin']));

create policy "Members can read memberships"
on public.tenant_memberships for select to authenticated
using (public.is_tenant_member(tenant_id));
create policy "Tenant owners can insert memberships"
on public.tenant_memberships for insert to authenticated
with check (public.has_tenant_role(tenant_id, array['owner']));
create policy "Tenant owners can update memberships"
on public.tenant_memberships for update to authenticated
using (public.has_tenant_role(tenant_id, array['owner']))
with check (public.has_tenant_role(tenant_id, array['owner']));
create policy "Tenant owners can delete memberships"
on public.tenant_memberships for delete to authenticated
using (public.has_tenant_role(tenant_id, array['owner']));

create policy "Users can read permitted profiles"
on public.profiles for select to authenticated
using (public.can_view_profile(id));

create policy "Members can read locations"
on public.locations for select to authenticated
using (public.is_tenant_member(tenant_id));
create policy "Tenant managers can insert locations"
on public.locations for insert to authenticated
with check (public.has_tenant_role(tenant_id, array['owner', 'admin', 'manager']));
create policy "Tenant managers can update locations"
on public.locations for update to authenticated
using (public.has_tenant_role(tenant_id, array['owner', 'admin', 'manager']))
with check (public.has_tenant_role(tenant_id, array['owner', 'admin', 'manager']));
create policy "Tenant admins can delete locations"
on public.locations for delete to authenticated
using (public.has_tenant_role(tenant_id, array['owner', 'admin']));

create policy "Customers can read own customer profile"
on public.customers for select to authenticated
using (auth_user_id = auth.uid());
create policy "Order managers can read tenant customers"
on public.customers for select to authenticated
using (public.can_manage_orders(tenant_id));
create policy "Customers can update own customer profile"
on public.customers for update to authenticated
using (auth_user_id = auth.uid())
with check (auth_user_id = auth.uid());
create policy "Order managers can manage customers"
on public.customers for all to authenticated
using (public.can_manage_orders(tenant_id))
with check (public.can_manage_orders(tenant_id));

create policy "Customers can read own orders"
on public.orders for select to authenticated
using (exists (
  select 1 from public.customers
  where customers.id = orders.customer_id
    and customers.tenant_id = orders.tenant_id
    and customers.auth_user_id = auth.uid()
));
create policy "Order managers can read tenant orders"
on public.orders for select to authenticated
using (public.can_manage_orders(tenant_id));

create policy "Customers can read own order tracking"
on public.order_tracking for select to authenticated
using (exists (
  select 1
  from public.orders
  join public.customers on customers.id = orders.customer_id
  where orders.id = order_tracking.order_id
    and orders.tenant_id = order_tracking.tenant_id
    and customers.auth_user_id = auth.uid()
));
create policy "Order managers can read tenant tracking"
on public.order_tracking for select to authenticated
using (public.can_manage_orders(tenant_id));

revoke all on all tables in schema public from public, anon, authenticated;
grant select on public.products, public.categories to authenticated;
grant select on public.tenants, public.locations, public.tenant_memberships,
  public.inventory_levels, public.inventory_transactions, public.customers,
  public.orders, public.order_tracking, public.profiles to authenticated;
grant insert, update, delete on public.products, public.categories,
  public.locations, public.tenant_memberships, public.customers to authenticated;
grant update on public.tenants to authenticated;
grant update (name, avatar_url) on public.profiles to authenticated;

-- Stock is writable only under the isolated RPC owner, never direct API DML.
revoke all on public.products from authenticated;
grant select, delete on public.products to authenticated;
grant insert (id, tenant_id, name, slug, description, price, compare_at_price,
  category, images, metadata, is_active, barcode) on public.products to authenticated;
grant update (name, slug, description, price, compare_at_price,
  category, images, metadata, is_active, barcode) on public.products to authenticated;

revoke all on all functions in schema public from public, anon, authenticated, service_role;
grant execute on function public.is_platform_admin() to authenticated;
grant execute on function public.has_tenant_role(uuid, text[]) to authenticated;
grant execute on function public.is_tenant_member(uuid) to authenticated;
grant execute on function public.can_view_profile(uuid) to authenticated;
grant execute on function public.can_manage_inventory(uuid) to authenticated;
grant execute on function public.can_manage_orders(uuid) to authenticated;
grant execute on function public.create_tenant(text, text) to authenticated;
grant execute on function public.stock_in(uuid, uuid, uuid, integer, text, text) to authenticated;
grant execute on function public.stock_out(uuid, uuid, uuid, integer, text, text, text) to authenticated;

alter default privileges for role postgres in schema public revoke all on tables from anon, authenticated;
alter default privileges for role postgres in schema public revoke all on functions from anon, authenticated;
alter default privileges for role postgres in schema public revoke all on sequences from anon, authenticated;
alter default privileges for role postgres revoke execute on functions from public, anon, authenticated;

-- Backend access stays explicit. Stock-table triggers still require the RPC role.
grant all on all tables in schema public to service_role;
revoke truncate on public.products, public.inventory_levels, public.inventory_transactions from service_role;
grant execute on function public.is_platform_admin(), public.has_tenant_role(uuid, text[]),
  public.is_tenant_member(uuid), public.can_view_profile(uuid), public.can_manage_inventory(uuid),
  public.can_manage_orders(uuid), public.create_tenant(text, text),
  public.stock_in(uuid, uuid, uuid, integer, text, text),
  public.stock_out(uuid, uuid, uuid, integer, text, text, text) to service_role;

grant usage on schema public to inventory_rpc_executor;
grant execute on function public.inventory_request_context() to inventory_rpc_executor;
grant execute on function public.can_manage_inventory(uuid) to inventory_rpc_executor;
grant select on public.tenants, public.locations, public.products,
  public.inventory_levels, public.inventory_transactions to inventory_rpc_executor;
grant update (stock_quantity, updated_at) on public.products to inventory_rpc_executor;
grant insert, update on public.inventory_levels to inventory_rpc_executor;
grant insert on public.inventory_transactions to inventory_rpc_executor;
create policy "Inventory RPC reads tenants" on public.tenants for select to inventory_rpc_executor using (true);
create policy "Inventory RPC reads locations" on public.locations for select to inventory_rpc_executor using (true);
create policy "Inventory RPC reads products" on public.products for select to inventory_rpc_executor using (true);
create policy "Inventory RPC updates products" on public.products for update to inventory_rpc_executor using (true) with check (true);
create policy "Inventory RPC manages levels" on public.inventory_levels for all to inventory_rpc_executor using (true) with check (true);
create policy "Inventory RPC reads transactions" on public.inventory_transactions for select to inventory_rpc_executor using (true);
create policy "Inventory RPC inserts transactions" on public.inventory_transactions for insert to inventory_rpc_executor with check (true);

-- Ownership transfer needs CREATE temporarily; the role cannot create objects afterward.
grant create on schema public to inventory_rpc_executor;
alter function public.stock_in(uuid, uuid, uuid, integer, text, text) owner to inventory_rpc_executor;
alter function public.stock_out(uuid, uuid, uuid, integer, text, text, text) owner to inventory_rpc_executor;
revoke create on schema public from inventory_rpc_executor;

commit;
