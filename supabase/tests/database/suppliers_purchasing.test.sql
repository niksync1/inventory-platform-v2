begin;
create extension if not exists pgtap with schema extensions;
set search_path = public, extensions;
select no_plan();

select has_table('public','suppliers','supplier directory exists');
select has_table('public','purchase_orders','purchase orders exist');
select has_table('public','purchase_order_items','purchase orders support multiple lines');
select has_table('public','purchase_receipts','goods receipts are recorded');
select has_table('public','purchase_receipt_items','goods receipt lines are recorded');
select has_table('public','supplier_payments','supplier payments are tracked');
select has_view('public','purchase_order_report','purchase order balance report exists');
select has_function('public','create_purchase_order',array['uuid','uuid','uuid','text','text','jsonb','text'],'purchase order RPC exists');
select has_function('public','receive_purchase_order',array['uuid','jsonb','text','text'],'goods receipt RPC exists');
select has_function('public','record_supplier_payment',array['uuid','numeric','text','text','text','text'],'supplier payment RPC exists');

insert into auth.users(id,email) values ('f1000000-0000-4000-8000-000000000001','purchasing-owner@test.invalid');
insert into public.tenants(id,name,slug) values ('f2000000-0000-4000-8000-000000000001','Purchasing Test','purchasing-test');
insert into public.tenant_memberships(tenant_id,user_id,role,status)
values ('f2000000-0000-4000-8000-000000000001','f1000000-0000-4000-8000-000000000001','owner','active');
insert into auth.users(id,email) values ('f1000000-0000-4000-8000-000000000002','purchasing-viewer@test.invalid');
insert into public.tenant_memberships(tenant_id,user_id,role,status)
values ('f2000000-0000-4000-8000-000000000001','f1000000-0000-4000-8000-000000000002','viewer','active');
insert into auth.users(id,email) values ('f1000000-0000-4000-8000-000000000003','purchasing-warehouse@test.invalid');
insert into public.tenant_memberships(tenant_id,user_id,role,status)
values ('f2000000-0000-4000-8000-000000000001','f1000000-0000-4000-8000-000000000003','warehouse','active');
insert into public.locations(id,tenant_id,name,code)
values ('f3000000-0000-4000-8000-000000000001','f2000000-0000-4000-8000-000000000001','Main','MAIN');
insert into public.products(id,tenant_id,name,slug,price)
values ('f4000000-0000-4000-8000-000000000001','f2000000-0000-4000-8000-000000000001','Test Product','purchasing-test-product',5);
insert into public.suppliers(id,tenant_id,supplier_type,name)
values ('f5000000-0000-4000-8000-000000000001','f2000000-0000-4000-8000-000000000001','business','Test Supplier');

set local role authenticated;
select set_config('request.jwt.claims','{"sub":"f1000000-0000-4000-8000-000000000001","role":"authenticated"}',true);

