-- Transactional smoke test for the local-day override. Any temporary change is
-- rolled back. If no terminal exists yet, the test exits without mutation.
begin;
do $$
declare
  v_terminal uuid;
  v_owner uuid;
  v_settings public.portfolio_risk_settings%rowtype;
  v_context record;
begin
  select id, user_id into v_terminal, v_owner
  from public.mt5_terminals
  order by created_at
  limit 1;
  if v_terminal is null then return; end if;

  perform set_config('request.jwt.claims', json_build_object('role','authenticated','sub',v_owner)::text, true);
  select * into v_settings from public.set_daily_risk_override(v_terminal, true);
  select * into v_context from public.terminal_local_day_context(v_terminal, now());

  if v_settings.daily_override_until is distinct from v_context.ends_at then
    raise exception 'override expiry does not match next local midnight';
  end if;
  if v_context.override_active is not true then
    raise exception 'override did not become active';
  end if;
end
$$;
rollback;
select 'local day override checks passed' as result;
