-- Signal persistence and outgoing delivery intent commit together.
create table if not exists public.signal_outbox (
 destination text not null,event_key text not null references public.signal_events(event_key),
 payload jsonb not null,created_at timestamptz not null default now(),
 primary key(destination,event_key)
);
alter table public.signal_outbox enable row level security;
revoke all on public.signal_outbox from anon,authenticated;
grant all on public.signal_outbox to service_role;
create or replace function public.persist_signal_delivery(p_row jsonb,p_payload jsonb,p_destination text)
returns void language plpgsql security definer set search_path=public as $$
begin
 insert into signal_events(id,event_key,occurred_at,mode,symbol,signal_types,signal_count,price,confluence,levels,context)
 values((p_row->>'id')::uuid,p_row->>'event_key',(p_row->>'occurred_at')::timestamptz,p_row->>'mode',p_row->>'symbol',array(select jsonb_array_elements_text(p_row->'signal_types')),(p_row->>'signal_count')::smallint,(p_row->>'price')::numeric,(p_row->>'confluence')::boolean,p_row->'levels',p_row->'context') on conflict(event_key) do nothing;
 insert into signal_outbox(destination,event_key,payload) values(p_destination,p_row->>'event_key',p_payload) on conflict do nothing;
end $$;
revoke all on function public.persist_signal_delivery(jsonb,jsonb,text) from public,anon,authenticated;
grant execute on function public.persist_signal_delivery(jsonb,jsonb,text) to service_role;
