begin;

create or replace function public.refresh_inventory_expiry_alerts_on_batch_change()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $function$
begin
  perform public.refresh_inventory_expiry_alerts_internal(
    new.tenant_id,
    new.location_id
  );

  return new;
end;
$function$;

drop trigger if exists refresh_inventory_expiry_alerts_on_batch_change
on public.inventory_batches;

create trigger refresh_inventory_expiry_alerts_on_batch_change
after insert or update of expiry_date, quantity, location_id
on public.inventory_batches
for each row
execute function public.refresh_inventory_expiry_alerts_on_batch_change();

revoke all on function
  public.refresh_inventory_expiry_alerts_on_batch_change()
from public, anon, authenticated, service_role;

commit;