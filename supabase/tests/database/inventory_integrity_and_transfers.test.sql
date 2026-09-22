begin;
create extension if not exists pgtap with schema extensions;
set search_path = public, extensions;
select no_plan();

insert into auth.users (id, email) values
 ('c1000000-0000-4000-8000-000000000001', 'source-manager@test.invalid'),
 ('c1000000-0000-4000-8000-000000000002', 'destination-warehouse@test.invalid'),
 ('c1000000-0000-4000-8000-000000000003', 'transfer-viewer@test.invalid'),
 ('c1000000-0000-4000-8000-000000000004', 'source-warehouse@test.invalid');
insert into public.tenants (id, name, slug) values
 ('c2000000-0000-4000-8000-000000000001', 'Transfer Test', 'transfer-test');
insert into public.tenant_memberships (tenant_id, user_id, role) values
 ('c2000000-0000-4000-8000-000000000001', 'c1000000-0000-4000-8000-000000000001', 'manager'),
 ('c2000000-0000-4000-8000-000000000001', 'c1000000-0000-4000-8000-000000000002', 'warehouse'),
 ('c2000000-0000-4000-8000-000000000001', 'c1000000-0000-4000-8000-000000000003', 'viewer'),
 ('c2000000-0000-4000-8000-000000000001', 'c1000000-0000-4000-8000-000000000004', 'warehouse');
insert into public.locations (id, tenant_id, name, code) values
 ('c3000000-0000-4000-8000-000000000001', 'c2000000-0000-4000-8000-000000000001', 'Source', 'SRC'),
 ('c3000000-0000-4000-8000-000000000002', 'c2000000-0000-4000-8000-000000000001', 'Destination', 'DST');
insert into public.location_memberships (tenant_id, location_id, user_id) values
 ('c2000000-0000-4000-8000-000000000001', 'c3000000-0000-4000-8000-000000000001', 'c1000000-0000-4000-8000-000000000001'),
 ('c2000000-0000-4000-8000-000000000001', 'c3000000-0000-4000-8000-000000000002', 'c1000000-0000-4000-8000-000000000002'),
 ('c2000000-0000-4000-8000-000000000001', 'c3000000-0000-4000-8000-000000000001', 'c1000000-0000-4000-8000-000000000003'),
 ('c2000000-0000-4000-8000-000000000001', 'c3000000-0000-4000-8000-000000000001', 'c1000000-0000-4000-8000-000000000004');
insert into public.products (id, tenant_id, name, slug, price)
values ('c4000000-0000-4000-8000-000000000001', 'c2000000-0000-4000-8000-000000000001', 'Transfer Medicine', 'transfer-medicine', 1);

select has_table('public', 'inventory_transfers', 'inventory transfers table exists');
select has_table('public', 'inventory_transfer_items', 'transfer items table exists');
select has_table('public', 'inventory_transfer_events', 'transfer event audit table exists');
select has_view('public', 'inventory_transfer_report', 'dashboard transfer report exists');
select has_function('public', 'stock_out_batch', array['uuid','uuid','uuid','uuid','integer','text','text','text'], 'selected-batch stock-out RPC exists');
select has_function('public', 'create_inventory_transfer', array['uuid','uuid','uuid','uuid','integer','text','text'], 'transfer creation RPC exists');

set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"c1000000-0000-4000-8000-000000000001","role":"authenticated"}', true);
select is(
  (select count(*) from public.get_inventory_transfer_destinations(
    'c2000000-0000-4000-8000-000000000001','c3000000-0000-4000-8000-000000000001'
  )), 1::bigint,
  'source manager can discover an active destination without gaining location inventory access'
);
select lives_ok(
  $$select public.stock_in_batch('c2000000-0000-4000-8000-000000000001','c3000000-0000-4000-8000-000000000001','c4000000-0000-4000-8000-000000000001',10,'LOT-EARLY',current_date + 10,null,'integrity-early')$$,
  'source manager receives early batch'
);
select lives_ok(
  $$select public.stock_in_batch('c2000000-0000-4000-8000-000000000001','c3000000-0000-4000-8000-000000000001','c4000000-0000-4000-8000-000000000001',20,'LOT-LATER',current_date + 60,null,'integrity-later')$$,
  'source manager receives later batch'
);
select lives_ok(
  $$select public.stock_in_batch('c2000000-0000-4000-8000-000000000001','c3000000-0000-4000-8000-000000000001','c4000000-0000-4000-8000-000000000001',3,'LOT-EXPIRED',current_date,null,'integrity-expired')$$,
  'source manager receives expiry test batch'
);

