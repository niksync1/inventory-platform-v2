import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const supabase = createClient(
  Deno.env.get('SUPABASE_URL')!,
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
);
const cors = { 'content-type': 'application/json' };

Deno.serve(async request => {
  if (
    request.headers.get('x-cron-secret') !==
    Deno.env.get('INVENTORY_NOTIFICATION_CRON_SECRET')
  ) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 401,
      headers: cors,
    });
  }

  const now = new Date().toISOString();
  const result = await supabase
    .from('inventory_notification_outbox')
    .select('id,tenant_id,alert_id,user_id,channel,attempts')
    .in('status', ['pending', 'failed'])
    .lte('next_attempt_at', now)
    .order('created_at')
    .limit(100);

  if (result.error) {
    return new Response(JSON.stringify({ error: result.error.message }), {
      status: 500,
      headers: cors,
    });
  }

  let sent = 0;
  let failed = 0;
  let skipped = 0;

  for (const item of result.data ?? []) {
    const claimed = await supabase
      .from('inventory_notification_outbox')
      .update({ status: 'processing', updated_at: now })
      .eq('id', item.id)
      .in('status', ['pending', 'failed'])
      .select('id')
      .maybeSingle();

    if (!claimed.data) continue;

    try {
      const [alertResult, profileResult] = await Promise.all([
        supabase
          .from('inventory_alerts')
          .select('alert_type,severity,message,location_id')
          .eq('id', item.alert_id)
          .single(),
        supabase
          .from('profiles')
          .select('email,name')
          .eq('id', item.user_id)
          .single(),
      ]);

      if (alertResult.error) throw alertResult.error;

      if (item.channel === 'push') {
        const tokens = await supabase
          .from('expo_push_tokens')
          .select('token')
          .eq('tenant_id', item.tenant_id)
          .eq('user_id', item.user_id)
          .eq('is_active', true);

        if (tokens.error) throw tokens.error;

        if (!tokens.data?.length) {
          await finish(item.id, 'skipped', 'No active Expo push token');
          skipped += 1;
          continue;
        }

        const response = await fetch(
          'https://exp.host/--/api/v2/push/send',
          {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(
              tokens.data.map(({ token }) => ({
                to: token,
                sound: 'default',
                channelId: 'inventory-alerts',
                title: titleFor(alertResult.data.alert_type),
                body: alertResult.data.message,
                data: {
                  alertId: item.alert_id,
                  tenantId: item.tenant_id,
                  locationId: alertResult.data.location_id,
                },
              })),
            ),
          },
        );

        const expoResult = await response.json();

        if (!response.ok) {
          throw new Error(
            `Expo push rejected the request (${response.status}): ${JSON.stringify(expoResult)}`,
          );
        }

        const tickets = Array.isArray(expoResult.data)
          ? expoResult.data
          : [expoResult.data];

        if (tickets.length !== tokens.data.length || tickets.length === 0) {
          throw new Error(
            `Unexpected Expo ticket count: received ${tickets.length} for ${tokens.data.length} token(s). Response: ${JSON.stringify(expoResult)}`,
          );
        }

        const ticketErrors = tickets
          .map((ticket: { status?: string; message?: string; details?: unknown }) =>
            ticket?.status === 'error'
              ? `${ticket.message ?? 'Expo ticket error'} ${JSON.stringify(ticket.details ?? {})}`
              : ticket?.status !== 'ok' || typeof ticket.id !== 'string'
                ? `Invalid Expo ticket: ${JSON.stringify(ticket)}`
                : null,
          )
          .filter(Boolean);

        if (ticketErrors.length > 0) {
          throw new Error(ticketErrors.join('; '));
        }

        // The outbox is currently one row per user/channel. Preserve the first
        // ticket for receipt diagnostics; the user currently has one active device.
        const trackingUpdate = await supabase
          .from('inventory_notification_outbox')
          .update({
            expo_ticket_id: tickets[0].id,
            expo_receipt_status: 'pending',
            expo_receipt_checked_at: null,
            expo_receipt_error: null,
            updated_at: new Date().toISOString(),
          })
          .eq('id', item.id);

        if (trackingUpdate.error) throw trackingUpdate.error;
      } else {
        const apiKey = Deno.env.get('RESEND_API_KEY');
        const from = Deno.env.get('INVENTORY_ALERT_EMAIL_FROM');

        if (!apiKey || !from || !profileResult.data?.email) {
          await finish(item.id, 'skipped', 'Email delivery is not configured');
          skipped += 1;
          continue;
        }

        const response = await fetch('https://api.resend.com/emails', {
          method: 'POST',
          headers: {
            authorization: `Bearer ${apiKey}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            from,
            to: [profileResult.data.email],
            subject: titleFor(alertResult.data.alert_type),
            text: alertResult.data.message,
          }),
        });

        if (!response.ok) {
          throw new Error(`Email provider rejected the request (${response.status})`);
        }
      }

      await finish(item.id, 'sent', null);
      sent += 1;
    } catch (error) {
      const attempts = item.attempts + 1;
      const next = new Date(
        Date.now() + Math.min(60, 2 ** attempts) * 60_000,
      ).toISOString();

      await supabase
        .from('inventory_notification_outbox')
        .update({
          status: 'failed',
          attempts,
          next_attempt_at: next,
          last_error: error instanceof Error ? error.message : 'Delivery failed',
          updated_at: new Date().toISOString(),
        })
        .eq('id', item.id);
      failed += 1;
    }
  }

  return new Response(JSON.stringify({ processed: sent + failed + skipped, sent, failed, skipped }), {
    headers: cors,
  });
});

async function finish(
  id: string,
  status: 'sent' | 'skipped',
  lastError: string | null,
) {
  await supabase
    .from('inventory_notification_outbox')
    .update({
      status,
      last_error: lastError,
      sent_at: status === 'sent' ? new Date().toISOString() : null,
      updated_at: new Date().toISOString(),
    })
    .eq('id', id);
}

function titleFor(type: string) {
  return (
    {
      LOW_STOCK: 'Low stock',
      OUT_OF_STOCK: 'Out of stock',
      DAMAGE: 'Damaged goods',
      EXPIRED: 'Expired goods',
      EXPIRING_90_DAYS: 'Batch expiry warning',
      EXPIRING_30_DAYS: 'Batch expiry warning',
      BATCH_EXPIRED: 'Batch expired',
      TRANSFER_PENDING_RECEIPT: 'Transfer awaiting receipt',
      SYNC_FAILURE: 'Inventory sync needs attention',
    } as Record<string, string>
  )[type] ?? 'Inventory alert';
}
