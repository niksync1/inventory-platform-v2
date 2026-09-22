begin;
create extension if not exists pgtap with schema extensions;
set search_path=public,extensions;
select no_plan();
insert into auth.users(id,email) values
 ('d1000000-0000-4000-8000-000000000001','notify-manager@test.invalid'),
 ('d1000000-0000-4000-8000-000000000002','notify-warehouse@test.invalid'),
 ('d1000000-0000-4000-8000-000000000003','notify-viewer@test.invalid');
insert into public.tenants(id,name,slug) values ('d2000000-0000-4000-8000-000000000001','Notification Test','notification-test');
insert into public.tenant_memberships(tenant_id,user_id,role) values
 ('d2000000-0000-4000-8000-000000000001','d1000000-0000-4000-8000-000000000001','manager'),
 ('d2000000-0000-4000-8000-000000000001','d1000000-0000-4000-8000-000000000002','warehouse'),
 ('d2000000-0000-4000-8000-000000000001','d1000000-0000-4000-8000-000000000003','viewer');
insert into public.locations(id,tenant_id,name,code) values ('d3000000-0000-4000-8000-000000000001','d2000000-0000-4000-8000-000000000001','Notify Branch','NTF');
insert into public.location_memberships(tenant_id,location_id,user_id) values
 ('d2000000-0000-4000-8000-000000000001','d3000000-0000-4000-8000-000000000001','d1000000-0000-4000-8000-000000000001'),
 ('d2000000-0000-4000-8000-000000000001','d3000000-0000-4000-8000-000000000001','d1000000-0000-4000-8000-000000000002'),
 ('d2000000-0000-4000-8000-000000000001','d3000000-0000-4000-8000-000000000001','d1000000-0000-4000-8000-000000000003');
insert into public.products(id,tenant_id,name,slug,price) values ('d4000000-0000-4000-8000-000000000001','d2000000-0000-4000-8000-000000000001','Notification Medicine','notification-medicine',1);
select has_table('public','inventory_notification_preferences','notification preferences table exists');
select has_table('public','expo_push_tokens','Expo token table exists');
select has_table('public','inventory_notification_outbox','notification outbox exists');
select has_function('public','report_inventory_sync_failure',array['uuid','uuid','uuid','text','text'],'sync failure RPC exists');
select ok(exists(select 1 from cron.job where jobname='refresh-inventory-expiry-alerts-daily'),'daily expiry refresh is scheduled');

set local role authenticated;
select set_config('request.jwt.claims','{"sub":"d1000000-0000-4000-8000-000000000001","role":"authenticated"}',true);
select lives_ok($$insert into public.inventory_notification_preferences(tenant_id,user_id,push_enabled,email_enabled) values ('d2000000-0000-4000-8000-000000000001','d1000000-0000-4000-8000-000000000001',true,true)$$,'manager can opt into push and email alerts');
select set_config('request.jwt.claims','{"sub":"d1000000-0000-4000-8000-000000000002","role":"authenticated"}',true);
select throws_ok($$insert into public.inventory_notification_preferences(tenant_id,user_id,email_enabled) values ('d2000000-0000-4000-8000-000000000001','d1000000-0000-4000-8000-000000000002',true)$$,'P0001','Email alerts are available only to owners, admins, and managers','warehouse cannot enable email alerts');
select lives_ok($$insert into public.inventory_notification_preferences(tenant_id,user_id,push_enabled,email_enabled) values ('d2000000-0000-4000-8000-000000000001','d1000000-0000-4000-8000-000000000002',true,false)$$,'warehouse can opt into push alerts');
select set_config('request.jwt.claims','{"sub":"d1000000-0000-4000-8000-000000000003","role":"authenticated"}',true);
select throws_ok($$select public.report_inventory_sync_failure('d2000000-0000-4000-8000-000000000001','d3000000-0000-4000-8000-000000000001','d4000000-0000-4000-8000-000000000001','viewer-sync','should fail')$$,'P0001','Not authorized to report a sync failure for this location','viewer cannot report operational sync failures');

select set_config('request.jwt.claims','{"sub":"d1000000-0000-4000-8000-000000000001","role":"authenticated"}',true);
select lives_ok($$select public.report_inventory_sync_failure('d2000000-0000-4000-8000-000000000001','d3000000-0000-4000-8000-000000000001','d4000000-0000-4000-8000-000000000001','manager-sync','Rejected queued operation')$$,'manager can report a failed queued operation');
reset role;
select is((select count(*) from public.inventory_alerts where alert_type='SYNC_FAILURE'),1::bigint,'sync failure produces one operational alert');
select is((select count(*) from public.inventory_notification_outbox where channel='push'),2::bigint,'manager and warehouse receive location-scoped push deliveries');
select is((select count(*) from public.inventory_notification_outbox where channel='email'),1::bigint,'only opted-in manager receives email delivery');
select * from finish();
rollback;
