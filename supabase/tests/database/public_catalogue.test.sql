begin;
create extension if not exists pgtap with schema extensions;
set search_path = public, extensions;
select no_plan();

insert into auth.users (id, email) values
 ('11000000-0000-4000-8000-000000000001','catalog-owner@test.invalid'),
 ('11000000-0000-4000-8000-000000000002','catalog-viewer@test.invalid');
insert into public.tenants (id,name,slug,status) values
 ('22000000-0000-4000-8000-000000000001','Catalogue Test Business','catalogue-test-business','active');
insert into public.locations (id,tenant_id,name,code,is_active) values
 ('33000000-0000-4000-8000-000000000001','22000000-0000-4000-8000-000000000001','Main','MAIN',true);
insert into public.tenant_memberships (tenant_id,user_id,role,status) values
 ('22000000-0000-4000-8000-000000000001','11000000-0000-4000-8000-000000000001','owner','active');
insert into public.products (id,tenant_id,name,slug,description,price,stock_quantity,images,is_active)
values
 ('44000000-0000-4000-8000-000000000001','22000000-0000-4000-8000-000000000001','Public Test Product','public-test-product','Public description',3.50,0,array['https://example.invalid/product.jpg'],true),
 ('44000000-0000-4000-8000-000000000002','22000000-0000-4000-8000-000000000001','Private Test Product','private-test-product','Must stay private',9.99,0,'{}',true);

set local role authenticated;
select set_config('request.jwt.claims','{"sub":"11000000-0000-4000-8000-000000000001","role":"authenticated"}',true);
insert into public.public_catalogue_listings (tenant_id,product_id,retail_price,currency,is_published)
values ('22000000-0000-4000-8000-000000000001','44000000-0000-4000-8000-000000000001',12.50,'GHS',true),
       ('22000000-0000-4000-8000-000000000001','44000000-0000-4000-8000-000000000002',99.99,'GHS',false);
select is((select retail_price from public.public_catalogue_listings where product_id='44000000-0000-4000-8000-000000000001'),12.50::numeric,'retail price is separate from internal product price');
select is((select count(*) from public.public_catalogue),1::bigint,'only explicitly published products appear in public view');
select is((select product_name from public.public_catalogue limit 1),'Public Test Product','published product name is public');
select is((select retail_price from public.public_catalogue limit 1),12.50::numeric,'public catalogue exposes retail price');
select is((select count(*) from public.search_public_catalogue('private')),0::bigint,'unpublished products are not searchable');
select lives_ok($$select public.stock_in('22000000-0000-4000-8000-000000000001','33000000-0000-4000-8000-000000000001','44000000-0000-4000-8000-000000000001',5,null,'catalogue-stock-in')$$,'inventory RPC can add stock for availability');
select is((select available from public.public_catalogue limit 1),true,'availability becomes true when unexpired sellable stock exists');
select throws_ok($$update public.public_catalogue_listings set retail_price=0 where product_id='44000000-0000-4000-8000-000000000001'$$,'P0001',null,'retail listing price is constrained to business role policies');
reset role;

set local role anon;
select is((select count(*) from public.public_catalogue),1::bigint,'anonymous access only sees published public catalogue');
select is((select count(*) from public.public_catalogue_listings),0::bigint,'anonymous users cannot read internal listing records directly');
select is((select count(*) from public.search_public_catalogue('Public Test')),1::bigint,'anonymous users can search published products');
reset role;
select * from finish();
rollback;
