# Inventory notification dispatcher

Deploy this function with JWT verification disabled because access is protected by `x-cron-secret`:

```bash
supabase functions deploy dispatch-inventory-notifications --no-verify-jwt
supabase secrets set INVENTORY_NOTIFICATION_CRON_SECRET=<strong-random-secret>
```

For email delivery also configure `RESEND_API_KEY` and `INVENTORY_ALERT_EMAIL_FROM`. Schedule an authenticated POST from Supabase Cron every five minutes and send the same secret in the `x-cron-secret` header. Push delivery uses Expo's push service.
