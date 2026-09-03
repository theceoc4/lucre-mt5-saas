-- One user-issued command closes every position on the connected MT5 terminal.
-- Keep this distinct from flatten_basket so audit logs can separate an explicit
-- dashboard action from an automated basket-risk shutdown.

alter table public.ea_commands
  drop constraint ea_commands_command_type_check;

alter table public.ea_commands
  add constraint ea_commands_command_type_check
    check (command_type in (
      'open', 'modify', 'close', 'close_all', 'hedge_open', 'flatten_basket', 'modify_sl_tp'
    ));

create unique index ea_commands_one_active_close_all_per_terminal
  on public.ea_commands (terminal_id)
  where command_type = 'close_all' and status in ('queued', 'sent', 'acknowledged');

comment on column public.ea_commands.command_type is
  'close_all is one explicit dashboard command to close every open MT5 position. flatten_basket is reserved for automated basket-risk management; the remaining values retain their existing meanings.';
