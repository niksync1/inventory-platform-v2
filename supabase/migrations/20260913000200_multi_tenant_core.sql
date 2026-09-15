begin;

-- Additive multi-tenant foundation for the existing single-tenant database.
-- This migration intentionally preserves all current business data.

set local search_path = pg_catalog, public, pg_temp;
lock table public.products in access exclusive mode;
do $$
declare
  existing record;
begin
  if exists (select 1 from public.products where stock_quantity is null or stock_quantity < 0) then
    raise exception 'Cannot migrate inventory: product stock must be non-null and nonnegative';
  end if;
  select contype, pg_get_expr(conbin, conrelid) as expression, connoinherit
  into existing from pg_constraint
  where conrelid = 'public.products'::regclass
    and conname = 'products_stock_quantity_nonnegative';
  if found then
    -- Accept the canonical expression of the audited constraint, fail closed otherwise.
    if existing.contype <> 'c' or existing.connoinherit
       or existing.expression is null
       or existing.expression not in ('(stock_quantity >= 0)', '(0 <= stock_quantity)') then
      raise exception 'Incompatible products_stock_quantity_nonnegative constraint: %', existing.expression;
    end if;
    alter table public.products validate constraint products_stock_quantity_nonnegative;
  else
    alter table public.products add constraint products_stock_quantity_nonnegative
      check (stock_quantity >= 0);
  end if;
end;
$$;

create table public.tenants (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  slug text not null unique,
  status text not null default 'active'
    check (status in ('trial', 'active', 'suspended', 'cancelled')),
  plan text not null default 'starter',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.locations (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  name text not null,
  code text not null,
  address text,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, code)
);

