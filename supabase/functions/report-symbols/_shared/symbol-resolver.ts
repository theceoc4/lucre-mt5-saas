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

  // v1.0.16 -- dedupe by canonical symbol (case-insensitive) before
  // matching. bind-symbol now blocks creating a pending_manual row that
  // duplicates a built-in CANONICAL_SYMBOLS entry going forward, but this
  // is a second, defensive layer against any stale duplicate already
  // sitting in symbol_mappings (from before that guard existed, or from
  // any future extraCanonical source) reaching the upsert. Without it, two
  // result rows sharing one canonical_symbol get upserted in the same
  // batch, and Postgres rejects the *entire* upsert with "ON CONFLICT DO
  // UPDATE command cannot affect row a second time" -- breaking symbol
  // sync for every pair on the terminal, not just the duplicate. Built-in
  // entries take priority over extraCanonical ones since they're curated.
  const seen = new Set<string>();
  const allCanonical: { symbol: string; asset_class: AssetClass }[] = [];
  for (const entry of [...CANONICAL_SYMBOLS, ...extraCanonical]) {
    const key = entry.symbol.toUpperCase();
    if (seen.has(key)) continue;
    seen.add(key);
    allCanonical.push(entry);
  }

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

  if (!mapping || mapping.match_type === "unavailable" || !mapping.broker_symbol) {
    return { brokerSymbol: null, error: "symbol_unavailable" };
  }
  if (mapping.needs_review) {
    return { brokerSymbol: null, error: "symbol_needs_review" };
  }

  return { brokerSymbol: mapping.broker_symbol, error: null };
}
