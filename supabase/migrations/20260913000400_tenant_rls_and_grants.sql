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

create policy "Public can read active products"
on public.products for select
to anon, authenticated
using (is_active and tenant_id is not null);
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

create policy "Public can read active categories"
on public.categories for select to anon, authenticated
using (is_active and tenant_id is not null);
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
using (public.is_tenant_member(id));
create policy "Tenant admins can update tenants"
on public.tenants for update to authenticated
using (public.has_tenant_role(id, array['owner', 'admin']))
with check (public.has_tenant_role(id, array['owner', 'admin']));

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

revoke all on all tables in schema public from anon, authenticated;
grant select on public.products, public.categories to anon, authenticated;
grant select on public.tenants, public.locations, public.tenant_memberships,
  public.inventory_levels, public.inventory_transactions, public.customers,
  public.orders, public.order_tracking, public.profiles to authenticated;
grant insert, update, delete on public.products, public.categories,
  public.locations, public.tenant_memberships, public.customers to authenticated;
grant update on public.tenants to authenticated;
grant update on public.profiles to authenticated;

revoke all on all functions in schema public from public, anon, authenticated;
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
