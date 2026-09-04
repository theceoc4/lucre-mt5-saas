// v1.0.49 -- Authenticated, durable ingress for TradingView, generic webhooks,
// and Lucre EA indicator adapters. This endpoint only admits a candidate. It
// never accepts account identity, volume, risk, stops, or execution mode from
// the caller; those are loaded from the terminal-owned strategy by the engine.

import { createClient } from "jsr:@supabase/supabase-js@2";

const JSON_HEADERS = {
  "Content-Type": "application/json",
  "Cache-Control": "no-store",
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "content-type, x-api-key",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const TIMEFRAMES = new Set(["M1", "M5", "M15", "M30", "H1", "H4", "D1", "W1"]);

function respond(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return [...new Uint8Array(digest)].map((byte) =>
    byte.toString(16).padStart(2, "0")
  ).join("");
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${
      Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
        a.localeCompare(b)
      )
        .map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`)
        .join(",")
    }}`;
  }
  const encoded = JSON.stringify(value);
  return encoded === undefined ? "null" : encoded;
}

function normalizeTimeframe(value: unknown): string | null {
  const raw = String(value ?? "").trim().toUpperCase();
  const aliases: Record<string, string> = {
    "1": "M1",
    "5": "M5",
    "15": "M15",
    "30": "M30",
    "60": "H1",
    "240": "H4",
    "1H": "H1",
    "4H": "H4",
    "1D": "D1",
    "D": "D1",
    "1W": "W1",
    "W": "W1",
  };
  const normalized = aliases[raw] ?? raw;
  return TIMEFRAMES.has(normalized) ? normalized : null;
}

function normalizeSide(value: unknown): "buy" | "sell" | null {
  const raw = String(value ?? "").trim().toLowerCase();
  if (["buy", "long", "1"].includes(raw)) return "buy";
  if (["sell", "short", "-1"].includes(raw)) return "sell";
  return null;
}