select lives_ok(
  $$select public.stock_out_batch(
    'c2000000-0000-4000-8000-000000000001','c3000000-0000-4000-8000-000000000001','c4000000-0000-4000-8000-000000000001',
    (select id from public.inventory_batches where batch_number = 'LOT-LATER'),
    2,'DAMAGE','Damaged packaging','integrity-damage')$$,
  'damage is removed from a selected batch'
);
select is((select quantity from public.inventory_batches where batch_number = 'LOT-EARLY'), 10, 'selected damage does not consume the FEFO batch');
select is((select quantity from public.inventory_batches where batch_number = 'LOT-LATER'), 18, 'selected damage reduces only the chosen batch');
select throws_ok(
  $$select public.stock_out_batch(
    'c2000000-0000-4000-8000-000000000001','c3000000-0000-4000-8000-000000000001','c4000000-0000-4000-8000-000000000001',
    (select id from public.inventory_batches where batch_number = 'LOT-EARLY'),
    1,'EXPIRED','Expired disposal','integrity-not-expired')$$,
  'P0001','Only an expired batch can be disposed as expired stock',
  'non-expired batch cannot be recorded as expired disposal'
);

reset role;
set local role inventory_rpc_executor;
update public.inventory_batches set expiry_date = current_date - 1 where batch_number = 'LOT-EXPIRED';
reset role;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"c1000000-0000-4000-8000-000000000001","role":"authenticated"}', true);
select lives_ok(
  $$select public.stock_out_batch(
    'c2000000-0000-4000-8000-000000000001','c3000000-0000-4000-8000-000000000001','c4000000-0000-4000-8000-000000000001',
    (select id from public.inventory_batches where batch_number = 'LOT-EXPIRED'),
    1,'EXPIRED','Expired disposal','integrity-expired-out')$$,
  'expired disposal removes the selected expired batch'
);

select lives_ok(
  $$select public.create_inventory_transfer(
    'c2000000-0000-4000-8000-000000000001','c3000000-0000-4000-8000-000000000001','c3000000-0000-4000-8000-000000000002',
    (select id from public.inventory_batches where batch_number = 'LOT-LATER'),8,'Branch replenishment','transfer-create-1')$$,
  'source manager creates a draft transfer'
);
select lives_ok(
  $$select public.create_inventory_transfer(
    'c2000000-0000-4000-8000-000000000001','c3000000-0000-4000-8000-000000000001','c3000000-0000-4000-8000-000000000002',
    (select id from public.inventory_batches where batch_number = 'LOT-LATER'),8,'Branch replenishment','transfer-create-1')$$,
  'transfer creation retry is idempotent'
);
select is((select count(*) from public.inventory_transfers), 1::bigint, 'transfer creation retry does not duplicate the transfer');
select lives_ok(
  format('select public.dispatch_inventory_transfer(%L,%L)', (select id::text from public.inventory_transfers), 'transfer-dispatch-1'),
  'source manager dispatches the transfer'
);
select is((select status from public.inventory_transfers), 'dispatched', 'transfer is dispatched');
select is((select count(*) from public.inventory_transfer_report), 1::bigint, 'source manager can read the shared transfer projection');
select is((select stock_quantity from public.products where id = 'c4000000-0000-4000-8000-000000000001'), 30, 'tenant aggregate includes stock in transit');
select is((select quantity from public.inventory_levels where location_id = 'c3000000-0000-4000-8000-000000000001'), 22, 'dispatch removes stock from source availability');
select is((select count(*) from public.inventory_alerts where alert_type = 'TRANSFER_PENDING_RECEIPT' and status = 'active'), 0::bigint, 'source-only user cannot see destination transfer alert');
select throws_ok(
  format('select public.receive_inventory_transfer(%L,3,%L)', (select id::text from public.inventory_transfers), 'transfer-receive-denied'),
  'P0001','Not authorized to receive this transfer',
  'source manager cannot receive for an unauthorized destination'
);

select set_config('request.jwt.claims', '{"sub":"c1000000-0000-4000-8000-000000000002","role":"authenticated"}', true);
select is((select count(*) from public.inventory_transfer_report), 1::bigint, 'destination warehouse can read the incoming transfer projection');
select is((select count(*) from public.inventory_alerts where alert_type = 'TRANSFER_PENDING_RECEIPT' and status = 'active'), 1::bigint, 'destination warehouse sees pending transfer alert');
select lives_ok(
  format('select public.receive_inventory_transfer(%L,3,%L)', (select id::text from public.inventory_transfers), 'transfer-receive-1'),
  'destination warehouse partially receives the transfer'
);
select is((select status from public.inventory_transfers), 'partially_received', 'partial receipt updates transfer status');
select is((select quantity_received from public.inventory_transfer_items), 3, 'partial receipt is audited');
select lives_ok(
  format('select public.receive_inventory_transfer(%L,3,%L)', (select id::text from public.inventory_transfers), 'transfer-receive-1'),
  'partial receipt retry is idempotent'
);
select is((select quantity from public.inventory_levels where location_id = 'c3000000-0000-4000-8000-000000000002'), 3, 'receipt retry does not duplicate destination stock');
select lives_ok(
  format('select public.receive_inventory_transfer(%L,5,%L)', (select id::text from public.inventory_transfers), 'transfer-receive-2'),
  'destination warehouse completes the receipt'
);
select is((select status from public.inventory_transfers), 'received', 'completed receipt updates transfer status');
select is((select quantity from public.inventory_batches where location_id = 'c3000000-0000-4000-8000-000000000002' and batch_number = 'LOT-LATER'), 8, 'destination preserves batch identity and quantity');
select is((select count(*) from public.inventory_alerts where alert_type = 'TRANSFER_PENDING_RECEIPT' and status = 'resolved'), 1::bigint, 'completed receipt resolves the transfer alert');

