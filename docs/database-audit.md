# Database audit and migration safety

## Source of truth

`20260913000100_live_public_schema_baseline.sql` captures the public schema that
was live on 2026-09-13. The legacy migrations are historical inputs, but they are
not a complete rebuild because `products` and `inventory_transactions` were
created outside that chain.

## Migration policy

- The baseline represents objects that already exist in production.
- Never apply the baseline to the linked production database as a pending change.
- Replay the complete chain against a clean local Supabase instance first.
- Reconcile the baseline with production migration history only after review.
- Apply only the additive multi-tenant migrations to production after backup,
  dry-run review, data preflight, and tenant-isolation tests.

## Confirmed live risks addressed forward

- Global roles are replaced by tenant-scoped memberships for authorization.
- Platform administrators are stored separately from tenant roles.
- Existing data is assigned to a stable initial tenant and main location.
- Barcode, slug, category, and order-number uniqueness becomes tenant-scoped.
- Inventory idempotency becomes tenant-scoped.
- Location inventory is separated from the product compatibility aggregate.
- Public order-tracking access and email-session order matching are removed.
- Anonymous function execution and broad default privileges are revoked.
- Report-oriented transaction indexes are added.

## Required preflight on production

Before applying forward migrations, confirm:

1. No product has a null or negative `stock_quantity`.
2. Existing profile roles are only `warehouse` or `admin`.
3. Customer emails do not conflict case-insensitively within the initial tenant.
4. Every order-tracking row references an order or can be assigned safely.
5. Existing `operation_id` values are unique.
6. The initial tenant name and slug have been changed from placeholders.
7. A logical backup has completed and is stored outside Git.

## Validation gates

Run locally:

```powershell
npx supabase start
npx supabase db reset
npx supabase test db
npx supabase db lint --local --schema public --fail-on error
```

Then compare local migrations with the linked project. Do not run `db push`
until every generated difference has been reviewed.
