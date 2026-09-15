begin;
create extension if not exists pgtap with schema extensions;
set search_path = public, extensions;
select no_plan();

insert into auth.users (id, email) values
 ('10000000-0000-4000-8000-000000000001', 'owner@test.invalid'),
 ('10000000-0000-4000-8000-000000000002', 'customer@test.invalid'),
 ('10000000-0000-4000-8000-000000000003', 'platform@test.invalid');
insert into public.tenants (id,name,slug) values
 ('20000000-0000-4000-8000-000000000001','Test A','test-a'),
 ('20000000-0000-4000-8000-000000000002','Test B','test-b');
insert into public.tenant_memberships (tenant_id,user_id,role) values
 ('20000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000001','owner');
insert into public.platform_admins (user_id) values ('10000000-0000-4000-8000-000000000003');
insert into public.locations (id,tenant_id,name,code) values
 ('30000000-0000-4000-8000-000000000001','20000000-0000-4000-8000-000000000001','Main','MAIN'),
 ('30000000-0000-4000-8000-000000000002','20000000-0000-4000-8000-000000000001','Other','OTHER');
insert into public.products (id,tenant_id,name,slug,price,is_active) values
 ('40000000-0000-4000-8000-000000000001','20000000-0000-4000-8000-000000000001','Active','active',1,true),
 ('40000000-0000-4000-8000-000000000002','20000000-0000-4000-8000-000000000001','Inactive','inactive',1,false),
 ('40000000-0000-4000-8000-000000000003','20000000-0000-4000-8000-000000000002','Other','other',1,true);
insert into public.categories (tenant_id,name,slug,is_active) values
 ('20000000-0000-4000-8000-000000000001','Inactive','inactive',false),
 ('20000000-0000-4000-8000-000000000002','Other','other',true);
insert into public.customers (id,tenant_id,auth_user_id,email) values
 ('50000000-0000-4000-8000-000000000001','20000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000002','customer@test.invalid');
insert into public.orders (id,tenant_id,order_number,email,customer_name,shipping_address,shipping_city,items,subtotal,total) values
 ('60000000-0000-4000-8000-000000000001','20000000-0000-4000-8000-000000000001','ORDER','customer@test.invalid','Customer','Address','City','[]',0,0);

select ok(to_regprocedure('public.is_admin()') is null, 'legacy admin helper removed');
select ok(to_regprocedure('public.can_manage_inventory()') is null, 'legacy inventory helper removed');
select ok(not has_table_privilege('anon','public.products','SELECT'), 'anonymous product access revoked');
select ok(not has_table_privilege('anon','public.categories','SELECT'), 'anonymous category access revoked');
select ok(not pg_has_role('authenticated','inventory_rpc_executor','MEMBER'), 'clients cannot assume RPC owner');
select ok(not has_function_privilege('anon','public.stock_in(uuid,uuid,uuid,integer,text,text)','EXECUTE'), 'anonymous stock RPC forbidden');
select ok(not has_function_privilege('authenticated','public.inventory_request_context()','EXECUTE'), 'internal context adapter is not a client RPC');
create function public.test_default_permissions() returns integer language sql as 'select 1';
select ok(not has_function_privilege('anon','public.test_default_permissions()','EXECUTE'), 'new functions do not inherit anonymous execution');
select ok(not has_function_privilege('authenticated','public.test_default_permissions()','EXECUTE'), 'new functions do not inherit authenticated execution');

select throws_ok($$insert into public.order_tracking(tenant_id,order_id,status) values
 ('20000000-0000-4000-8000-000000000002','60000000-0000-4000-8000-000000000001','pending')$$,
 '23503', null, 'cross-tenant tracking rejected');
select lives_ok($$insert into public.order_tracking(tenant_id,order_id,status) values
 ('20000000-0000-4000-8000-000000000001','60000000-0000-4000-8000-000000000001','pending')$$,
 'same-tenant tracking accepted');