select set_config('request.jwt.claims', '{"sub":"c1000000-0000-4000-8000-000000000001","role":"authenticated"}', true);
select lives_ok(
  $$select public.create_inventory_transfer(
    'c2000000-0000-4000-8000-000000000001','c3000000-0000-4000-8000-000000000001','c3000000-0000-4000-8000-000000000002',
    (select id from public.inventory_batches where location_id = 'c3000000-0000-4000-8000-000000000001' and batch_number = 'LOT-LATER'),4,'Partial cancellation','transfer-create-2')$$,
  'source manager creates a second transfer'
);
select lives_ok(
  format('select public.dispatch_inventory_transfer(%L,%L)', (select id::text from public.inventory_transfers where status = 'draft'), 'transfer-dispatch-2'),
  'second transfer is dispatched'
);
select set_config('request.jwt.claims', '{"sub":"c1000000-0000-4000-8000-000000000002","role":"authenticated"}', true);
select lives_ok(
  format('select public.receive_inventory_transfer(%L,1,%L)', (select id::text from public.inventory_transfers where status = 'dispatched'), 'transfer-receive-3'),
  'destination receives part of the second transfer'
);
select set_config('request.jwt.claims', '{"sub":"c1000000-0000-4000-8000-000000000001","role":"authenticated"}', true);
select lives_ok(
  format('select public.cancel_inventory_transfer(%L,%L,%L)', (select id::text from public.inventory_transfers where status = 'partially_received'), 'transfer-cancel-2', 'Destination short received'),
  'source cancels the outstanding transfer balance'
);
select is((select count(*) from public.inventory_transfers where status = 'cancelled'), 1::bigint, 'partially received transfer becomes cancelled');
reset role;
select is((select sum(quantity)::integer from public.inventory_levels where tenant_id = 'c2000000-0000-4000-8000-000000000001'), 30, 'location balances reconcile after partial receipt and cancellation');
select is((select stock_quantity from public.products where id = 'c4000000-0000-4000-8000-000000000001'), 30, 'tenant aggregate remains reconciled after transfers');

set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"c1000000-0000-4000-8000-000000000004","role":"authenticated"}', true);
select throws_ok(
  $$select public.create_inventory_transfer(
    'c2000000-0000-4000-8000-000000000001','c3000000-0000-4000-8000-000000000001','c3000000-0000-4000-8000-000000000002',
    (select id from public.inventory_batches where location_id = 'c3000000-0000-4000-8000-000000000001' and batch_number = 'LOT-EARLY'),1,null,'warehouse-transfer')$$,
  'P0001','Not authorized to create a transfer from this location',
  'warehouse staff cannot create a transfer'
);
select throws_ok(
  format('select public.dispatch_inventory_transfer(%L,%L)', (select id::text from public.inventory_transfers limit 1), 'warehouse-dispatch'),
  'P0001','Not authorized to dispatch this transfer',
  'warehouse staff cannot dispatch a transfer'
);
select throws_ok(
  format('select public.cancel_inventory_transfer(%L,%L,%L)', (select id::text from public.inventory_transfers limit 1), 'warehouse-cancel', 'Not authorized'),
  'P0001','Not authorized to cancel this transfer',
  'warehouse staff cannot cancel a transfer'
);

select set_config('request.jwt.claims', '{"sub":"c1000000-0000-4000-8000-000000000001","role":"authenticated"}', true);
select throws_ok(
  $$select public.stock_out_batch(
    'c2000000-0000-4000-8000-000000000001','c3000000-0000-4000-8000-000000000002','c4000000-0000-4000-8000-000000000001',
    (select id from public.inventory_batches where location_id = 'c3000000-0000-4000-8000-000000000002' and batch_number = 'LOT-LATER'),
    1,'DAMAGE','Unauthorized location','manager-destination-damage')$$,
  'P0001','Not authorized to manage inventory at this location',
  'batch stock-out requires access to the selected location'
);

select set_config('request.jwt.claims', '{"sub":"c1000000-0000-4000-8000-000000000003","role":"authenticated"}', true);
select throws_ok(
  $$select public.create_inventory_transfer(
    'c2000000-0000-4000-8000-000000000001','c3000000-0000-4000-8000-000000000001','c3000000-0000-4000-8000-000000000002',
    (select id from public.inventory_batches where location_id = 'c3000000-0000-4000-8000-000000000001' and batch_number = 'LOT-EARLY'),1,null,'viewer-transfer')$$,
  'P0001','Not authorized to create a transfer from this location',
  'viewer cannot create a transfer'
);

reset role;
set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select throws_ok(
  $$update public.inventory_transfers set status = 'received' where status = 'cancelled'$$,
  'P0001','Inventory batches may only be changed through stock RPCs',
  'service role cannot bypass transfer lifecycle RPCs'
);

reset role;
select * from finish();
rollback;
