# Inventory Platform v2

A clean rebuild of the React Native inventory and sales application, using the
existing Supabase project as the system of record.

## Foundation

- Expo SDK 57, React Native 0.86, and strict TypeScript
- Feature-based application boundaries
- Tested inventory rules and a user-scoped offline operation model
- GitHub Actions validation on every pull request
- No credentials committed to source control

## Local setup

1. Install Node.js 24 and run `npm ci`.
2. Copy `.env.example` to `.env.local` and enter the Supabase URL and anon key.
3. Run `npm start`.

## Local Android push setup

The permanent Android application ID is `com.ck1gh.inventoryplatformv2`. Register
an Android app with that exact ID in Firebase, download its `google-services.json`,
and place the file in the repository root. The file is intentionally ignored by
Git. Never place the Firebase service-account private key in the repository.

After adding or changing Firebase/native configuration, regenerate and install
the local development client:

```powershell
npx expo prebuild --clean
npx expo run:android --device
```

For later JavaScript-only changes, use `npx expo start --dev-client` without
rebuilding the APK.

## Validation

Run `npm run typecheck` and `npm test`.

## Rebuild sequence

1. Audit the existing Supabase schema, migrations, indexes, RPC functions, and RLS.
2. Add authentication and session lifecycle handling.
3. Add products, barcode lookup, and safe text search.
4. Add idempotent stock-in and stock-out operations.
5. Add account-isolated offline persistence, cancellation, retry, and recovery UI.
6. Add summaries, line-level reports, custom date ranges, CSV, and PDF export.
7. Add wholesale/retail pricing, Paystack routing, and administration.

Existing production data will not be mutated until the database audit is complete.

## Multi-tenant database foundation

The `multi-tenant-foundation` work adds an ordered Supabase baseline and forward
migrations for tenants, memberships, locations, customers, location inventory,
tenant-aware RPCs, RLS, grants, and database tests. Offline operations are isolated
by both authenticated user and tenant. See
`docs/database-audit.md` before applying any migration to a linked project.

## Tenant onboarding

The application restores Supabase sessions, loads active tenant memberships,
selects an active warehouse/location, and scopes inventory summaries and RPC
inputs to that context. Tenant selection is stored per user. Signing out removes
that user's saved selection and offline operation queues from the device.
