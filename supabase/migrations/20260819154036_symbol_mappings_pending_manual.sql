alter table public.symbol_mappings drop constraint symbol_mappings_match_type_check;
alter table public.symbol_mappings add constraint symbol_mappings_match_type_check
  check (match_type in ('exact', 'auto_prefix', 'manual', 'unavailable', 'pending_manual'));;
