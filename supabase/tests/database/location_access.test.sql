begin;
create extension if not exists pgtap with schema extensions;
set search_path = public, extensions;
select no_plan();

insert into auth.users (id, email) values
 ('81000000-0000-4000-8000-000000000001', 'manager-location@test.invalid'),
 ('81000000-0000-4000-8000-000000000002', 'warehouse-location@test.invalid');
insert into public.tenants (id, name, slug) values
 ('82000000-0000-4000-8000-000000000001', 'Location Test', 'location-test');
insert into public.tenant_memberships (tenant_id, user_id, role) values
 ('82000000-0000-4000-8000-000000000001', '81000000-0000-4000-8000-000000000001', 'manager'),
 ('82000000-0000-4000-8000-000000000001', '81000000-0000-4000-8000-000000000002', 'warehouse');
insert into public.locations (id, tenant_id, name, code) values
 ('83000000-0000-4000-8000-000000000001', '82000000-0000-4000-8000-000000000001', 'Accra', 'ACC'),
 ('83000000-0000-4000-8000-000000000002', '82000000-0000-4000-8000-000000000001', 'Kaneshie', 'KAN'),
 ('83000000-0000-4000-8000-000000000003', '82000000-0000-4000-8000-000000000001', 'Achimota', 'ACH');
insert into public.location_memberships (tenant_id, location_id, user_id) values
 ('82000000-0000-4000-8000-000000000001', '83000000-0000-4000-8000-000000000001', '81000000-0000-4000-8000-000000000001'),
 ('82000000-0000-4000-8000-000000000001', '83000000-0000-4000-8000-000000000002', '81000000-0000-4000-8000-000000000001'),
 ('82000000-0000-4000-8000-000000000001', '83000000-0000-4000-8000-000000000001', '81000000-0000-4000-8000-000000000002');
insert into public.products (id, tenant_id, name, slug, price)
values ('84000000-0000-4000-8000-000000000001', '82000000-0000-4000-8000-000000000001', 'Medicine', 'medicine', 1);

set local role authenticated;
select set_config('request.jwt.claims','{"sub":"81000000-0000-4000-8000-000000000001","role":"authenticated"}',true);
select is((select count(*) from public.locations), 2::bigint, 'manager sees only Accra and Kaneshie');
select ok(public.can_manage_orders_at_location('82000000-0000-4000-8000-000000000001','83000000-0000-4000-8000-000000000002'), 'manager manages orders at assigned location');
select ok(not public.can_access_location('82000000-0000-4000-8000-000000000001','83000000-0000-4000-8000-000000000003'), 'manager cannot access Achimota');

select set_config('request.jwt.claims','{"sub":"81000000-0000-4000-8000-000000000002","role":"authenticated"}',true);
select is((select count(*) from public.locations), 1::bigint, 'warehouse user sees only Accra');
select lives_ok($$select public.stock_in('82000000-0000-4000-8000-000000000001','83000000-0000-4000-8000-000000000001','84000000-0000-4000-8000-000000000001',5,null,'allowed-location')$$, 'warehouse stock-in succeeds at assigned location');
select throws_ok($$select public.stock_in('82000000-0000-4000-8000-000000000001','83000000-0000-4000-8000-000000000002','84000000-0000-4000-8000-000000000001',5,null,'blocked-location')$$, 'P0001', 'Active location not found in tenant', 'warehouse stock-in fails at unassigned location');
select ok(not public.can_manage_orders_at_location('82000000-0000-4000-8000-000000000001','83000000-0000-4000-8000-000000000001'), 'warehouse role cannot manage orders');

reset role;
select * from finish();
rollback;
