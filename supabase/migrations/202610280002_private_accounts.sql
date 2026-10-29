-- Accounts and personal paper data require Supabase. No anonymous/browser access.
create table public.app_users (
 id uuid primary key default gen_random_uuid(), email text unique not null,
 password_hash text not null, role text not null check(role in ('admin','friend')),
 settings jsonb not null default '{"capital":200000,"riskPct":1}',
 telegram_chat_id text unique, created_at timestamptz not null default now()
);
create table public.app_invites (
 code_hash text primary key, created_by uuid references public.app_users(id),
 expires_at timestamptz not null, used_at timestamptz
);
create table public.app_sessions (
 token_hash text primary key, user_id uuid not null references public.app_users(id) on delete cascade,
 expires_at timestamptz not null
);
create index on public.app_sessions(user_id);
create table public.app_telegram_links (
 token_hash text primary key, user_id uuid not null references public.app_users(id) on delete cascade,
 expires_at timestamptz not null
);
create table public.personal_trades (
 id uuid primary key default gen_random_uuid(), user_id uuid not null references public.app_users(id),
 event_key text not null, symbol text not null, mode text not null check(mode in ('intraday','swing')),
 entry numeric not null check(entry>0), stop numeric not null check(stop>0 and stop<entry),
 target numeric not null check(target>entry), quantity integer not null check(quantity>0),
 trail_pct numeric not null check(trail_pct>0 and trail_pct<=50), time_stop_sessions integer not null check(time_stop_sessions between 1 and 100),
 highest numeric not null, opened_at timestamptz not null default now(), closed_at timestamptz, exit numeric,
 unique(user_id,event_key)
);
create table public.personal_reminders (
 id uuid primary key default gen_random_uuid(), user_id uuid not null references public.app_users(id),
 trade_id uuid not null references public.personal_trades(id), kind text not null,
 message text not null, delivered_at timestamptz, unique(trade_id,kind)
);
-- Locking makes single-use invites and bootstrap safe under concurrent requests.
create function public.app_register(p_email text,p_password_hash text,p_code_hash text)
returns uuid language plpgsql security definer set search_path=public as $$
declare v_id uuid; v_inv public.app_invites;
begin
 select * into v_inv from app_invites where code_hash=p_code_hash for update;
 if not found or v_inv.used_at is not null or v_inv.expires_at<=now() then raise exception 'invalid invite'; end if;
 insert into app_users(email,password_hash,role) values(p_email,p_password_hash,'friend') returning id into v_id;
 update app_invites set used_at=now() where code_hash=p_code_hash;
 return v_id;
end $$;
create function public.app_bootstrap(p_email text,p_password_hash text)
returns uuid language plpgsql security definer set search_path=public as $$
declare v_id uuid;
begin
 perform pg_advisory_xact_lock(73281042);
 if exists(select 1 from app_users) then raise exception 'already initialized'; end if;
 insert into app_users(email,password_hash,role) values(p_email,p_password_hash,'admin') returning id into v_id;
 return v_id;
end $$;
create function public.app_link_telegram(p_token_hash text,p_chat_id text)
returns boolean language plpgsql security definer set search_path=public as $$
declare v_link public.app_telegram_links;
begin
 select * into v_link from app_telegram_links where token_hash=p_token_hash for update;
 if not found or v_link.expires_at<=now() then return false; end if;
 update app_users set telegram_chat_id=p_chat_id where id=v_link.user_id;
 delete from app_telegram_links where user_id=v_link.user_id;
 return true;
end $$;
do $$ declare t text; begin
 foreach t in array array['app_users','app_invites','app_sessions','app_telegram_links','personal_trades','personal_reminders'] loop
 execute format('alter table public.%I enable row level security',t);
 execute format('revoke all on public.%I from anon, authenticated',t);
 execute format('grant all on public.%I to service_role',t);
 end loop;
end $$;
revoke all on function public.app_register(text,text,text), public.app_bootstrap(text,text), public.app_link_telegram(text,text) from public,anon,authenticated;
grant execute on function public.app_register(text,text,text), public.app_bootstrap(text,text), public.app_link_telegram(text,text) to service_role;
-- Serialize sizing checks per owner, including concurrent browser requests.
create function public.app_take_trade(p_trade jsonb)
returns setof public.personal_trades language plpgsql security definer set search_path=public as $$
declare u public.app_users; deployed numeric; t public.personal_trades;
begin
 select * into u from app_users where id=(p_trade->>'user_id')::uuid for update;
 if not found then raise exception 'unknown user'; end if;
 select coalesce(sum(entry*quantity),0) into deployed from personal_trades where user_id=u.id and closed_at is null;
 t=jsonb_populate_record(null::public.personal_trades,p_trade);
 if deployed+t.entry*t.quantity>(u.settings->>'capital')::numeric or (t.entry-t.stop)*t.quantity>(u.settings->>'capital')::numeric*(u.settings->>'riskPct')::numeric/100 then raise exception 'risk limit'; end if;
 return query insert into personal_trades(user_id,event_key,symbol,mode,entry,stop,target,quantity,trail_pct,time_stop_sessions,highest)
 values(t.user_id,t.event_key,t.symbol,t.mode,t.entry,t.stop,t.target,t.quantity,t.trail_pct,t.time_stop_sessions,t.highest) returning *;
end $$;
revoke all on function public.app_take_trade(jsonb) from public,anon,authenticated;
grant execute on function public.app_take_trade(jsonb) to service_role;
