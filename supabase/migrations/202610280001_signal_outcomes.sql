-- Additive Phase 1 migration. Apply after the persistent scanner migration.
create table if not exists public.signal_outcomes (
 event_key text not null,
 calculation_version integer not null,
 payload jsonb not null,
 updated_at timestamptz not null,
 primary key(event_key, calculation_version)
);
alter table public.signal_outcomes enable row level security;
revoke all on public.signal_outcomes from anon, authenticated;
grant all on public.signal_outcomes to service_role;