set local role authenticated;
select set_config('request.jwt.claims','{"sub":"10000000-0000-4000-8000-000000000001","role":"authenticated"}',true);
select is((select count(*) from public.products),2::bigint,'owner sees active and inactive own products only');
select is((select count(*) from public.categories),1::bigint,'owner sees inactive own category only');
select throws_ok($$update public.products set stock_quantity=1 where id='40000000-0000-4000-8000-000000000001'$$,
 '42501',null,'direct stock update rejected');
select lives_ok($$update public.tenants set name='Renamed' where id='20000000-0000-4000-8000-000000000001'$$,'tenant owner can edit display name');
select throws_ok($$update public.tenants set plan='enterprise' where id='20000000-0000-4000-8000-000000000001'$$,
 'P0001','Only platform administrators may change tenant plan or status','tenant owner cannot edit plan');
select throws_ok($$update public.tenants set status='suspended' where id='20000000-0000-4000-8000-000000000001'$$,
 'P0001','Only platform administrators may change tenant plan or status','tenant owner cannot edit status');
select lives_ok($$select public.stock_in('20000000-0000-4000-8000-000000000001','30000000-0000-4000-8000-000000000001','40000000-0000-4000-8000-000000000001',10,null,'receipt')$$,'stock in succeeds');
select lives_ok($$select public.stock_in('20000000-0000-4000-8000-000000000001','30000000-0000-4000-8000-000000000001','40000000-0000-4000-8000-000000000001',10,null,'receipt')$$,'equivalent retry succeeds');
select is((select stock_quantity from public.products where id='40000000-0000-4000-8000-000000000001'),10,'retry does not double stock');
select is((select count(*) from public.inventory_transactions where operation_id='receipt'),1::bigint,'retry does not duplicate ledger');
select throws_ok($$select public.stock_in('20000000-0000-4000-8000-000000000001','30000000-0000-4000-8000-000000000001','40000000-0000-4000-8000-000000000001',11,null,'receipt')$$,
 'P0001','Operation ID conflicts with an existing inventory request','different quantity rejected');
select throws_ok($$select public.stock_in('20000000-0000-4000-8000-000000000001','30000000-0000-4000-8000-000000000002','40000000-0000-4000-8000-000000000001',10,null,'receipt')$$,
 'P0001','Operation ID conflicts with an existing inventory request','different location rejected');
select throws_ok($$select public.stock_in('20000000-0000-4000-8000-000000000001','30000000-0000-4000-8000-000000000001','40000000-0000-4000-8000-000000000002',10,null,'receipt')$$,
 'P0001','Operation ID conflicts with an existing inventory request','different product rejected');
select throws_ok($$select public.stock_out('20000000-0000-4000-8000-000000000001','30000000-0000-4000-8000-000000000001','40000000-0000-4000-8000-000000000001',10,'SALE',null,'receipt')$$,
 'P0001','Operation ID conflicts with an existing inventory request','different operation type rejected');
select throws_ok($$select public.stock_out('20000000-0000-4000-8000-000000000001','30000000-0000-4000-8000-000000000001','40000000-0000-4000-8000-000000000001',1,null)$$,
 'P0001','Invalid stock-out transaction type: <NULL>','null transaction type rejected');
select throws_ok($$select public.stock_out('20000000-0000-4000-8000-000000000001','30000000-0000-4000-8000-000000000001','40000000-0000-4000-8000-000000000001',1,'BOGUS')$$,
 'P0001','Invalid stock-out transaction type: BOGUS','invalid transaction type rejected');
select lives_ok($$select public.stock_out('20000000-0000-4000-8000-000000000001','30000000-0000-4000-8000-000000000001','40000000-0000-4000-8000-000000000001',3,'SALE',null,'sale')$$,'stock out succeeds');
select lives_ok($$select public.stock_out('20000000-0000-4000-8000-000000000001','30000000-0000-4000-8000-000000000001','40000000-0000-4000-8000-000000000001',3,'SALE',null,'sale')$$,'stock out retry succeeds');
select is((select quantity from public.inventory_levels where product_id='40000000-0000-4000-8000-000000000001'),7,'location balance correct');
select is((select stock_quantity from public.products where id='40000000-0000-4000-8000-000000000001'),7,'aggregate balance correct');