select lives_ok(
 $$select public.create_purchase_order(
 'f2000000-0000-4000-8000-000000000001','f3000000-0000-4000-8000-000000000001',
 'f5000000-0000-4000-8000-000000000001','GHS',null,
 '[{"product_id":"f4000000-0000-4000-8000-000000000001","quantity":10,"unit_cost":2.5}]'::jsonb,
 'po-idempotency-test')$$,
 'owner can create a purchase order using existing products'
);
select lives_ok(
 $$select public.create_purchase_order(
 'f2000000-0000-4000-8000-000000000001','f3000000-0000-4000-8000-000000000001',
 'f5000000-0000-4000-8000-000000000001','GHS',null,
 '[{"product_id":"f4000000-0000-4000-8000-000000000001","quantity":10,"unit_cost":2.5}]'::jsonb,
 'po-idempotency-test')$$,
 'purchase order retries are idempotent'
);
select is((select count(*)::integer from public.purchase_orders where tenant_id='f2000000-0000-4000-8000-000000000001'),1,'retry creates no duplicate purchase order');
select is((select total_amount from public.purchase_orders where operation_id='po-idempotency-test'),25::numeric,'purchase order total is calculated from line quantity and unit cost');
select throws_ok(
 $$insert into public.suppliers(tenant_id,supplier_type,name) values ('f2000000-0000-4000-8000-000000000001','business','Mobile Write Must Fail')$$,
 '42501','permission denied for table suppliers','mobile clients cannot create supplier accounts directly'
);
select throws_ok(
 $$update public.suppliers set name='Mobile Update Must Fail' where id='f5000000-0000-4000-8000-000000000001'$$,
 '42501','permission denied for table suppliers','mobile clients cannot update supplier accounts directly'
);
select throws_ok(
 $$delete from public.suppliers where id='f5000000-0000-4000-8000-000000000001'$$,
 '42501','permission denied for table suppliers','mobile clients cannot delete supplier accounts directly'
);
select lives_ok(
 $$select public.update_purchase_order(
  (select id from public.purchase_orders where operation_id='po-idempotency-test'),
  'f5000000-0000-4000-8000-000000000001','f3000000-0000-4000-8000-000000000001','GHS',null,
  '[{"product_id":"f4000000-0000-4000-8000-000000000001","quantity":10,"unit_cost":2.5}]'::jsonb
 )$$,
 'owner can edit an unreceived purchase order'
);
select is((select total_amount from public.purchase_orders where operation_id='po-idempotency-test'),25::numeric,'editing preserves the recalculated order total');
select lives_ok(
 $$select public.create_purchase_order(
 'f2000000-0000-4000-8000-000000000001','f3000000-0000-4000-8000-000000000001',
 'f5000000-0000-4000-8000-000000000001','GHS',null,
 '[{"product_id":"f4000000-0000-4000-8000-000000000001","quantity":1,"unit_cost":1}]'::jsonb,
 'po-delete-test')$$,
 'owner can create a second order for delete testing'
);
select lives_ok(
 $$select public.delete_purchase_order((select id from public.purchase_orders where operation_id='po-delete-test'))$$,
 'owner can delete an order with no receipts or payments'
);
select is((select count(*)::integer from public.purchase_orders where operation_id='po-delete-test'),0,'deleted purchase order is removed');
select is((select count(*)::integer from public.inventory_levels where tenant_id='f2000000-0000-4000-8000-000000000001' and product_id='f4000000-0000-4000-8000-000000000001'),0,'creating an order does not increase stock');
select set_config('test.purchase_order_id',(select id::text from public.purchase_orders where operation_id='po-idempotency-test'),true);
select set_config('test.purchase_order_item_id',(select id::text from public.purchase_order_items where purchase_order_id=(select id from public.purchase_orders where operation_id='po-idempotency-test')),true);
select set_config('request.jwt.claims','{"sub":"f1000000-0000-4000-8000-000000000002","role":"authenticated"}',true);
select is((select count(*)::integer from public.suppliers where tenant_id='f2000000-0000-4000-8000-000000000001'),0,'viewer cannot read supplier records through direct queries');
select is((select count(*)::integer from public.purchase_orders where tenant_id='f2000000-0000-4000-8000-000000000001'),0,'viewer cannot read purchase orders');
select is((select count(*)::integer from public.purchase_order_items where tenant_id='f2000000-0000-4000-8000-000000000001'),0,'viewer cannot read purchase order line items');
select is((select count(*)::integer from public.purchase_order_report where tenant_id='f2000000-0000-4000-8000-000000000001'),0,'viewer cannot read the purchase order report');
select throws_ok(
 $$select public.receive_purchase_order(
  current_setting('test.purchase_order_id')::uuid,
  jsonb_build_array(jsonb_build_object(
    'item_id',current_setting('test.purchase_order_item_id')::uuid,
    'quantity',1,'batch_number','LOT-VIEWER','expiry_date',(current_date+60)::text
  )),null,'viewer-receipt-test')$$,
 'P0001','Not authorized to receive stock at this location','viewer role remains read-only and cannot receive stock'
);
select throws_ok(
 $$select public.update_purchase_order(
  current_setting('test.purchase_order_id')::uuid,
  'f5000000-0000-4000-8000-000000000001','f3000000-0000-4000-8000-000000000001','GHS',null,
  '[{"product_id":"f4000000-0000-4000-8000-000000000001","quantity":10,"unit_cost":2.5}]'::jsonb
 )$$,
 'P0001','Not authorized to edit this purchase order','viewer cannot edit purchase orders'
);
select throws_ok(
 $$select public.delete_purchase_order(current_setting('test.purchase_order_id')::uuid)$$,
 'P0001','Not authorized to delete this purchase order','viewer cannot delete purchase orders'
);
select set_config('request.jwt.claims','{"sub":"f1000000-0000-4000-8000-000000000003","role":"authenticated"}',true);
select is((select count(*)::integer from public.suppliers where tenant_id='f2000000-0000-4000-8000-000000000001'),1,'warehouse can read suppliers needed for receiving');
select throws_ok(
 $$insert into public.suppliers(tenant_id,supplier_type,name) values ('f2000000-0000-4000-8000-000000000001','business','Warehouse Create Must Fail')$$,
 '42501','permission denied for table suppliers','warehouse cannot create supplier accounts');
select throws_ok(
 $$update public.suppliers set name='Warehouse Update Must Fail' where id='f5000000-0000-4000-8000-000000000001'$$,
 '42501','permission denied for table suppliers','warehouse cannot update supplier accounts');
select throws_ok(
 $$delete from public.suppliers where id='f5000000-0000-4000-8000-000000000001'$$,
 '42501','permission denied for table suppliers','warehouse cannot delete supplier accounts');
select set_config('request.jwt.claims','{"sub":"f1000000-0000-4000-8000-000000000001","role":"authenticated"}',true);

