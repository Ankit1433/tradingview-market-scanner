-- Phase 5 UI persistence only; delivery enforcement remains Phase 3.
alter table public.app_users add column if not exists alert_preferences jsonb not null default '{}';
