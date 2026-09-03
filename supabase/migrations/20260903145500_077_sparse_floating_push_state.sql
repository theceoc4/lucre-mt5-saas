-- Keep the floating-P/L latch sparse: store only which side of the threshold
-- the cluster is on, and avoid an UPDATE when no state changed. This prevents
-- every EA mark-to-market snapshot from becoming an extra database write.
create or replace function public.evaluate_floating_pl_push(
  p_terminal_id uuid,
  p_open_position_count integer,
  p_total_pl numeric,
  p_threshold numeric default 1.00
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  s public.push_position_cluster_state%rowtype;
  owner_id uuid; terminal_label text; queued uuid;
  threshold_state numeric := case when p_total_pl >= p_threshold then p_threshold else 0 end;
begin
  select * into s from public.push_position_cluster_state where terminal_id = p_terminal_id for update;
  if not found then
    insert into public.push_position_cluster_state(terminal_id) values (p_terminal_id)
    returning * into s;
  end if;

  if p_open_position_count <= 0 then
    if s.open_position_count <> 0 or s.cluster_id is not null or s.target_notified or s.last_total_pl <> 0 then
      update public.push_position_cluster_state set cluster_id = null, open_position_count = 0,
        last_total_pl = 0, target_notified = false, cluster_started_at = null, updated_at = now()
      where terminal_id = p_terminal_id;
    end if;
    return false;
  end if;

  if s.open_position_count <= 0 or s.cluster_id is null then
    s.cluster_id := gen_random_uuid();
    s.target_notified := false;
    s.last_total_pl := 0;
    s.cluster_started_at := now();
  end if;

  if not s.target_notified and threshold_state = p_threshold and s.last_total_pl < p_threshold then
    select user_id, label into owner_id, terminal_label from public.mt5_terminals where id = p_terminal_id;
    queued := public.enqueue_push_notification(
      owner_id, p_terminal_id, 'floating_pl_target',
      'floating-pl-target:' || p_terminal_id || ':' || s.cluster_id,
      'Floating P/L crossed +$' || trim(to_char(p_threshold, 'FM999999990.00')),
      trim(to_char(p_open_position_count, 'FM999999990')) || ' open position' || case when p_open_position_count = 1 then '' else 's' end || ' · +' || '$' || trim(to_char(p_total_pl, 'FM999999990.00')),
      jsonb_build_object('url','/?view=dashboard&tab=positions','floating_pl',p_total_pl,'position_count',p_open_position_count,'cluster_id',s.cluster_id,'terminal_label',terminal_label)
    );
    s.target_notified := queued is not null;
  end if;

  update public.push_position_cluster_state set cluster_id = s.cluster_id,
    open_position_count = p_open_position_count, last_total_pl = threshold_state,
    target_notified = s.target_notified, cluster_started_at = s.cluster_started_at, updated_at = now()
  where terminal_id = p_terminal_id
    and (cluster_id, open_position_count, last_total_pl, target_notified, cluster_started_at)
      is distinct from
      (s.cluster_id, p_open_position_count, threshold_state, s.target_notified, s.cluster_started_at);
  return queued is not null;
end;
$$;

revoke all on function public.evaluate_floating_pl_push(uuid,integer,numeric,numeric)
  from public, anon, authenticated;
grant execute on function public.evaluate_floating_pl_push(uuid,integer,numeric,numeric)
  to service_role;
