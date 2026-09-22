begin;
create extension if not exists pgtap with schema extensions;
set search_path = public, extensions;
select no_plan();

insert into auth.users (id, email) values
 ('b1000000-0000-4000-8000-000000000001', 'warehouse-batch@test.invalid'),
 ('b1000000-0000-4000-8000-000000000002', 'viewer-batch@test.invalid');
insert into public.tenants (id, name, slug) values
 ('b2000000-0000-4000-8000-000000000001', 'Batch Test', 'batch-test');
insert into public.tenant_memberships (tenant_id, user_id, role) values
 ('b2000000-0000-4000-8000-000000000001', 'b1000000-0000-4000-8000-000000000001', 'warehouse'),
 ('b2000000-0000-4000-8000-000000000001', 'b1000000-0000-4000-8000-000000000002', 'viewer');
insert into public.locations (id, tenant_id, name, code) values
 ('b3000000-0000-4000-8000-000000000001', 'b2000000-0000-4000-8000-000000000001', 'Assigned', 'ASSIGNED'),
 ('b3000000-0000-4000-8000-000000000002', 'b2000000-0000-4000-8000-000000000001', 'Other', 'OTHER');
insert into public.location_memberships (tenant_id, location_id, user_id) values
 ('b2000000-0000-4000-8000-000000000001', 'b3000000-0000-4000-8000-000000000001', 'b1000000-0000-4000-8000-000000000001'),
 ('b2000000-0000-4000-8000-000000000001', 'b3000000-0000-4000-8000-000000000001', 'b1000000-0000-4000-8000-000000000002');
insert into public.products (id, tenant_id, name, slug, price)
values ('b4000000-0000-4000-8000-000000000001', 'b2000000-0000-4000-8000-000000000001', 'Batch Medicine', 'batch-medicine', 1);

select has_table('public', 'inventory_batches', 'inventory batches table exists');
select has_table('public', 'inventory_transaction_batches', 'batch allocation ledger exists');
select has_view('public', 'inventory_expiry_report', 'expiry report view exists');
select has_function('public', 'stock_in_batch', array['uuid','uuid','uuid','integer','text','date','text','text'], 'batch stock-in RPC exists');
select has_function('public', 'stock_out_fefo', array['uuid','uuid','uuid','integer','text','text','text'], 'FEFO stock-out RPC exists');
select has_function('public', 'refresh_inventory_expiry_alerts', array['uuid','uuid'], 'expiry alert refresh RPC exists');
select is((select expiry_warning_days from public.tenant_inventory_settings where tenant_id = 'b2000000-0000-4000-8000-000000000001'), 90, 'new tenant receives default expiry settings');

set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"b1000000-0000-4000-8000-000000000001","role":"authenticated"}', true);
select lives_ok(
  $$select public.stock_in_batch('b2000000-0000-4000-8000-000000000001','b3000000-0000-4000-8000-000000000001','b4000000-0000-4000-8000-000000000001',5,'LOT-EARLY',current_date + 10,null,'batch-early')$$,
  'warehouse can receive an expiring batch at an assigned location'
);
select lives_ok(
  $$select public.stock_in_batch('b2000000-0000-4000-8000-000000000001','b3000000-0000-4000-8000-000000000001','b4000000-0000-4000-8000-000000000001',7,'LOT-MIDDLE',current_date + 20,null,'batch-middle')$$,
  'warehouse can receive a second batch'
);
select lives_ok(
  $$select public.stock_in_batch('b2000000-0000-4000-8000-000000000001','b3000000-0000-4000-8000-000000000001','b4000000-0000-4000-8000-000000000001',9,'LOT-LATER',current_date + 60,null,'batch-later')$$,
  'warehouse can receive a later-expiring batch'
);
select lives_ok(
  $$select public.stock_in_batch('b2000000-0000-4000-8000-000000000001','b3000000-0000-4000-8000-000000000001','b4000000-0000-4000-8000-000000000001',5,'LOT-EARLY',current_date + 10,null,'batch-early')$$,
  'equivalent batch receipt retry is idempotent'
);
select is((select quantity from public.inventory_levels where product_id = 'b4000000-0000-4000-8000-000000000001'), 21, 'batch receipts update location stock once');
select is((select sum(quantity)::integer from public.inventory_batches where product_id = 'b4000000-0000-4000-8000-000000000001'), 21, 'batch quantities reconcile with location stock');

select lives_ok(
  $$select public.stock_out_sale_fefo('b2000000-0000-4000-8000-000000000001','b3000000-0000-4000-8000-000000000001','b4000000-0000-4000-8000-000000000001',8,null,'fefo-sale')$$,
  'warehouse can issue stock using FEFO'
);
select is((select quantity from public.inventory_batches where batch_number = 'LOT-EARLY'), 0, 'FEFO empties the earliest batch first');
select is((select quantity from public.inventory_batches where batch_number = 'LOT-MIDDLE'), 4, 'FEFO continues into the next batch');
select is((select count(*) from public.inventory_transaction_batches allocation join public.inventory_transactions transaction on transaction.id = allocation.transaction_id where transaction.operation_id = 'fefo-sale'), 2::bigint, 'stock-out records both batch allocations');
select is((select sum(quantity)::integer from public.inventory_batches where product_id = 'b4000000-0000-4000-8000-000000000001'), 13, 'remaining batches reconcile after FEFO stock-out');

select lives_ok(
  $$select public.refresh_inventory_expiry_alerts('b2000000-0000-4000-8000-000000000001','b3000000-0000-4000-8000-000000000001')$$,
  'assigned member can refresh expiry alerts'
);
select is((select count(*) from public.inventory_alerts where alert_type = 'EXPIRING_30_DAYS' and status = 'active'), 1::bigint, 'critical expiry alert is active');
select is((select count(*) from public.inventory_alerts where alert_type = 'EXPIRING_90_DAYS' and status = 'active'), 1::bigint, 'warning expiry alert is active');

select throws_ok(
  $$select public.stock_in_batch('b2000000-0000-4000-8000-000000000001','b3000000-0000-4000-8000-000000000002','b4000000-0000-4000-8000-000000000001',1,'DENIED',current_date + 30,null,'denied-location')$$,
  'P0001', 'Active location not found in tenant',
  'warehouse cannot receive stock at an unassigned location'
);

select set_config('request.jwt.claims', '{"sub":"b1000000-0000-4000-8000-000000000002","role":"authenticated"}', true);
select is((select count(*) from public.inventory_batches), 3::bigint, 'viewer can read batches at an assigned location');
select throws_ok(
  $$select public.stock_out_sale_fefo('b2000000-0000-4000-8000-000000000001','b3000000-0000-4000-8000-000000000001','b4000000-0000-4000-8000-000000000001',1,null,'viewer-denied')$$,
  'P0001', 'Not authorized to manage inventory for this tenant',
  'viewer cannot issue stock'
);

reset role;
set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select throws_ok(
  $$update public.inventory_batches set quantity = 999 where batch_number = 'LOT-MIDDLE'$$,
  'P0001', 'Inventory batches may only be changed through stock RPCs',
  'service role cannot bypass the batch ledger'
);

reset role;
select * from finish();
rollback;
