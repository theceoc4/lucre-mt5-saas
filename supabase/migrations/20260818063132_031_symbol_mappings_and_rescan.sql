create table public.symbol_mappings (
  id uuid primary key default gen_random_uuid(),
  terminal_id uuid not null references public.mt5_terminals(id) on delete cascade,
  canonical_symbol text not null,
  asset_class text not null check (asset_class in ('fx', 'metal', 'index', 'crypto')),
  broker_symbol text,
  match_type text not null default 'unavailable'
    check (match_type in ('exact', 'auto_prefix', 'manual', 'unavailable')),
  candidates text[] not null default '{}',
  needs_review boolean not null default false,
  last_synced_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (terminal_id, canonical_symbol)
);

create index idx_symbol_mappings_terminal on public.symbol_mappings(terminal_id);
create index idx_symbol_mappings_needs_review on public.symbol_mappings(terminal_id)
  where needs_review;

create trigger set_updated_at before update on public.symbol_mappings
  for each row execute function public.set_updated_at();

comment on table public.symbol_mappings is
  'One row per (terminal, canonical_symbol) mapping the dashboard/signal-generation canonical name to this specific broker''s actual symbol string. Populated by report-symbols; consumed by manual-order and signal-action before every ea_commands insert.';
comment on column public.symbol_mappings.match_type is
  'exact: broker offers the canonical name verbatim. auto_prefix: exactly one broker symbol starts with the canonical name plus a short suffix (e.g. EURUSD.a) -- auto-mapped, no human step. manual: multiple plausible candidates existed and a human picked one (or hasn''t yet -- see needs_review). unavailable: broker offers nothing matching this canonical symbol.';
comment on column public.symbol_mappings.candidates is
  'Every broker symbol string seen at last scan that could plausibly be this canonical instrument, for the dashboard''s manual-resolution picker. Not necessarily still accurate after the next scan.';

alter table public.symbol_mappings enable row level security;

create policy "select own terminal symbol mappings"
  on public.symbol_mappings for select
  using (terminal_id in (select id from public.mt5_terminals where user_id = auth.uid()));

create policy "update own terminal symbol mappings"
  on public.symbol_mappings for update
  using (terminal_id in (select id from public.mt5_terminals where user_id = auth.uid()));

alter table public.mt5_terminals
  add column force_symbol_rescan boolean not null default false,
  add column last_symbol_scan_at timestamptz;

comment on column public.mt5_terminals.force_symbol_rescan is
  'Set true by request-symbol-rescan (dashboard "Rescan Symbols" button). ea-sync echoes it back to the EA on the next poll; report-symbols clears it back to false once that terminal''s scan lands.';
comment on column public.mt5_terminals.last_symbol_scan_at is
  'When report-symbols last successfully processed a full symbol list from this terminal. NULL if the EA has never reported one -- e.g. an EA build from before v1.0.12.';;
