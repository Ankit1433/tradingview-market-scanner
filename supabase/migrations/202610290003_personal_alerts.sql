-- Phase 3: durable signal alerts and account Telegram controls.
alter table public.app_users add column if not exists alerts_paused boolean not null default false;
alter table public.app_users add column if not exists alerts_muted_until timestamptz;
alter table public.app_users add column if not exists telegram_next_at timestamptz;
create table if not exists public.alert_queue (
 id uuid primary key default gen_random_uuid(),user_id uuid not null references public.app_users(id),
 dedupe_key text not null,kind text not null check(kind in ('signal','admin','control')),
 signal_day date, payload jsonb not null, created_at timestamptz not null default now(),
 expires_at timestamptz not null, available_at timestamptz not null default now(),
 delivered_at timestamptz,skipped_at timestamptz,attempts integer not null default 0,
 unique(user_id,dedupe_key)
);
create index if not exists alert_queue_due_idx on public.alert_queue(available_at,created_at) where delivered_at is null and skipped_at is null;
create index if not exists alert_queue_daily_idx on public.alert_queue(user_id,signal_day,kind);
alter table public.alert_queue enable row level security;
revoke all on public.alert_queue from anon,authenticated;
grant all on public.alert_queue to service_role;
create or replace function public.enqueue_personal_alert(p_user uuid,p_key text,p_kind text,p_day date,p_payload jsonb,p_expires timestamptz,p_limit integer)
returns boolean language plpgsql security definer set search_path=public as $$
declare u public.app_users; inserted integer;
begin
 select * into u from app_users where id=p_user for update;
 if not found or u.telegram_chat_id is null then return false; end if;
 if exists(select 1 from alert_queue where user_id=p_user and dedupe_key=p_key) then return false;end if;
 if p_kind='signal' then
  if u.alerts_paused or u.alerts_muted_until>now() then return false;end if;
  if (select count(*) from alert_queue where user_id=p_user and kind='signal' and signal_day=p_day)>=p_limit then return false;end if;
 end if;
 insert into alert_queue(user_id,dedupe_key,kind,signal_day,payload,expires_at) values(p_user,p_key,p_kind,p_day,p_payload,p_expires) on conflict do nothing;
 get diagnostics inserted=row_count;return inserted>0;
end $$;
revoke all on function public.enqueue_personal_alert(uuid,text,text,date,jsonb,timestamptz,integer) from public,anon,authenticated;
grant execute on function public.enqueue_personal_alert(uuid,text,text,date,jsonb,timestamptz,integer) to service_role;
