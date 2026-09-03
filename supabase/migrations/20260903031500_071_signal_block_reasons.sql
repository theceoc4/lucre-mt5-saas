-- Preserve why a generated signal was blocked so strategy performance can
-- expose an auditable newest-first history instead of only an aggregate count.

alter table public.signals
  add column if not exists block_reason text;

comment on column public.signals.block_reason is
  'Human-readable policy or risk reason when policy_decision is block. Null for allowed or downweighted signals.';

create or replace function public.set_signal_block_reason()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if new.policy_decision = 'block' and nullif(btrim(new.block_reason), '') is null then
    new.block_reason := case
      when new.near_news_event then 'Directional news policy'
      else 'Adaptive policy or risk guardrail'
    end;
  elsif new.policy_decision <> 'block' then
    new.block_reason := null;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_signals_set_block_reason on public.signals;
create trigger trg_signals_set_block_reason
  before insert or update of policy_decision, block_reason, near_news_event
  on public.signals
  for each row execute function public.set_signal_block_reason();

update public.signals
set block_reason = case
  when near_news_event then 'Directional news policy'
  else 'Adaptive policy or risk guardrail'
end
where policy_decision = 'block' and block_reason is null;

create index if not exists idx_signals_strategy_blocked_generated
  on public.signals(strategy_id, generated_at desc)
  where policy_decision = 'block';
