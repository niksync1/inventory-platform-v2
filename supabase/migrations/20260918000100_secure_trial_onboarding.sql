begin;

set local search_path = pg_catalog, public, pg_temp;

alter table public.tenants
  add column business_type text,
  add column country_code text,
  add column timezone text not null default 'UTC',
  add column trial_started_at timestamptz,
  add column trial_ends_at timestamptz,
  add column subscription_status text not null default 'active'
    check (subscription_status in ('trialing', 'active', 'past_due', 'expired', 'cancelled')),
  add column created_by uuid references auth.users(id) on delete set null;

-- Legacy trial rows had no clock. Give them a fresh, explicit migration window
-- instead of either failing the migration or expiring them unexpectedly.
update public.tenants
set trial_started_at = now(),
    trial_ends_at = now() + interval '14 days',
    subscription_status = 'trialing'
where status = 'trial';

alter table public.tenants
  add constraint tenants_trial_window_check check (
    (status <> 'trial' and trial_started_at is null and trial_ends_at is null)
    or
    (status = 'trial' and trial_started_at is not null and trial_ends_at > trial_started_at)
  ),
  add constraint tenants_country_code_check check (
    country_code is null or country_code ~ '^[A-Z]{2}$'
  );

-- Existing non-trial tenants predate subscriptions and remain active.
update public.tenants
set subscription_status = 'active'
where status <> 'trial';

create table public.user_trial_eligibility (
  user_id uuid primary key references auth.users(id) on delete restrict,
  tenant_id uuid not null unique references public.tenants(id) on delete restrict,
  trial_used_at timestamptz not null default now()
);

create table public.tenant_creation_requests (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete restrict,
  idempotency_key text not null,
  tenant_id uuid references public.tenants(id) on delete restrict,
  status text not null default 'processing'
    check (status in ('processing', 'completed')),
  created_at timestamptz not null default now(),
  completed_at timestamptz,
  unique (user_id, idempotency_key),
  check (
    (status = 'processing' and tenant_id is null and completed_at is null)
    or
    (status = 'completed' and tenant_id is not null and completed_at is not null)
  )
);

