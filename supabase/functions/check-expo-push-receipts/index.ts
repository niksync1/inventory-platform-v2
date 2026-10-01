import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const supabase = createClient(
  Deno.env.get('SUPABASE_URL')!,
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
);

const cors = { 'content-type': 'application/json' };
const EXPO_RECEIPT_URL = 'https://exp.host/--/api/v2/push/getReceipts';
const RECEIPT_WAIT_MINUTES = 15;
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

  const result = await supabase
    .from('inventory_notification_outbox')
    .select(
      'id,expo_ticket_id,expo_receipt_checked_at,expo_receipt_status',
    )
    .eq('status', 'sent')
    .not('expo_ticket_id', 'is', null)
    .eq('expo_receipt_status', 'pending')
    .lte('sent_at', receiptCutoff)
    .or(
      'expo_receipt_checked_at.is.null,expo_receipt_checked_at.lte.' +
        receiptCutoff,
    )
    .order('sent_at')
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

  for (const item of items) {
    const ticketId = item.expo_ticket_id as string;
    const receipt = receipts[ticketId];

    if (!receipt) {
      await updateReceipt(item.id, {
        expo_receipt_status: 'pending',
        expo_receipt_checked_at: checkedAt,
        expo_receipt_error: null,
      });
      pending += 1;
      continue;
    }

    if (receipt.status === 'ok') {
      await updateReceipt(item.id, {
        expo_receipt_status: 'ok',
        expo_receipt_checked_at: checkedAt,
        expo_receipt_error: null,
      });
      delivered += 1;
      continue;
    }

    const errorDetails = receipt.details ?? {};
    const errorMessage = [
      receipt.message ?? 'Expo receipt reported an error',
      Object.keys(errorDetails).length
        ? JSON.stringify(errorDetails)
        : null,
    ]
      .filter(Boolean)
      .join(' ');

    await updateReceipt(item.id, {
      expo_receipt_status: 'error',
      expo_receipt_checked_at: checkedAt,
      expo_receipt_error: errorMessage,
    });
    failed += 1;
  }

  return new Response(
    JSON.stringify({
      processed: items.length,
      delivered,
      failed,
      pending,
    }),
    { headers: cors },
  );
});

async function updateReceipt(
  id: string,
  update: {
    expo_receipt_status: 'pending' | 'ok' | 'error';
    expo_receipt_checked_at: string;
    expo_receipt_error: string | null;
  },
) {
  const result = await supabase
    .from('inventory_notification_outbox')
    .update({
      ...update,
      updated_at: new Date().toISOString(),
    })
    .eq('id', id);

  if (result.error) throw result.error;
}
