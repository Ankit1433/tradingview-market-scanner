-- AnkQuant persistent scanner history.
-- Run this once in Supabase SQL Editor before setting the app's DB variables.

create table if not exists public.signal_events (
  id uuid primary key,
  event_key text not null unique,
  occurred_at timestamptz not null,
  mode text not null check (mode in ('intraday', 'swing')),
  symbol text not null,
  signal_types text[] not null default '{}',
  signal_count smallint not null default 0,
  price numeric,
  confluence boolean not null default false,
  levels jsonb,
  context jsonb,
  created_at timestamptz not null default now()
);

create index if not exists signal_events_occurred_at_idx
  on public.signal_events (occurred_at desc);
create index if not exists signal_events_mode_symbol_idx
  on public.signal_events (mode, symbol, occurred_at desc);
create index if not exists signal_events_types_idx
  on public.signal_events using gin (signal_types);

create table if not exists public.scanner_state (
  state_key text primary key,
  payload jsonb not null,
  updated_at timestamptz not null default now()
);

create table if not exists public.paper_trades (
  trade_key text primary key,
  mode text not null check (mode in ('intraday', 'swing')),
  symbol text not null,
  status text not null check (status in ('open', 'closed', 'stale')),
  opened_on date,
  closed_at timestamptz,
  entry_price numeric,
  initial_stop numeric,
  current_stop numeric,
  target_price numeric,
  quantity integer,
  remaining_quantity integer,
  exit_price numeric,
  realized_pnl numeric not null default 0,
  exit_reason text,
  setup_types text[] not null default '{}',
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists paper_trades_mode_status_idx
  on public.paper_trades (mode, status, opened_on desc);
create index if not exists paper_trades_symbol_idx
  on public.paper_trades (symbol, opened_on desc);

-- The app accesses these tables only from its server using a Supabase
-- secret/service-role key. No browser role receives direct table access.
alter table public.signal_events enable row level security;
alter table public.scanner_state enable row level security;
alter table public.paper_trades enable row level security;

revoke all on public.signal_events from anon, authenticated;
revoke all on public.scanner_state from anon, authenticated;
revoke all on public.paper_trades from anon, authenticated;
grant all on public.signal_events to service_role;
grant all on public.scanner_state to service_role;
grant all on public.paper_trades to service_role;
