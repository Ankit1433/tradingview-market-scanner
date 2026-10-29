create table if not exists public.worker_leases (
 lease_key text primary key, owner_id uuid not null, expires_at timestamptz not null
);
alter table public.worker_leases enable row level security;
revoke all on public.worker_leases from anon, authenticated;
grant all on public.worker_leases to service_role;
create or replace function public.acquire_worker_lease(p_key text,p_owner uuid)
returns boolean language plpgsql security definer set search_path=public as $$
declare obtained integer;
begin
 insert into worker_leases values(p_key,p_owner,now()+interval '120 seconds')
 on conflict(lease_key) do update set owner_id=excluded.owner_id, expires_at=excluded.expires_at
 where worker_leases.owner_id=p_owner or worker_leases.expires_at<now();
 get diagnostics obtained = row_count;
 return obtained > 0;
end $$;
revoke all on function public.acquire_worker_lease(text,uuid) from public,anon,authenticated;
grant execute on function public.acquire_worker_lease(text,uuid) to service_role;