select lives_ok(
 $$select public.receive_purchase_order(
  (select id from public.purchase_orders where operation_id='po-idempotency-test'),
  jsonb_build_array(jsonb_build_object(
    'item_id',(select id from public.purchase_order_items where purchase_order_id=(select id from public.purchase_orders where operation_id='po-idempotency-test')),
    'quantity',4,'batch_number','LOT-PO-1','expiry_date',(current_date+60)::text
  )),null,'receipt-idempotency-test')$$,
 'owner can receive a partial delivery into a tracked batch'
);
select lives_ok(
 $$select public.receive_purchase_order(
  (select id from public.purchase_orders where operation_id='po-idempotency-test'),
  jsonb_build_array(jsonb_build_object(
    'item_id',(select id from public.purchase_order_items where purchase_order_id=(select id from public.purchase_orders where operation_id='po-idempotency-test')),
    'quantity',4,'batch_number','LOT-PO-1','expiry_date',(current_date+60)::text
  )),null,'receipt-idempotency-test')$$,
 'goods receipt retries are idempotent'
);
select is((select quantity from public.inventory_levels where tenant_id='f2000000-0000-4000-8000-000000000001' and product_id='f4000000-0000-4000-8000-000000000001'),4,'receipt retry does not double stock');
select is((select status from public.purchase_orders where operation_id='po-idempotency-test'),'partially_received','partial delivery keeps the order open');
select throws_ok(
 $$select public.update_purchase_order(
  (select id from public.purchase_orders where operation_id='po-idempotency-test'),
  'f5000000-0000-4000-8000-000000000001','f3000000-0000-4000-8000-000000000001','GHS',null,
  '[{"product_id":"f4000000-0000-4000-8000-000000000001","quantity":10,"unit_cost":2.5}]'::jsonb
 )$$,
 'P0001','Only orders with no receipts or payments can be edited','orders with receipt history cannot be edited'
);
select throws_ok(
 $$select public.delete_purchase_order((select id from public.purchase_orders where operation_id='po-idempotency-test'))$$,
 'P0001','Only orders with no receipts or payments can be deleted','orders with receipt history cannot be deleted'
);

select lives_ok(
 $$select public.receive_purchase_order(
  (select id from public.purchase_orders where operation_id='po-idempotency-test'),
  jsonb_build_array(jsonb_build_object(
    'item_id',(select id from public.purchase_order_items where purchase_order_id=(select id from public.purchase_orders where operation_id='po-idempotency-test')),
    'quantity',6,'batch_number','LOT-PO-2','expiry_date',(current_date+90)::text
  )),null,'receipt-second-test')$$,
 'remaining order quantity can be received later'
);
select is((select quantity from public.inventory_levels where tenant_id='f2000000-0000-4000-8000-000000000001' and product_id='f4000000-0000-4000-8000-000000000001'),10,'all received quantities update stock');
select is((select status from public.purchase_orders where operation_id='po-idempotency-test'),'received','fully received order is marked received');

select set_config('request.jwt.claims','{"sub":"f1000000-0000-4000-8000-000000000002","role":"authenticated"}',true);
select is((select count(*)::integer from public.purchase_orders where tenant_id='f2000000-0000-4000-8000-000000000001'),0,'viewer cannot read an existing purchase order');
select is((select count(*)::integer from public.purchase_order_items where tenant_id='f2000000-0000-4000-8000-000000000001'),0,'viewer cannot read existing order lines');
select is((select count(*)::integer from public.purchase_receipts where tenant_id='f2000000-0000-4000-8000-000000000001'),0,'viewer cannot read goods receipts for purchase orders');
select is((select count(*)::integer from public.purchase_receipt_items where tenant_id='f2000000-0000-4000-8000-000000000001'),0,'viewer cannot read goods receipt lines');
select is((select count(*)::integer from public.purchase_order_report where tenant_id='f2000000-0000-4000-8000-000000000001'),0,'viewer cannot read the report for existing purchase orders');
select set_config('request.jwt.claims','{"sub":"f1000000-0000-4000-8000-000000000001","role":"authenticated"}',true);

select lives_ok(
 $$select public.record_supplier_payment(
  (select id from public.purchase_orders where operation_id='po-idempotency-test'),5,'mobile_money','PAY-1',null,'payment-idempotency-test')$$,
 'purchasing manager can record a partial supplier payment'
);
select lives_ok(
 $$select public.record_supplier_payment(
  (select id from public.purchase_orders where operation_id='po-idempotency-test'),5,'mobile_money','PAY-1',null,'payment-idempotency-test')$$,
 'payment retries are idempotent'
);
select is((select count(*)::integer from public.supplier_payments where operation_id='payment-idempotency-test'),1,'payment retry does not create a duplicate payment');
select is((select outstanding_amount from public.purchase_order_report where reference=(select reference from public.purchase_orders where operation_id='po-idempotency-test')),20::numeric,'outstanding balance reflects partial payment');
select throws_ok(
 $$select public.record_supplier_payment(
  (select id from public.purchase_orders where operation_id='po-idempotency-test'),21,'cash',null,null,'overpayment-test')$$,
 'P0001','Payment exceeds the outstanding purchase balance','overpayment is rejected'
);

reset role;
select * from finish();
rollback;
