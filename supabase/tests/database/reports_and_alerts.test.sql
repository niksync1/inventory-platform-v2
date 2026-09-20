begin;
create extension if not exists pgtap with schema extensions;
set search_path = public, extensions;
select no_plan();

insert into auth.users (id, email) values
 ('a1000000-0000-4000-8000-000000000001', 'warehouse-report@test.invalid'),
 ('a1000000-0000-4000-8000-000000000002', 'viewer-report@test.invalid');
insert into public.tenants (id, name, slug) values
 ('a2000000-0000-4000-8000-000000000001', 'Report Test', 'report-test');
insert into public.tenant_memberships (tenant_id, user_id, role) values
 ('a2000000-0000-4000-8000-000000000001', 'a1000000-0000-4000-8000-000000000001', 'warehouse'),
 ('a2000000-0000-4000-8000-000000000001', 'a1000000-0000-4000-8000-000000000002', 'viewer');
insert into public.locations (id, tenant_id, name, code) values
 ('a3000000-0000-4000-8000-000000000001', 'a2000000-0000-4000-8000-000000000001', 'Accra', 'ACC');
insert into public.location_memberships (tenant_id, location_id, user_id) values
 ('a2000000-0000-4000-8000-000000000001', 'a3000000-0000-4000-8000-000000000001', 'a1000000-0000-4000-8000-000000000001'),
 ('a2000000-0000-4000-8000-000000000001', 'a3000000-0000-4000-8000-000000000001', 'a1000000-0000-4000-8000-000000000002');
insert into public.products (id, tenant_id, name, slug, price)
values ('a4000000-0000-4000-8000-000000000001', 'a2000000-0000-4000-8000-000000000001', 'Test Medicine', 'test-medicine', 1);

select has_column('public', 'inventory_levels', 'reorder_level', 'inventory levels have a reorder threshold');
select has_table('public', 'inventory_alerts', 'inventory alerts table exists');
select has_view('public', 'inventory_transaction_report', 'secure transaction report view exists');
select has_function(
  'public',
  'get_inventory_report_summary',
  array['uuid','uuid','timestamptz','timestamptz'],
  'report summary RPC exists'
);
select has_function(
  'public',
  'acknowledge_inventory_alert',
  array['uuid'],
  'alert acknowledgement RPC exists'
);

set local role authenticated;
select set_config(
  'request.jwt.claims',
  '{"sub":"a1000000-0000-4000-8000-000000000001","role":"authenticated"}',
  true
);
select lives_ok(
  $$select public.stock_in(
    'a2000000-0000-4000-8000-000000000001',
    'a3000000-0000-4000-8000-000000000001',
    'a4000000-0000-4000-8000-000000000001',
    10, 'initial receipt', 'report-receipt'
  )$$,
  'warehouse can receive report test stock'
);
select lives_ok(
  $$select public.stock_out(
    'a2000000-0000-4000-8000-000000000001',
    'a3000000-0000-4000-8000-000000000001',
    'a4000000-0000-4000-8000-000000000001',
    6, 'DAMAGE', 'damaged return', 'report-damage'
  )$$,
  'warehouse can record damaged goods'
);

select is(
  (select count(*) from public.inventory_transaction_report),
  2::bigint,
  'report view returns location transactions'
);
select is(
  (select performer_email from public.inventory_transaction_report
   where transaction_type = 'DAMAGE'),
  'warehouse-report@test.invalid',
  'report view resolves the transaction performer'
);
select is(
  (select stock_received from public.get_inventory_report_summary(
    'a2000000-0000-4000-8000-000000000001',
    'a3000000-0000-4000-8000-000000000001',
    now() - interval '1 day',
    now() + interval '1 day'
  )),
  10::bigint,
  'summary totals received stock'
);
select is(
  (select stock_issued from public.get_inventory_report_summary(
    'a2000000-0000-4000-8000-000000000001',
    'a3000000-0000-4000-8000-000000000001',
    now() - interval '1 day',
    now() + interval '1 day'
  )),
  6::bigint,
  'summary totals issued stock'
);
select is(
  (select count(*) from public.inventory_alerts
   where status = 'active' and alert_type in ('LOW_STOCK', 'DAMAGE')),
  2::bigint,
  'low-stock and damaged-goods alerts are active'
);
select lives_ok(
  format(
    'select public.acknowledge_inventory_alert(%L)',
    (select id::text from public.inventory_alerts where alert_type = 'DAMAGE')
  ),
  'warehouse can acknowledge an alert at an assigned location'
);

select set_config(
  'request.jwt.claims',
  '{"sub":"a1000000-0000-4000-8000-000000000002","role":"authenticated"}',
  true
);
select is(
  (select count(*) from public.inventory_alerts),
  3::bigint,
  'viewer can read active, acknowledged and resolved alerts at an assigned location'
);
select throws_ok(
  format(
    'select public.acknowledge_inventory_alert(%L)',
    (select id::text from public.inventory_alerts where alert_type = 'LOW_STOCK')
  ),
  'P0001',
  'Not authorized to acknowledge this alert',
  'viewer cannot acknowledge alerts'
);

select set_config(
  'request.jwt.claims',
  '{"sub":"a1000000-0000-4000-8000-000000000001","role":"authenticated"}',
  true
);
select lives_ok(
  $$select public.stock_out(
    'a2000000-0000-4000-8000-000000000001',
    'a3000000-0000-4000-8000-000000000001',
    'a4000000-0000-4000-8000-000000000001',
    4, 'SALE', 'final sale', 'report-sale'
  )$$,
  'stock can reach zero'
);
select is(
  (select count(*) from public.inventory_alerts
   where alert_type = 'LOW_STOCK' and status = 'resolved'),
  1::bigint,
  'low-stock alert resolves when the condition changes'
);
select is(
  (select count(*) from public.inventory_alerts
   where alert_type = 'OUT_OF_STOCK' and status = 'active'),
  1::bigint,
  'out-of-stock alert becomes active at zero'
);

reset role;
select * from finish();
rollback;