select set_config('request.jwt.claims','{"sub":"10000000-0000-4000-8000-000000000002","role":"authenticated"}',true);
select lives_ok($$update public.customers set full_name='New name',phone='123',email='new@test.invalid',default_address='New address' where id='50000000-0000-4000-8000-000000000001'$$,'customer can update contact fields');
select throws_ok($$update public.customers set buyer_type='wholesale' where id='50000000-0000-4000-8000-000000000001'$$,
 'P0001','Customers may only update contact and profile fields','customer cannot change buyer type');
select throws_ok($$update public.customers set auth_user_id=null where id='50000000-0000-4000-8000-000000000001'$$,
 'P0001','Customers may only update contact and profile fields','customer cannot change auth ownership');
select throws_ok($$update public.customers set tenant_id='20000000-0000-4000-8000-000000000002' where id='50000000-0000-4000-8000-000000000001'$$,
 'P0001','Customer identity and tenant are immutable','customer cannot move tenants');
select throws_ok($$select public.stock_in('20000000-0000-4000-8000-000000000001','30000000-0000-4000-8000-000000000001','40000000-0000-4000-8000-000000000001',1)$$,
 'P0001','Not authorized to manage inventory for this tenant','nonmember cannot operate stock');

select set_config('request.jwt.claims','{"sub":"10000000-0000-4000-8000-000000000003","role":"authenticated"}',true);
select lives_ok($$update public.tenants set plan='enterprise',status='suspended' where id='20000000-0000-4000-8000-000000000001'$$,'platform admin can change plan and suspend');
select ok(not public.can_manage_inventory('20000000-0000-4000-8000-000000000001'),'platform operational access also rejects suspended tenants');
select set_config('request.jwt.claims','{"sub":"10000000-0000-4000-8000-000000000001","role":"authenticated"}',true);
select ok(not public.is_tenant_member('20000000-0000-4000-8000-000000000001'),'suspended tenant membership rejected');
select is((select count(*) from public.products),0::bigint,'suspended tenant products hidden');
select throws_ok($$select public.stock_in('20000000-0000-4000-8000-000000000001','30000000-0000-4000-8000-000000000001','40000000-0000-4000-8000-000000000001',1)$$,
 'P0001','Not authorized to manage inventory for this tenant','suspended tenant stock rejected');
select set_config('request.jwt.claims','{"sub":"10000000-0000-4000-8000-000000000003","role":"authenticated"}',true);
select lives_ok($$update public.tenants set status='active' where id='20000000-0000-4000-8000-000000000001'$$,'platform admin can reactivate tenant');

reset role;
set local role service_role;
select set_config('request.jwt.claims','{"role":"service_role"}',true);
select ok(not has_table_privilege('service_role','public.inventory_transactions','TRUNCATE'),'backend cannot truncate inventory history');
select throws_ok($$insert into public.products(tenant_id,name,slug,price,stock_quantity) values
 ('20000000-0000-4000-8000-000000000001','Invalid','nonzero-stock',1,9)$$,
 'P0001','Products must start with zero stock; use stock_in','backend cannot insert nonzero stock');
select throws_ok($$update public.inventory_levels set quantity=99 where product_id='40000000-0000-4000-8000-000000000001'$$,
 'P0001','Inventory writes require tenant-aware inventory RPCs','backend cannot directly change location stock');
select throws_ok($$delete from public.inventory_transactions where operation_id='receipt'$$,
 'P0001','Inventory writes require tenant-aware inventory RPCs','backend cannot erase inventory history');
select throws_ok($$update public.products set stock_quantity=99 where id='40000000-0000-4000-8000-000000000001'$$,
 'P0001','Stock changes require tenant-aware inventory RPCs','backend cannot directly change stock');
select lives_ok($$select public.stock_in('20000000-0000-4000-8000-000000000001','30000000-0000-4000-8000-000000000001','40000000-0000-4000-8000-000000000001',1,null,'backend')$$,'backend can use tenant-aware RPC');
reset role;
select * from finish();
rollback;
