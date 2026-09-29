begin;
set local search_path = pg_catalog, public, pg_temp;

alter table public.inventory_alerts drop constraint inventory_alerts_alert_type_check;
alter table public.inventory_alerts add constraint inventory_alerts_alert_type_check check (
  alert_type in ('LOW_STOCK','OUT_OF_STOCK','DAMAGE','EXPIRED','EXPIRING_90_DAYS','EXPIRING_30_DAYS','BATCH_EXPIRED','TRANSFER_PENDING_RECEIPT','SYNC_FAILURE')
);
alter table public.inventory_alerts add column client_operation_id text;
create unique index inventory_alerts_client_operation_uidx on public.inventory_alerts (tenant_id, client_operation_id) where client_operation_id is not null;

create table public.inventory_notification_preferences (
  tenant_id uuid not null,
  user_id uuid not null,
  push_enabled boolean not null default true,
  email_enabled boolean not null default false,
  stock_alerts boolean not null default true,
  expiry_alerts boolean not null default true,
  damage_alerts boolean not null default true,
  transfer_alerts boolean not null default true,
  sync_failure_alerts boolean not null default true,
  updated_at timestamptz not null default now(),
  primary key (tenant_id, user_id),
  foreign key (tenant_id, user_id) references public.tenant_memberships (tenant_id, user_id) on delete cascade
);
create table public.expo_push_tokens (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  user_id uuid not null,
  token text not null check (length(token) between 10 and 500),
  platform text not null check (platform in ('android','ios')),
  device_id text,
  is_active boolean not null default true,
  last_seen_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  foreign key (tenant_id, user_id) references public.tenant_memberships (tenant_id, user_id) on delete cascade,
  unique (tenant_id, user_id, token)
);
create table public.inventory_notification_outbox (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  alert_id uuid not null references public.inventory_alerts(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  channel text not null check (channel in ('push','email')),
  status text not null default 'pending' check (status in ('pending','processing','sent','failed','skipped')),
  attempts integer not null default 0 check (attempts >= 0),
  next_attempt_at timestamptz not null default now(),
  last_error text,
  sent_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (alert_id, user_id, channel)
);
create index inventory_notification_outbox_pending_idx on public.inventory_notification_outbox (status, next_attempt_at, created_at) where status in ('pending','failed');

alter table public.inventory_notification_preferences enable row level security;
alter table public.expo_push_tokens enable row level security;
alter table public.inventory_notification_outbox enable row level security;
create policy "Members manage their notification preferences" on public.inventory_notification_preferences for all to authenticated
using (user_id = auth.uid() and public.is_tenant_member(tenant_id))
with check (user_id = auth.uid() and public.is_tenant_member(tenant_id));
create policy "Members manage their push tokens" on public.expo_push_tokens for all to authenticated
using (user_id = auth.uid() and public.is_tenant_member(tenant_id))
with check (user_id = auth.uid() and public.is_tenant_member(tenant_id));

create function public.validate_inventory_notification_preferences()
returns trigger language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $$
begin
  if new.email_enabled and not public.has_tenant_role(new.tenant_id, array['owner','admin','manager']) then
    raise exception 'Email alerts are available only to owners, admins, and managers';
  end if;
  new.updated_at := now(); return new;
end;
$$;
create trigger validate_inventory_notification_preferences before insert or update on public.inventory_notification_preferences for each row execute function public.validate_inventory_notification_preferences();

create function public.enqueue_inventory_alert_notifications()
returns trigger language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $$
begin
  insert into public.inventory_notification_outbox (tenant_id, alert_id, user_id, channel)
  select new.tenant_id, new.id, preference.user_id, channel.name
  from public.inventory_notification_preferences preference
  join public.tenant_memberships membership on membership.tenant_id = preference.tenant_id and membership.user_id = preference.user_id and membership.status = 'active'
  cross join lateral (values ('push'::text),('email'::text)) channel(name)
  where preference.tenant_id = new.tenant_id
    and membership.role in ('owner','admin','manager','warehouse')
    and (membership.role in ('owner','admin') or exists (
      select 1 from public.location_memberships assignment where assignment.tenant_id = new.tenant_id and assignment.user_id = preference.user_id and assignment.location_id = new.location_id
    ))
    and ((channel.name = 'push' and preference.push_enabled) or (channel.name = 'email' and preference.email_enabled and membership.role in ('owner','admin','manager')))
    and case
      when new.alert_type in ('LOW_STOCK','OUT_OF_STOCK') then preference.stock_alerts
      when new.alert_type in ('EXPIRING_90_DAYS','EXPIRING_30_DAYS','BATCH_EXPIRED','EXPIRED') then preference.expiry_alerts
      when new.alert_type = 'DAMAGE' then preference.damage_alerts
      when new.alert_type = 'TRANSFER_PENDING_RECEIPT' then preference.transfer_alerts
      when new.alert_type = 'SYNC_FAILURE' then preference.sync_failure_alerts
      else false end
  on conflict (alert_id, user_id, channel) do nothing;
  return new;
end;
$$;
create trigger enqueue_inventory_alert_notifications after insert on public.inventory_alerts for each row execute function public.enqueue_inventory_alert_notifications();

create function public.report_inventory_sync_failure(p_tenant_id uuid, p_location_id uuid, p_product_id uuid, p_operation_id text, p_message text)
returns void language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $$
declare product_name text;
begin
  if not public.can_manage_inventory_at_location(p_tenant_id, p_location_id) then raise exception 'Not authorized to report a sync failure for this location'; end if;
  if p_operation_id is null or length(btrim(p_operation_id)) = 0 then raise exception 'Operation ID is required'; end if;
  select name into product_name from public.products where tenant_id = p_tenant_id and id = p_product_id;
  if not found then raise exception 'Product not found'; end if;
  insert into public.inventory_alerts (tenant_id,location_id,product_id,alert_type,severity,message,client_operation_id)
  values (p_tenant_id,p_location_id,p_product_id,'SYNC_FAILURE','warning',coalesce(product_name,'Product') || ' has an offline operation that needs attention: ' || left(coalesce(nullif(btrim(p_message),''),'Synchronization failed'),500),p_operation_id)
  on conflict (tenant_id,client_operation_id) where client_operation_id is not null do update set message=excluded.message,triggered_at=now(),status='active',resolved_at=null;
end;
$$;

create function public.refresh_inventory_expiry_alerts_internal(p_tenant_id uuid, p_location_id uuid)
returns void language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $$
declare warning_days integer; critical_days integer;
begin
  select expiry_warning_days,expiry_critical_days into warning_days,critical_days from public.tenant_inventory_settings where tenant_id=p_tenant_id;
  warning_days:=coalesce(warning_days,90); critical_days:=coalesce(critical_days,30);
  update public.inventory_alerts alert set status='resolved',resolved_at=now()
  where alert.tenant_id=p_tenant_id and alert.location_id=p_location_id and alert.alert_type in ('EXPIRING_90_DAYS','EXPIRING_30_DAYS','BATCH_EXPIRED') and alert.status in ('active','acknowledged')
    and not exists (select 1 from public.inventory_batches batch where batch.id=alert.batch_id and batch.quantity>0 and batch.expiry_date is not null and case alert.alert_type when 'BATCH_EXPIRED' then batch.expiry_date<current_date when 'EXPIRING_30_DAYS' then batch.expiry_date between current_date and current_date+critical_days else batch.expiry_date>current_date+critical_days and batch.expiry_date<=current_date+warning_days end);
  insert into public.inventory_alerts (tenant_id,location_id,product_id,batch_id,alert_type,severity,quantity,threshold,message)
  select batch.tenant_id,batch.location_id,batch.product_id,batch.id,
    case when batch.expiry_date<current_date then 'BATCH_EXPIRED' when batch.expiry_date<=current_date+critical_days then 'EXPIRING_30_DAYS' else 'EXPIRING_90_DAYS' end,
    case when batch.expiry_date<=current_date+critical_days then 'critical' else 'warning' end,batch.quantity,
    case when batch.expiry_date<=current_date+critical_days then critical_days else warning_days end,
    product.name || ' batch ' || batch.batch_number || case when batch.expiry_date<current_date then ' expired on ' else ' expires on ' end || to_char(batch.expiry_date,'YYYY-MM-DD') || '.'
  from public.inventory_batches batch join public.products product on product.tenant_id=batch.tenant_id and product.id=batch.product_id
  where batch.tenant_id=p_tenant_id and batch.location_id=p_location_id and batch.quantity>0 and batch.expiry_date is not null and batch.expiry_date<=current_date+warning_days
  on conflict (tenant_id,batch_id,alert_type) where status in ('active','acknowledged') and batch_id is not null and alert_type in ('EXPIRING_90_DAYS','EXPIRING_30_DAYS','BATCH_EXPIRED')
  do update set quantity=excluded.quantity,message=excluded.message;
end;
$$;
create or replace function public.refresh_inventory_expiry_alerts(p_tenant_id uuid,p_location_id uuid)
returns void language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $$
begin
  if auth.uid() is null or not public.can_access_location(p_tenant_id,p_location_id) then raise exception 'Not authorized to refresh alerts for this location'; end if;
  perform public.refresh_inventory_expiry_alerts_internal(p_tenant_id,p_location_id);
end;
$$;
create function public.refresh_all_inventory_expiry_alerts()
returns void language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $$
declare target record;
begin
  for target in select tenant_id,id as location_id from public.locations where is_active loop
    perform public.refresh_inventory_expiry_alerts_internal(target.tenant_id,target.location_id);
  end loop;
end;
$$;

create extension if not exists pg_cron with schema pg_catalog;
do $$ declare existing_job bigint; begin
  select jobid into existing_job from cron.job where jobname='refresh-inventory-expiry-alerts-daily';
  if existing_job is not null then perform cron.unschedule(existing_job); end if;
  perform cron.schedule('refresh-inventory-expiry-alerts-daily','15 1 * * *','select public.refresh_all_inventory_expiry_alerts()');
end $$;

revoke all on public.inventory_notification_preferences,public.expo_push_tokens,public.inventory_notification_outbox from public,anon;
grant select,insert,update,delete on public.inventory_notification_preferences,public.expo_push_tokens to authenticated;
grant all on public.inventory_notification_preferences,public.expo_push_tokens,public.inventory_notification_outbox to service_role;
revoke all on function public.report_inventory_sync_failure(uuid,uuid,uuid,text,text) from public,anon;
grant execute on function public.report_inventory_sync_failure(uuid,uuid,uuid,text,text) to authenticated,service_role;
revoke all on function public.refresh_inventory_expiry_alerts_internal(uuid,uuid),public.refresh_all_inventory_expiry_alerts(),public.validate_inventory_notification_preferences(),public.enqueue_inventory_alert_notifications() from public,anon,authenticated,service_role;
comment on table public.inventory_notification_outbox is 'Server-owned push/email delivery queue populated from tenant and location scoped inventory alerts.';
commit;
