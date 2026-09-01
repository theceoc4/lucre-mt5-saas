-- v1.0.31 -- Progressive indicator strategies and direct execution-mode choice.
-- Existing v1 rule definitions remain valid. New builder definitions use a
-- bounded v2 indicator stack: at most four allowlisted indicators, joined by
-- explicit AND/OR operators. No user-provided code is stored or executed.

create or replace function public.valid_strategy_definition(p_definition jsonb)
returns boolean
language plpgsql
immutable
set search_path to 'public', 'pg_temp'
as $$
declare
  definition_version integer;
  side_name text;
  condition jsonb;
  indicator_row jsonb;
  indicator_index integer := 0;
  indicator_name text;
  previous_indicator_name text;
  has_directional_indicator boolean := false;
  parameter record;
  allowed_metrics constant text[] := array[
    'rsi14','adx14','ema_spread_atr','close_ema20_atr','breakout20_atr',
    'atr_ratio','volume_ratio','spread_ratio','trend_score','linearity'
  ];
  allowed_operators constant text[] := array['gt','gte','lt','lte','eq'];
  allowed_timeframes constant text[] := array['M1','M5','M15','M30','H1','H4','D1','W1'];
  allowed_indicators constant text[] := array[
    'ema_crossover','rsi','adx','price_vs_ema','breakout','atr_volatility',
    'volume_confirmation','trend_strength','linearity'
  ];
  allowed_parameter_keys constant text[] := array[
    'fast_period','slow_period','trigger','period','buy_above','sell_below',
    'minimum','ema_period','minimum_atr','lookback','baseline','minimum_ratio'
  ];
begin
  if p_definition is null or jsonb_typeof(p_definition) <> 'object' then return false; end if;
  definition_version := coalesce((p_definition->>'version')::integer, 0);

  if definition_version = 1 then
    if jsonb_array_length(coalesce(p_definition->'long', '[]'::jsonb)) > 12
       or jsonb_array_length(coalesce(p_definition->'short', '[]'::jsonb)) > 12 then return false; end if;
    foreach side_name in array array['long','short'] loop
      if jsonb_typeof(coalesce(p_definition->side_name, '[]'::jsonb)) <> 'array' then return false; end if;
      for condition in select value from jsonb_array_elements(coalesce(p_definition->side_name, '[]'::jsonb)) loop
        if not (condition->>'metric' = any(allowed_metrics)) then return false; end if;
        if not (condition->>'operator' = any(allowed_operators)) then return false; end if;
        if not (condition->>'timeframe' = any(allowed_timeframes)) then return false; end if;
        if jsonb_typeof(condition->'value') is distinct from 'number' then return false; end if;
      end loop;
    end loop;
    return jsonb_array_length(coalesce(p_definition->'long', '[]'::jsonb)) > 0
        or jsonb_array_length(coalesce(p_definition->'short', '[]'::jsonb)) > 0;
  end if;

  if definition_version <> 2 or jsonb_typeof(p_definition->'indicators') <> 'array' then return false; end if;
  if jsonb_array_length(p_definition->'indicators') not between 1 and 4 then return false; end if;

  for indicator_row in select value from jsonb_array_elements(p_definition->'indicators') loop
    indicator_name := indicator_row->>'indicator';
    if not (indicator_name = any(allowed_indicators)) then return false; end if;
    if indicator_name in ('ema_crossover','rsi','price_vs_ema','breakout','trend_strength','linearity') then
      has_directional_indicator := true;
    end if;
    if jsonb_typeof(coalesce(indicator_row->'params', '{}'::jsonb)) <> 'object' then return false; end if;
    if indicator_index > 0 and coalesce(indicator_row->>'join', '') not in ('and','or') then return false; end if;
    if indicator_index = 0 and coalesce(indicator_row->>'join', 'and') <> 'and' then return false; end if;
    if indicator_index > 0 and indicator_row->>'join' = 'or'
       and (indicator_name in ('adx','atr_volatility','volume_confirmation')
         or previous_indicator_name in ('adx','atr_volatility','volume_confirmation')) then return false; end if;

    for parameter in select key, value from jsonb_each(coalesce(indicator_row->'params', '{}'::jsonb)) loop
      if not (parameter.key = any(allowed_parameter_keys)) then return false; end if;
      if parameter.key = 'trigger' then
        if jsonb_typeof(parameter.value) <> 'string'
           or trim(both '"' from parameter.value::text) not in ('alignment','fresh_cross') then return false; end if;
      elsif jsonb_typeof(parameter.value) <> 'number'
         or abs((parameter.value #>> '{}')::numeric) > 10000 then return false;
      end if;
    end loop;
    if indicator_name = 'ema_crossover'
       and coalesce((indicator_row->'params'->>'fast_period')::numeric, 20)
         >= coalesce((indicator_row->'params'->>'slow_period')::numeric, 50) then return false; end if;
    if indicator_name in ('rsi','trend_strength')
       and coalesce((indicator_row->'params'->>'buy_above')::numeric, case when indicator_name='rsi' then 55 else 35 end)
         <= coalesce((indicator_row->'params'->>'sell_below')::numeric, case when indicator_name='rsi' then 45 else -35 end) then return false; end if;
    previous_indicator_name := indicator_name;
    indicator_index := indicator_index + 1;
  end loop;
  return has_directional_indicator;
exception when others then
  return false;
end;
$$;

-- Users may now deliberately start in Manual or Auto mode. Portfolio limits,
-- per-strategy limits, policy checks, and the EA capability gate still apply
-- before any automatic order is queued.
drop trigger if exists trg_strategy_live_promotion on public.strategies;

comment on column public.strategies.run_mode is
  'shadow records hypothetical outcomes; live generates signals. The dashboard maps Manual and Auto to live plus the appropriate delivery_mode.';
comment on column public.strategies.rule_definition is
  'Versioned declarative logic. v1 stores metric comparisons; v2 stores up to four allowlisted indicator clauses joined by AND/OR. Executable user code is never accepted.';
