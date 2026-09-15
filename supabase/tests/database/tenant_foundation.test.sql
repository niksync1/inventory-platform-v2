begin;
create extension if not exists pgtap with schema extensions;
select plan(20);

select has_table('public', 'tenants', 'tenants table exists');
select has_table('public', 'tenant_memberships', 'tenant memberships table exists');
select has_table('public', 'platform_admins', 'platform admins are separate from tenant roles');
select has_table('public', 'locations', 'locations table exists');
select has_table('public', 'customers', 'customers table exists');
select has_table('public', 'inventory_levels', 'inventory levels table exists');

select has_column('public', 'products', 'tenant_id', 'products are tenant-owned');
select has_column('public', 'inventory_transactions', 'tenant_id', 'transactions are tenant-owned');
select has_column('public', 'inventory_transactions', 'location_id', 'transactions are location-owned');
select has_column('public', 'orders', 'customer_id', 'orders reference customers');

select has_function('public', 'is_tenant_member', array['uuid'], 'tenant membership helper exists');
select has_function('public', 'can_view_profile', array['uuid'], 'profile visibility helper exists');
select has_function('public', 'can_manage_inventory', array['uuid'], 'tenant inventory helper exists');
select has_function('public', 'can_manage_orders', array['uuid'], 'tenant order helper exists');
select has_function('public', 'stock_in', array['uuid','uuid','uuid','integer','text','text'], 'tenant stock-in RPC exists');
select has_function('public', 'stock_out', array['uuid','uuid','uuid','integer','text','text','text'], 'tenant stock-out RPC exists');

select col_not_null('public', 'products', 'tenant_id', 'product tenant is required');
select col_not_null('public', 'inventory_transactions', 'tenant_id', 'transaction tenant is required');
select col_not_null('public', 'inventory_transactions', 'location_id', 'transaction location is required');
select col_not_null('public', 'products', 'stock_quantity', 'product aggregate stock is required');

select * from finish();
rollback;
