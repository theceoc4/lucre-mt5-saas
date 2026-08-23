// v1.0.12 — canonical <-> broker symbol matching + lookup.

import { CANONICAL_SYMBOLS, type AssetClass } from "./canonical-symbols.ts";

export type MatchType = "exact" | "auto_prefix" | "manual" | "unavailable";

export interface SymbolMatchResult {
  canonical_symbol: string;
  asset_class: AssetClass;
  broker_symbol: string | null;
  match_type: MatchType;
  candidates: string[];
  needs_review: boolean;
}

const MAX_SUFFIX_LEN = 6;

export function matchBrokerSymbols(brokerSymbols: string[]): SymbolMatchResult[] {
  const results: SymbolMatchResult[] = [];

  for (const { symbol: canonical, asset_class } of CANONICAL_SYMBOLS) {
    const canonicalLower = canonical.toLowerCase();

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
