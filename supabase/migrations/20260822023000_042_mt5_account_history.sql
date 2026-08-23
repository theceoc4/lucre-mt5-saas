-- v1.0.21 — lossless MT5 account-history import.
-- trade_history remains Lucre's normalized closed-position analytics table;
-- this table preserves every MT5 deal (including partial fills and balance
-- events) for the Account History view.

create table public.mt5_account_history (
  terminal_id uuid not null references public.mt5_terminals(id) on delete cascade,
  deal_ticket bigint not null,
  position_id bigint,
  symbol text,
  side text check (side in ('buy', 'sell')),
  entry_type int not null,
  deal_type int not null,
  volume numeric not null default 0,
  price numeric not null default 0,
  profit numeric not null default 0,
  commission numeric not null default 0,
  swap numeric not null default 0,
  fee numeric not null default 0,
  occurred_at timestamptz not null,
  magic bigint,
  comment text,
  imported_at timestamptz not null default now(),
  primary key (terminal_id, deal_ticket)
);

create index idx_mt5_account_history_terminal_time
  on public.mt5_account_history(terminal_id, occurred_at desc);

alter table public.mt5_account_history enable row level security;

create policy "account_history_select_own_terminal"
  on public.mt5_account_history for select to authenticated
  using (exists (
    select 1 from public.mt5_terminals terminal
    where terminal.id = mt5_account_history.terminal_id
      and terminal.user_id = auth.uid()
  ));

revoke insert, update, delete on public.mt5_account_history from anon, authenticated;

alter publication supabase_realtime add table public.mt5_account_history;

comment on table public.mt5_account_history is
  'Lossless MT5 deal ledger sent by LucreHubEA in bounded batches. Unlike trade_history, it retains every deal ticket and supports the Account History modal.';
