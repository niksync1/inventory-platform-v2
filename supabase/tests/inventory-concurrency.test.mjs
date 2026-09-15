// Local-only integration test: never accepts a remote database URL.
import { spawn } from 'node:child_process';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { readFile } from 'node:fs/promises';

const container = 'supabase_db_inventory-platform-v2-work';
const tenant = '70000000-0000-4000-8000-000000000001';
const location = '70000000-0000-4000-8000-000000000002';
const product = '70000000-0000-4000-8000-000000000003';

function connection(sql, keepOpen = false) {
  const child = spawn('docker', ['exec', '-i', container, 'psql', '-X', '-qAt',
    '-U', 'postgres', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1'], { windowsHide: true });
  const result = { stdout: '', stderr: '' };
  child.stdout.on('data', data => { result.stdout += data; });
  child.stderr.on('data', data => { result.stderr += data; });
  const done = new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('close', code => resolve({ ...result, code }));
  });
  child.stdin.write(sql + '\n');
  if (!keepOpen) child.stdin.end();
  return { child, result, done };
}
async function query(sql) {
  const result = await connection(sql).done;
  assert.equal(result.code, 0, result.stderr);
  return result.stdout.trim();
}
const rpc = (operation, quantity) => `select public.stock_in('${tenant}','${location}','${product}',${quantity},null,'${operation}');`;
const backend = `set role service_role; set request.jwt.claims = '{"role":"service_role"}';`;

test('migration preflight preserves equivalent constraints and rejects incompatible definitions and invalid stock', async () => {
  const migration = await readFile(new URL('../migrations/20260913000200_multi_tenant_core.sql', import.meta.url), 'utf8');
  const preflight = migration.slice(0, migration.indexOf('create table public.tenants')).replace(/^begin;\s*/, '');
  const backfillStart = migration.indexOf('insert into public.inventory_levels');
  const backfill = migration.slice(backfillStart, migration.indexOf(';', backfillStart) + 1);
  const copied = await query(`begin;
    alter table public.products disable trigger guard_product_stock;
    alter table public.inventory_levels disable trigger guard_inventory_writes;
    insert into public.products(id,tenant_id,name,slug,price,stock_quantity)
    values ('70000000-0000-4000-8000-000000000004','00000000-0000-4000-8000-000000000001','Backfill','backfill-test',1,173);
    ${preflight}
    ${backfill}
    select quantity from public.inventory_levels where product_id='70000000-0000-4000-8000-000000000004';
    rollback;`);
  assert.equal(copied, '173', 'backfill copies the exact validated stock value');
  for (const expression of ['stock_quantity >= 0', '0 <= stock_quantity']) {
    const output = await query(`begin;
      alter table public.products drop constraint products_stock_quantity_nonnegative;
      alter table public.products add constraint products_stock_quantity_nonnegative check (${expression});
      select oid from pg_constraint where conrelid='public.products'::regclass and conname='products_stock_quantity_nonnegative';
      ${preflight}
      select oid from pg_constraint where conrelid='public.products'::regclass and conname='products_stock_quantity_nonnegative';
      rollback;`);
    const [before, after] = output.split(/\r?\n/);
    assert.equal(before, after, 'equivalent existing constraint must retain its OID');
  }
  const incompatible = await connection(`begin;
    alter table public.products drop constraint products_stock_quantity_nonnegative;
    alter table public.products add constraint products_stock_quantity_nonnegative check (stock_quantity >= -1);
    ${preflight}`).done;
  assert.notEqual(incompatible.code, 0);
  assert.match(incompatible.stderr, /Incompatible products_stock_quantity_nonnegative constraint/);
  for (const invalidStock of ['null', '-1']) {
    const invalid = await connection(`begin;
      alter table public.products disable trigger guard_product_stock;
      alter table public.products drop constraint products_stock_quantity_nonnegative;
      alter table public.products alter column stock_quantity drop not null;
      insert into public.products(tenant_id,name,slug,price,stock_quantity)
      values ('00000000-0000-4000-8000-000000000001','Invalid','invalid-preflight',1,${invalidStock});
      ${preflight}`).done;
    assert.notEqual(invalid.code, 0);
    assert.match(invalid.stderr, /product stock must be non-null and nonnegative/);
  }
});

test('concurrent inventory retries serialize and compare the complete request', { timeout: 60000 }, async () => {
  await query(`
    insert into public.tenants(id,name,slug) values ('${tenant}','Concurrency test','concurrency-test');
    insert into public.locations(id,tenant_id,name,code) values ('${location}','${tenant}','Main','MAIN');
    insert into public.products(id,tenant_id,name,slug,price) values ('${product}','${tenant}','Test','test',1);
  `);
  try {
    for (const [operation, retryQuantity, succeeds] of [['equivalent',10,true], ['conflict',11,false]]) {
      const first = connection(`begin; ${backend} ${rpc(operation,10)}\n\\echo READY`, true);
      let second;
      try {
        for (let attempt = 0; !first.result.stdout.includes('READY') && attempt < 100; attempt++) {
          if (first.result.stderr.includes('ERROR')) throw new Error(first.result.stderr);
          await delay(50);
        }
        assert.ok(first.result.stdout.includes('READY'), first.result.stderr || 'first transaction did not become ready');
        second = connection(`set application_name = 'inventory_concurrency_retry'; ${backend} ${rpc(operation,retryQuantity)}`);
        let blocked = false;
        for (let attempt = 0; attempt < 30; attempt++) {
          blocked = (await query(`select exists (
            select 1 from pg_locks l join pg_stat_activity a on a.pid=l.pid
            where a.application_name='inventory_concurrency_retry'
              and l.locktype='advisory' and not l.granted);`)) === 't';
          if (blocked) break;
          await delay(50);
        }
        assert.ok(blocked, 'second transaction must actually wait for the operation lock');
        first.child.stdin.end('commit;\n');
        assert.equal((await first.done).code, 0);
        const retry = await second.done;
        if (succeeds) assert.equal(retry.code, 0, retry.stderr);
        else {
          assert.notEqual(retry.code, 0);
          assert.match(retry.stderr, /Operation ID conflicts with an existing inventory request/);
        }
      } finally {
        if (!first.child.stdin.writableEnded) first.child.stdin.end('rollback;\n');
        await first.done;
        if (second) await second.done;
      }
    }
    assert.equal(await query(`select stock_quantity from public.products where id='${product}'`), '20');
    assert.equal(await query(`select quantity from public.inventory_levels where product_id='${product}'`), '20');
    assert.equal(await query(`select count(*) from public.inventory_transactions where product_id='${product}'`), '2');
  } finally {
    // Fixtures committed for cross-connection visibility. Local administrative
    // teardown briefly disables only the write guards inside one transaction.
    await query(`begin;
      alter table public.inventory_transactions disable trigger guard_inventory_writes;
      alter table public.inventory_levels disable trigger guard_inventory_writes;
      delete from public.inventory_transactions where tenant_id='${tenant}';
      delete from public.inventory_levels where tenant_id='${tenant}';
      delete from public.products where tenant_id='${tenant}';
      delete from public.tenants where id='${tenant}';
      alter table public.inventory_transactions enable trigger guard_inventory_writes;
      alter table public.inventory_levels enable trigger guard_inventory_writes;
      commit;`);
  }
});
