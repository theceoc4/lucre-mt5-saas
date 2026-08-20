// v1.0.14 — report-bars
//
// The MT5 EA posts the latest three CLOSED M5 bars for every currently bound
// broker symbol. This function reverse-resolves each broker-native spelling to
// the terminal's canonical symbol before upserting price_bars, so strategy
// definitions and indicator calculations stay broker-independent.
//
// This function is EA-key authenticated (x-api-key -> api_key_hash) and must
// be deployed with verify_jwt:false, like ea-sync/report-symbols. That deploy
// setting lives outside this source file.
//
// Request:  { symbols: [{ broker_symbol, bars: [{ time, open, high, low, close, volume }] }] }
// Response: { upserted, warnings }

import { createClient } from "jsr:@supabase/supabase-js@2";
import { authenticateTerminal } from "../_shared/auth.ts";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "x-api-key, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const MAX_SYMBOLS_PER_REQUEST = 50;
// v1.0.17 -- raised from 20 to 300 so the EA's one-time new-symbol history
// backfill (PriceReporter.mqh PR_BACKFILL_BARS) can land in a single request.
// strategy-signal-engine reads up to 300 M5 bars per symbol, so this is the
// real ceiling of useful bars per request anyway.
const MAX_BARS_PER_SYMBOL = 300;

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
  });
}

interface IncomingBar {
  time: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

interface IncomingSymbolBars {
  broker_symbol: string;
  bars: IncomingBar[];
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS_HEADERS });
  if (req.method !== "POST") return jsonResponse({ error: "method_not_allowed" }, 405);

  const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
  const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

  const auth = await authenticateTerminal(req, admin, "id");
  if (auth.error) {
    const status = auth.error === "missing_api_key" || auth.error === "invalid_api_key" ? 401 : 500;
    return jsonResponse({ error: auth.error, detail: auth.detail }, status);
  }
  const terminal = auth.terminal!;

  let body: { symbols?: IncomingSymbolBars[] };
  try {
    body = await req.json();
  } catch {
    return jsonResponse({ error: "invalid_json_body" }, 400);
  }

  if (!Array.isArray(body.symbols)) return jsonResponse({ error: "missing_symbols_array" }, 400);
  if (body.symbols.length > MAX_SYMBOLS_PER_REQUEST) {
    return jsonResponse({ error: "too_many_symbols", max: MAX_SYMBOLS_PER_REQUEST }, 413);
  }

  for (const symbolPayload of body.symbols) {
    if (!symbolPayload || typeof symbolPayload.broker_symbol !== "string" || !Array.isArray(symbolPayload.bars)) {
      return jsonResponse({ error: "invalid_symbol_payload" }, 400);
    }
    if (symbolPayload.bars.length > MAX_BARS_PER_SYMBOL) {
      return jsonResponse({
        error: "too_many_bars_for_symbol",
        broker_symbol: symbolPayload.broker_symbol,
        max: MAX_BARS_PER_SYMBOL,
      }, 413);
    }
  }

  const warnings: string[] = [];
  const brokerSymbols = [...new Set(body.symbols.map((s) => s.broker_symbol).filter((s) => s.length > 0))];
  if (brokerSymbols.length === 0) return jsonResponse({ upserted: 0, warnings });

  const { data: mappingRows, error: mappingsError } = await admin
    .from("symbol_mappings")
    .select("canonical_symbol, broker_symbol")
    .eq("terminal_id", terminal.id)
    .in("broker_symbol", brokerSymbols)
    .not("broker_symbol", "is", null)
    .neq("match_type", "unavailable");

  if (mappingsError) return jsonResponse({ error: "mapping_lookup_failed", detail: mappingsError.message }, 500);

  const canonicalByBroker = new Map<string, string>();
  for (const mapping of mappingRows ?? []) {
    // A terminal should not map two canonicals to one broker symbol; keeping the
    // first row is safer than rejecting the entire small, frequent EA payload.
    if (!canonicalByBroker.has(mapping.broker_symbol)) {
      canonicalByBroker.set(mapping.broker_symbol, mapping.canonical_symbol);
    }
  }

  const rows: Array<{
    terminal_id: string;
    symbol: string;
    timeframe: "M5";
    bar_time: string;
    open: number;
    high: number;
    low: number;
    close: number;
    volume: number;
  }> = [];

  for (const symbolPayload of body.symbols) {
    const canonicalSymbol = canonicalByBroker.get(symbolPayload.broker_symbol);
    if (!canonicalSymbol) {
      warnings.push(`No canonical mapping for broker symbol ${symbolPayload.broker_symbol}; skipped.`);
      continue;
    }

    for (const bar of symbolPayload.bars) {
      const barTime = typeof bar?.time === "string" ? new Date(bar.time) : null;
      if (!barTime || Number.isNaN(barTime.getTime())) {
        warnings.push(`Invalid bar time for ${symbolPayload.broker_symbol}; bar skipped.`);
        continue;
      }
      if (![bar.open, bar.high, bar.low, bar.close, bar.volume].every(isFiniteNumber)) {
        warnings.push(`Non-numeric OHLCV value for ${symbolPayload.broker_symbol} at ${bar.time}; bar skipped.`);
        continue;
      }
      if (bar.high < bar.low || bar.volume < 0) {
        warnings.push(`Invalid range or volume for ${symbolPayload.broker_symbol} at ${bar.time}; bar skipped.`);
        continue;
      }

      rows.push({
        terminal_id: terminal.id,
        symbol: canonicalSymbol,
        timeframe: "M5",
        bar_time: barTime.toISOString(),
        open: bar.open,
        high: bar.high,
        low: bar.low,
        close: bar.close,
        volume: bar.volume,
      });
    }
  }

  if (rows.length === 0) return jsonResponse({ upserted: 0, warnings });

  const { error: upsertError } = await admin
    .from("price_bars")
    .upsert(rows, { onConflict: "terminal_id,symbol,timeframe,bar_time" });

  if (upsertError) return jsonResponse({ error: "upsert_failed", detail: upsertError.message }, 500);
  return jsonResponse({ upserted: rows.length, warnings });
});
