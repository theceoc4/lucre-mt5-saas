// v1.0.2 — ea-sync
//
// The MQL5 EA polls this every 1-2s. It is the ONLY function EAs talk to and the
// only inbound path for account/position state and command execution results.
// Auth is a plaintext API key (header: x-api-key), hashed and matched against
// mt5_terminals.api_key_hash — NOT a Supabase JWT, so this function is deployed
// with verify_jwt = false and does all authorization itself via the service role.
//
// v1.0.2: no code change here, but two backend gaps closed by migration 029
// now flow through this function automatically:
//   - ea_commands.strategy_id (new column) rides along in pending_commands
//     for free since that query is `select("*")` — EASync.mqh reads it off
//     each command and reports it back on the resulting position.
//   - Commands stuck in status='sent' (EA crashed/disconnected before
//     reporting a result) are no longer permanently lost — a pg_cron job
//     (public.sweep_stuck_commands(), every 5 min) resets them to 'queued'
//     so the query below re-offers them, instead of them only ever being
//     handed out once.
//
// v1.0.12: response now echoes mt5_terminals.force_symbol_rescan so the EA's
// SymbolMap module can trigger an on-demand symbol universe report without
// any new EA-initiated network call — it just reads this field off the
// response it was already parsing. See SymbolMap.mqh / report-symbols.
//
// Request body:
// {
//   account?: { equity, balance, margin_level, account_login?, server?, is_live? },
//   positions?: [{ mt5_ticket, symbol, side, volume, open_price, current_price,
//                   sl, tp, unrealized_pl, open_time, strategy_id? }],
//   command_results?: [{ ea_command_id, status: 'acknowledged'|'executed'|'failed',
//                         mt5_ticket?, error_message?, close_price?, profit?,
//                         r_multiple?, close_time? }],
//   closed_deals?: [{ mt5_ticket, symbol, close_price, profit, close_time }]
// }
//
// v1.0.14: response also includes bound_symbols (canonical -> broker strings) so
// PriceReporter.mqh can report CLOSED M5 bars under the canonical symbol the
// strategy engine stores, without a second lookup/network call.
//
// v1.0.14: closed_deals is sourced from EASync_BuildClosedDealsJson() scanning
// MT5 deal history every poll. It finalizes any position closed outside the
// command flow (SL/TP hit, or closed directly in the MT5 terminal/mobile app)
// which previously got stuck at status='closing' forever (see step 2.5 below)
// — this was the root cause of stale/"ghost" positions like ticket 153333
// persisting on the dashboard after being closed elsewhere.
// Also new in v1.0.14: EASync_TradingAllowed()/EASync_ApplyStopsLevel() add an
// AutoTrading preflight check and broker stops-level clamping before every
// order attempt on the EA side (no request-body/response shape change).
//
// v1.0.18: added a time-based self-healing reconciler (see step 3.5 below) so
// positions that get flagged 'closing' but never receive a matching
// closed_deals report (e.g. because the field EA build predates v1.0.14) do
// not persist forever. After a grace window they are finalized into
// trade_history with profit_verified=false and close_reason
// 'reconciled_missing_ea_report' rather than showing a false $0 result.
//
// Response: { terminal_id, server_time, pending_commands: [...], bound_symbols: [...], force_symbol_rescan }

import { createClient } from "jsr:@supabase/supabase-js@2";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "x-api-key, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
  });
}

