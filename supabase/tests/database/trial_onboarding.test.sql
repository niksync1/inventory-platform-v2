begin;
create extension if not exists pgtap with schema extensions;
set search_path = public, extensions;
select no_plan();

insert into auth.users (id, email, email_confirmed_at) values
 ('91000000-0000-4000-8000-000000000001', 'verified@test.invalid', now()),
 ('91000000-0000-4000-8000-000000000002', 'unverified@test.invalid', null),
 ('91000000-0000-4000-8000-000000000003', 'second@test.invalid', now());

select has_column('public', 'tenants', 'trial_started_at', 'tenant records trial start');
select has_column('public', 'tenants', 'trial_ends_at', 'tenant records trial end');
select has_column('public', 'tenants', 'subscription_status', 'tenant records subscription status');
select has_table('public', 'user_trial_eligibility', 'permanent trial eligibility table exists');
select has_table('public', 'tenant_creation_requests', 'idempotency table exists');
select has_table('public', 'tenant_audit_events', 'tenant audit table exists');
select has_function(
  'public',
  'create_trial_tenant',
  array['text','text','text','text','text','text','text'],
  'secure trial creation RPC exists'
);
select ok(
  not has_function_privilege('authenticated', 'public.create_tenant(text,text)', 'EXECUTE'),
  'legacy tenant creation is unavailable to clients'
);
select ok(
  has_function_privilege(
    'authenticated',
    'public.create_trial_tenant(text,text,text,text,text,text,text)',
    'EXECUTE'
  ),
  'authenticated clients can request a secure trial'
);
select ok(
  not has_table_privilege('authenticated', 'public.user_trial_eligibility', 'SELECT'),
  'clients cannot read permanent trial claims directly'
);
select ok(
  not has_table_privilege('authenticated', 'public.tenant_creation_requests', 'INSERT'),
  'clients cannot forge idempotency records'
);

set local role authenticated;
select set_config(
  'request.jwt.claims',
  '{"sub":"91000000-0000-4000-8000-000000000002","role":"authenticated"}',
  true
);
select throws_ok(
  $$select public.create_trial_tenant('Unverified Ltd','retail','GH','Africa/Accra','Main',null,'92000000-0000-4000-8000-000000000001')$$,
  'P0001',
  'Email verification is required',
  'unverified email cannot create a tenant'
);

select set_config(
  'request.jwt.claims',
  '{"sub":"91000000-0000-4000-8000-000000000001","role":"authenticated"}',
  true
);
select lives_ok(
  $$select public.create_trial_tenant('Example Pharmacy','pharmacy','gh','Africa/Accra','Accra','1 High Street','92000000-0000-4000-8000-000000000002')$$,
  'verified user can create a trial tenant'
);
select is(
  (select count(*) from public.tenant_memberships where user_id = '91000000-0000-4000-8000-000000000001' and role = 'owner'),
  1::bigint,
  'creator becomes owner'
);

-- The client deliberately has no direct access to eligibility or audit state;
-- inspect those internal records from the database test role.
reset role;
select is(
  (select count(*) from public.user_trial_eligibility where user_id = '91000000-0000-4000-8000-000000000001'),
  1::bigint,
  'trial use is permanently recorded'
);
select is(
  (select count(*) from public.locations where tenant_id = (
    select tenant_id from public.user_trial_eligibility where user_id = '91000000-0000-4000-8000-000000000001'
  )),
  1::bigint,
  'first location is created'
);
select ok(
  (select trial_ends_at between now() + interval '13 days 23 hours' and now() + interval '14 days 1 hour'
   from public.tenants where id = (
     select tenant_id from public.user_trial_eligibility where user_id = '91000000-0000-4000-8000-000000000001'
   )),
  'trial expires after fourteen days'
);
select is(
  (select country_code from public.tenants where id = (
    select tenant_id from public.user_trial_eligibility where user_id = '91000000-0000-4000-8000-000000000001'
  )),
  'GH',
  'country code is normalized server-side'
);
select is(
  (select count(*) from public.tenant_audit_events where actor_user_id = '91000000-0000-4000-8000-000000000001' and event_type = 'tenant.trial_created'),
  1::bigint,
  'creation is audited'
);

set local role authenticated;
select set_config(
  'request.jwt.claims',
  '{"sub":"91000000-0000-4000-8000-000000000001","role":"authenticated"}',
  true
);
select lives_ok(
  $$select public.create_trial_tenant('Example Pharmacy','pharmacy','GH','Africa/Accra','Accra','1 High Street','92000000-0000-4000-8000-000000000002')$$,
  'retry with the same idempotency key succeeds'
);
select is(
  (select count(*) from public.tenant_memberships where user_id = '91000000-0000-4000-8000-000000000001'),
  1::bigint,
  'idempotent retry does not create another tenant'
);
select throws_ok(
  $$select public.create_trial_tenant('Another Business','retail','GH','Africa/Accra','Main',null,'92000000-0000-4000-8000-000000000003')$$,
  'P0001',
  'This account has already used its trial',
  'second trial is rejected'
);

select set_config(
  'request.jwt.claims',
  '{"sub":"91000000-0000-4000-8000-000000000003","role":"authenticated"}',
  true
);
select throws_ok(
  $$select public.create_trial_tenant('Invalid Timezone','retail','GH','Not/AZone','Main',null,'92000000-0000-4000-8000-000000000004')$$,
  'P0001',
  'Timezone is invalid',
  'invalid timezone is rejected'
);

reset role;
select * from finish();
rollback;
