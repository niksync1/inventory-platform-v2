begin;
set local search_path = pg_catalog, public, pg_temp;

-- A public listing is an explicit publication record for an existing tenant product.
-- Retail price is independent of products.price (the internal/product purchase price).
create table public.public_catalogue_listings (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  product_id uuid not null,
  retail_price numeric(12,2) not null check (retail_price >= 0),
  currency text not null default 'GHS' check (currency ~ '^[A-Z]{3}$'),
  is_published boolean not null default false,
  created_by uuid references auth.users(id) on delete set null default auth.uid(),
  published_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint public_catalogue_listing_product_fkey
    foreign key (tenant_id, product_id)
    references public.products(tenant_id, id) on delete cascade,
  constraint public_catalogue_listing_tenant_product_key unique (tenant_id, product_id),
  constraint public_catalogue_listing_publish_timestamp_check
    check ((is_published and published_at is not null) or (not is_published))
);

create index public_catalogue_published_idx
  on public.public_catalogue_listings (tenant_id, product_id)
  where is_published;

create trigger set_public_catalogue_listings_updated_at
before update on public.public_catalogue_listings
for each row execute function public.update_updated_at_column();

create function public.set_public_catalogue_published_at()
returns trigger
language plpgsql
set search_path = pg_catalog, public, pg_temp
as $$
begin
  if new.is_published then
    if tg_op = 'INSERT' or not old.is_published then
      new.published_at := now();
    end if;
  else
    new.published_at := null;
  end if;
  return new;
end;
$$;

create trigger set_public_catalogue_published_at
before insert or update of is_published on public.public_catalogue_listings
for each row execute function public.set_public_catalogue_published_at();

alter table public.public_catalogue_listings enable row level security;

create policy "Tenant members read own catalogue listings"
on public.public_catalogue_listings for select to authenticated
using (public.is_tenant_member(tenant_id));

create policy "Tenant managers create catalogue listings"
on public.public_catalogue_listings for insert to authenticated
with check (public.has_tenant_role(tenant_id, array['owner','admin','manager']));

create policy "Tenant managers update catalogue listings"
on public.public_catalogue_listings for update to authenticated
using (public.has_tenant_role(tenant_id, array['owner','admin','manager']))
with check (public.has_tenant_role(tenant_id, array['owner','admin','manager']));

revoke all on public.public_catalogue_listings from public, anon, authenticated;
grant select, insert, update on public.public_catalogue_listings to authenticated;

-- This view is intentionally owner-executed: it exposes a narrow allowlist of fields
-- from published products and never exposes supplier cost, batches, or exact stock.
create view public.public_catalogue
with (security_barrier = true)
as
select
  listing.id as listing_id,
  tenant.name as business_name,
  product.name as product_name,
  coalesce(product.description, '') as description,
  coalesce(product.images, '{}'::text[]) as images,
  listing.retail_price,
  listing.currency,
  exists (
    select 1
    from public.inventory_batches batch
    join public.locations location
      on location.tenant_id = batch.tenant_id
     and location.id = batch.location_id
    where batch.tenant_id = listing.tenant_id
      and batch.product_id = listing.product_id
      and location.is_active
      and batch.quantity > 0
      and (batch.expiry_date is null or batch.expiry_date >= current_date)
  ) as available
from public.public_catalogue_listings listing
join public.products product
  on product.tenant_id = listing.tenant_id
 and product.id = listing.product_id
join public.tenants tenant on tenant.id = listing.tenant_id
where listing.is_published
  and product.is_active
  and tenant.status in ('trial','active');

revoke all on public.public_catalogue from public, anon, authenticated;
grant usage on schema public to anon, authenticated;
grant select on public.public_catalogue to anon, authenticated;

-- Bound parameters are used for search. Only fields in the public view can be returned.
create function public.search_public_catalogue(p_query text default null)
returns table (
  listing_id uuid,
  business_name text,
  product_name text,
  description text,
  images text[],
  retail_price numeric,
  currency text,
  available boolean
)
language sql
stable
security definer
set search_path = pg_catalog, public, pg_temp
as $$
  select catalogue.listing_id, catalogue.business_name, catalogue.product_name,
         catalogue.description, catalogue.images, catalogue.retail_price,
         catalogue.currency, catalogue.available
  from public.public_catalogue catalogue
  where nullif(btrim(p_query), '') is null
     or position(lower(btrim(p_query)) in lower(catalogue.product_name)) > 0
     or position(lower(btrim(p_query)) in lower(catalogue.description)) > 0
  order by catalogue.product_name, catalogue.business_name
  limit 100;
$$;

revoke all on function public.search_public_catalogue(text) from public;
grant execute on function public.search_public_catalogue(text) to anon, authenticated;

comment on table public.public_catalogue_listings is
  'Explicit publication records for tenant products. Retail price is public-facing and independent of supplier purchase cost.';
comment on view public.public_catalogue is
  'Safe public projection of published listings only. Does not expose tenant inventory quantities or supplier data.';
commit;
