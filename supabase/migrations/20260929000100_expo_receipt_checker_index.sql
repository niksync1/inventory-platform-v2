begin;

create index if not exists idx_inventory_notification_outbox_expo_receipts
  on public.inventory_notification_outbox (expo_receipt_status, sent_at)
  where status = 'sent'
    and expo_ticket_id is not null;

comment on index public.idx_inventory_notification_outbox_expo_receipts
  is 'Supports periodic lookup of sent push notifications awaiting Expo delivery receipts.';

commit;
