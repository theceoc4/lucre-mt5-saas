// v1.0.12 — canonical <-> broker symbol matching + lookup.
//
// matchBrokerSymbols() is called once per terminal by report-symbols,
// against that broker's full symbol universe. resolveBrokerSymbol() is
// called by manual-order/signal-action on every order placement to turn a
// canonical symbol into the exact string this terminal's broker expects.

import { CANONICAL_SYMBOLS, type AssetClass } from "./canonical-symbols.ts";

export type MatchType = "exact" | "auto_prefix" | "manual" | "unavailable" | "pending_manual";

export interface SymbolMatchResult {
  canonical_symbol: string;
  asset_class: AssetClass;
  broker_symbol: string | null;
  match_type: MatchType;
  candidates: string[];
  needs_review: boolean;
}

// Suffix cap for the auto_prefix heuristic. Real-world broker suffixes are
// short: ".a", ".raw", "m", "_i", ".pro" — all well under 6 chars. Capping
// this avoids accidentally treating an unrelated longer symbol that happens
// to start with the same 6 letters (e.g. EURUSD vs EURUSDTRY-style triangular
// crosses some brokers list) as a confident single match.
const MAX_SUFFIX_LEN = 6;

/**
 * Matches every canonical symbol against one broker's reported symbol list.
 * Comparison is case-insensitive (brokers vary casing), but the returned
 * broker_symbol/candidates preserve the broker's original casing exactly —
 * MT5's SymbolSelect() needs the exact string.
 *
 * `extraCanonical` (v1.0.14) folds in any user-typed pairs from the
 * dashboard's "add a pair" workflow (bind-symbol edge function, stored as
 * `pending_manual` symbol_mappings rows) so they get matched against the
 * broker's real symbol universe on the very next scan exactly like every
 * built-in canonical symbol — no separate code path needed.
 */
export function matchBrokerSymbols(
  brokerSymbols: string[],
  extraCanonical: { symbol: string; asset_class: AssetClass }[] = [],
): SymbolMatchResult[] {
  const results: SymbolMatchResult[] = [];
  const allCanonical = [...CANONICAL_SYMBOLS, ...extraCanonical];

  for (const { symbol: canonical, asset_class } of allCanonical) {
    const canonicalLower = canonical.toLowerCase();

    // 1. Exact match (case-insensitive).
    const exact = brokerSymbols.find((b) => b.toLowerCase() === canonicalLower);
    if (exact) {
      results.push({
        canonical_symbol: canonical,
        asset_class,
        broker_symbol: exact,
        match_type: "exact",
        candidates: [exact],
        needs_review: false,
      });
      continue;
    }

    // 2. Prefix match: broker symbol starts with the canonical name and has
    //    a short suffix left over (e.g. EURUSD.a, EURUSDm, EURUSD_i).
    const prefixMatches = brokerSymbols.filter((b) => {
      const bLower = b.toLowerCase();
      return bLower.startsWith(canonicalLower) && bLower.length - canonicalLower.length <= MAX_SUFFIX_LEN;
    });

    if (prefixMatches.length === 1) {
      results.push({
        canonical_symbol: canonical,
        asset_class,
        broker_symbol: prefixMatches[0],
        match_type: "auto_prefix",
        candidates: prefixMatches,
        needs_review: false,
      });
    } else if (prefixMatches.length > 1) {
      // Multiple plausible candidates — don't guess, flag for a human.
      results.push({
        canonical_symbol: canonical,
        asset_class,
        broker_symbol: null,
        match_type: "manual",
        candidates: prefixMatches,
        needs_review: true,
      });
    } else {
      results.push({
        canonical_symbol: canonical,
        asset_class,
        broker_symbol: null,
        match_type: "unavailable",
        candidates: [],
        needs_review: false,
      });
    }
  }

  return results;
}

export type ResolveSymbolError = "symbol_needs_review" | "symbol_unavailable" | "lookup_failed";

export interface ResolveSymbolResult {
  brokerSymbol: string | null;
  error: ResolveSymbolError | null;
  detail?: string;
}

/**
 * Looks up terminal_id + canonical_symbol in symbol_mappings and returns the
 * broker-native symbol string, or a typed error explaining why none is
 * available yet. Used by manual-order and signal-action before every
 * ea_commands insert so a doomed command (wrong symbol string) never
 * reaches the EA.
 */
export async function resolveBrokerSymbol(
  // deno-lint-ignore no-explicit-any
  admin: any,
  terminalId: string,
  canonicalSymbol: string,
): Promise<ResolveSymbolResult> {
  const { data: mapping, error } = await admin
    .from("symbol_mappings")
    .select("broker_symbol, match_type, needs_review")
    .eq("terminal_id", terminalId)
    .eq("canonical_symbol", canonicalSymbol)
    .maybeSingle();

  if (error) return { brokerSymbol: null, error: "lookup_failed", detail: error.message };

  // No row at all means this terminal has never reported its symbol
  // universe (pre-v1.0.12 EA, or first connection before the initial scan
  // lands) — same treatment as "unavailable" so callers get one clear error
  // path rather than needing to special-case a missing row.
  if (!mapping || mapping.match_type === "unavailable" || !mapping.broker_symbol) {
    return { brokerSymbol: null, error: "symbol_unavailable" };
  }
  if (mapping.needs_review) {
    return { brokerSymbol: null, error: "symbol_needs_review" };
  }

  return { brokerSymbol: mapping.broker_symbol, error: null };
}
