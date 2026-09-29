begin;

alter table public.inventory_notification_outbox
  add column if not exists expo_ticket_id text,
  add column if not exists expo_receipt_status text,
  add column if not exists expo_receipt_checked_at timestamptz,
  add column if not exists expo_receipt_error text;

comment on column public.inventory_notification_outbox.expo_ticket_id
  is 'Expo push ticket ID returned when Expo accepts a notification.';
comment on column public.inventory_notification_outbox.expo_receipt_status
  is 'Expo delivery receipt status: ok, error, or pending.';
comment on column public.inventory_notification_outbox.expo_receipt_checked_at
  is 'When the Expo delivery receipt was last checked.';
comment on column public.inventory_notification_outbox.expo_receipt_error
  is 'Error details returned by the Expo delivery receipt.';

commit;