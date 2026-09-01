-- Give both dashboard strategy surfaces one ownership-checked, idempotent
-- mutation that returns the state committed by Postgres. Retrying the same
-- desired boolean is safe if a mobile browser loses only the HTTP response.
create or replace function public.set_strategy_enabled(
  p_strategy_id uuid,
  p_enabled boolean
)
returns table(strategy_id uuid, enabled boolean)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if auth.uid() is null then
    raise exception 'authentication_required' using errcode = '42501';
  end if;

  return query
  update public.strategies as strategy
     set enabled = p_enabled
   where strategy.id = p_strategy_id
     and exists (
       select 1
       from public.mt5_terminals as terminal
       where terminal.id = strategy.terminal_id
         and terminal.user_id = auth.uid()
     )
  returning strategy.id, strategy.enabled;

  if not found then
    raise exception 'strategy_not_found_or_not_owned' using errcode = 'P0002';
  end if;
end;
$$;

revoke all on function public.set_strategy_enabled(uuid, boolean) from public, anon;
grant execute on function public.set_strategy_enabled(uuid, boolean) to authenticated;

comment on function public.set_strategy_enabled(uuid, boolean) is
  'Idempotently enables or disables one strategy owned by the authenticated user and returns the committed state.';
