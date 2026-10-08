import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const supabase = createClient(
  Deno.env.get('SUPABASE_URL')!,
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
);

const cors = { 'content-type': 'application/json' };
const EXPO_RECEIPT_URL = 'https://exp.host/--/api/v2/push/getReceipts';
const RECEIPT_WAIT_MINUTES = 15;
const RECEIPT_RETENTION_HOURS = 24;
const MAX_RECEIPTS_PER_REQUEST = 1000;

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

  const now = new Date();
  const receiptCutoff = new Date(
    now.getTime() - RECEIPT_WAIT_MINUTES * 60_000,
  ).toISOString();
  const receiptExpiryCutoff = new Date(
    now.getTime() - RECEIPT_RETENTION_HOURS * 60 * 60_000,
  ).toISOString();

  const expiredResult = await supabase
    .from('inventory_notification_push_deliveries')
    .update(
      {
        receipt_status: 'expired',
        receipt_checked_at: now.toISOString(),
        receipt_error:
          'Expo receipt unavailable after the 24-hour receipt retention period. Delivery outcome is unknown.',
        updated_at: now.toISOString(),
      },
      { count: 'exact' },
    )
    .eq('ticket_status', 'ok')
    .eq('receipt_status', 'pending')
    .not('expo_ticket_id', 'is', null)
    .lte('created_at', receiptExpiryCutoff);

  if (expiredResult.error) {
    return new Response(
      JSON.stringify({ error: expiredResult.error.message }),
      { status: 500, headers: cors },
    );
  }

  const expired = expiredResult.count ?? 0;

  const result = await supabase
    .from('inventory_notification_push_deliveries')
    .select(
      'id,token_id,expo_ticket_id,receipt_checked_at,receipt_status',
    )
    .eq('ticket_status', 'ok')
    .not('expo_ticket_id', 'is', null)
    .eq('receipt_status', 'pending')
    .lte('created_at', receiptCutoff)
    .or(
      'receipt_checked_at.is.null,receipt_checked_at.lte.' + receiptCutoff,
    )
    .order('created_at')
    .limit(MAX_RECEIPTS_PER_REQUEST);

  if (result.error) {
    return new Response(JSON.stringify({ error: result.error.message }), {
      status: 500,
      headers: cors,
    });
  }

  const items = result.data ?? [];

  if (items.length === 0) {
    return new Response(
      JSON.stringify({
        processed: 0,
        delivered: 0,
        failed: 0,
        pending: 0,
        expired,
      }),
      { headers: cors },
    );
  }

  const ids = items.map(item => item.expo_ticket_id as string);

  let expoResponse: Response;

  try {
    expoResponse = await fetch(EXPO_RECEIPT_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ids }),
    });
  } catch (error) {
    return new Response(
      JSON.stringify({
        error:
          error instanceof Error
            ? error.message
            : 'Unable to reach Expo receipt service',
      }),
      { status: 502, headers: cors },
    );
  }

  const expoResult = await expoResponse.json();

  if (!expoResponse.ok) {
    return new Response(
      JSON.stringify({
        error:
          'Expo receipt request rejected (' +
          expoResponse.status +
          ')',
        details: expoResult,
      }),
      { status: 502, headers: cors },
    );
  }

  const receipts = expoResult?.data ?? {};
  const checkedAt = new Date().toISOString();

  let delivered = 0;
  let failed = 0;
  let pending = 0;
  let deactivated = 0;

  for (const item of items) {
    const ticketId = item.expo_ticket_id as string;
    const receipt = receipts[ticketId];

    if (!receipt) {
      await updateDelivery(item.id, {
        receipt_status: 'pending',
        receipt_checked_at: checkedAt,
        receipt_error: null,
      });
      pending += 1;
      continue;
    }

    if (receipt.status === 'ok') {
      await updateDelivery(item.id, {
        receipt_status: 'ok',
        receipt_checked_at: checkedAt,
        receipt_error: null,
      });
      delivered += 1;
      continue;
    }

    const errorDetails = receipt.details ?? {};
    const errorCode = errorDetails.error;
    const errorMessage = [
      receipt.message ?? 'Expo receipt reported an error',
      Object.keys(errorDetails).length
        ? JSON.stringify(errorDetails)
        : null,
    ]
      .filter(Boolean)
      .join(' ');

    await updateDelivery(item.id, {
      receipt_status: 'error',
      receipt_checked_at: checkedAt,
      receipt_error: errorMessage,
    });
    failed += 1;

    if (errorCode === 'DeviceNotRegistered') {
      const deactivation = await supabase
        .from('expo_push_tokens')
        .update({ is_active: false }, { count: 'exact' })
        .eq('id', item.token_id)
        .eq('is_active', true);

      if (deactivation.error) throw deactivation.error;
      if (deactivation.count === 1) deactivated += 1;
    }
  }

  return new Response(
    JSON.stringify({
      processed: items.length,
      delivered,
      failed,
      pending,
      expired,
      deactivated,
    }),
    { headers: cors },
  );
});

async function updateDelivery(
  id: string,
  update: {
    receipt_status: 'pending' | 'ok' | 'error' | 'expired';
    receipt_checked_at: string;
    receipt_error: string | null;
  },
) {
  const result = await supabase
    .from('inventory_notification_push_deliveries')
    .update({
      ...update,
      updated_at: new Date().toISOString(),
    })
    .eq('id', id);

  if (result.error) throw result.error;
}
