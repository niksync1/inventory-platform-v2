begin;

create table if not exists public.inventory_notification_push_deliveries (
  id uuid primary key default gen_random_uuid(),
  outbox_id uuid not null references public.inventory_notification_outbox(id) on delete cascade,
  token_id uuid not null references public.expo_push_tokens(id) on delete cascade,
  expo_ticket_id text,
  ticket_status text not null,
  receipt_status text not null default 'pending',
  receipt_checked_at timestamptz,
  receipt_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint inventory_notification_push_deliveries_ticket_status_check check (ticket_status in ('ok', 'error')),
  constraint inventory_notification_push_deliveries_receipt_status_check check (receipt_status in ('pending', 'ok', 'error', 'expired'))
);

create unique index if not exists idx_inventory_notification_push_deliveries_ticket on public.inventory_notification_push_deliveries (expo_ticket_id) where expo_ticket_id is not null;
create index if not exists idx_inventory_notification_push_deliveries_receipts on public.inventory_notification_push_deliveries (receipt_status, created_at) where ticket_status = 'ok' and expo_ticket_id is not null;
create index if not exists idx_inventory_notification_push_deliveries_outbox on public.inventory_notification_push_deliveries (outbox_id);

alter table public.inventory_notification_push_deliveries enable row level security;
revoke all on public.inventory_notification_push_deliveries from anon, authenticated;
grant all on public.inventory_notification_push_deliveries to service_role;

commit;
