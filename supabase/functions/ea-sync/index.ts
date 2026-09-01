// v1.0.35 — verified candle bootstrap lifecycle and freshness manifest.
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
import { captureMarketContext } from "../_shared/market-context.ts";

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

const CLOSE_REASONS = new Set(["sl", "tp", "manual", "agent", "stop_out", "rollover", "other"]);

function closeReason(value?: string | null): string | null {
  return value && CLOSE_REASONS.has(value) ? value : null;
}

function realizedR(position: Record<string, unknown>, closePrice: number): number | null {
  const risk = Number(position.initial_risk_distance ?? 0);
  const open = Number(position.open_price ?? 0);
  if (!(risk > 0) || !(open > 0) || !(closePrice > 0)) return null;
  return (position.side === "sell" ? open - closePrice : closePrice - open) / risk;
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
  commission?: number;
  swap?: number;
  fee?: number;
  net_profit?: number;
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
  commission?: number;
  swap?: number;
  fee?: number;
  close_time: string;
  reason?: string;
}

interface AccountHistoryDeal {
  deal_ticket: number;
  position_id?: number;
  symbol?: string;
  side?: "buy" | "sell" | null;
  entry_type: number;
  deal_type: number;
  volume: number;
  price: number;
  profit: number;
  commission: number;
  swap: number;
  fee: number;
  occurred_at: string;
  magic?: number;
  comment?: string;
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
      ea_version?: string;
    };
    positions?: PositionReport[];
    command_results?: CommandResult[];
    closed_deals?: ClosedDeal[];
    account_history_deals?: AccountHistoryDeal[];
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
    if (body.account.ea_version !== undefined) accountUpdate.ea_version = body.account.ea_version;
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
  const closedPositionTickets = new Set<number>();

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
          const hasCostBreakdown = result.net_profit !== undefined
            || result.commission !== undefined || result.swap !== undefined || result.fee !== undefined;
          const netProfit = result.net_profit ?? (hasCostBreakdown
            ? result.profit + Number(result.commission ?? 0) + Number(result.swap ?? 0) + Number(result.fee ?? 0)
            : result.profit);
          const outcome = netProfit > 0 ? "win" : netProfit < 0 ? "loss" : "breakeven";
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
            r_multiple: result.r_multiple ?? realizedR(position, result.close_price),
            session: position.session ?? command.session,
            htf_regime: position.htf_regime ?? command.htf_regime,
            near_news_event: position.near_news_event ?? command.near_news_event,
            news_event_id: position.news_event_id ?? command.news_event_id,
            source: command.source === "dashboard_close" ? "manual_order" : command.source,
            strategy_name_at_entry: position.strategy_name_at_entry,
            origin_detail: position.origin_detail,
            risk_defined: position.risk_defined,
            entry_context: position.entry_context,
            net_profit: netProfit,
            outcome,
            close_reason: command.source === "dashboard_close" ? "manual" : "agent",
            initial_sl: position.initial_sl,
            initial_tp: position.initial_tp,
            initial_risk_distance: position.initial_risk_distance,
            risk_percent: position.risk_percent,
            entry_atr: position.entry_atr,
            entry_spread_points: position.entry_spread_points,
            mfe_price_distance: position.mfe_price_distance,
            mae_price_distance: position.mae_price_distance,
            mfe_r: position.mfe_r,
            mae_r: position.mae_r,
            max_unrealized_pl: position.max_unrealized_pl,
            min_unrealized_pl: position.min_unrealized_pl,
          });
          if (tradeHistoryError) {
            processedResults.push({ ea_command_id: result.ea_command_id, ok: false, detail: `trade_history: ${tradeHistoryError.message}` });
            continue;
          }
          closedPositionTickets.add(Number(ticket));
          await admin.from("positions").update({ status: "closed", updated_at: nowIso }).eq("id", position.id);
        }
      }
    }

    if (result.status === "executed" && command.command_type === "modify_sl_tp" && command.mt5_ticket) {
      await admin.from("positions").update({
        management_stage: command.management_stage ?? 0,
        last_management_bar_time: command.management_source_bar_time ?? nowIso,
        updated_at: nowIso,
      }).eq("terminal_id", terminal.id).eq("mt5_ticket", command.mt5_ticket);
    }

    processedResults.push({ ea_command_id: result.ea_command_id, ok: true });
  }

  // 2.25. Lossless MT5 account-history import. This is separate from
  // trade_history: it keeps every deal ticket for the dashboard ledger,
  // including partial fills and account-level balance events.
  const historyRows = (body.account_history_deals ?? [])
    .filter((deal) => Number.isFinite(deal.deal_ticket) && Number.isFinite(deal.entry_type) && Number.isFinite(deal.deal_type)
      && Number.isFinite(deal.volume) && Number.isFinite(deal.price) && Number.isFinite(deal.profit)
      && Number.isFinite(deal.commission) && Number.isFinite(deal.swap) && Number.isFinite(deal.fee)
      && typeof deal.occurred_at === "string" && !Number.isNaN(Date.parse(deal.occurred_at)))
    .map((deal) => ({
      terminal_id: terminal.id,
      deal_ticket: deal.deal_ticket,
      position_id: deal.position_id ?? null,
      symbol: deal.symbol ?? null,
      side: deal.side === "buy" || deal.side === "sell" ? deal.side : null,
      entry_type: deal.entry_type,
      deal_type: deal.deal_type,
      volume: deal.volume,
      price: deal.price,
      profit: deal.profit,
      commission: deal.commission,
      swap: deal.swap,
      fee: deal.fee,
      occurred_at: deal.occurred_at,
      magic: deal.magic ?? null,
      comment: deal.comment ?? null,
    }));
  if (historyRows.length > 0) {
    const { error: accountHistoryError } = await admin
      .from("mt5_account_history")
      .upsert(historyRows, { onConflict: "terminal_id,deal_ticket", ignoreDuplicates: true });
    if (accountHistoryError) console.error("ea-sync: account-history import failed", accountHistoryError.message);
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

    // v1.0.23 sends MT5's gross DEAL_PROFIT separately from commission,
    // swap and fee. Older EAs sent profit+commission+swap in `profit`, so
    // preserve that legacy interpretation when the new fields are absent.
    const hasCostBreakdown = deal.commission !== undefined || deal.swap !== undefined;
    const netProfit = hasCostBreakdown
      ? deal.profit + Number(deal.commission ?? 0) + Number(deal.swap ?? 0) + Number(deal.fee ?? 0)
      : deal.profit + Number(deal.fee ?? 0);
    const displayProfit = hasCostBreakdown ? deal.profit : netProfit;
    const outcome = netProfit > 0 ? "win" : netProfit < 0 ? "loss" : "breakeven";
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
        profit: displayProfit,
        r_multiple: realizedR(position, deal.close_price),
        session: position.session ?? null,
        htf_regime: position.htf_regime ?? null,
        near_news_event: position.near_news_event ?? false,
        news_event_id: position.news_event_id ?? null,
        source: position.source,
        strategy_name_at_entry: position.strategy_name_at_entry,
        origin_detail: position.origin_detail,
        risk_defined: position.risk_defined,
        entry_context: position.entry_context,
        net_profit: netProfit,
        outcome,
        close_reason: closeReason(deal.reason),
        initial_sl: position.initial_sl,
        initial_tp: position.initial_tp,
        initial_risk_distance: position.initial_risk_distance,
        risk_percent: position.risk_percent,
        entry_atr: position.entry_atr,
        entry_spread_points: position.entry_spread_points,
        mfe_price_distance: position.mfe_price_distance,
        mae_price_distance: position.mae_price_distance,
        mfe_r: position.mfe_r,
        mae_r: position.mae_r,
        max_unrealized_pl: position.max_unrealized_pl,
        min_unrealized_pl: position.min_unrealized_pl,
      },
      { onConflict: "terminal_id,mt5_ticket", ignoreDuplicates: true },
    );

    if (!closedDealError) {
      closedPositionTickets.add(Number(deal.mt5_ticket));
      await admin.from("positions").update({ status: "closed", updated_at: nowIso }).eq("id", position.id);
    }
  }

  // Reconcile the analytical trade against the lossless MT5 deal ledger.
  // This includes costs charged on both the opening and closing legs, and it
  // also guarantees that the dashboard's displayed trade P/L and net P/L are
  // derived from one authoritative set of deals.
  for (const positionTicket of closedPositionTickets) {
    const { data: ledgerRows, error: ledgerError } = await admin
      .from("mt5_account_history")
      .select("profit, commission, swap, fee")
      .eq("terminal_id", terminal.id)
      .eq("position_id", positionTicket);
    if (ledgerError || !ledgerRows || ledgerRows.length === 0) continue;

    const tradeProfit = ledgerRows.reduce((sum, row) => sum + Number(row.profit ?? 0), 0);
    const reconciledNet = ledgerRows.reduce(
      (sum, row) => sum + Number(row.profit ?? 0) + Number(row.commission ?? 0)
        + Number(row.swap ?? 0) + Number(row.fee ?? 0),
      0,
    );
    await admin
      .from("trade_history")
      .update({
        profit: tradeProfit,
        net_profit: reconciledNet,
        outcome: reconciledNet > 0 ? "win" : reconciledNet < 0 ? "loss" : "breakeven",
      })
      .eq("terminal_id", terminal.id)
      .eq("mt5_ticket", positionTicket);
  }

  // 3. Reconcile reported open positions (mirrored from the EA on every poll).
  const reportedTickets = new Set<number>();
  for (const p of body.positions ?? []) {
    reportedTickets.add(p.mt5_ticket);
    const { data: existing } = await admin
      .from("positions")
      .select("id, side, open_price, initial_sl, initial_risk_distance, mfe_price_distance, mae_price_distance, mfe_r, mae_r, max_unrealized_pl, min_unrealized_pl")
      .eq("terminal_id", terminal.id)
      .eq("mt5_ticket", p.mt5_ticket)
      .maybeSingle();

    if (existing) {
      const openPrice = Number(existing.open_price ?? p.open_price);
      const riskDistance = Number(existing.initial_risk_distance ?? 0)
        || (existing.initial_sl ? Math.abs(openPrice - Number(existing.initial_sl)) : 0);
      const favorableDistance = Math.max(0, p.side === "buy" ? p.current_price - openPrice : openPrice - p.current_price);
      const adverseDistance = Math.max(0, p.side === "buy" ? openPrice - p.current_price : p.current_price - openPrice);
      const mfeDistance = Math.max(Number(existing.mfe_price_distance ?? 0), favorableDistance);
      const maeDistance = Math.max(Number(existing.mae_price_distance ?? 0), adverseDistance);
      await admin
        .from("positions")
        .update({
          current_price: p.current_price,
          sl: p.sl ?? null,
          tp: p.tp ?? null,
          unrealized_pl: p.unrealized_pl,
          initial_risk_distance: riskDistance || null,
          mfe_price_distance: mfeDistance,
          mae_price_distance: maeDistance,
          mfe_r: riskDistance > 0 ? mfeDistance / riskDistance : null,
          mae_r: riskDistance > 0 ? maeDistance / riskDistance : null,
          max_unrealized_pl: Math.max(Number(existing.max_unrealized_pl ?? p.unrealized_pl), p.unrealized_pl),
          min_unrealized_pl: Math.min(Number(existing.min_unrealized_pl ?? p.unrealized_pl), p.unrealized_pl),
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
        strategy_name_at_entry: string;
        origin_detail: string;
        risk_defined: boolean;
        entry_context: Record<string, unknown>;
        risk_percent: number | null;
        entry_atr: number | null;
        entry_spread_points: number | null;
        initial_risk_distance: number | null;
        auto_manage: boolean;
      } = {
        strategy_id: p.strategy_id ?? null,
        session: null,
        htf_regime: null,
        near_news_event: false,
        news_event_id: null,
        source: "manual_order",
        strategy_name_at_entry: "Discretionary manual",
        origin_detail: "mt5_direct_manual",
        risk_defined: false,
        entry_context: {},
        risk_percent: null,
        entry_atr: null,
        entry_spread_points: null,
        initial_risk_distance: null,
        auto_manage: false,
      };
      const { data: openCommand } = await admin
        .from("ea_commands")
        .select("strategy_id, session, htf_regime, near_news_event, news_event_id, source, strategy_name_at_entry, origin_detail, risk_defined, entry_context, risk_percent, entry_atr, entry_spread_points, initial_risk_distance, auto_manage")
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
          strategy_name_at_entry: openCommand.strategy_name_at_entry ?? (openCommand.strategy_id ? "Strategy" : "Discretionary manual"),
          origin_detail: openCommand.origin_detail ?? openCommand.source ?? "dashboard_manual",
          risk_defined: openCommand.risk_defined ?? Boolean(p.sl),
          entry_context: openCommand.entry_context ?? {},
          risk_percent: openCommand.risk_percent ?? null,
          entry_atr: openCommand.entry_atr ?? null,
          entry_spread_points: openCommand.entry_spread_points ?? null,
          initial_risk_distance: openCommand.initial_risk_distance ?? null,
          auto_manage: openCommand.auto_manage ?? false,
        };
      } else {
        const directContext = await captureMarketContext(admin, {
          terminalId: terminal.id, symbol: p.symbol, at: new Date(p.open_time), origin: "mt5_direct_manual", riskDefined: Boolean(p.sl),
        });
        openContext = {
          strategy_id: p.strategy_id ?? null, session: directContext.session, htf_regime: directContext.htf_regime,
          near_news_event: directContext.near_news_event, news_event_id: directContext.news_event_id,
          source: "manual_order", strategy_name_at_entry: "MT5 direct manual", origin_detail: "mt5_direct_manual",
          risk_defined: Boolean(p.sl), entry_context: directContext.context,
          risk_percent: null, entry_atr: null, entry_spread_points: null,
          initial_risk_distance: p.sl ? Math.abs(p.open_price - p.sl) : null, auto_manage: false,
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
        strategy_name_at_entry: openContext.strategy_name_at_entry,
        origin_detail: openContext.origin_detail,
        risk_defined: openContext.risk_defined,
        entry_context: openContext.entry_context,
        initial_sl: p.sl ?? null,
        initial_tp: p.tp ?? null,
        initial_risk_distance: p.sl ? Math.abs(p.open_price - p.sl) : openContext.initial_risk_distance,
        risk_percent: openContext.risk_percent,
        entry_atr: openContext.entry_atr,
        entry_spread_points: openContext.entry_spread_points,
        mfe_price_distance: 0,
        mae_price_distance: 0,
        mfe_r: 0,
        mae_r: 0,
        max_unrealized_pl: p.unrealized_pl,
        min_unrealized_pl: p.unrealized_pl,
        auto_manage: openContext.auto_manage,
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
        "id, mt5_ticket, symbol, side, volume, open_price, current_price, open_time, strategy_id, source, status, closing_since, session, htf_regime, near_news_event, news_event_id, strategy_name_at_entry, origin_detail, risk_defined, entry_context, initial_sl, initial_tp, initial_risk_distance, risk_percent, entry_atr, entry_spread_points, mfe_price_distance, mae_price_distance, mfe_r, mae_r, max_unrealized_pl, min_unrealized_pl"
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
          strategy_name_at_entry: pos.strategy_name_at_entry,
          origin_detail: pos.origin_detail,
          risk_defined: pos.risk_defined,
          entry_context: pos.entry_context,
          net_profit: 0,
          outcome: "breakeven",
          close_reason: "reconciled_missing_ea_report",
          profit_verified: false,
          initial_sl: pos.initial_sl,
          initial_tp: pos.initial_tp,
          initial_risk_distance: pos.initial_risk_distance,
          risk_percent: pos.risk_percent,
          entry_atr: pos.entry_atr,
          entry_spread_points: pos.entry_spread_points,
          mfe_price_distance: pos.mfe_price_distance,
          mae_price_distance: pos.mae_price_distance,
          mfe_r: pos.mfe_r,
          mae_r: pos.mae_r,
          max_unrealized_pl: pos.max_unrealized_pl,
          min_unrealized_pl: pos.min_unrealized_pl,
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

  const { data: symbolSettings, error: settingsError } = await admin
    .from("symbol_settings")
    .select("symbol, enabled, timeframes")
    .eq("terminal_id", terminal.id);
  if (settingsError) return jsonResponse({ error: "symbol_settings_fetch_failed", detail: settingsError.message }, 500);

  const supportedTimeframes = ["M1", "M5", "M15", "M30", "H1", "H4", "D1", "W1"];
  const settingsBySymbol = new Map(
    (symbolSettings ?? []).map((setting) => [setting.symbol, setting]),
  );

  // Active strategy inputs must win over general dashboard/trend collection.
  // The mapping array is sorted for older EAs, while priority_timeframes lets
  // v1.0.30+ explicitly run those series before its round-robin background
  // queue. This keeps one large visible-symbol universe from starving an auto
  // strategy's exact symbol/timeframe feed.
  const { data: enabledStrategies, error: enabledStrategiesError } = await admin
    .from("strategies")
    .select("symbols,timeframe,bias_timeframe,rule_definition,kind,run_mode,delivery_mode")
    .eq("terminal_id", terminal.id)
    .eq("enabled", true);
  if (enabledStrategiesError) {
    return jsonResponse({ error: "strategy_feed_priority_fetch_failed", detail: enabledStrategiesError.message }, 500);
  }
  const priorityTimeframesBySymbol = new Map<string, Set<string>>();
  const priorityRankBySymbol = new Map<string, number>();
  for (const strategy of enabledStrategies ?? []) {
    if (!supportedTimeframes.includes(strategy.timeframe) || !Array.isArray(strategy.symbols)) continue;
    const requiredTimeframes = new Set<string>([strategy.timeframe]);
    if (supportedTimeframes.includes(strategy.bias_timeframe)) requiredTimeframes.add(strategy.bias_timeframe);
    if (strategy.kind === "multi_timeframe_trend_pullback" && !strategy.bias_timeframe) requiredTimeframes.add("H4");
    if (strategy.rule_definition?.version === 1) {
      for (const condition of [
        ...(strategy.rule_definition.long ?? []),
        ...(strategy.rule_definition.short ?? []),
      ]) {
        if (supportedTimeframes.includes(condition?.timeframe)) requiredTimeframes.add(condition.timeframe);
      }
    }
    const rank = strategy.run_mode === "live" && strategy.delivery_mode === "auto" ? 0
      : strategy.run_mode === "live" ? 1 : 2;
    for (const symbol of strategy.symbols) {
      if (typeof symbol !== "string" || symbol.length === 0) continue;
      if (!priorityTimeframesBySymbol.has(symbol)) priorityTimeframesBySymbol.set(symbol, new Set());
      for (const timeframe of requiredTimeframes) priorityTimeframesBySymbol.get(symbol)!.add(timeframe);
      priorityRankBySymbol.set(symbol, Math.min(rank, priorityRankBySymbol.get(symbol) ?? 99));
    }
  }

  const desiredFeedSeries = (mappings ?? []).flatMap((mapping) => {
    const setting = settingsBySymbol.get(mapping.canonical_symbol);
    const enabled = setting?.enabled !== false;
    const priorityTimeframes = priorityTimeframesBySymbol.get(mapping.canonical_symbol) ?? new Set<string>();
    const symbolRank = priorityRankBySymbol.get(mapping.canonical_symbol) ?? 99;
    return supportedTimeframes.map((timeframe) => ({
      symbol: mapping.canonical_symbol,
      timeframe,
      enabled,
      priority_rank: priorityTimeframes.has(timeframe) ? symbolRank : 99,
    }));
  });
  const { error: reconcileFeedError } = await admin.rpc("reconcile_price_feed_manifest", {
    p_terminal_id: terminal.id,
    p_desired: desiredFeedSeries,
  });
  if (reconcileFeedError) {
    return jsonResponse({ error: "price_feed_manifest_reconcile_failed", detail: reconcileFeedError.message }, 500);
  }

  const { data: feedStates, error: feedStatesError } = await admin
    .from("price_feed_series_state")
    .select("symbol,timeframe,latest_bar_time,oldest_bar_time,history_bar_count,bootstrap_generation,bootstrap_required,status")
    .eq("terminal_id", terminal.id);
  if (feedStatesError) {
    return jsonResponse({ error: "price_feed_state_fetch_failed", detail: feedStatesError.message }, 500);
  }
  type FeedState = {
    latest_bar_time: string | null;
    oldest_bar_time: string | null;
    history_bar_count: number;
    bootstrap_generation: number;
    bootstrap_required: boolean;
    status: string;
  };
  const feedStatesBySymbol = new Map<string, Record<string, FeedState>>();
  for (const state of feedStates ?? []) {
    if (!feedStatesBySymbol.has(state.symbol)) feedStatesBySymbol.set(state.symbol, {});
    feedStatesBySymbol.get(state.symbol)![state.timeframe] = state as FeedState;
  }
  const orderedMappings = [...(mappings ?? [])].sort((left, right) => {
    const rankDelta = (priorityRankBySymbol.get(left.canonical_symbol) ?? 99) -
      (priorityRankBySymbol.get(right.canonical_symbol) ?? 99);
    return rankDelta || left.canonical_symbol.localeCompare(right.canonical_symbol);
  });

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
    bound_symbols: orderedMappings.map((m) => ({
      canonical_symbol: m.canonical_symbol,
      broker_symbol: m.broker_symbol,
      // Visibility now controls collection system-wide. Every visible symbol
      // reports the standard timeframe set; the removed timeframe picker must
      // not silently stop market-data ingestion when its saved array is empty.
      report_timeframes: (() => {
        const setting = settingsBySymbol.get(m.canonical_symbol);
        if (setting && !setting.enabled) return [];
        return supportedTimeframes;
      })(),
      priority_timeframes: [...(priorityTimeframesBySymbol.get(m.canonical_symbol) ?? [])],
      // The server is authoritative for accepted candle progress. New EAs
      // initialize their volatile local cursor from this object after every
      // restart instead of blindly replaying 1,000 bars for every series.
      feed_checkpoints: Object.fromEntries(
        Object.entries(feedStatesBySymbol.get(m.canonical_symbol) ?? {})
          .filter(([, state]) => Boolean(state.latest_bar_time))
          .map(([timeframe, state]) => [timeframe, state.latest_bar_time]),
      ),
      feed_bootstrap_generations: Object.fromEntries(
        Object.entries(feedStatesBySymbol.get(m.canonical_symbol) ?? {})
          .map(([timeframe, state]) => [timeframe, state.bootstrap_generation]),
      ),
      feed_bootstrap_required: Object.entries(feedStatesBySymbol.get(m.canonical_symbol) ?? {})
        .filter(([, state]) => state.bootstrap_required)
        .map(([timeframe]) => timeframe),
      feed_history_counts: Object.fromEntries(
        Object.entries(feedStatesBySymbol.get(m.canonical_symbol) ?? {})
          .map(([timeframe, state]) => [timeframe, state.history_bar_count]),
      ),
      feed_statuses: Object.fromEntries(
        Object.entries(feedStatesBySymbol.get(m.canonical_symbol) ?? {})
          .map(([timeframe, state]) => [timeframe, state.status]),
      ),
    })),
    force_symbol_rescan: terminal.force_symbol_rescan ?? false,
  });
});
