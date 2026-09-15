-- Run only after all five accounts exist in Supabase Authentication.
-- This script is intentionally transactional and fails without partial changes.
begin;

do $$
declare
  phoenix_tenant constant uuid := '00000000-0000-4000-8000-000000000001';
  assignment record;
  account_id uuid;
  location_code text;
begin
  for assignment in
    select * from (values
      ('owner@phoenix.com', 'owner', array['ACC','KAN','ACH']::text[]),
      ('manager@phoenix.com', 'manager', array['ACC','KAN']::text[]),
      ('accra@phoenix.com', 'warehouse', array['ACC']::text[]),
      ('kaneshie@phoenix.com', 'warehouse', array['KAN']::text[]),
      ('achimota@phoenix.com', 'warehouse', array['ACH']::text[])
    ) as configured(email, tenant_role, location_codes)
  loop
    select id into account_id
    from auth.users
    where lower(email) = lower(assignment.email);

    if account_id is null then
      raise exception 'Create Supabase Auth account % before assigning Phoenix access', assignment.email;
    end if;

    insert into public.tenant_memberships (tenant_id, user_id, role, status)
    values (phoenix_tenant, account_id, assignment.tenant_role, 'active')
    on conflict (tenant_id, user_id) do update
      set role = excluded.role, status = 'active', updated_at = now();

    delete from public.location_memberships
    where tenant_id = phoenix_tenant and user_id = account_id;

    foreach location_code in array assignment.location_codes loop
      insert into public.location_memberships (tenant_id, location_id, user_id)
      select phoenix_tenant, id, account_id
      from public.locations
      where tenant_id = phoenix_tenant and code = location_code and is_active;
      if not found then
        raise exception 'Phoenix location code % does not exist', location_code;
      end if;
    end loop;
  end loop;
end;
$$;

commit;