create table public.tenant_audit_events (
  id bigint generated always as identity primary key,
  tenant_id uuid not null references public.tenants(id) on delete restrict,
  actor_user_id uuid references auth.users(id) on delete set null,
  event_type text not null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index tenant_audit_events_tenant_created_idx
  on public.tenant_audit_events (tenant_id, created_at desc);

alter table public.user_trial_eligibility enable row level security;
alter table public.tenant_creation_requests enable row level security;
alter table public.tenant_audit_events enable row level security;

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $$
begin
  insert into public.profiles (id, email, name, role)
  values (new.id, new.email, nullif(trim(new.raw_user_meta_data->>'name'), ''), 'customer')
  on conflict (id) do update
  set email = excluded.email,
      name = coalesce(public.profiles.name, excluded.name);
  return new;
end;
$$;

create or replace function public.tenant_subscription_allows_writes(p_tenant_id uuid)
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public, pg_temp
as $$
  select exists (
    select 1
    from public.tenants
    where id = p_tenant_id
      and (
        (status = 'active' and subscription_status = 'active')
        or
        (status = 'trial' and subscription_status = 'trialing' and now() < trial_ends_at)
      )
  );
$$;

create or replace function public.create_trial_tenant(
  p_business_name text,
  p_business_type text,
  p_country_code text,
  p_timezone text,
  p_first_location_name text,
  p_first_location_address text,
  p_idempotency_key text
)
returns table (tenant_id uuid, location_id uuid, trial_ends_at timestamptz)
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  requester_id uuid := auth.uid();
  normalized_name text := nullif(trim(p_business_name), '');
  normalized_type text := nullif(lower(trim(p_business_type)), '');
  normalized_country text := upper(trim(p_country_code));
  normalized_timezone text := trim(p_timezone);
  normalized_location text := nullif(trim(p_first_location_name), '');
  normalized_address text := nullif(trim(p_first_location_address), '');
  slug_base text;
  generated_slug text;
  created_tenant_id uuid;
  created_location_id uuid;
  created_trial_end timestamptz;
  existing_request public.tenant_creation_requests%rowtype;
begin
  if requester_id is null then
    raise exception 'Authentication required';
  end if;
  if nullif(trim(p_idempotency_key), '') is null or char_length(p_idempotency_key) > 100
     or p_idempotency_key !~ '^[A-Za-z0-9_-]+$' then
    raise exception 'Idempotency key is required';
  end if;
  if not exists (
    select 1 from auth.users
    where id = requester_id and email_confirmed_at is not null
  ) then
    raise exception 'Email verification is required';
  end if;
  if normalized_name is null or char_length(normalized_name) > 120 then
    raise exception 'Business name must be between 1 and 120 characters';
  end if;
  if normalized_type is null or char_length(normalized_type) > 60
     or normalized_type !~ '^[a-z0-9][a-z0-9 _-]*$' then
    raise exception 'Business type is invalid';
  end if;
  if normalized_country is null or normalized_country !~ '^[A-Z]{2}$' then
    raise exception 'Country code must contain two letters';
  end if;
  if normalized_timezone = '' or not exists (
    select 1 from pg_timezone_names where name = normalized_timezone
  ) then
    raise exception 'Timezone is invalid';
  end if;
  if normalized_location is null or char_length(normalized_location) > 120 then
    raise exception 'Location name must be between 1 and 120 characters';
  end if;
  if normalized_address is not null and char_length(normalized_address) > 250 then
    raise exception 'Location address cannot exceed 250 characters';
  end if;

  insert into public.tenant_creation_requests (user_id, idempotency_key)
  values (requester_id, p_idempotency_key)
  on conflict (user_id, idempotency_key) do nothing;

  select * into existing_request
  from public.tenant_creation_requests
  where user_id = requester_id and idempotency_key = p_idempotency_key
  for update;

  if existing_request.status = 'completed' then
    return query
    select tenants.id, locations.id, tenants.trial_ends_at
    from public.tenants
    join public.locations on locations.tenant_id = tenants.id
    where tenants.id = existing_request.tenant_id
    order by locations.created_at
    limit 1;
    return;
  end if;

  if exists (select 1 from public.user_trial_eligibility where user_id = requester_id) then
    raise exception 'This account has already used its trial';
  end if;

  slug_base := trim(both '-' from regexp_replace(lower(normalized_name), '[^a-z0-9]+', '-', 'g'));
  if slug_base = '' then slug_base := 'business'; end if;
  generated_slug := left(slug_base, 70) || '-' || substr(replace(gen_random_uuid()::text, '-', ''), 1, 8);
  created_trial_end := now() + interval '14 days';

  insert into public.tenants (
    name, slug, status, plan, business_type, country_code, timezone,
    trial_started_at, trial_ends_at, subscription_status, created_by
  ) values (
    normalized_name, generated_slug, 'trial', 'trial', normalized_type,
    normalized_country, normalized_timezone, now(), created_trial_end,
    'trialing', requester_id
  ) returning id into created_tenant_id;

  insert into public.user_trial_eligibility (user_id, tenant_id)
  values (requester_id, created_tenant_id);

  insert into public.tenant_memberships (tenant_id, user_id, role, status)
  values (created_tenant_id, requester_id, 'owner', 'active');

  insert into public.locations (tenant_id, name, code, address)
  values (created_tenant_id, normalized_location, 'MAIN', normalized_address)
  returning id into created_location_id;

  insert into public.tenant_audit_events (
    tenant_id, actor_user_id, event_type, metadata
  ) values (
    created_tenant_id,
    requester_id,
    'tenant.trial_created',
    jsonb_build_object(
      'trial_days', 14,
      'country_code', normalized_country,
      'timezone', normalized_timezone,
      'first_location_id', created_location_id
    )
  );

  update public.tenant_creation_requests
  set tenant_id = created_tenant_id, status = 'completed', completed_at = now()
  where id = existing_request.id;

  return query select created_tenant_id, created_location_id, created_trial_end;
end;
$$;

-- The original function trusted a client-generated slug and did not enforce
-- verification, trial eligibility, expiry, or idempotency.
revoke execute on function public.create_tenant(text, text) from public, anon, authenticated;
grant execute on function public.create_trial_tenant(text, text, text, text, text, text, text)
  to authenticated;

revoke all on public.user_trial_eligibility, public.tenant_creation_requests,
  public.tenant_audit_events from public, anon, authenticated;

grant execute on function public.tenant_subscription_allows_writes(uuid) to authenticated;

grant select, insert, update on public.user_trial_eligibility,
  public.tenant_creation_requests, public.tenant_audit_events to service_role;
grant execute on function public.tenant_subscription_allows_writes(uuid),
  public.create_trial_tenant(text, text, text, text, text, text, text) to service_role;

commit;