create table public.tenant_memberships (
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role text not null check (role in ('owner', 'admin', 'manager', 'warehouse', 'viewer')),
  status text not null default 'active' check (status in ('invited', 'active', 'suspended')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (tenant_id, user_id)
);

-- Platform administration is deliberately separate from tenant roles. Rows in
-- this table must only be managed through trusted service-role operations.
create table public.platform_admins (
  user_id uuid primary key references auth.users(id) on delete cascade,
  created_at timestamptz not null default now()
);

create table public.customers (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  auth_user_id uuid references auth.users(id) on delete set null,
  email text not null,
  full_name text,
  phone text,
  default_address text,
  buyer_type text not null default 'retail' check (buyer_type in ('retail', 'wholesale')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, email),
  unique (tenant_id, auth_user_id)
);

create unique index customers_tenant_email_ci_uidx
  on public.customers (tenant_id, lower(email));

create table public.inventory_levels (
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  location_id uuid not null references public.locations(id) on delete cascade,
  product_id uuid not null references public.products(id) on delete cascade,
  quantity integer not null default 0 check (quantity >= 0),
  updated_at timestamptz not null default now(),
  primary key (tenant_id, location_id, product_id)
);

-- A stable initial tenant/location makes the existing rows tenant-owned before
-- NOT NULL and foreign-key enforcement are added.
insert into public.tenants (id, name, slug, status, plan)
values (
  '00000000-0000-4000-8000-000000000001',
  'Primary Business',
  'primary-business',
  'active',
  'starter'
)
on conflict (id) do nothing;

insert into public.locations (id, tenant_id, name, code)
values (
  '00000000-0000-4000-8000-000000000002',
  '00000000-0000-4000-8000-000000000001',
  'Main Location',
  'MAIN'
)
on conflict (id) do nothing;

alter table public.categories add column tenant_id uuid;
alter table public.products add column tenant_id uuid;
alter table public.inventory_transactions add column tenant_id uuid;
alter table public.inventory_transactions add column location_id uuid;
alter table public.orders add column tenant_id uuid;
alter table public.orders add column customer_id uuid;
alter table public.orders add column location_id uuid;
alter table public.order_tracking add column tenant_id uuid;

update public.categories
set tenant_id = '00000000-0000-4000-8000-000000000001'
where tenant_id is null;

update public.products
set tenant_id = '00000000-0000-4000-8000-000000000001'
where tenant_id is null;

update public.inventory_transactions
set tenant_id = '00000000-0000-4000-8000-000000000001',
    location_id = '00000000-0000-4000-8000-000000000002'
where tenant_id is null or location_id is null;

update public.orders
set tenant_id = '00000000-0000-4000-8000-000000000001',
    location_id = '00000000-0000-4000-8000-000000000002'
where tenant_id is null or location_id is null;

update public.order_tracking tracking
set tenant_id = orders.tenant_id
from public.orders
where tracking.order_id = orders.id
  and tracking.tenant_id is null;

update public.order_tracking
set tenant_id = '00000000-0000-4000-8000-000000000001'
where tenant_id is null;

insert into public.tenant_memberships (tenant_id, user_id, role, status)
select
  '00000000-0000-4000-8000-000000000001',
  profiles.id,
  case when profiles.role = 'admin' then 'owner' else 'warehouse' end,
  'active'
from public.profiles
on conflict (tenant_id, user_id) do nothing;

insert into public.customers (
  tenant_id, auth_user_id, email, full_name, phone, default_address
)
select
  '00000000-0000-4000-8000-000000000001',
  auth_match.id,
  legacy.email,
  legacy.full_name,
  legacy.phone,
  legacy.default_address
from public.users legacy
left join lateral (
  select auth_users.id
  from auth.users auth_users
  where lower(auth_users.email) = lower(legacy.email)
  limit 1
) auth_match on true
on conflict do nothing;

update public.orders orders
set customer_id = customers.id
from public.customers customers
where customers.tenant_id = orders.tenant_id
  and lower(customers.email) = lower(orders.email)
  and orders.customer_id is null;

insert into public.inventory_levels (tenant_id, location_id, product_id, quantity)
select
  products.tenant_id,
  '00000000-0000-4000-8000-000000000002',
  products.id,
  products.stock_quantity
from public.products
on conflict (tenant_id, location_id, product_id) do nothing;

alter table public.categories alter column tenant_id set not null;
alter table public.products alter column tenant_id set not null;
alter table public.inventory_transactions alter column tenant_id set not null;
alter table public.inventory_transactions alter column location_id set not null;
alter table public.orders alter column tenant_id set not null;
alter table public.order_tracking alter column tenant_id set not null;

alter table public.categories
  add constraint categories_tenant_id_fkey foreign key (tenant_id)
  references public.tenants(id) on delete cascade;
alter table public.products
  add constraint products_tenant_id_fkey foreign key (tenant_id)
  references public.tenants(id) on delete cascade;
alter table public.inventory_transactions
  add constraint inventory_transactions_tenant_id_fkey foreign key (tenant_id)
  references public.tenants(id) on delete cascade;
alter table public.inventory_transactions
  add constraint inventory_transactions_location_id_fkey foreign key (location_id)
  references public.locations(id);
alter table public.orders
  add constraint orders_tenant_id_fkey foreign key (tenant_id)
  references public.tenants(id) on delete cascade;
alter table public.orders
  add constraint orders_customer_id_fkey foreign key (customer_id)
  references public.customers(id) on delete set null;
alter table public.orders
  add constraint orders_location_id_fkey foreign key (location_id)
  references public.locations(id) on delete set null;
alter table public.order_tracking
  add constraint order_tracking_tenant_id_fkey foreign key (tenant_id)
  references public.tenants(id) on delete cascade;

alter table public.locations
  add constraint locations_tenant_id_id_key unique (tenant_id, id);
alter table public.products
  add constraint products_tenant_id_id_key unique (tenant_id, id);
alter table public.customers
  add constraint customers_tenant_id_id_key unique (tenant_id, id);
alter table public.orders
  add constraint orders_tenant_id_id_key unique (tenant_id, id);
alter table public.order_tracking
  drop constraint order_tracking_order_id_fkey,
  add constraint order_tracking_tenant_order_fkey
  foreign key (tenant_id, order_id) references public.orders(tenant_id, id) on delete cascade;
alter table public.inventory_levels
  add constraint inventory_levels_tenant_location_fkey
  foreign key (tenant_id, location_id) references public.locations(tenant_id, id) on delete cascade;
alter table public.inventory_levels
  add constraint inventory_levels_tenant_product_fkey
  foreign key (tenant_id, product_id) references public.products(tenant_id, id) on delete cascade;
alter table public.inventory_transactions
  add constraint inventory_transactions_tenant_location_fkey
  foreign key (tenant_id, location_id) references public.locations(tenant_id, id);
alter table public.inventory_transactions
  add constraint inventory_transactions_tenant_product_fkey
  foreign key (tenant_id, product_id) references public.products(tenant_id, id);
alter table public.orders
  add constraint orders_tenant_location_fkey
  foreign key (tenant_id, location_id) references public.locations(tenant_id, id)
  on delete set null (location_id);
alter table public.orders
  add constraint orders_tenant_customer_fkey
  foreign key (tenant_id, customer_id) references public.customers(tenant_id, id)
  on delete set null (customer_id);

alter table public.products drop constraint products_barcode_key;
alter table public.products drop constraint products_slug_key;
alter table public.categories drop constraint categories_name_key;
alter table public.categories drop constraint categories_slug_key;
alter table public.orders drop constraint orders_order_number_key;

alter table public.products add constraint products_tenant_barcode_key unique (tenant_id, barcode);
alter table public.products add constraint products_tenant_slug_key unique (tenant_id, slug);
alter table public.categories add constraint categories_tenant_name_key unique (tenant_id, name);
alter table public.categories add constraint categories_tenant_slug_key unique (tenant_id, slug);
alter table public.orders add constraint orders_tenant_order_number_key unique (tenant_id, order_number);

drop index if exists public.idx_products_barcode;
drop index if exists public.idx_products_slug;
drop index if exists public.idx_orders_order_number;
drop index if exists public.inventory_transactions_operation_id_uidx;

create unique index inventory_transactions_tenant_operation_id_uidx
  on public.inventory_transactions (tenant_id, operation_id)
  where operation_id is not null;
create index inventory_transactions_tenant_created_at_idx
  on public.inventory_transactions (tenant_id, created_at desc);
create index inventory_transactions_tenant_product_created_at_idx
  on public.inventory_transactions (tenant_id, product_id, created_at desc);
create index inventory_transactions_tenant_location_created_at_idx
  on public.inventory_transactions (tenant_id, location_id, created_at desc);
create index tenant_memberships_user_id_idx
  on public.tenant_memberships (user_id, status);
create index customers_auth_user_id_idx
  on public.customers (auth_user_id) where auth_user_id is not null;
create index orders_tenant_customer_created_at_idx
  on public.orders (tenant_id, customer_id, created_at desc);

alter table public.products alter column stock_quantity set default 0;
alter table public.products alter column stock_quantity set not null;

alter table public.profiles drop constraint profiles_role_check;
alter table public.profiles alter column role set default 'customer';
alter table public.profiles
  add constraint profiles_role_check check (role in ('customer', 'warehouse', 'admin'));

create or replace trigger set_tenants_updated_at
before update on public.tenants
for each row execute function public.update_updated_at_column();
create or replace trigger set_locations_updated_at
before update on public.locations
for each row execute function public.update_updated_at_column();
create or replace trigger set_tenant_memberships_updated_at
before update on public.tenant_memberships
for each row execute function public.update_updated_at_column();
create or replace trigger set_customers_updated_at
before update on public.customers
for each row execute function public.update_updated_at_column();

alter table public.tenants enable row level security;
alter table public.locations enable row level security;
alter table public.tenant_memberships enable row level security;
alter table public.platform_admins enable row level security;
alter table public.customers enable row level security;
alter table public.inventory_levels enable row level security;

comment on column public.profiles.role is
  'Legacy global role retained during transition. Tenant authorization uses tenant_memberships.role.';
comment on column public.products.stock_quantity is
  'Compatibility aggregate across locations; inventory_levels is the location-level source of truth.';

commit;