async function sha256Hex(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

interface PositionReport {
  mt5_ticket: number;
  symbol: string;
  side: "buy" | "sell";
  volume: number;
  open_price: number;
  current_price: number;
  sl?: number | null;
  tp?: number | null;
  unrealized_pl: number;
  open_time: string;
  strategy_id?: string | null;
}

interface CommandResult {
  ea_command_id: string;
  status: "acknowledged" | "executed" | "failed";
  mt5_ticket?: number;
  error_message?: string;
  close_price?: number;
  profit?: number;
  r_multiple?: number;
  close_time?: string;
}

// v1.0.14: reported by EASync_BuildClosedDealsJson() every poll for any
// closing deal (SL/TP hit, manual close in the terminal/mobile app, or
// anything else outside the command flow) found in MT5 deal history.
interface ClosedDeal {
  mt5_ticket: number; // position ticket (DEAL_POSITION_ID of the closing deal)
  symbol: string;
  close_price: number;
  profit: number;
  close_time: string;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS_HEADERS });
  if (req.method !== "POST") return jsonResponse({ error: "method_not_allowed" }, 405);

  const apiKey = req.headers.get("x-api-key");
  if (!apiKey) return jsonResponse({ error: "missing_api_key" }, 401);

  const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
  const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

  const keyHash = await sha256Hex(apiKey);
  const { data: terminal, error: terminalError } = await admin
    .from("mt5_terminals")
    .select("id, max_open_positions, force_symbol_rescan")
    .eq("api_key_hash", keyHash)
    .maybeSingle();

  if (terminalError) return jsonResponse({ error: "lookup_failed", detail: terminalError.message }, 500);
  if (!terminal) return jsonResponse({ error: "invalid_api_key" }, 401);

  let body: {
    account?: {
      equity?: number;
      balance?: number;
      margin_level?: number;
      account_login?: string;
      server?: string;
      is_live?: boolean;
    };
    positions?: PositionReport[];
    command_results?: CommandResult[];
    closed_deals?: ClosedDeal[];
  };
  try {
    body = await req.json();
  } catch {
    return jsonResponse({ error: "invalid_json_body" }, 400);
  }

  const nowIso = new Date().toISOString();

  // 1. Heartbeat + account state.
  const accountUpdate: Record<string, unknown> = {
    last_heartbeat_at: nowIso,
    status: "connected",
  };
  if (body.account) {
    if (body.account.equity !== undefined) accountUpdate.equity = body.account.equity;
    if (body.account.balance !== undefined) accountUpdate.balance = body.account.balance;
    if (body.account.margin_level !== undefined) accountUpdate.margin_level = body.account.margin_level;
    if (body.account.account_login !== undefined) accountUpdate.account_login = body.account.account_login;
    if (body.account.server !== undefined) accountUpdate.server = body.account.server;
    if (body.account.is_live !== undefined) accountUpdate.is_live = body.account.is_live;
  }
  const { error: heartbeatError } = await admin
    .from("mt5_terminals")
    .update(accountUpdate)
    .eq("id", terminal.id);
  if (heartbeatError) {
    return jsonResponse({ error: "heartbeat_update_failed", detail: heartbeatError.message }, 500);
  }

  // 2. Process command execution results (acks, executions, failures).
  const processedResults: Array<{ ea_command_id: string; ok: boolean; detail?: string }> = [];

  for (const result of body.command_results ?? []) {
    const { data: command, error: commandFetchError } = await admin
      .from("ea_commands")
      .select("*")
      .eq("id", result.ea_command_id)
      .eq("terminal_id", terminal.id)
      .maybeSingle();

    if (commandFetchError || !command) {
      processedResults.push({ ea_command_id: result.ea_command_id, ok: false, detail: "command_not_found" });
      continue;
    }

    const commandUpdate: Record<string, unknown> = { status: result.status };
    if (result.mt5_ticket !== undefined) commandUpdate.mt5_ticket = result.mt5_ticket;
    if (result.error_message !== undefined) commandUpdate.error_message = result.error_message;
    if (result.status === "executed" || result.status === "failed") {
      commandUpdate.executed_at = nowIso;
    }

    const { error: commandUpdateError } = await admin
      .from("ea_commands")
      .update(commandUpdate)
      .eq("id", command.id);

    if (commandUpdateError) {
      processedResults.push({ ea_command_id: result.ea_command_id, ok: false, detail: commandUpdateError.message });
      continue;
    }

    // A successfully executed close writes the closing trade_history row and
    // marks the position closed, carrying forward the context tagged onto the
    // command at insert time (session/htf_regime/near_news_event/news_event_id).
    if (result.status === "executed" && command.command_type === "close") {
      const ticket = result.mt5_ticket ?? command.mt5_ticket;
      if (ticket) {
        const { data: position } = await admin
          .from("positions")
          .select("*")
          .eq("terminal_id", terminal.id)
          .eq("mt5_ticket", ticket)
          .maybeSingle();

        if (position && result.close_price !== undefined && result.profit !== undefined) {
          const outcome = result.profit > 0 ? "win" : result.profit < 0 ? "loss" : "breakeven";
          // v1.0.19 -- prefer the position's own stored context (migration
          // 038) and fall back to the closing command's, rather than the
          // other way around, so a close command that for any reason lacks
          // context (e.g. a future close path that doesn't set it) still
          // inherits what was captured when the position was opened.
          const { error: tradeHistoryError } = await admin.from("trade_history").insert({
            terminal_id: terminal.id,
            strategy_id: position.strategy_id,
            mt5_ticket: ticket,
            symbol: position.symbol,
            side: position.side,
            volume: position.volume,
            open_price: position.open_price,
            close_price: result.close_price,
            open_time: position.open_time,
            close_time: result.close_time ?? nowIso,
            profit: result.profit,
            r_multiple: result.r_multiple ?? null,
            session: position.session ?? command.session,
            htf_regime: position.htf_regime ?? command.htf_regime,
            near_news_event: position.near_news_event ?? command.near_news_event,
            news_event_id: position.news_event_id ?? command.news_event_id,
            source: command.source === "dashboard_close" ? "manual_order" : command.source,
            outcome,
          });
          if (tradeHistoryError) {
            processedResults.push({ ea_command_id: result.ea_command_id, ok: false, detail: `trade_history: ${tradeHistoryError.message}` });
            continue;
          }
          await admin.from("positions").update({ status: "closed", updated_at: nowIso }).eq("id", position.id);
        }
      }
    }

    processedResults.push({ ea_command_id: result.ea_command_id, ok: true });
  }

  // 2.5. v1.0.14: finalize positions closed outside the command flow (SL/TP
  // hit, or closed directly in the MT5 terminal/mobile app). This is the fix
  // for the ticket-153333 class of bug: previously any position missing from
  // the reported list just got flagged status='closing' below and sat there
  // forever, because nothing ever supplied the close price/profit needed to
  // write trade_history. EASync_BuildClosedDealsJson() now supplies exactly
  // that from MT5 deal history, so we can finalize it here directly.
  // Idempotent: trade_history has unique(terminal_id, mt5_ticket), so
  // re-reporting the same deal across overlapping EA scan windows is safe.
  for (const deal of body.closed_deals ?? []) {
    const { data: position } = await admin
      .from("positions")
      .select("*")
      .eq("terminal_id", terminal.id)
      .eq("mt5_ticket", deal.mt5_ticket)
      .neq("status", "closed")
      .maybeSingle();

    if (!position) continue; // already closed, or never tracked (shouldn't happen)

    const outcome = deal.profit > 0 ? "win" : deal.profit < 0 ? "loss" : "breakeven";
    // v1.0.19 -- this path (a position closed outside the command flow, e.g.
    // SL/TP hit) previously hard-coded session/htf_regime/near_news_event/
    // news_event_id to null since it had no command row to read them from.
    // Migration 038 gives positions their own copy of that context (set
    // when the position was first opened/reported), so it can be carried
    // forward here too -- this was the single biggest reason scenario_stats
    // never accumulated rows, since most closes happen via SL/TP, not a
    // dashboard/EA close command.
    const { error: closedDealError } = await admin.from("trade_history").upsert(
      {
        terminal_id: terminal.id,
        strategy_id: position.strategy_id,
        mt5_ticket: deal.mt5_ticket,
        symbol: position.symbol,
        side: position.side,
        volume: position.volume,
        open_price: position.open_price,
        close_price: deal.close_price,
        open_time: position.open_time,
        close_time: deal.close_time,
        profit: deal.profit,
        r_multiple: null,
        session: position.session ?? null,
        htf_regime: position.htf_regime ?? null,
        near_news_event: position.near_news_event ?? false,
        news_event_id: position.news_event_id ?? null,
        source: position.source,
        outcome,
      },
      { onConflict: "terminal_id,mt5_ticket", ignoreDuplicates: true },
    );

    if (!closedDealError) {
      await admin.from("positions").update({ status: "closed", updated_at: nowIso }).eq("id", position.id);
    }
  }

  // 3. Reconcile reported open positions (mirrored from the EA on every poll).
  const reportedTickets = new Set<number>();
  for (const p of body.positions ?? []) {
    reportedTickets.add(p.mt5_ticket);
    const { data: existing } = await admin
      .from("positions")
      .select("id")
      .eq("terminal_id", terminal.id)
      .eq("mt5_ticket", p.mt5_ticket)
      .maybeSingle();

    if (existing) {
      await admin
        .from("positions")
        .update({
          current_price: p.current_price,
          sl: p.sl ?? null,
          tp: p.tp ?? null,
          unrealized_pl: p.unrealized_pl,
          status: "open",
          closing_since: null,
          updated_at: nowIso,
        })
        .eq("id", existing.id);
    } else {
      // v1.0.19 -- look up the "open" ea_commands row this position
      // resulted from (matched by mt5_ticket, set once the EA reports the
      // executed ticket back in step 2 above) so the session/htf_regime/
      // near_news_event/news_event_id context generated at signal time by
      // strategy-signal-engine survives on the position itself. Without
      // this, that context was only ever reachable while the *same*
      // command row was still around, which the closed_deals and
      // self-healing reconciler close paths never look at -- so
      // trade_history rows created via those two paths always got
      // session/htf_regime=null and could never feed scenario_stats.
      // Manually-opened positions (no matching open command) legitimately
      // have no strategy context and keep these fields null.
      let openContext: {
        strategy_id: string | null;
        session: string | null;
        htf_regime: string | null;
        near_news_event: boolean;
        news_event_id: string | null;
        source: string;
      } = {
        strategy_id: p.strategy_id ?? null,
        session: null,
        htf_regime: null,
        near_news_event: false,
        news_event_id: null,
        source: "manual_order",
      };
      const { data: openCommand } = await admin
        .from("ea_commands")
        .select("strategy_id, session, htf_regime, near_news_event, news_event_id, source")
        .eq("terminal_id", terminal.id)
        .eq("mt5_ticket", p.mt5_ticket)
        .eq("command_type", "open")
        .order("requested_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (openCommand) {
        openContext = {
          strategy_id: openCommand.strategy_id ?? p.strategy_id ?? null,
          session: openCommand.session ?? null,
          htf_regime: openCommand.htf_regime ?? null,
          near_news_event: openCommand.near_news_event ?? false,
          news_event_id: openCommand.news_event_id ?? null,
          // v1.0.19 -- previously every EA-reported position was hardcoded
          // 'manual_order' here regardless of how it was actually opened,
          // which silently mis-tagged every auto-signal position and broke
          // the dashboard's "Auto Only"/"Manual Only" P/L filter. Now
          // inherited from the originating command, same as trade_history
          // already does on the close side.
          source: openCommand.source === "dashboard_close" ? "manual_order" : openCommand.source ?? "manual_order",
        };
      }

      await admin.from("positions").insert({
        terminal_id: terminal.id,
        strategy_id: openContext.strategy_id,
        mt5_ticket: p.mt5_ticket,
        symbol: p.symbol,
        side: p.side,
        volume: p.volume,
        open_price: p.open_price,
        current_price: p.current_price,
        sl: p.sl ?? null,
        tp: p.tp ?? null,
        unrealized_pl: p.unrealized_pl,
        source: openContext.source,
        status: "open",
        open_time: p.open_time,
        session: openContext.session,
        htf_regime: openContext.htf_regime,
        near_news_event: openContext.near_news_event,
        news_event_id: openContext.news_event_id,
        updated_at: nowIso,
      });
    }
  }

  // Safety net: an open position in our DB that's absent from this poll's list
  // and has no matching close command in flight is flagged 'closing' rather than
  // silently left stale, so the dashboard can surface a reconciliation banner.
  //
  // v1.0.18: previously this only flagged 'closing' and stopped there, which
  // meant a position stayed stuck forever whenever the EA build in the field
  // never sends closed_deals (older binaries predating v1.0.14). Now, once a
  // position has sat in 'closing' for RECONCILE_GRACE_MS while the terminal
  // is actively polling (this request itself proves that), it is
  // self-finalized into trade_history with profit_verified=false and an
  // honest close_reason, using the last known current_price as an
  // approximate close price. This is clearly surfaced to the user as
  // unverified rather than presented as a real $0 result -- see the
  // dashboard's profit_verified filtering.
  const RECONCILE_GRACE_MS = 3 * 60 * 1000;
  if (body.positions !== undefined) {
    const { data: trackedPositions } = await admin
      .from("positions")
      .select(
        "id, mt5_ticket, symbol, side, volume, open_price, current_price, open_time, strategy_id, source, status, closing_since, session, htf_regime, near_news_event, news_event_id"
      )
      .eq("terminal_id", terminal.id)
      .in("status", ["open", "closing"]);

    for (const pos of trackedPositions ?? []) {
      if (reportedTickets.has(pos.mt5_ticket)) continue; // handled by step 3 above

      if (pos.status === "open") {
        await admin
          .from("positions")
          .update({ status: "closing", closing_since: nowIso, updated_at: nowIso })
          .eq("id", pos.id);
        continue;
      }

      // Already 'closing'. If it has no closing_since yet (e.g. flagged by
      // an older deploy before this column existed), start the clock now
      // rather than finalizing immediately.
      if (!pos.closing_since) {
        await admin
          .from("positions")
          .update({ closing_since: nowIso, updated_at: nowIso })
          .eq("id", pos.id);
        continue;
      }

      const closingForMs = Date.parse(nowIso) - Date.parse(pos.closing_since);
      if (closingForMs < RECONCILE_GRACE_MS) continue;

      const approxClosePrice = pos.current_price ?? pos.open_price;
      // v1.0.19 -- session/htf_regime/near_news_event/news_event_id are now
      // carried forward from the position (migration 038) instead of being
      // hard-coded null, for consistency/analysis purposes (e.g. "which
      // regime tends to produce unreported closes"). This is safe even
      // though these are placeholder $0/breakeven rows: migration 039 makes
      // compute_scenario_stats/throttle_sweep/the trade-close trigger all
      // require profit_verified = true, so these unverified rows are still
      // fully excluded from the adaptive throttle ladder's calculations.
      const { error: reconcileError } = await admin.from("trade_history").upsert(
        {
          terminal_id: terminal.id,
          strategy_id: pos.strategy_id,
          mt5_ticket: pos.mt5_ticket,
          symbol: pos.symbol,
          side: pos.side,
          volume: pos.volume,
          open_price: pos.open_price,
          close_price: approxClosePrice,
          open_time: pos.open_time,
          close_time: nowIso,
          profit: 0,
          r_multiple: null,
          session: pos.session ?? null,
          htf_regime: pos.htf_regime ?? null,
          near_news_event: pos.near_news_event ?? false,
          news_event_id: pos.news_event_id ?? null,
          source: pos.source,
          outcome: "breakeven",
          close_reason: "reconciled_missing_ea_report",
          profit_verified: false,
        },
        { onConflict: "terminal_id,mt5_ticket", ignoreDuplicates: true }
      );

      if (!reconcileError) {
        await admin.from("positions").update({ status: "closed", updated_at: nowIso }).eq("id", pos.id);
      }
    }
  }

  // 4. Fetch queued commands for this terminal, mark them sent, return them.
  const { data: queuedCommands, error: queuedError } = await admin
    .from("ea_commands")
    .select("*")
    .eq("terminal_id", terminal.id)
    .eq("status", "queued")
    .order("requested_at", { ascending: true });

  if (queuedError) return jsonResponse({ error: "queued_fetch_failed", detail: queuedError.message }, 500);

  // v1.0.14: PriceReporter.mqh consumes this piggybacked mapping list from the
  // cached ea-sync response. Keep only usable resolved broker symbols; mappings
  // still awaiting review (broker_symbol null) must never reach CopyRates().
  const { data: mappings, error: mappingsError } = await admin
    .from("symbol_mappings")
    .select("canonical_symbol, broker_symbol")
    .eq("terminal_id", terminal.id)
    .not("broker_symbol", "is", null)
    .neq("match_type", "unavailable");

  if (mappingsError) return jsonResponse({ error: "symbol_mappings_fetch_failed", detail: mappingsError.message }, 500);

  if (queuedCommands && queuedCommands.length > 0) {
    await admin
      .from("ea_commands")
      .update({ status: "sent" })
      .in("id", queuedCommands.map((c) => c.id));
  }

  return jsonResponse({
    terminal_id: terminal.id,
    server_time: nowIso,
    command_results_processed: processedResults,
    pending_commands: queuedCommands ?? [],
    bound_symbols: (mappings ?? []).map((m) => ({
      canonical_symbol: m.canonical_symbol,
      broker_symbol: m.broker_symbol,
    })),
    force_symbol_rescan: terminal.force_symbol_rescan ?? false,
  });
});
