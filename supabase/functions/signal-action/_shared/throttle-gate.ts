// v1.0.0 — throttle-gate lookup, shared by signal-action.
//
// Reads the Adaptive Throttle Engine's live output (public.agent_policies)
// for one (terminal, strategy, symbol, session, htf_regime, near_news_event)
// cell. This is a pure read — the actual scoring happens server-side on a
// 15-minute cron (throttle_sweep -> apply_throttle_ladder, migration 025),
// and signals-table gating on insert happens via the DB trigger added in
// migration 032 (trg_signals_apply_throttle_gate). This helper exists so
// signal-action can re-check the *current* policy at tap time, catching any
// cell that flipped to block/downweight after the signal was generated.

export interface ThrottlePolicy {
  decision: "ok" | "downweight" | "block";
  downweight_factor: number | null;
  reason: string | null;
  cooldown_until: string | null;
}

export async function lookupThrottlePolicy(
  // deno-lint-ignore no-explicit-any
  admin: any,
  params: {
    terminal_id: string;
    strategy_id: string | null;
    symbol: string;
    session: string | null;
    htf_regime: string | null;
    near_news_event: boolean;
  },
): Promise<ThrottlePolicy | null> {
  // agent_policies rows only ever exist for fully strategy-attributed,
  // regime-tagged cells (strategy_id/session/htf_regime are all NOT NULL on
  // that table) — a signal missing any of these can never have a matching
  // policy, so skip the round-trip entirely rather than issuing a query that
  // would just come back empty.
  if (!params.strategy_id || !params.session || !params.htf_regime) {
    return null;
  }

  const { data, error } = await admin
    .from("agent_policies")
    .select("decision, downweight_factor, reason, cooldown_until")
    .eq("terminal_id", params.terminal_id)
    .eq("strategy_id", params.strategy_id)
    .eq("symbol", params.symbol)
    .eq("session", params.session)
    .eq("htf_regime", params.htf_regime)
    .eq("near_news_event", params.near_news_event)
    .maybeSingle();

  if (error || !data) return null;
  return data as ThrottlePolicy;
}