function normalizeProviderSymbol(value: unknown): string {
  return String(value ?? "").trim().split(":").pop()?.toUpperCase() ?? "";
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: JSON_HEADERS });
  }
  if (req.method !== "POST") {
    return respond({ error: "method_not_allowed" }, 405);
  }
  const declaredLength = Number(req.headers.get("content-length") ?? 0);
  if (declaredLength > 16_384) {
    return respond({ error: "payload_too_large" }, 413);
  }

  const rawBody = await req.text();
  if (rawBody.length > 16_384) {
    return respond({ error: "payload_too_large" }, 413);
  }
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(rawBody);
  } catch {
    return respond({ error: "invalid_json_body" }, 400);
  }

  const url = new URL(req.url);
  const pathParts = url.pathname.split("/").filter(Boolean);
  const pathToken = pathParts[pathParts.length - 1] === "external-signal"
    ? ""
    : pathParts[pathParts.length - 1];
  const eaKey = req.headers.get("x-api-key") ?? "";
  if (!pathToken && !eaKey) {
    return respond({ error: "missing_endpoint_credential" }, 401);
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const admin = createClient(supabaseUrl, serviceKey);

  let endpoint: Record<string, unknown> | null = null;
  if (pathToken) {
    const tokenHash = await sha256Hex(pathToken);
    const { data } = await admin.from("external_signal_endpoints")
      .select(
        "id,terminal_id,strategy_id,provider,enabled,rate_limit_per_minute",
      )
      .eq("token_hash", tokenHash).maybeSingle();
    endpoint = data;
  } else {
    const keyHash = await sha256Hex(eaKey);
    const { data: terminal } = await admin.from("mt5_terminals").select("id")
      .eq("api_key_hash", keyHash).maybeSingle();
    if (terminal && body.strategy_id) {
      const { data } = await admin.from("external_signal_endpoints")
        .select(
          "id,terminal_id,strategy_id,provider,enabled,rate_limit_per_minute",
        )
        .eq("terminal_id", terminal.id).eq("strategy_id", body.strategy_id)
        .eq("provider", "mt5_indicator").maybeSingle();
      endpoint = data;
    }
  }
  if (!endpoint) return respond({ error: "invalid_endpoint_credential" }, 401);
  if (!endpoint.enabled) return respond({ error: "endpoint_disabled" }, 410);

  const { data: strategy } = await admin.from("strategies")
    .select(
      "id,terminal_id,enabled,signal_source,symbols,timeframe,signal_ttl_seconds",
    )
    .eq("id", endpoint.strategy_id).eq("terminal_id", endpoint.terminal_id)
    .maybeSingle();
  if (!strategy || strategy.signal_source !== endpoint.provider) {
    return respond({ error: "strategy_source_mismatch" }, 409);
  }
  if (!strategy.enabled) return respond({ error: "strategy_disabled" }, 409);

  const side = normalizeSide(body.side ?? body.action ?? body.direction);
  const timeframe = normalizeTimeframe(
    body.timeframe ?? body.interval ?? strategy.timeframe,
  );
  const symbolReceived = normalizeProviderSymbol(body.symbol ?? body.ticker);
  if (!side) return respond({ error: "invalid_side" }, 422);
  if (!timeframe || timeframe !== strategy.timeframe) {
    return respond({
      error: "timeframe_not_allowed",
      expected: strategy.timeframe,
    }, 422);
  }
  if (!symbolReceived) return respond({ error: "symbol_required" }, 422);

  let canonicalSymbol = (strategy.symbols as string[]).find((symbol) =>
    symbol.toUpperCase() === symbolReceived
  ) ?? null;
  if (!canonicalSymbol && endpoint.provider === "mt5_indicator") {
    const { data: mapping } = await admin.from("symbol_mappings").select(
      "canonical_symbol",
    )
      .eq("terminal_id", endpoint.terminal_id).ilike(
        "broker_symbol",
        symbolReceived,
      ).maybeSingle();
    if (
      mapping &&
      (strategy.symbols as string[]).includes(mapping.canonical_symbol)
    ) {
      canonicalSymbol = mapping.canonical_symbol;
    }
  }
  if (!canonicalSymbol) {
    return respond({ error: "symbol_not_allowed" }, 422);
  }

  if (body.test === true) {
    return respond({
      valid: true,
      strategy_id: strategy.id,
      symbol: canonicalSymbol,
      timeframe,
      side,
    });
  }

  const occurredAt = new Date(
    String(body.occurred_at ?? body.time ?? new Date().toISOString()),
  );
  if (!Number.isFinite(occurredAt.getTime())) {
    return respond({
      error: "invalid_occurred_at",
    }, 422);
  }
  const now = new Date();
  if (occurredAt.getTime() > now.getTime() + 30_000) {
    return respond({
      error: "occurred_at_in_future",
    }, 422);
  }
  const ttlSeconds = Math.max(
    1,
    Math.min(86_400, Number(strategy.signal_ttl_seconds) || 60),
  );
  if (now.getTime() - occurredAt.getTime() > ttlSeconds * 1000) {
    return respond(
      { error: "signal_expired" },
      410,
    );
  }

  const { count } = await admin.from("external_signal_events").select("id", {
    count: "exact",
    head: true,
  })
    .eq("endpoint_id", endpoint.id).gte(
      "received_at",
      new Date(now.getTime() - 60_000).toISOString(),
    );
  if ((count ?? 0) >= Number(endpoint.rate_limit_per_minute)) {
    await admin.from("external_signal_endpoints").update({
      last_received_at: now.toISOString(),
      last_status: "rate_limited",
    }).eq("id", endpoint.id);
    return respond({ error: "rate_limited" }, 429);
  }

  const payloadHash = await sha256Hex(canonicalJson(body));
  const providerEventId = String(
    body.event_id ?? body.idempotency_key ?? payloadHash,
  ).trim().slice(0, 180);
  const sourcePrice = Number(body.source_price ?? body.price ?? body.close);
  const sanitizedPayload = {
    event_id: providerEventId,
    symbol: symbolReceived,
    timeframe,
    side,
    source_price: Number.isFinite(sourcePrice) ? sourcePrice : null,
    occurred_at: occurredAt.toISOString(),
  };
  const { data: event, error: insertError } = await admin.from(
    "external_signal_events",
  ).insert({
    endpoint_id: endpoint.id,
    terminal_id: endpoint.terminal_id,
    strategy_id: endpoint.strategy_id,
    provider: endpoint.provider,
    provider_event_id: providerEventId,
    payload_hash: payloadHash,
    symbol_received: symbolReceived,
    canonical_symbol: canonicalSymbol,
    timeframe,
    side,
    source_price: Number.isFinite(sourcePrice) ? sourcePrice : null,
    occurred_at: occurredAt.toISOString(),
    sanitized_payload: sanitizedPayload,
  }).select("id").single();
  if (insertError?.code === "23505") {
    return respond({
      received: true,
      duplicate: true,
    }, 200);
  }
  if (insertError || !event) {
    return respond(
      { error: "event_store_failed" },
      500,
    );
  }

  await admin.from("external_signal_endpoints").update({
    last_received_at: now.toISOString(),
    last_status: "received",
  }).eq("id", endpoint.id);
  const { error: dispatchError } = await admin.rpc(
    "dispatch_external_signal_event",
    { p_event_id: event.id },
  );
  if (dispatchError) {
    await admin.from("external_signal_events").update({
      status: "processing_failed",
      block_reason: "dispatch_failed",
    }).eq("id", event.id);
    return respond({ error: "dispatch_failed", event_id: event.id }, 503);
  }
  return respond({ received: true, event_id: event.id }, 202);
});
