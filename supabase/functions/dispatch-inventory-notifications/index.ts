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

  // Recover abandoned claims. The 10-minute lease is longer than the function's
  // expected runtime. Push deliveries already accepted by Expo are preserved
  // in the delivery table and excluded from subsequent attempts below.
  const staleProcessingCutoff = new Date(Date.now() - 10 * 60_000).toISOString();
  const recovery = await supabase
    .from('inventory_notification_outbox')
    .update({
      status: 'failed',
      next_attempt_at: now,
      last_error: 'Recovered stale processing claim; delivery outcome may be unknown.',
      updated_at: now,
    })
    .eq('status', 'processing')
    .lt('updated_at', staleProcessingCutoff);

  if (recovery.error) {
    return new Response(JSON.stringify({ error: recovery.error.message }), {
      status: 500,
      headers: cors,
    });
  }

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

    if (claimed.error) {
      return new Response(JSON.stringify({ error: claimed.error.message }), {
        status: 500,
        headers: cors,
      });
    }
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
          .select('id,token')
          .eq('tenant_id', item.tenant_id)
          .eq('user_id', item.user_id)
          .eq('is_active', true);

        if (tokens.error) throw tokens.error;

        // A successful Expo ticket means the provider accepted that device's
        // notification. Never resend to that device when retrying this outbox
        // item because another device in the same batch failed.
        const priorDeliveries = await supabase
          .from('inventory_notification_push_deliveries')
          .select('token_id')
          .eq('outbox_id', item.id)
          .eq('ticket_status', 'ok');

        if (priorDeliveries.error) throw priorDeliveries.error;
        const acceptedTokenIds = new Set(
          (priorDeliveries.data ?? []).map(delivery => delivery.token_id),
        );
        const targetTokens = (tokens.data ?? []).filter(
          tokenRow => !acceptedTokenIds.has(tokenRow.id),
        );

        if (!targetTokens.length) {
          if (acceptedTokenIds.size > 0) {
            await finish(item.id, 'sent', null);
            sent += 1;
          } else {
            await finish(item.id, 'skipped', 'No active Expo push token');
            skipped += 1;
          }
          continue;
        }

        const response = await fetch(
          'https://exp.host/--/api/v2/push/send',
          {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(
              targetTokens.map(({ token }) => ({
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

        if (tickets.length !== targetTokens.length || tickets.length === 0) {
          throw new Error(
            `Unexpected Expo ticket count: received ${tickets.length} for ${targetTokens.length} token(s). Response: ${JSON.stringify(expoResult)}`,
          );
        }

        const ticketErrors: string[] = [];
        const successfulTickets: { id: string }[] = [];

        for (let index = 0; index < tickets.length; index += 1) {
          const ticket = tickets[index] as {
            status?: string;
            id?: string;
            message?: string;
            details?: { error?: string; [key: string]: unknown };
          };
          const tokenRow = targetTokens[index];
          const token = tokenRow?.token;

          if (ticket?.status === 'ok' && typeof ticket.id === 'string' && tokenRow?.id) {
            successfulTickets.push({ id: ticket.id });

            const delivery = await supabase
              .from('inventory_notification_push_deliveries')
              .insert({
                outbox_id: item.id,
                token_id: tokenRow.id,
                expo_ticket_id: ticket.id,
                ticket_status: 'ok',
                receipt_status: 'pending',
              });

            if (delivery.error) throw delivery.error;
            continue;
          }

          if (
            ticket?.status === 'error' &&
            ticket?.details?.error === 'DeviceNotRegistered' &&
            token &&
            tokenRow?.id
          ) {
            const delivery = await supabase
              .from('inventory_notification_push_deliveries')
              .insert({
                outbox_id: item.id,
                token_id: tokenRow.id,
                ticket_status: 'error',
                receipt_status: 'error',
                receipt_checked_at: new Date().toISOString(),
                receipt_error: 'DeviceNotRegistered',
              });

            if (delivery.error) throw delivery.error;

            const deactivation = await supabase
              .from('expo_push_tokens')
              .update({ is_active: false })
              .eq('id', tokenRow.id)
              .eq('is_active', true);

            if (deactivation.error) throw deactivation.error;
            continue;
          }

          const ticketError = ticket?.status === 'error'
            ? `${ticket.message ?? 'Expo ticket error'} ${JSON.stringify(ticket.details ?? {})}`
            : `Invalid Expo ticket: ${JSON.stringify(ticket)}`;

          // Persist the failed device attempt for diagnosis. It remains
          // retryable because only ticket_status='ok' deliveries are excluded.
          const failedDelivery = await supabase
            .from('inventory_notification_push_deliveries')
            .insert({
              outbox_id: item.id,
              token_id: tokenRow.id,
              ticket_status: 'error',
              receipt_status: 'error',
              receipt_checked_at: new Date().toISOString(),
              receipt_error: ticketError,
            });

          if (failedDelivery.error) throw failedDelivery.error;
          ticketErrors.push(ticketError);
        }

        if (ticketErrors.length > 0) {
          throw new Error(ticketErrors.join('; '));
        }

        if (successfulTickets.length === 0) {
          await finish(item.id, 'skipped', 'All active Expo push tokens are no longer registered');
          skipped += 1;
          continue;
        }

        // Keep the existing outbox-level ticket for backward-compatible diagnostics.
        const trackingUpdate = await supabase
          .from('inventory_notification_outbox')
          .update({
            expo_ticket_id: successfulTickets[0].id,
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

      const failureUpdate = await supabase
        .from('inventory_notification_outbox')
        .update({
          status: 'failed',
          attempts,
          next_attempt_at: next,
          last_error: error instanceof Error ? error.message : 'Delivery failed',
          updated_at: new Date().toISOString(),
        })
        .eq('id', item.id);

      if (failureUpdate.error) {
        return new Response(JSON.stringify({ error: failureUpdate.error.message }), {
          status: 500,
          headers: cors,
        });
      }
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
  const result = await supabase
    .from('inventory_notification_outbox')
    .update({
      status,
      last_error: lastError,
      sent_at: status === 'sent' ? new Date().toISOString() : null,
      updated_at: new Date().toISOString(),
    })
    .eq('id', id)
    .select('id')
    .maybeSingle();

  if (result.error) throw result.error;
  if (!result.data) throw new Error(`Outbox status update affected no row: ${id}`);
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
