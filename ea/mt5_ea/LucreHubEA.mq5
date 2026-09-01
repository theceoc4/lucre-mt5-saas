//+------------------------------------------------------------------+
//|                                                  LucreHubEA.mq5   |
//|  v1.0.31 — Lucre Hub main Expert Advisor (single-file build)      |
//|                                                                    |
//|  Thin execution client per the architecture spec (§3 "MT5 EA —    |
//|  Thin Execution Client"): this file owns no trading logic of its  |
//|  own. It authenticates once, then on a timer:                     |
//|    - reports account state + open positions (EASync module)      |
//|    - executes whatever commands the dashboard/backend queued      |
//|      (open/modify/close/hedge_open/flatten_basket/modify_sl_tp)    |
//|    - pushes the terminal's native Economic Calendar to the        |
//|      backend on a slower interval (CalendarSync module)            |
//|    - optionally holds a persistent WebSocket to the backend for     |
//|      near-instant command pickup between polls (EAStream module)     |
//|    - reports the broker's full symbol list so the backend can map   |
//|      canonical pairs to this broker's specific symbol names          |
//|      (SymbolMap module)                                              |
//|    - reports closed M5 price bars per canonical symbol so the        |
//|      backend's strategy-signal-engine can evaluate live strategies   |
//|      (PriceReporter module)                                          |
//|                                                                     |
//|  Attach this EA to exactly ONE chart per MT5 terminal/account.     |
//|  Which symbol/timeframe the chart is on does not matter — all      |
//|  trading happens via explicit commands against explicit symbols,   |
//|  not against the chart it's attached to.                           |
//|                                                                     |
//|  v1.0.18 — SINGLE-FILE BUILD. Previously this EA shipped as         |
//|  LucreHubEA.mq5 + 5 sibling .mqh files (EASync/CalendarSync/        |
//|  EAStream/SymbolMap/PriceReporter) that had to be copied into       |
//|  MQL5/Include alongside the .mq5 in MQL5/Experts. That works on a   |
//|  local terminal but MetaTrader VPS hosting only syncs the compiled  |
//|  .ex5 (and does not reliably sync sibling .mq5/.mqh source files),  |
//|  so a VPS-hosted instance would fail to compile/attach if any       |
//|  include was missing. This build inlines all 5 modules directly    |
//|  into this one file (MQL5 #include is plain text substitution, so   |
//|  the compiled result is byte-for-byte equivalent) — copy just this  |
//|  ONE file into MQL5/Experts, compile, attach. No behavior change,   |
//|  packaging only. Each module's original header comment is kept in  |
//|  place below, wrapped in BEGIN/END inlined module banners, purely   |
//|  for readability/navigation.                                        |
//+------------------------------------------------------------------+
#property copyright "Lucre Hub"
#property version   "1.31"
#property strict


//============================================================================
// BEGIN inlined module: EASync.mqh
// (originally a separate #include file — merged in for single-file
// deployment; MT5 VPS does not reliably sync sibling .mqh files, so
// this build ships as one self-contained .mq5.)
//============================================================================
//+------------------------------------------------------------------+
//|                                                    EASync.mqh    |
//|  v1.0.13 — Core execution client: the EA's half of ea-sync.      |
//|                                                                    |
//|  This is the ONLY module that talks to /functions/v1/ea-sync.     |
//|  Every poll, in one HTTP round trip:                              |
//|    1. Pushes a fresh account snapshot + full open-position list   |
//|       (heartbeat — ea-sync marks the terminal 'connected' on any  |
//|       successful call).                                           |
//|    2. Pushes results for every command executed since the last    |
//|       poll (command_results).                                     |
//|    3. Receives back any newly queued ea_commands rows and         |
//|       executes them locally (open/modify/close/hedge_open/        |
//|       flatten_basket/modify_sl_tp) via OrderSend/PositionModify.   |
//|                                                                    |
//|  INTEGRATION (in your main .mq5 EA file):                         |
//|    #include "EASync.mqh"                                          |
//|                                                                    |
//|    int OnInit() {                                                 |
//|      EASync_Init(SupabaseProjectUrl, TerminalApiKey, PollSeconds);|
//|      EventSetTimer(1); // 1s ticks; EASync_OnTimer() self-gates    |
//|      return(INIT_SUCCEEDED);                                      |
//|    }                                                               |
//|                                                                    |
//|    void OnDeinit(const int reason) {                              |
//|      EASync_Deinit();                                             |
//|      EventKillTimer();                                            |
//|    }                                                               |
//|                                                                    |
//|    void OnTimer() {                                                |
//|      EASync_OnTimer(); // no-op unless PollSeconds has elapsed     |
//|    }                                                                |
//|                                                                     |
//|  REQUIRED ONE-TIME TERMINAL SETUP (per machine running the EA):      |
//|    Tools > Options > Expert Advisors > "Allow WebRequest for listed  |
//|    URL" and add: https://qxlfnscmrhwfcpattqxa.supabase.co           |
//|    (WebRequest() fails silently with error 4060 otherwise.)          |
//|                                                                       |
//|  KNOWN LIMITATIONS (see mt5_ea/README.md for detail):                |
//|    - flatten_basket closes EVERY open position on the terminal.      |
//|      Safe today because basket_state has one row per terminal        |
//|      (unique terminal_id) -- there is only ever one basket to        |
//|      flatten. Revisit if that constraint ever changes.               |
//|    - hedge_open executes identically to open. The backend does not   |
//|      yet accept is_hedge/hedge_layer/basket_state_id on the position |
//|      report (ea-sync's PositionReport shape does not carry them), so |
//|      basket tagging on the position record itself is not yet         |
//|      possible from the EA side -- that lands when the (not-yet-      |
//|      built) basket manager worker extends ea-sync.                   |
//|    - strategy_id tracking (v1.0.10) is in-memory only: if the EA     |
//|      restarts between opening a position and its first position-    |
//|      report poll, the ticket->strategy_id map entry for that one     |
//|      ticket is lost. ea-sync's existing-position UPDATE path never   |
//|      re-sets strategy_id (only the INSERT-of-new-position path       |
//|      does), so that position permanently reports strategy_id=null.  |
//|      Rare in practice (narrow restart window) but a known gap.       |
//|    - v1.0.20: open-command idempotency now uses a compact `lh:` tag  |
//|      plus the first 20 hex characters of the command UUID (23 chars |
//|      total), safely below common 31-character broker comment limits. |
//|    - FIXED in v1.0.13: all three OrderSend() call sites used to hard- |
//|      code request.type_filling = ORDER_FILLING_FOK, which errors out |
//|      with "Unsupported filling mode" (retcode 10030) on any broker/  |
//|      symbol that doesn't support FOK -- most retail FX/CFD brokers    |
//|      only support IOC or market-execution Return. Now resolved per-   |
//|      symbol from SYMBOL_FILLING_MODE via                              |
//|      EASync_SendOrderWithFillingFallback(), which also retries the    |
//|      other two modes if the broker's reported flags turn out to be    |
//|      wrong. See EASync_ResolveFillingMode() / _SendOrderWithFilling-   |
//|      Fallback() below.                                                |
//+------------------------------------------------------------------+
//----------------------------------------------------------------------
// Configuration (set via EASync_Init args, not #property input, so
// this .mqh can be shared by every EA variant without redeclaring
// duplicate inputs — mirrors CalendarSync.mqh's convention).
//----------------------------------------------------------------------
string   g_es_base_url         = "";   // e.g. https://qxlfnscmrhwfcpattqxa.supabase.co
string   g_es_api_key          = "";   // mtk_live_... from provision-terminal-key
int      g_es_poll_seconds     = 10;   // adaptive: slower while Realtime is healthy
datetime g_es_last_poll        = 0;
datetime g_es_last_history_scan = 0; // v1.0.14: rolling window start for closed-deal detection
ulong    g_es_account_history_last_ticket = 0;
bool     g_es_account_history_initial_sync = true;
int      g_es_magic            = 990110; // orders/positions tagged with this magic number

// Local defense-in-depth ceilings. These do not replace server-side terminal
// policy; they ensure a malformed/stale command cannot exceed a conservative
// lot, account-position, or per-trade monetary-risk limit at the terminal.
#define LUCRE_HARD_MAX_VOLUME_PER_ORDER 0.10
#define LUCRE_HARD_MAX_OPEN_POSITIONS    5
#define LUCRE_HARD_MAX_RISK_PER_TRADE_USD 500.0

// Results collected while executing commands during one poll, flushed on
// the *next* poll's request body (ea-sync is stateless per-request; the
// EA carries them across the one-timer-tick gap itself).
string   g_es_pending_results[];
int      g_es_pending_results_count = 0;

// In-memory ticket -> strategy_id map (v1.0.10). ea_commands.strategy_id is
// only known at command-execution time (from the poll response); positions
// carry no such field on the broker side, so this parallel-array map is how
// EASync_BuildRequestBody() re-attaches strategy_id to each position report.
// Lost on EA restart for any ticket opened-but-not-yet-reported (see file
// header "KNOWN LIMITATIONS").
long     g_es_strategy_tickets[];
string   g_es_strategy_ids[];
int      g_es_strategy_map_count = 0;

// v1.0.12 — cache of the most recent raw ea-sync response body. SymbolMap.mqh
// polls this via EASync_GetLastResponse() to read force_symbol_rescan without
// EASync.mqh taking a dependency on SymbolMap.mqh (wrong direction of
// coupling — this module should stay ignorant of who else reads its output).
string   g_es_last_response = "";

//+------------------------------------------------------------------+
//| Public: call once from OnInit()                                  |
//+------------------------------------------------------------------+
void EASync_Init(const string base_url, const string api_key, const int poll_seconds = 2)
{
   g_es_base_url     = base_url;
   g_es_api_key      = api_key;
   g_es_poll_seconds = poll_seconds;
   g_es_last_poll    = 0; // force an immediate first poll on the next OnTimer() tick
   ArrayResize(g_es_pending_results, 0);
   g_es_pending_results_count = 0;
   ArrayResize(g_es_strategy_tickets, 0);
   ArrayResize(g_es_strategy_ids, 0);
   g_es_strategy_map_count = 0;

   PrintFormat("EASync: initialized, base_url=%s, poll_seconds=%d", g_es_base_url, g_es_poll_seconds);
}

// Realtime changes the reconciliation cadence, never the command source of
// truth. The EA always retains a periodic ea-sync fallback.
void EASync_SetPollSeconds(const int poll_seconds)
{
   int normalized = (poll_seconds > 0) ? poll_seconds : 10;
   if(g_es_poll_seconds == normalized) return;
   g_es_poll_seconds = normalized;
   PrintFormat("EASync: reconciliation interval now %d seconds", g_es_poll_seconds);
}

//+------------------------------------------------------------------+
//| Strategy-attribution map (v1.0.10) — see globals comment above.   |
//| Track: no-op if strategy_id is ""/"null" (nothing to attribute);  |
//| overwrites the entry if the ticket is already tracked, else       |
//| appends (growing the backing arrays by 16 slots at a time).       |
//+------------------------------------------------------------------+
void EASync_TrackStrategyForTicket(const long ticket, const string strategy_id)
{
   if(strategy_id == "" || strategy_id == "null")
      return;

   for(int i = 0; i < g_es_strategy_map_count; i++)
   {
      if(g_es_strategy_tickets[i] == ticket)
      {
         g_es_strategy_ids[i] = strategy_id;
         return;
      }
   }

   if(g_es_strategy_map_count >= ArraySize(g_es_strategy_tickets))
   {
      ArrayResize(g_es_strategy_tickets, g_es_strategy_map_count + 16);
      ArrayResize(g_es_strategy_ids, g_es_strategy_map_count + 16);
   }
   g_es_strategy_tickets[g_es_strategy_map_count] = ticket;
   g_es_strategy_ids[g_es_strategy_map_count]     = strategy_id;
   g_es_strategy_map_count++;
}

//+------------------------------------------------------------------+
//| Strategy-attribution map: lookup. Returns "" if the ticket is not |
//| tracked (e.g. manual order, or lost-on-restart edge case).        |
//+------------------------------------------------------------------+
string EASync_StrategyForTicket(const long ticket)
{
   for(int i = 0; i < g_es_strategy_map_count; i++)
   {
      if(g_es_strategy_tickets[i] == ticket)
         return g_es_strategy_ids[i];
   }
   return "";
}

//+------------------------------------------------------------------+
//| Strategy-attribution map: remove an entry once its position has   |
//| closed, so the map stays bounded to currently-open tickets rather |
//| than growing unboundedly over the EA's lifetime.                  |
//+------------------------------------------------------------------+
void EASync_UntrackTicket(const long ticket)
{
   for(int i = 0; i < g_es_strategy_map_count; i++)
   {
      if(g_es_strategy_tickets[i] == ticket)
      {
         // Shift the tail down by one to fill the gap, then shrink the count.
         for(int j = i; j < g_es_strategy_map_count - 1; j++)
         {
            g_es_strategy_tickets[j] = g_es_strategy_tickets[j + 1];
            g_es_strategy_ids[j]     = g_es_strategy_ids[j + 1];
         }
         g_es_strategy_map_count--;
         return;
      }
   }
}

//+------------------------------------------------------------------+
//| Public: v1.0.12 — most recent raw ea-sync response body, or ""    |
//| before the first successful poll. SymbolMap.mqh reads this to     |
//| check the force_symbol_rescan flag without EASync.mqh needing to  |
//| know SymbolMap.mqh exists.                                        |
//+------------------------------------------------------------------+
string EASync_GetLastResponse()
{
   return g_es_last_response;
}

//+------------------------------------------------------------------+
//| Public: call once from OnDeinit() — no owned handles today, kept  |
//| for symmetry with CalendarSync_Deinit() and future teardown needs.|
//+------------------------------------------------------------------+
void EASync_Deinit()
{
   // Nothing to release: the EA-level EventKillTimer() owns the timer.
}

//+------------------------------------------------------------------+
//| Public: call from OnTimer(). No-op until poll_seconds has elapsed.|
//+------------------------------------------------------------------+
void EASync_OnTimer()
{
   if(g_es_base_url == "" || g_es_api_key == "")
      return; // EASync_Init() was never called — nothing to do.

   if(TimeCurrent() - g_es_last_poll < g_es_poll_seconds)
      return;

   EASync_Run();
}

//+------------------------------------------------------------------+
//| Public: call from OnTradeTransaction() the instant a position    |
//| opens, modifies, or closes. Previously every trade event waited  |
//| out the full g_es_poll_seconds gate before its effect reached    |
//| the dashboard at all, on top of whatever delay                   |
//| the dashboard's own poll/Realtime layer added on the way out —   |
//| together explaining the ~1 minute lag reported live. This runs   |
//| EASync_Run() immediately, bypassing the gate, so a trade event   |
//| reaches Supabase on this exact tick instead of the next timer.   |
//+------------------------------------------------------------------+
void EASync_ForceSync()
{
   if(g_es_base_url == "" || g_es_api_key == "")
      return; // EASync_Init() was never called — nothing to do.

   EASync_Run();
}

//+------------------------------------------------------------------+
//| ISO 8601 UTC timestamp helper (positions/close times are reported |
//| in the terminal's own time; MT5 servers are UTC-based by default  |
//| on virtually every broker's demo/live infra, matching what        |
//| ea-sync expects — see README for the (rare) offset-server caveat).|
//+------------------------------------------------------------------+
string EASync_ToIso8601(const datetime t)
{
   string s = TimeToString(t, TIME_DATE | TIME_SECONDS); // "YYYY.MM.DD HH:MM:SS"
   StringReplace(s, ".", "-");
   StringReplace(s, " ", "T");
   return s + "Z";
}

string EASync_JsonEscape(const string s)
{
   string out = s;
   StringReplace(out, "\\", "\\\\");
   StringReplace(out, "\"", "\\\"");
   StringReplace(out, "\n", " ");
   StringReplace(out, "\r", " ");
   return out;
}

//+------------------------------------------------------------------+
//| One pip in price terms for a symbol, broker-digit-agnostic:        |
//| 3/5-digit ("micro-pip") brokers quote an extra fractional digit,   |
//| so 1 pip = 10 points there; 2/4-digit brokers quote 1 pip = 1 point|
//+------------------------------------------------------------------+
double EASync_PipSize(const string symbol)
{
   int digits = (int)SymbolInfoInteger(symbol, SYMBOL_DIGITS);
   double point = SymbolInfoDouble(symbol, SYMBOL_POINT);
   return (digits == 3 || digits == 5) ? point * 10.0 : point;
}

//+------------------------------------------------------------------+
//| Resolve an absolute SL/TP price from either a direct value or a   |
//| pip distance from the fill/reference price (ea_commands.sl_pips / |
//| tp_pips, migration 016). Returns 0.0 (=no stop) if neither is set.|
//+------------------------------------------------------------------+
double EASync_ResolveStop(const string symbol, const double direct_price,
                           const double pips, const double reference_price,
                           const bool is_buy, const bool is_stop_loss)
{
   double raw = 0.0;
   if(direct_price > 0.0)
   {
      raw = direct_price;
   }
   else if(pips > 0.0)
   {
      double distance = pips * EASync_PipSize(symbol);
      // Buy SL / Sell TP go below the reference price; Buy TP / Sell SL go above it.
      bool below = (is_buy == is_stop_loss);
      double digits_pow = MathPow(10, (int)SymbolInfoInteger(symbol, SYMBOL_DIGITS));
      raw = below ? reference_price - distance : reference_price + distance;
      raw = MathRound(raw * digits_pow) / digits_pow;
   }
   else
   {
      return 0.0;
   }

   // v1.0.14: clamp against the broker's minimum stop distance so a
   // tight-but-otherwise-valid SL/TP (from either an absolute price or a
   // pip distance) never gets rejected outright with "Invalid stops"
   // (retcode 10016 / TRADE_RETCODE_INVALID_STOPS) -- instead it's pushed
   // out to the nearest allowed distance and the trade still executes.
   return EASync_ApplyStopsLevel(symbol, raw, is_stop_loss, is_buy);
}

//+------------------------------------------------------------------+
//| v1.0.14 -- Clamps a computed SL/TP price to the broker's minimum   |
//| distance from the current market price (SYMBOL_TRADE_STOPS_LEVEL   |
//| and SYMBOL_TRADE_FREEZE_LEVEL, both in points; brokers commonly    |
//| enforce these on JPY pairs and low-priced instruments where a      |
//| pip-based sl_pips/tp_pips value can resolve to a distance narrower  |
//| than the broker allows). If the requested stop is already far      |
//| enough away, it is returned unchanged.                             |
//+------------------------------------------------------------------+
double EASync_ApplyStopsLevel(const string symbol, const double stop_price,
                               const bool is_stop_loss, const bool is_buy)
{
   if(stop_price <= 0.0) return stop_price;

   long stops_level  = SymbolInfoInteger(symbol, SYMBOL_TRADE_STOPS_LEVEL);
   long freeze_level = SymbolInfoInteger(symbol, SYMBOL_TRADE_FREEZE_LEVEL);
   long min_points = MathMax(stops_level, freeze_level);
   if(min_points <= 0) return stop_price; // broker enforces no minimum for this symbol

   double point = SymbolInfoDouble(symbol, SYMBOL_POINT);
   double min_distance = min_points * point;

   // Buy stops are validated against Bid, sell stops against Ask -- the
   // standard convention brokers use when checking stop distance.
   double basis = is_buy ? SymbolInfoDouble(symbol, SYMBOL_BID) : SymbolInfoDouble(symbol, SYMBOL_ASK);
   bool below = (is_buy == is_stop_loss); // same direction rule as EASync_ResolveStop above
   double distance = below ? (basis - stop_price) : (stop_price - basis);

   if(distance >= min_distance) return stop_price; // already compliant (or on the correct side with room)

   double digits_pow = MathPow(10, (int)SymbolInfoInteger(symbol, SYMBOL_DIGITS));
   double clamped = below ? basis - min_distance : basis + min_distance;
   double result = MathRound(clamped * digits_pow) / digits_pow;
   PrintFormat("EASync: stop clamped for %s (was %.5f, min_distance=%.5f points=%d, now %.5f)",
               symbol, stop_price, min_distance, (int)min_points, result);
   return result;
}

//+------------------------------------------------------------------+
//| v1.0.14 -- AutoTrading preflight. Covers both the terminal-level   |
//| "AutoTrading" toggle (top toolbar) and the per-EA "Allow live      |
//| trading" checkbox -- either being off makes OrderSend() fail with  |
//| retcode 10027 / error 4752, which previously surfaced as an opaque |
//| order_send_failed with no distinct signal for the dashboard to     |
//| show a clear banner for. Checked before every trade attempt so the |
//| failure reason is unambiguous and no wasted round trip is spent.   |
//+------------------------------------------------------------------+
bool EASync_TradingAllowed()
{
   return TerminalInfoInteger(TERMINAL_TRADE_ALLOWED) != 0 && MQLInfoInteger(MQL_TRADE_ALLOWED) != 0;
}

//+------------------------------------------------------------------+
//| v1.0.14 -- THE root-cause fix for "only EURUSD works". A symbol   |
//| the EA's own chart is already sitting on (or one the terminal      |
//| happened to already have subscribed) has a live tick cached and    |
//| SymbolInfoDouble() returns immediately. Any OTHER symbol -- exactly |
//| the case for every pair besides the one on the active chart --      |
//| gets added to Market Watch by SymbolSelect() but the broker hasn't  |
//| pushed a first tick yet, so SymbolInfoDouble(SYMBOL_BID/ASK) reads  |
//| back 0.0 on the very next line. That zero price flows straight into|
//| request.price (and, via EASync_ResolveStop, into a garbage SL/TP    |
//| computed off a 0 reference), which the broker then rejects --       |
//| appearing to the user as "only EURUSD works, everything else fails".|
//| Fix: after selecting the symbol, poll for an actual non-zero        |
//| Bid/Ask for up to ~1s (ticks normally arrive within tens of ms) --   |
//| the short blocking Sleep() here is fine because this runs on the    |
//| already-explicitly-blocking command-execution path (same rationale |
//| as the existing WebRequest-from-timer-not-OnTick design), not       |
//| OnTick(). One active EA on one chart can now open positions on any  |
//| bound symbol, not just the chart's own.                             |
//+------------------------------------------------------------------+
bool EASync_EnsureSymbolReady(const string symbol)
{
   if(!SymbolSelect(symbol, true)) return false;

   for(int attempt = 0; attempt < 20; attempt++) // 20 x 50ms = up to 1s
   {
      double bid = SymbolInfoDouble(symbol, SYMBOL_BID);
      double ask = SymbolInfoDouble(symbol, SYMBOL_ASK);
      if(bid > 0.0 && ask > 0.0) return true;
      Sleep(50);
   }

   PrintFormat("EASync: symbol %s selected but no live quote arrived after 1s -- rejecting open", symbol);
   return false;
}

//+------------------------------------------------------------------+
//| Resolve the best-guess order filling mode for a symbol from its   |
//| broker-reported SYMBOL_FILLING_MODE bitmask. Fixes v1.0.12 and     |
//| earlier hardcoding ORDER_FILLING_FOK unconditionally, which fails  |
//| with "Unsupported filling mode" (TRADE_RETCODE_INVALID_FILL=10030) |
//| on any broker/symbol that doesn't support FOK -- the majority of   |
//| retail FX/CFD brokers only support IOC or market-execution Return. |
//+------------------------------------------------------------------+
ENUM_ORDER_TYPE_FILLING EASync_ResolveFillingMode(const string symbol)
{
   int flags = (int)SymbolInfoInteger(symbol, SYMBOL_FILLING_MODE);
   if((flags & SYMBOL_FILLING_FOK) != 0)
      return ORDER_FILLING_FOK;
   if((flags & SYMBOL_FILLING_IOC) != 0)
      return ORDER_FILLING_IOC;
   // Neither bit set (some brokers report 0/empty here) -- Return is the
   // universal fallback for market-execution accounts and is accepted
   // wherever FOK/IOC are not.
   return ORDER_FILLING_RETURN;
}

//+------------------------------------------------------------------+
//| Sends a trade request, auto-detecting the filling mode from the   |
//| symbol's SYMBOL_FILLING_MODE flags. If the broker still rejects it |
//| with TRADE_RETCODE_INVALID_FILL (some brokers misreport their own  |
//| flags), retries with each of the other two modes in turn before    |
//| giving up -- so a broker whose reported flags are wrong still gets |
//| a working order instead of a permanent "unsupported filling mode". |
//| request.type_filling is overwritten on every attempt; set every    |
//| other field before calling this.                                   |
//+------------------------------------------------------------------+
bool EASync_SendOrderWithFillingFallback(MqlTradeRequest &request, MqlTradeResult &result)
{
   ENUM_ORDER_TYPE_FILLING all_modes[3] = {ORDER_FILLING_FOK, ORDER_FILLING_IOC, ORDER_FILLING_RETURN};
   ENUM_ORDER_TYPE_FILLING guess = EASync_ResolveFillingMode(request.symbol);
   ENUM_ORDER_TYPE_FILLING attempts[3];
   int attempt_count = 0;
   attempts[attempt_count++] = guess;
   for(int m = 0; m < 3; m++)
      if(all_modes[m] != guess)
         attempts[attempt_count++] = all_modes[m];

   for(int i = 0; i < attempt_count; i++)
   {
      request.type_filling = attempts[i];
      ResetLastError();
      bool sent = OrderSend(request, result);
      bool ok = sent && (result.retcode == TRADE_RETCODE_DONE || result.retcode == TRADE_RETCODE_DONE_PARTIAL);
      if(ok)
         return true;

      if(result.retcode != TRADE_RETCODE_INVALID_FILL)
         return false; // a different failure (no money, market closed, etc.) -- don't mask it by retrying

      PrintFormat("EASync: filling mode %d rejected for %s (retcode=%d), trying next mode",
                  (int)attempts[i], request.symbol, result.retcode);
   }
   return false; // exhausted all three modes, still TRADE_RETCODE_INVALID_FILL
}

//+------------------------------------------------------------------+
//| Queue a command result to be flushed on the next poll request.    |
//+------------------------------------------------------------------+
void EASync_QueueResult(const string json)
{
   if(g_es_pending_results_count >= ArraySize(g_es_pending_results))
      ArrayResize(g_es_pending_results, g_es_pending_results_count + 16);
   g_es_pending_results[g_es_pending_results_count] = json;
   g_es_pending_results_count++;
}

void EASync_QueueAcknowledged(const string ea_command_id)
{
   EASync_QueueResult("{\"ea_command_id\":\"" + ea_command_id + "\",\"status\":\"acknowledged\"}");
}

void EASync_QueueFailed(const string ea_command_id, const string error_message)
{
   EASync_QueueResult(
      "{\"ea_command_id\":\"" + ea_command_id + "\","
      "\"status\":\"failed\","
      "\"error_message\":\"" + EASync_JsonEscape(error_message) + "\"}");
}

void EASync_QueueExecutedOpen(const string ea_command_id, const long ticket)
{
   EASync_QueueResult(
      "{\"ea_command_id\":\"" + ea_command_id + "\","
      "\"status\":\"executed\","
      "\"mt5_ticket\":" + IntegerToString(ticket) + "}");
}

void EASync_QueueExecutedModify(const string ea_command_id, const long ticket)
{
   EASync_QueueResult(
      "{\"ea_command_id\":\"" + ea_command_id + "\","
      "\"status\":\"executed\","
      "\"mt5_ticket\":" + IntegerToString(ticket) + "}");
}

void EASync_QueueExecutedClose(const string ea_command_id, const long ticket,
                                const double close_price, const double profit,
                                const double commission, const double swap, const double fee,
                                const double r_multiple, const bool has_r)
{
   string s =
      "{\"ea_command_id\":\"" + ea_command_id + "\","
      "\"status\":\"executed\","
      "\"mt5_ticket\":" + IntegerToString(ticket) + ","
      "\"close_price\":" + DoubleToString(close_price, 5) + ","
      "\"profit\":" + DoubleToString(profit, 2) + ","
      "\"commission\":" + DoubleToString(commission, 2) + ","
      "\"swap\":" + DoubleToString(swap, 2) + ","
      "\"fee\":" + DoubleToString(fee, 2) + ","
      "\"net_profit\":" + DoubleToString(profit + commission + swap + fee, 2) + ","
      "\"r_multiple\":" + (has_r ? DoubleToString(r_multiple, 4) : "null") + ","
      "\"close_time\":\"" + EASync_ToIso8601(TimeCurrent()) + "\"}";
   EASync_QueueResult(s);
}

//+------------------------------------------------------------------+
//| Find an open position by MT5 ticket. Returns true and selects it  |
//| via PositionSelectByTicket() on success.                          |
//+------------------------------------------------------------------+
bool EASync_SelectPositionByTicket(const long ticket)
{
   return PositionSelectByTicket(ticket);
}

//+------------------------------------------------------------------+
//| Returns a compact, deterministic per-command trade tag. The 80-bit |
//| prefix is short enough to survive historic broker comment limits.  |
//+------------------------------------------------------------------+
string EASync_CommandTradeTag(const string ea_command_id)
{
   string compact_id = ea_command_id;
   StringReplace(compact_id, "-", "");
   StringToLower(compact_id);
   return StringSubstr(compact_id, 0, 20);
}

//+------------------------------------------------------------------+
//| Idempotency guard: compact `lh:<tag>` prefix is the current form. |
//| Retain the legacy lookup so an EA update cannot duplicate an order |
//| placed by an older build that used the full UUID comment.          |
//+------------------------------------------------------------------+
long EASync_FindPositionByCommandComment(const string ea_command_id)
{
   string compact_wanted = "lh:" + EASync_CommandTradeTag(ea_command_id);
   string legacy_wanted = "lucrehub:" + ea_command_id;
   int total = PositionsTotal();
   for(int i = 0; i < total; i++)
   {
      ulong ticket = PositionGetTicket(i);
      if(ticket == 0) continue;
      string comment = PositionGetString(POSITION_COMMENT);
      if(StringFind(comment, compact_wanted) == 0 || StringFind(comment, legacy_wanted) == 0)
         return (long)ticket;
   }
   return 0;
}

//+------------------------------------------------------------------+
//| Reject volume outside the broker's range/step and above Lucre's   |
//| terminal-side absolute lot ceiling. Never round a server command: |
//| a different size would violate the requested risk calculation.    |
//+------------------------------------------------------------------+
bool EASync_ValidateOpenVolume(const string symbol, const double volume, string &reason)
{
   double min_volume = SymbolInfoDouble(symbol, SYMBOL_VOLUME_MIN);
   double max_volume = SymbolInfoDouble(symbol, SYMBOL_VOLUME_MAX);
   double volume_step = SymbolInfoDouble(symbol, SYMBOL_VOLUME_STEP);
   if(volume <= 0.0 || min_volume <= 0.0 || max_volume < min_volume || volume_step <= 0.0)
   {
      reason = "invalid_broker_volume_constraints";
      return false;
   }
   if(volume > LUCRE_HARD_MAX_VOLUME_PER_ORDER)
   {
      reason = "hard_max_volume_per_order_exceeded";
      return false;
   }
   if(volume < min_volume || volume > max_volume)
   {
      reason = "broker_volume_range_exceeded";
      return false;
   }
   double steps = (volume - min_volume) / volume_step;
   if(MathAbs(steps - MathRound(steps)) > 0.000001)
   {
      reason = "broker_volume_step_mismatch";
      return false;
   }
   return true;
}

//+------------------------------------------------------------------+
//| Verify an opening command has a protective stop and a bounded USD |
//| loss at that stop using the broker's own profit calculation.      |
//+------------------------------------------------------------------+
bool EASync_ValidateOpenRisk(const string symbol, const bool is_buy, const double volume,
                             const double entry_price, const double stop_loss, string &reason)
{
   if(stop_loss <= 0.0)
   {
      reason = "hard_stop_loss_required";
      return false;
   }
   if((is_buy && stop_loss >= entry_price) || (!is_buy && stop_loss <= entry_price))
   {
      reason = "invalid_stop_loss_direction";
      return false;
   }
   double estimated_profit = 0.0;
   ENUM_ORDER_TYPE order_type = is_buy ? ORDER_TYPE_BUY : ORDER_TYPE_SELL;
   if(!OrderCalcProfit(order_type, symbol, volume, entry_price, stop_loss, estimated_profit))
   {
      reason = "risk_calculation_failed";
      return false;
   }
   double risk_usd = MathAbs(estimated_profit);
   if(risk_usd <= 0.0 || risk_usd > LUCRE_HARD_MAX_RISK_PER_TRADE_USD)
   {
      reason = "hard_max_risk_per_trade_exceeded";
      return false;
   }
   return true;
}

//+------------------------------------------------------------------+
//| Convert a percentage-of-balance risk budget into a broker-valid  |
//| volume using the actual entry and protective stop. The command's |
//| volume remains an upper bound. Volume is always rounded DOWN, so  |
//| broker normalization can never silently increase intended risk.  |
//+------------------------------------------------------------------+
bool EASync_RiskSizedVolume(const string symbol, const bool is_buy,
                            const double entry_price, const double stop_loss,
                            const double risk_percent, const double max_volume,
                            double &sized_volume, string &reason)
{
   if(risk_percent <= 0.0)
   {
      sized_volume = max_volume;
      return true;
   }
   if(stop_loss <= 0.0 || max_volume <= 0.0)
   {
      reason = "risk_sizing_requires_stop_and_volume_cap";
      return false;
   }

   double one_lot_profit = 0.0;
   ENUM_ORDER_TYPE order_type = is_buy ? ORDER_TYPE_BUY : ORDER_TYPE_SELL;
   if(!OrderCalcProfit(order_type, symbol, 1.0, entry_price, stop_loss, one_lot_profit))
   {
      reason = "risk_calculation_failed";
      return false;
   }
   double risk_per_lot = MathAbs(one_lot_profit);
   double risk_budget = AccountInfoDouble(ACCOUNT_BALANCE) * risk_percent / 100.0;
   if(risk_per_lot <= 0.0 || risk_budget <= 0.0)
   {
      reason = "risk_calculation_failed";
      return false;
   }

   double min_volume = SymbolInfoDouble(symbol, SYMBOL_VOLUME_MIN);
   double broker_max = SymbolInfoDouble(symbol, SYMBOL_VOLUME_MAX);
   double volume_step = SymbolInfoDouble(symbol, SYMBOL_VOLUME_STEP);
   double raw_volume = risk_budget / risk_per_lot;
   double capped_volume = MathMin(raw_volume, MathMin(max_volume,
                                  MathMin(broker_max, LUCRE_HARD_MAX_VOLUME_PER_ORDER)));
   if(min_volume <= 0.0 || volume_step <= 0.0 || capped_volume + 0.000000001 < min_volume)
   {
      reason = "risk_budget_below_min_volume";
      return false;
   }

   double steps = MathFloor((capped_volume - min_volume + 0.000000001) / volume_step);
   sized_volume = NormalizeDouble(min_volume + steps * volume_step, 8);
   if(sized_volume < min_volume || sized_volume <= 0.0)
   {
      reason = "risk_budget_below_min_volume";
      return false;
   }
   return true;
}

//+------------------------------------------------------------------+
//| Executes one 'open'/'hedge_open' command: market order.           |
//| hedge_open runs the identical path as open — see file header for  |
//| why (backend doesn't yet accept basket tagging on the report).    |
//| strategy_id (v1.0.10) is tracked in-memory against the resulting   |
//| ticket so position reports can carry it forward (see globals).     |
//+------------------------------------------------------------------+
void EASync_ExecuteOpen(const string ea_command_id, const string symbol, const string side,
                         const double volume, const double sl, const double tp,
                         const double sl_pips, const double tp_pips, const int max_deviation,
                         const string strategy_id, const string source, const double risk_percent)
{
   // Idempotency guard (gap #2 fix): if a position tagged with this exact
   // command's comment already exists, this command was already executed —
   // most likely re-queued by sweep_stuck_commands() after its original
   // 'executed' result never made it back to ea-sync. Re-report success
   // instead of placing a duplicate order.
   long existing_ticket = EASync_FindPositionByCommandComment(ea_command_id);
   if(existing_ticket != 0)
   {
      EASync_TrackStrategyForTicket(existing_ticket, strategy_id);
      EASync_QueueExecutedOpen(ea_command_id, existing_ticket);
      PrintFormat("EASync: duplicate open suppressed, ticket=%I64d already tagged for command=%s",
                  existing_ticket, ea_command_id);
      return;
   }

   if(!EASync_TradingAllowed())
   {
      EASync_QueueFailed(ea_command_id, "autotrading_disabled");
      PrintFormat("EASync: AutoTrading is OFF (terminal toolbar or this EA's Allow-live-trading checkbox) -- rejected open command=%s", ea_command_id);
      return;
   }

   if(symbol == "" || volume <= 0.0 || (side != "buy" && side != "sell"))
   {
      EASync_QueueFailed(ea_command_id, "invalid_command_parameters");
      return;
   }

   if(!EASync_EnsureSymbolReady(symbol))
   {
      EASync_QueueFailed(ea_command_id, "symbol_not_available_or_no_quote:" + symbol);
      return;
   }

   string safety_reason = "";
   if(PositionsTotal() >= LUCRE_HARD_MAX_OPEN_POSITIONS)
   {
      EASync_QueueFailed(ea_command_id, "hard_max_open_positions_reached");
      return;
   }

   bool is_buy = (side == "buy");
   MqlTradeRequest request;
   MqlTradeResult  result;
   ZeroMemory(request);
   ZeroMemory(result);

   double price = is_buy ? SymbolInfoDouble(symbol, SYMBOL_ASK) : SymbolInfoDouble(symbol, SYMBOL_BID);

   double resolved_sl = EASync_ResolveStop(symbol, sl, sl_pips, price, is_buy, true);
   double resolved_tp = EASync_ResolveStop(symbol, tp, tp_pips, price, is_buy, false);
   double actual_volume = volume;
   if(!EASync_RiskSizedVolume(symbol, is_buy, price, resolved_sl, risk_percent, volume, actual_volume, safety_reason)
      || !EASync_ValidateOpenVolume(symbol, actual_volume, safety_reason))
   {
      EASync_QueueFailed(ea_command_id, safety_reason);
      return;
   }

   request.action       = TRADE_ACTION_DEAL;
   request.symbol       = symbol;
   request.volume       = actual_volume;
   request.type         = is_buy ? ORDER_TYPE_BUY : ORDER_TYPE_SELL;
   request.price        = price;
   request.deviation    = max_deviation;
   request.magic        = g_es_magic;
   request.comment      = "lh:" + EASync_CommandTradeTag(ea_command_id);
   // type_filling is set per-attempt inside EASync_SendOrderWithFillingFallback().

   // Discretionary dashboard orders may be intentionally stopless. They still
   // obey MT5/broker volume, quote, margin and AutoTrading constraints above;
   // automated strategy orders retain the mandatory-stop/risk ceiling.
   if(source != "manual_order" && !EASync_ValidateOpenRisk(symbol, is_buy, actual_volume, price, resolved_sl, safety_reason))
   {
      EASync_QueueFailed(ea_command_id, safety_reason);
      return;
   }
   if(resolved_sl > 0.0) request.sl = resolved_sl;
   if(resolved_tp > 0.0) request.tp = resolved_tp;

   if(!EASync_SendOrderWithFillingFallback(request, result))
   {
      EASync_QueueFailed(ea_command_id,
         StringFormat("order_send_failed:retcode=%d,error=%d,comment=%s", result.retcode, GetLastError(), result.comment));
      return;
   }

   EASync_TrackStrategyForTicket(result.order, strategy_id);
   EASync_QueueExecutedOpen(ea_command_id, result.order);
   PrintFormat("EASync: opened %s %.2f %s (risk %.3f%%, cap %.2f), ticket=%I64d, command=%s",
               side, actual_volume, symbol, risk_percent, volume, result.order, ea_command_id);
}

//+------------------------------------------------------------------+
//| Executes one 'modify'/'modify_sl_tp' command: change SL/TP on an  |
//| existing position, leaving volume/direction untouched.            |
//+------------------------------------------------------------------+
void EASync_ExecuteModify(const string ea_command_id, const long ticket,
                           const double sl, const double tp,
                           const double sl_pips, const double tp_pips)
{
   if(!EASync_TradingAllowed())
   {
      EASync_QueueFailed(ea_command_id, "autotrading_disabled");
      PrintFormat("EASync: AutoTrading is OFF -- rejected modify command=%s", ea_command_id);
      return;
   }

   if(ticket <= 0 || !EASync_SelectPositionByTicket(ticket))
   {
      EASync_QueueFailed(ea_command_id, "position_not_found:" + IntegerToString(ticket));
      return;
   }

   string symbol      = PositionGetString(POSITION_SYMBOL);
   bool   is_buy       = (PositionGetInteger(POSITION_TYPE) == POSITION_TYPE_BUY);
   double open_price   = PositionGetDouble(POSITION_PRICE_OPEN);
   double current_sl   = PositionGetDouble(POSITION_SL);
   double current_tp   = PositionGetDouble(POSITION_TP);

   double new_sl = EASync_ResolveStop(symbol, sl, sl_pips, open_price, is_buy, true);
   double new_tp = EASync_ResolveStop(symbol, tp, tp_pips, open_price, is_buy, false);
   if(new_sl <= 0.0) new_sl = current_sl; // not being changed — keep existing
   if(new_tp <= 0.0) new_tp = current_tp;

   MqlTradeRequest request;
   MqlTradeResult  result;
   ZeroMemory(request);
   ZeroMemory(result);
   request.action   = TRADE_ACTION_SLTP;
   request.symbol   = symbol;
   request.position = ticket;
   request.sl       = new_sl;
   request.tp       = new_tp;

   ResetLastError();
   if(!OrderSend(request, result) || (result.retcode != TRADE_RETCODE_DONE && result.retcode != TRADE_RETCODE_DONE_PARTIAL))
   {
      EASync_QueueFailed(ea_command_id,
         StringFormat("modify_failed:retcode=%d,error=%d,comment=%s", result.retcode, GetLastError(), result.comment));
      return;
   }

   EASync_QueueExecutedModify(ea_command_id, ticket);
   PrintFormat("EASync: modified ticket=%I64d sl=%.5f tp=%.5f, command=%s", ticket, new_sl, new_tp, ea_command_id);
}

//+------------------------------------------------------------------+
//| Executes one 'close' command: full close of one position.         |
//| r_multiple is an approximation: risk distance is taken from the   |
//| position's SL *at the moment of close* (its original risk if never|
//| modified, or its trailed/break-even risk otherwise) — there is no  |
//| stored "initial SL" anywhere in this schema to compute a purer R.  |
//+------------------------------------------------------------------+
void EASync_ExecuteClose(const string ea_command_id, const long ticket)
{
   if(!EASync_TradingAllowed())
   {
      EASync_QueueFailed(ea_command_id, "autotrading_disabled");
      PrintFormat("EASync: AutoTrading is OFF -- rejected close command=%s", ea_command_id);
      return;
   }

   if(ticket <= 0 || !EASync_SelectPositionByTicket(ticket))
   {
      EASync_QueueFailed(ea_command_id, "position_not_found:" + IntegerToString(ticket));
      return;
   }

   string symbol     = PositionGetString(POSITION_SYMBOL);
   double volume     = PositionGetDouble(POSITION_VOLUME);
   bool   is_buy      = (PositionGetInteger(POSITION_TYPE) == POSITION_TYPE_BUY);
   double open_price  = PositionGetDouble(POSITION_PRICE_OPEN);
   double sl_at_close = PositionGetDouble(POSITION_SL);

   MqlTradeRequest request;
   MqlTradeResult  result;
   ZeroMemory(request);
   ZeroMemory(result);

   double close_price = is_buy ? SymbolInfoDouble(symbol, SYMBOL_BID) : SymbolInfoDouble(symbol, SYMBOL_ASK);

   request.action       = TRADE_ACTION_DEAL;
   request.symbol       = symbol;
   request.volume       = volume;
   request.position     = ticket;
   request.type         = is_buy ? ORDER_TYPE_SELL : ORDER_TYPE_BUY; // opposite side closes
   request.price        = close_price;
   request.deviation    = 20;
   request.magic        = g_es_magic;
   // type_filling is set per-attempt inside EASync_SendOrderWithFillingFallback().

   if(!EASync_SendOrderWithFillingFallback(request, result))
   {
      EASync_QueueFailed(ea_command_id,
         StringFormat("close_failed:retcode=%d,error=%d,comment=%s", result.retcode, GetLastError(), result.comment));
      return;
   }

   // v1.0.17 -- BUG FIX: HistoryDealGetDouble() only returns valid data once the
   // target deal has been selected into the history cache via HistoryDealSelect()
   // (or an encompassing HistorySelect()). Previously this read DEAL_PROFIT/
   // DEAL_SWAP/DEAL_COMMISSION with no selection at all, which silently returned
   // 0.0 for every field every time -- so every dashboard-initiated close reported
   // profit=0 regardless of the real P&L, which is why R:R/Win Ratio/P&L on the
   // dashboard showed 0/no data despite real, sometimes-winning trades. Select the
   // just-created deal by ticket first; if the terminal hasn't flushed it into the
   // history cache yet (rare timing edge case right after OrderSend), fall back to
   // a small HistorySelect() window and retry once before giving up.
   if(!HistoryDealSelect(result.deal))
   {
      HistorySelect(TimeCurrent() - 60, TimeCurrent() + 60);
      HistoryDealSelect(result.deal);
   }

   double profit = HistoryDealGetDouble(result.deal, DEAL_PROFIT);
   double commission = HistoryDealGetDouble(result.deal, DEAL_COMMISSION);
   double swap = HistoryDealGetDouble(result.deal, DEAL_SWAP);
   double fee = HistoryDealGetDouble(result.deal, DEAL_FEE);
   double net_profit = profit + commission + swap + fee;

   bool has_r = (sl_at_close > 0.0);
   double r_multiple = 0.0;
   if(has_r)
   {
      double risk_distance = MathAbs(open_price - sl_at_close);
      double tick_value = SymbolInfoDouble(symbol, SYMBOL_TRADE_TICK_VALUE);
      double tick_size  = SymbolInfoDouble(symbol, SYMBOL_TRADE_TICK_SIZE);
      double risk_amount = (tick_size > 0.0) ? (risk_distance / tick_size) * tick_value * volume : 0.0;
      has_r = (risk_amount > 0.0);
      if(has_r) r_multiple = net_profit / risk_amount;
   }

   EASync_UntrackTicket(ticket);
   EASync_QueueExecutedClose(ea_command_id, ticket, result.price > 0 ? result.price : close_price,
                             profit, commission, swap, fee, r_multiple, has_r);
   PrintFormat("EASync: closed ticket=%I64d profit=%.2f net=%.2f, command=%s", ticket, profit, net_profit, ea_command_id);
}

//+------------------------------------------------------------------+
//| Executes 'flatten_basket': close every currently open position on |
//| this terminal (see file header re: one-basket-per-terminal today).|
//+------------------------------------------------------------------+
void EASync_ExecuteFlattenBasket(const string ea_command_id)
{
   if(!EASync_TradingAllowed())
   {
      EASync_QueueFailed(ea_command_id, "autotrading_disabled");
      PrintFormat("EASync: AutoTrading is OFF -- rejected flatten_basket command=%s", ea_command_id);
      return;
   }

   int total = PositionsTotal();
   int closed = 0, failed = 0;

   for(int i = total - 1; i >= 0; i--)
   {
      ulong ticket = PositionGetTicket(i);
      if(ticket == 0) continue;

      string symbol    = PositionGetString(POSITION_SYMBOL);
      double volume    = PositionGetDouble(POSITION_VOLUME);
      bool   is_buy    = (PositionGetInteger(POSITION_TYPE) == POSITION_TYPE_BUY);
      double close_px  = is_buy ? SymbolInfoDouble(symbol, SYMBOL_BID) : SymbolInfoDouble(symbol, SYMBOL_ASK);

      MqlTradeRequest request;
      MqlTradeResult  result;
      ZeroMemory(request);
      ZeroMemory(result);
      request.action       = TRADE_ACTION_DEAL;
      request.symbol       = symbol;
      request.volume       = volume;
      request.position     = ticket;
      request.type         = is_buy ? ORDER_TYPE_SELL : ORDER_TYPE_BUY;
      request.price        = close_px;
      request.deviation    = 20;
      request.magic        = g_es_magic;
      // type_filling is set per-attempt inside EASync_SendOrderWithFillingFallback().

      if(EASync_SendOrderWithFillingFallback(request, result))
      {
         EASync_UntrackTicket((long)ticket);
         closed++;
      }
      else
         failed++;
   }

   if(failed == 0)
      EASync_QueueResult("{\"ea_command_id\":\"" + ea_command_id + "\",\"status\":\"executed\"}");
   else
      EASync_QueueFailed(ea_command_id, StringFormat("flatten_partial:closed=%d,failed=%d", closed, failed));

   PrintFormat("EASync: flatten_basket closed=%d failed=%d, command=%s", closed, failed, ea_command_id);
}

//+------------------------------------------------------------------+
//| Dispatches one pending command by command_type. Called once per   |
//| element of the pending_commands array returned by ea-sync.        |
//+------------------------------------------------------------------+
void EASync_ExecuteCommand(const string id, const string command_type, const string symbol,
                           const string side, const double volume, const double sl, const double tp,
                           const long mt5_ticket, const int max_deviation,
                           const double sl_pips, const double tp_pips, const string strategy_id,
                           const string source, const double risk_percent)
{
   if(command_type == "open" || command_type == "hedge_open")
      EASync_ExecuteOpen(id, symbol, side, volume, sl, tp, sl_pips, tp_pips, max_deviation, strategy_id, source, risk_percent);
   else if(command_type == "modify" || command_type == "modify_sl_tp")
      EASync_ExecuteModify(id, mt5_ticket, sl, tp, sl_pips, tp_pips);
   else if(command_type == "close")
      EASync_ExecuteClose(id, mt5_ticket);
   else if(command_type == "flatten_basket")
      EASync_ExecuteFlattenBasket(id);
   else
      EASync_QueueFailed(id, "unknown_command_type:" + command_type);
}

//+------------------------------------------------------------------+
//| Very small hand-rolled JSON reader: extracts the value of one key |
//| from a flat (or one-level-nested-object) JSON object substring    |
//| between [obj_start, obj_end). Good enough for ea_commands rows,    |
//| which are flat except for null/number/string/bool leaves.         |
//| Returns "" if the key is absent (caller treats that as null/0).   |
//+------------------------------------------------------------------+
string EASync_JsonGetRaw(const string json, const int obj_start, const int obj_end, const string key)
{
   string needle = "\"" + key + "\":";
   int search_from = obj_start;
   int pos = StringFind(json, needle, search_from);
   if(pos < 0 || pos >= obj_end) return "";

   int value_start = pos + StringLen(needle);
   // Skip leading whitespace.
   while(value_start < obj_end && StringGetCharacter(json, value_start) == ' ') value_start++;

   int c = StringGetCharacter(json, value_start);
   if(c == '"') // string value
   {
      int end = value_start + 1;
      while(end < obj_end)
      {
         int ch = StringGetCharacter(json, end);
         if(ch == '\\') { end += 2; continue; }
         if(ch == '"') break;
         end++;
      }
      return StringSubstr(json, value_start + 1, end - value_start - 1);
   }

   // number / bool / null — read until , or } at this nesting level.
   int end = value_start;
   int depth = 0;
   while(end < obj_end)
   {
      int ch = StringGetCharacter(json, end);
      if(ch == '{' || ch == '[') depth++;
      else if(ch == '}' || ch == ']')
      {
         if(depth == 0) break;
         depth--;
      }
      else if(ch == ',' && depth == 0) break;
      end++;
   }
   string raw = StringSubstr(json, value_start, end - value_start);
   StringTrimLeft(raw);
   StringTrimRight(raw);
   return raw;
}

double EASync_JsonGetNumber(const string json, const int obj_start, const int obj_end, const string key, const double def_value = 0.0)
{
   string raw = EASync_JsonGetRaw(json, obj_start, obj_end, key);
   if(raw == "" || raw == "null") return def_value;
   return StringToDouble(raw);
}

long EASync_JsonGetInt(const string json, const int obj_start, const int obj_end, const string key, const long def_value = 0)
{
   string raw = EASync_JsonGetRaw(json, obj_start, obj_end, key);
   if(raw == "" || raw == "null") return def_value;
   return StringToInteger(raw);
}

//+------------------------------------------------------------------+
//| Splits the top-level "pending_commands":[ ... ] array in the       |
//| ea-sync response into per-object [start,end) index pairs, then     |
//| dispatches each one to EASync_ExecuteCommand().                    |
//+------------------------------------------------------------------+
void EASync_ProcessPendingCommands(const string json)
{
   int arr_key = StringFind(json, "\"pending_commands\":[");
   if(arr_key < 0) return; // no commands field at all — nothing queued

   int arr_start = arr_key + StringLen("\"pending_commands\":[");
   // Empty array — nothing to do.
   if(StringGetCharacter(json, arr_start) == ']') return;

   int pos = arr_start;
   int json_len = StringLen(json);
   int depth = 0;
   int obj_start = -1;

   while(pos < json_len)
   {
      int ch = StringGetCharacter(json, pos);
      if(ch == '{')
      {
         if(depth == 0) obj_start = pos;
         depth++;
      }
      else if(ch == '}')
      {
         depth--;
         if(depth == 0 && obj_start >= 0)
         {
            int obj_end = pos + 1;
            string id            = EASync_JsonGetRaw(json, obj_start, obj_end, "id");
            string command_type  = EASync_JsonGetRaw(json, obj_start, obj_end, "command_type");
            string symbol        = EASync_JsonGetRaw(json, obj_start, obj_end, "symbol");
            string side          = EASync_JsonGetRaw(json, obj_start, obj_end, "side");
            double volume        = EASync_JsonGetNumber(json, obj_start, obj_end, "volume");
            double sl            = EASync_JsonGetNumber(json, obj_start, obj_end, "sl");
            double tp            = EASync_JsonGetNumber(json, obj_start, obj_end, "tp");
            long   mt5_ticket    = EASync_JsonGetInt(json, obj_start, obj_end, "mt5_ticket");
            long   max_deviation = EASync_JsonGetInt(json, obj_start, obj_end, "max_deviation_points", 20);
            double sl_pips       = EASync_JsonGetNumber(json, obj_start, obj_end, "sl_pips");
            double tp_pips       = EASync_JsonGetNumber(json, obj_start, obj_end, "tp_pips");
            string strategy_id   = EASync_JsonGetRaw(json, obj_start, obj_end, "strategy_id");
            string source        = EASync_JsonGetRaw(json, obj_start, obj_end, "source");
            double risk_percent  = EASync_JsonGetNumber(json, obj_start, obj_end, "risk_percent");

            if(id != "")
            {
               PrintFormat("EASync: executing command id=%s type=%s symbol=%s", id, command_type, symbol);
               EASync_ExecuteCommand(id, command_type, symbol, side, volume, sl, tp,
                                      mt5_ticket, (int)max_deviation, sl_pips, tp_pips, strategy_id, source, risk_percent);
            }
            obj_start = -1;
         }
      }
      // Stop once we've closed the array that opened at arr_start-1.
      else if(ch == ']' && depth == 0)
         break;
      pos++;
   }
}

//+------------------------------------------------------------------+
//| Builds the JSON body: account snapshot + open positions + any      |
//| command_results queued since the last poll.                        |
//+------------------------------------------------------------------+
string EASync_BuildRequestBody()
{
   string account_json =
      "\"account\":{"
      "\"equity\":" + DoubleToString(AccountInfoDouble(ACCOUNT_EQUITY), 2) + ","
      "\"balance\":" + DoubleToString(AccountInfoDouble(ACCOUNT_BALANCE), 2) + ","
      "\"margin_level\":" + DoubleToString(AccountInfoDouble(ACCOUNT_MARGIN_LEVEL), 2) + ","
      "\"account_login\":\"" + IntegerToString((long)AccountInfoInteger(ACCOUNT_LOGIN)) + "\","
      "\"server\":\"" + EASync_JsonEscape(AccountInfoString(ACCOUNT_SERVER)) + "\","
      "\"is_live\":" + (AccountInfoInteger(ACCOUNT_TRADE_MODE) == ACCOUNT_TRADE_MODE_REAL ? "true" : "false") + ","
      "\"ea_version\":\"1.0.31\""
      + "}";

   string positions_json = "\"positions\":[";
   int total = PositionsTotal();
   for(int i = 0; i < total; i++)
   {
      ulong ticket = PositionGetTicket(i);
      if(ticket == 0) continue;
      if(i > 0) positions_json += ",";

      string symbol   = PositionGetString(POSITION_SYMBOL);
      bool   is_buy    = (PositionGetInteger(POSITION_TYPE) == POSITION_TYPE_BUY);
      double sl        = PositionGetDouble(POSITION_SL);
      double tp        = PositionGetDouble(POSITION_TP);
      string strat     = EASync_StrategyForTicket((long)ticket);

      positions_json +=
         "{\"mt5_ticket\":" + IntegerToString((long)ticket) + ","
         "\"symbol\":\"" + EASync_JsonEscape(symbol) + "\","
         "\"side\":\"" + (is_buy ? "buy" : "sell") + "\","
         "\"volume\":" + DoubleToString(PositionGetDouble(POSITION_VOLUME), 2) + ","
         "\"open_price\":" + DoubleToString(PositionGetDouble(POSITION_PRICE_OPEN), 5) + ","
         "\"current_price\":" + DoubleToString(PositionGetDouble(POSITION_PRICE_CURRENT), 5) + ","
         "\"sl\":" + (sl > 0.0 ? DoubleToString(sl, 5) : "null") + ","
         "\"tp\":" + (tp > 0.0 ? DoubleToString(tp, 5) : "null") + ","
         "\"unrealized_pl\":" + DoubleToString(PositionGetDouble(POSITION_PROFIT), 2) + ","
         "\"open_time\":\"" + EASync_ToIso8601((datetime)PositionGetInteger(POSITION_TIME)) + "\","
         "\"strategy_id\":" + (strat != "" ? "\"" + EASync_JsonEscape(strat) + "\"" : "null") +
         "}";
   }
   positions_json += "]";

   string results_json = "\"command_results\":[";
   for(int i = 0; i < g_es_pending_results_count; i++)
   {
      if(i > 0) results_json += ",";
      results_json += g_es_pending_results[i];
   }
   results_json += "]";

   string closed_deals_json = EASync_BuildClosedDealsJson();
   string account_history_json = EASync_BuildAccountHistoryJson();

   return "{" + account_json + "," + positions_json + "," + results_json + "," + closed_deals_json + "," + account_history_json + "}";
}

//+------------------------------------------------------------------+
//| Import the MT5 deal ledger in bounded batches. The first run walks|
//| all available account history 100 deals at a time; once caught up,|
//| a rolling one-hour scan catches new entries cheaply. Upserts make |
//| restarts and the intentional overlap safe.                         |
//+------------------------------------------------------------------+
string EASync_BuildAccountHistoryJson()
{
   datetime now = TimeLocal();
   datetime from = g_es_account_history_initial_sync ? 0 : now - 3600;
   string json = "\"account_history_deals\":[";
   bool first = true;
   int sent = 0;
   ulong newest_ticket = g_es_account_history_last_ticket;

   if(HistorySelect(from, now))
   {
      int total = HistoryDealsTotal();
      for(int i = 0; i < total && sent < 100; i++)
      {
         ulong deal_ticket = HistoryDealGetTicket(i);
         if(deal_ticket == 0) continue;
         if(g_es_account_history_initial_sync && deal_ticket <= g_es_account_history_last_ticket) continue;

         long deal_type = HistoryDealGetInteger(deal_ticket, DEAL_TYPE);
         string side = "null";
         if(deal_type == DEAL_TYPE_BUY) side = "\"buy\"";
         else if(deal_type == DEAL_TYPE_SELL) side = "\"sell\"";

         if(!first) json += ",";
         first = false;
         sent++;
         if(deal_ticket > newest_ticket) newest_ticket = deal_ticket;
         json +=
            "{\"deal_ticket\":" + IntegerToString((long)deal_ticket) + ","
            "\"position_id\":" + IntegerToString((long)HistoryDealGetInteger(deal_ticket, DEAL_POSITION_ID)) + ","
            "\"symbol\":\"" + EASync_JsonEscape(HistoryDealGetString(deal_ticket, DEAL_SYMBOL)) + "\","
            "\"side\":" + side + ","
            "\"entry_type\":" + IntegerToString((long)HistoryDealGetInteger(deal_ticket, DEAL_ENTRY)) + ","
            "\"deal_type\":" + IntegerToString(deal_type) + ","
            "\"volume\":" + DoubleToString(HistoryDealGetDouble(deal_ticket, DEAL_VOLUME), 8) + ","
            "\"price\":" + DoubleToString(HistoryDealGetDouble(deal_ticket, DEAL_PRICE), 8) + ","
            "\"profit\":" + DoubleToString(HistoryDealGetDouble(deal_ticket, DEAL_PROFIT), 2) + ","
            "\"commission\":" + DoubleToString(HistoryDealGetDouble(deal_ticket, DEAL_COMMISSION), 2) + ","
            "\"swap\":" + DoubleToString(HistoryDealGetDouble(deal_ticket, DEAL_SWAP), 2) + ","
            "\"fee\":" + DoubleToString(HistoryDealGetDouble(deal_ticket, DEAL_FEE), 2) + ","
            "\"occurred_at\":\"" + EASync_ToIso8601((datetime)HistoryDealGetInteger(deal_ticket, DEAL_TIME)) + "\","
            "\"magic\":" + IntegerToString((long)HistoryDealGetInteger(deal_ticket, DEAL_MAGIC)) + ","
            "\"comment\":\"" + EASync_JsonEscape(HistoryDealGetString(deal_ticket, DEAL_COMMENT)) + "\"}";
      }
   }
   if(g_es_account_history_initial_sync)
   {
      g_es_account_history_last_ticket = newest_ticket;
      if(sent < 100) g_es_account_history_initial_sync = false;
   }
   return json + "]";
}

//+------------------------------------------------------------------+
//| v1.0.14 -- Scans deal history for closing deals (DEAL_ENTRY_OUT /  |
//| DEAL_ENTRY_OUT_BY) since the last scan and reports them as         |
//| "closed_deals":[...]. This closes the gap where a position closed  |
//| outside the command flow (SL/TP hit, or closed directly in the     |
//| MT5 terminal/mobile app) never appeared in command_results and so   |
//| was never finalized server-side -- it just sat at status='closing' |
//| forever (the ticket-153333 class of bug). Idempotent: the backend   |
//| upserts on (terminal_id, mt5_ticket), so re-reporting the same deal |
//| across overlapping scan windows is safe. Rolling 1-hour lookback   |
//| bounds the per-poll HistorySelect() cost for active scalping        |
//| accounts; a position that sits in 'closing' for over an hour would  |
//| need a wider one-off scan, which is not expected in steady state.  |
//+------------------------------------------------------------------+
string EASync_DealReasonText(const long reason)
{
   if(reason == DEAL_REASON_SL) return "sl";
   if(reason == DEAL_REASON_TP) return "tp";
   if(reason == DEAL_REASON_CLIENT || reason == DEAL_REASON_MOBILE || reason == DEAL_REASON_WEB) return "manual";
   if(reason == DEAL_REASON_EXPERT) return "agent";
   if(reason == DEAL_REASON_SO) return "stop_out";
   if(reason == DEAL_REASON_ROLLOVER) return "rollover";
   return "other";
}

string EASync_BuildClosedDealsJson()
{
   datetime now = TimeCurrent();
   datetime scan_from = (g_es_last_history_scan == 0) ? (now - 3600) : (g_es_last_history_scan - 60);
   if(scan_from < 0) scan_from = 0;

   string json = "\"closed_deals\":[";
   bool first = true;

   if(HistorySelect(scan_from, now))
   {
      int total = HistoryDealsTotal();
      for(int i = 0; i < total; i++)
      {
         ulong deal_ticket = HistoryDealGetTicket(i);
         if(deal_ticket == 0) continue;

         // v1.0.17 -- BUG FIX: this used to require magic == g_es_magic, which
         // silently drops any closing deal whose magic doesn't match this EA
         // instance -- e.g. a position closed manually from the MT5 mobile app or
         // terminal UI, or a broker-side stop-out, both of which can log the
         // closing deal under magic 0 or a different value depending on broker.
         // Those positions would then sit at status='closing' on the dashboard
         // forever (never finalized into trade_history), and the dashboard would
         // report "position is no longer open" if the user tried to act on them.
         // The backend (ea-sync/index.ts step 2.5) already scopes this list down
         // to tickets it is actively tracking as non-closed for this terminal, so
         // it's safe to report every closing deal here and let the backend decide
         // which ones are relevant -- the magic filter added no real safety, only
         // a gap.
         long entry = (long)HistoryDealGetInteger(deal_ticket, DEAL_ENTRY);
         if(entry != DEAL_ENTRY_OUT && entry != DEAL_ENTRY_OUT_BY) continue; // only closing legs

         long position_id = (long)HistoryDealGetInteger(deal_ticket, DEAL_POSITION_ID);
         double close_price = HistoryDealGetDouble(deal_ticket, DEAL_PRICE);
         double deal_profit = HistoryDealGetDouble(deal_ticket, DEAL_PROFIT);
         double deal_commission = HistoryDealGetDouble(deal_ticket, DEAL_COMMISSION);
         double deal_swap = HistoryDealGetDouble(deal_ticket, DEAL_SWAP);
         double deal_fee = HistoryDealGetDouble(deal_ticket, DEAL_FEE);
         datetime close_time = (datetime)HistoryDealGetInteger(deal_ticket, DEAL_TIME);
         string symbol = HistoryDealGetString(deal_ticket, DEAL_SYMBOL);
         string reason = EASync_DealReasonText((long)HistoryDealGetInteger(deal_ticket, DEAL_REASON));

         if(!first) json += ",";
         first = false;
         json +=
            "{\"mt5_ticket\":" + IntegerToString(position_id) + ","
            "\"symbol\":\"" + EASync_JsonEscape(symbol) + "\","
            "\"close_price\":" + DoubleToString(close_price, 5) + ","
            "\"profit\":" + DoubleToString(deal_profit, 2) + ","
            "\"commission\":" + DoubleToString(deal_commission, 2) + ","
            "\"swap\":" + DoubleToString(deal_swap, 2) + ","
            "\"fee\":" + DoubleToString(deal_fee, 2) + ","
            "\"reason\":\"" + reason + "\","
            "\"close_time\":\"" + EASync_ToIso8601(close_time) + "\""
            "}";
      }
   }
   json += "]";

   g_es_last_history_scan = now;
   return json;
}

//+------------------------------------------------------------------+
//| Public: runs one full poll+execute cycle immediately (bypasses    |
//| the interval check). EASync_OnTimer() gates normal periodic calls.|
//+------------------------------------------------------------------+
void EASync_Run()
{
   g_es_last_poll = TimeCurrent();

   string body = EASync_BuildRequestBody();
   string url  = g_es_base_url + "/functions/v1/ea-sync";
   string headers = "Content-Type: application/json\r\nx-api-key: " + g_es_api_key + "\r\n";

   uchar data[];
   int data_len = StringToCharArray(body, data, 0, StringLen(body), CP_UTF8);
   ArrayResize(data, data_len); // drop the trailing null StringToCharArray appends

   uchar result[];
   string result_headers;
   ResetLastError();
   int status = WebRequest("POST", url, headers, 10000, data, result, result_headers);

   if(status == -1)
   {
      int err = GetLastError();
      if(err == 4060)
         PrintFormat("EASync: WebRequest blocked (error 4060) — add %s to Tools > Options > "
                     "Expert Advisors > Allow WebRequest for listed URL.", g_es_base_url);
      else
         PrintFormat("EASync: WebRequest failed, error %d", err);
      return; // pending results stay queued — retried on the next successful poll
   }

   string response = CharArrayToString(result, 0, WHOLE_ARRAY, CP_UTF8);
   g_es_last_response = response; // v1.0.12 — cached for EASync_GetLastResponse()

   if(status != 200)
   {
      PrintFormat("EASync: ea-sync returned HTTP %d: %s", status, response);
      return; // pending results stay queued — retried on the next successful poll
   }

   // Only clear the results buffer once the server has confirmed receipt.
   ArrayResize(g_es_pending_results, 0);
   g_es_pending_results_count = 0;

   EASync_ProcessPendingCommands(response);
}
//+------------------------------------------------------------------+
//============================================================================
// END inlined module: EASync.mqh
//============================================================================

//============================================================================
// BEGIN inlined module: CalendarSync.mqh
// (originally a separate #include file — merged in for single-file
// deployment; MT5 VPS does not reliably sync sibling .mqh files, so
// this build ships as one self-contained .mq5.)
//============================================================================
//+------------------------------------------------------------------+
//|                                              CalendarSync.mqh    |
//|  v1.0.11 — MT5 native Economic Calendar ingestion worker         |
//|                                                                    |
//|  This is the EA-side half of the calendar ingestion worker. There |
//|  is no public HTTP endpoint for MetaTrader's Economic Calendar —  |
//|  it only exists inside a running terminal/EA process via the      |
//|  native MQL5 Calendar API (CalendarValueHistory / CalendarEventById|
//|  / CalendarCountryById, terminal build 2775+). So the EA itself   |
//|  IS the ingestion worker: on a timer, it pulls a rolling window of |
//|  calendar values from the terminal's local calendar cache and     |
//|  pushes them to the calendar-sync Supabase edge function, which   |
//|  upserts them into calendar_events via ingest_calendar_events()   |
//|  (migration 028). This closes the v1.0.7 "known limitation" that  |
//|  nothing ingested currency/forecast/previous/actual.              |
//|                                                                    |
//|  Reuses the SAME x-api-key terminal credential ea-sync already    |
//|  uses (provisioned via provision-terminal-key) — no separate      |
//|  credential to manage.                                            |
//|                                                                    |
//|  INTEGRATION (in your main .mq5 EA file):                         |
//|    #include "CalendarSync.mqh"                                    |
//|                                                                    |
//|    int OnInit() {                                                 |
//|      ...                                                          |
//|      CalendarSync_Init(SupabaseProjectUrl, TerminalApiKey);       |
//|      return INIT_SUCCEEDED;                                       |
//|    }                                                               |
//|                                                                    |
//|    void OnDeinit(const int reason) {                              |
//|      CalendarSync_Deinit();                                        |
//|      ...                                                           |
//|    }                                                                |
//|                                                                     |
//|    void OnTimer() {                                                |
//|      CalendarSync_OnTimer();  // no-op unless the sync interval    |
//|                                // has elapsed; safe to call from    |
//|                                // the same OnTimer() ea-sync uses.  |
//|      ...                                                            |
//|    }                                                                 |
//|                                                                       |
//|  REQUIRED ONE-TIME TERMINAL SETUP (per machine running the EA):      |
//|    Tools > Options > Expert Advisors > "Allow WebRequest for listed  |
//|    URL" and add: https://qxlfnscmrhwfcpattqxa.supabase.co           |
//|    (WebRequest() fails silently with error 4060 otherwise.)          |
//+------------------------------------------------------------------+
//----------------------------------------------------------------------
// Configuration (set via CalendarSync_Init args, not #property input,
// so this .mqh can be shared by every EA variant without redeclaring
// duplicate inputs).
//----------------------------------------------------------------------
string   g_cs_base_url            = "";     // e.g. https://qxlfnscmrhwfcpattqxa.supabase.co
string   g_cs_api_key             = "";     // same key ea-sync uses
int      g_cs_interval_seconds    = 900;    // 15 min — calendar data changes far slower than positions
int      g_cs_window_days_back    = 1;      // catch just-released actuals
int      g_cs_window_days_forward = 14;     // enough runway for Phase 1 pre-news caution to see it coming
int      g_cs_batch_size          = 200;    // events per HTTP POST
datetime g_cs_last_sync           = 0;

//+------------------------------------------------------------------+
//| Public: call once from OnInit()                                  |
//+------------------------------------------------------------------+
void CalendarSync_Init(const string base_url, const string api_key,
                        const int interval_seconds = 900,
                        const int window_days_back = 1,
                        const int window_days_forward = 14)
{
   g_cs_base_url            = base_url;
   g_cs_api_key             = api_key;
   g_cs_interval_seconds    = interval_seconds;
   g_cs_window_days_back    = window_days_back;
   g_cs_window_days_forward = window_days_forward;
   g_cs_last_sync           = 0; // force an immediate first sync on the next OnTimer()/OnInit tick

   // Fire once at startup so calendar_events isn't empty until the first
   // interval elapses — mirrors ea-sync's immediate first heartbeat.
   CalendarSync_Run();
}

//+------------------------------------------------------------------+
//| Public: call once from OnDeinit() — currently a no-op placeholder |
//| kept for symmetry with EventKillTimer() call sites; this module   |
//| does not own the timer itself (the host EA already runs one for   |
//| ea-sync's poll loop), it just piggybacks on OnTimer().            |
//+------------------------------------------------------------------+
void CalendarSync_Deinit()
{
   // Nothing to release: no dedicated timer/handles owned by this module.
}

//+------------------------------------------------------------------+
//| Public: call from OnTimer(). No-op until the configured interval  |
//| has elapsed since the last sync.                                  |
//+------------------------------------------------------------------+
void CalendarSync_OnTimer()
{
   if(g_cs_base_url == "" || g_cs_api_key == "")
      return; // CalendarSync_Init() was never called — nothing to do.

   if(TimeCurrent() - g_cs_last_sync < g_cs_interval_seconds)
      return;

   CalendarSync_Run();
}

//+------------------------------------------------------------------+
//| MQL5 ENUM_CALENDAR_EVENT_IMPORTANCE -> our 3-tier impact.         |
//| Mirrors calendar-sync/index.ts's importanceToImpact() so a human  |
//| reading either side sees the same mapping without cross-checking. |
//+------------------------------------------------------------------+
int CalendarSync_ImportanceToInt(const ENUM_CALENDAR_EVENT_IMPORTANCE imp)
{
   switch(imp)
   {
      case CALENDAR_IMPORTANCE_HIGH:     return 3;
      case CALENDAR_IMPORTANCE_MODERATE: return 2;
      case CALENDAR_IMPORTANCE_LOW:      return 1;
      default:                           return 0; // CALENDAR_IMPORTANCE_NONE
   }
}

//+------------------------------------------------------------------+
//| Minimal JSON string escaper — calendar titles/countries can       |
//| contain quotes or backslashes (rare, but seen in some localized   |
//| event names); this is the only untrusted-ish text going into the  |
//| hand-built JSON payload below.                                    |
//+------------------------------------------------------------------+
string CalendarSync_JsonEscape(const string s)
{
   string out = s;
   StringReplace(out, "\\", "\\\\");
   StringReplace(out, "\"", "\\\"");
   StringReplace(out, "\n", " ");
   StringReplace(out, "\r", " ");
   return out;
}

//+------------------------------------------------------------------+
//| ISO 8601 UTC timestamp for a datetime already in server/UTC time. |
//| MqlCalendarValue.time is in UTC per MQL5 docs (calendar times are |
//| always UTC regardless of terminal server offset).                 |
//+------------------------------------------------------------------+
string CalendarSync_ToIso8601(const datetime t)
{
   return TimeToString(t, TIME_DATE | TIME_SECONDS);
   // TimeToString gives "YYYY.MM.DD HH:MM:SS"; normalize to ISO 8601
   // below via CalendarSync_NormalizeIso() at the call site to avoid a
   // second pass over the string here.
}

string CalendarSync_NormalizeIso(const datetime t)
{
   string s = TimeToString(t, TIME_DATE | TIME_SECONDS); // "YYYY.MM.DD HH:MM:SS"
   StringReplace(s, ".", "-");
   StringReplace(s, " ", "T");
   return s + "Z";
}

//+------------------------------------------------------------------+
//| Builds the JSON body for one batch of calendar values and posts   |
//| it. Returns true on HTTP 200, logs and returns false otherwise.   |
//| Never throws/blocks the EA's main loop on failure — a missed sync |
//| just retries on the next timer tick.                              |
//+------------------------------------------------------------------+
bool CalendarSync_PostBatch(const string &json_events[], const int count)
{
   if(count == 0)
      return true;

   string body = "{\"events\":[";
   for(int i = 0; i < count; i++)
   {
      if(i > 0) body += ",";
      body += json_events[i];
   }
   body += "]}";

   string url = g_cs_base_url + "/functions/v1/calendar-sync";
   string headers = "Content-Type: application/json\r\nx-api-key: " + g_cs_api_key + "\r\n";

   uchar data[];
   int data_len = StringToCharArray(body, data, 0, StringLen(body), CP_UTF8);
   ArrayResize(data, data_len); // drop the trailing null StringToCharArray appends

   uchar result[];
   string result_headers;
   ResetLastError();
   int status = WebRequest("POST", url, headers, 10000, data, result, result_headers);

   if(status == -1)
   {
      int err = GetLastError();
      if(err == 4060)
         PrintFormat("CalendarSync: WebRequest blocked (error 4060) — add %s to Tools > Options > "
                     "Expert Advisors > Allow WebRequest for listed URL.", g_cs_base_url);
      else
         PrintFormat("CalendarSync: WebRequest failed, error %d", err);
      return false;
   }

   if(status != 200)
   {
      PrintFormat("CalendarSync: calendar-sync returned HTTP %d: %s", status, CharArrayToString(result));
      return false;
   }

   return true;
}

//+------------------------------------------------------------------+
//| Public: runs one full pull+push cycle immediately (bypasses the   |
//| interval check — CalendarSync_Init() and manual re-syncs use this |
//| directly; CalendarSync_OnTimer() gates normal periodic calls).    |
//+------------------------------------------------------------------+
void CalendarSync_Run()
{
   g_cs_last_sync = TimeCurrent();

   datetime from = TimeCurrent() - g_cs_window_days_back * 86400;
   datetime to   = TimeCurrent() + g_cs_window_days_forward * 86400;

   MqlCalendarValue values[];
   // NULL country_code + NULL currency = every country/currency the
   // terminal's calendar covers, matching "all economic calendar
   // information available from MetaTrader 5" per the chosen data source.
   int total = CalendarValueHistory(values, from, to, NULL, NULL);
   if(total <= 0)
   {
      PrintFormat("CalendarSync: CalendarValueHistory returned %d rows for window %s .. %s",
                  total, TimeToString(from), TimeToString(to));
      return;
   }

   string batch[];
   ArrayResize(batch, MathMin(total, g_cs_batch_size));
   int batch_count = 0;
   int sent = 0, failed_batches = 0;

   for(int i = 0; i < total; i++)
   {
      MqlCalendarEvent  ev;
      MqlCalendarCountry ctry;
      bool have_event   = CalendarEventById(values[i].event_id, ev);
      bool have_country = have_event && CalendarCountryById(ev.country_id, ctry);

      if(!have_event)
         continue; // orphaned value row (rare) — skip rather than send garbage

      string currency_json = have_country && StringLen(ctry.currency) == 3
                              ? "\"" + ctry.currency + "\""
                              : "null";
      string country_json  = have_country
                              ? "\"" + CalendarSync_JsonEscape(ctry.name) + "\""
                              : "null";

      // MqlCalendarValue's Get*Value() accessors take no arguments -- they
      // decode the raw fixed-point long field and return it as a double (or
      // nan if unset). Presence is checked separately via Has*Value().
      bool has_forecast = values[i].HasForecastValue();
      bool has_prev     = values[i].HasPreviousValue();
      bool has_actual   = values[i].HasActualValue();
      double forecast_val = has_forecast ? values[i].GetForecastValue() : 0.0;
      double prev_val     = has_prev     ? values[i].GetPreviousValue() : 0.0;
      double actual_val   = has_actual   ? values[i].GetActualValue()   : 0.0;

      string event_json =
         "{"
         "\"mql5_value_id\":" + IntegerToString((long)values[i].id) + ","
         "\"mql5_event_id\":" + IntegerToString((long)values[i].event_id) + ","
         "\"event_time\":\"" + CalendarSync_NormalizeIso(values[i].time) + "\","
         "\"country\":" + country_json + ","
         "\"currency\":" + currency_json + ","
         "\"importance\":" + IntegerToString(CalendarSync_ImportanceToInt(ev.importance)) + ","
         "\"title\":\"" + CalendarSync_JsonEscape(ev.name) + "\","
         "\"forecast\":" + (has_forecast ? DoubleToString(forecast_val, 6) : "null") + ","
         "\"previous\":" + (has_prev ? DoubleToString(prev_val, 6) : "null") + ","
         "\"actual\":" + (has_actual ? DoubleToString(actual_val, 6) : "null")
         + "}";

      if(batch_count >= ArraySize(batch))
         ArrayResize(batch, batch_count + g_cs_batch_size);
      batch[batch_count] = event_json;
      batch_count++;

      if(batch_count >= g_cs_batch_size)
      {
         if(CalendarSync_PostBatch(batch, batch_count)) sent += batch_count;
         else failed_batches++;
         batch_count = 0;
      }
   }

   if(batch_count > 0)
   {
      if(CalendarSync_PostBatch(batch, batch_count)) sent += batch_count;
      else failed_batches++;
   }

   PrintFormat("CalendarSync: synced %d/%d calendar values (%d batch failure(s))",
               sent, total, failed_batches);
}
//+------------------------------------------------------------------+
//============================================================================
// END inlined module: CalendarSync.mqh
//============================================================================

//============================================================================
// BEGIN inlined module: EAStream.mqh
// (originally a separate #include file — merged in for single-file
// deployment; MT5 VPS does not reliably sync sibling .mqh files, so
// this build ships as one self-contained .mq5.)
//============================================================================
//+------------------------------------------------------------------+
//|                                                   EAStream.mqh   |
//|  v1.0.24 — Low-latency companion to durable EASync snapshots.    |
//|                                                                    |
//|  This module uses the terminal API key to load a random wake-up     |
//|  topic and opens a terminal-scoped Supabase Realtime Broadcast      |
//|  channel. On command_available it calls EASync_Run() directly,     |
//|  so a freshly-inserted ea_commands row (a new trade signal, a      |
//|  manual order, a hedge, a flatten) is picked up within one round   |
//|  trip instead of waiting for the next fallback reconciliation.     |
//|                                                                    |
//|  Correctness never depends on this channel. It carries command     |
//|  wake-up hints plus ephemeral mark-to-market position fields; the  |
//|  durable reconciliation loop remains authoritative for position    |
//|  identity, status, commands, account history and heartbeats.        |
//|  EASync.mqh's ordinary reconciliation loop remains active          |
//|  regardless of WebSocket state — it is                             |
//|  the source of truth for command execution and heartbeats. If the  |
//|  WebSocket never connects, never authenticates, or drops and       |
//|  can't reconnect, the EA behaves exactly as it did before this     |
//|  module existed. EAStream.mqh makes commands execute sooner and     |
//|  makes displayed prices/P&L fresher, never differently.             |
//|                                                                    |
//|  INTEGRATION (in your main .mq5 EA file, AFTER #include            |
//|  "EASync.mqh" — EAStream_HandleFrame() calls EASync_Run() and      |
//|  MQL5 #include is text-substitution, so EASync_Run() must already  |
//|  be declared above this file's #include line):                     |
//|    #include "EASync.mqh"                                          |
//|    #include "EAStream.mqh"                                        |
//|                                                                    |
//|    int OnInit() {                                                 |
//|      ...                                                           |
//|      if(EnableWebSocketPush)                                       |
//|         EAStream_Init(SupabaseProjectUrl, TerminalApiKey);          |
//|      EventSetTimer(1);                                             |
//|      return(INIT_SUCCEEDED);                                      |
//|    }                                                               |
//|                                                                     |
//|    void OnDeinit(const int reason) {                               |
//|      EAStream_Deinit();                                            |
//|      ...                                                            |
//|    }                                                                |
//|                                                                      |
//|    void OnTimer() {                                                 |
//|      ...                                                             |
//|      EAStream_OnTimer(); // no-op if EnableWebSocketPush was false   |
//|    }                                                                  |
//|                                                                        |
//|  REQUIRED ONE-TIME TERMINAL SETUP: same WebRequest allow-list entry   |
//|  as EASync.mqh (Tools > Options > Expert Advisors > "Allow WebRequest |
//|  for listed URL" -> https://qxlfnscmrhwfcpattqxa.supabase.co) is NOT  |
//|  sufficient for this module — raw sockets are a separate MT5          |
//|  permission. You must ALSO check "Allow WebRequest for listed URL"    |
//|  is on AND enable DLL/socket access is not required (SocketCreate     |
//|  et al. are native MQL5 calls, no extra checkbox), but the terminal    |
//|  must allow the EA to use sockets at all — this is controlled by the   |
//|  same "Allow Algo Trading" + WebRequest allow-list combination used    |
//|  for EASync.mqh. No separate host allow-list entry exists for raw      |
//|  sockets; MT5 permits SocketConnect to any host once WebRequest is     |
//|  allowed for that EA. See mt5_ea/README.md for full setup steps and    |
//|  known limitations.                                                     |
//|                                                                          |
//|  KNOWN LIMITATIONS (see mt5_ea/README.md for detail):                   |
//|    - Does NOT cryptographically verify Sec-WebSocket-Accept. Any HTTP   |
//|      101 response is accepted as a successful upgrade. Zero correctness |
//|      impact since streamed values are ephemeral and the connection is    |
//|      first-party endpoint reached over TLS.                              |
//|    - Frames with the 127-length marker (payloads >= 64KB, RFC6455        |
//|      len7==127) are defensively dropped — this channel only ever         |
//|      carries compact wake/state/heartbeat frames, which never approach  |
//|      that size.                                                           |
//|    - Reconnect logic runs from OnTimer(), so there can be a brief         |
//|      (sub-second) blocking window during SocketConnect/TlsHandshake       |
//|      on the timer thread. This does not block OnTick() or trade           |
//|      execution.                                                            |
//|    - Debounce/backoff is purely time-based, not request-tracked.          |
//+------------------------------------------------------------------+
#define EWS_STATE_DISCONNECTED 0
#define EWS_STATE_HANDSHAKING  1
#define EWS_STATE_OPEN         2

const int EWS_BACKOFF_CAP        = 60;
const int EWS_STALE_SECONDS      = 120;
const int EWS_PING_INTERVAL      = 25;
const int EWS_HANDSHAKE_TIMEOUT  = 10;

string   g_ews_base_url = "";
string   g_ews_api_key  = "";
string   g_ews_host     = "";
string   g_ews_public_api_key = "";
string   g_ews_topic = "";
string   g_ews_join_ref = "";
bool     g_ews_enabled  = false;
bool     g_ews_joined   = false;
int      g_ews_socket   = INVALID_HANDLE;
int      g_ews_state    = EWS_STATE_DISCONNECTED;
int      g_ews_ref      = 1;
int      g_ews_fallback_poll_seconds = 10;
int      g_ews_healthy_poll_seconds = 60;
int      g_ews_position_stream_seconds = 2;
datetime g_ews_last_position_stream_check = 0;
datetime g_ews_position_stream_requested_until = 0;
string   g_ews_last_position_state = "";
datetime g_ews_last_attempt      = 0;
int      g_ews_backoff_seconds   = 2;
datetime g_ews_last_activity     = 0;
datetime g_ews_last_ping_sent    = 0;
datetime g_ews_handshake_started = 0;

// Raw bytes during the HTTP upgrade phase. Kept as a byte buffer (not a
// string) because the tail of the handshake response can already contain
// the start of a binary WebSocket frame — round-tripping that through
// CharArrayToString/CP_UTF8 would corrupt it.
uchar    g_ews_hs_buf[];
int      g_ews_hs_len = 0;

// Raw bytes for WS frame parsing, same byte-safety reasoning.
uchar    g_ews_recv_buf[];
int      g_ews_recv_buf_len = 0;

//+------------------------------------------------------------------+
//| 1. Failure path: back off (doubling, capped) and go idle until the |
//|    next OnTimer tick's interval check fires EAStream_Connect again.|
//+------------------------------------------------------------------+
void EAStream_ScheduleRetry()
{
   g_ews_state = EWS_STATE_DISCONNECTED;
   g_ews_joined = false;
   EASync_SetPollSeconds(g_ews_fallback_poll_seconds);
   g_ews_backoff_seconds *= 2;
   if(g_ews_backoff_seconds > EWS_BACKOFF_CAP)
      g_ews_backoff_seconds = EWS_BACKOFF_CAP;
}

//+------------------------------------------------------------------+
//| Load the anonymous Realtime key and this terminal's high-entropy     |
//| topic. Commands themselves remain behind ea-sync API-key auth.       |
//+------------------------------------------------------------------+
bool EAStream_LoadConfig()
{
   string url = g_ews_base_url + "/functions/v1/terminal-realtime-config";
   string headers = "Content-Type: application/json\r\nx-api-key: " + g_ews_api_key + "\r\n";
   string request_body = "{}";
   uchar data[];
   int data_len = StringToCharArray(request_body, data, 0, StringLen(request_body), CP_UTF8);
   ArrayResize(data, data_len);
   uchar result[];
   string result_headers;
   ResetLastError();
   int status = WebRequest("POST", url, headers, 10000, data, result, result_headers);
   if(status != 200)
   {
      string detail = (status == -1) ? IntegerToString(GetLastError()) : CharArrayToString(result, 0, WHOLE_ARRAY, CP_UTF8);
      PrintFormat("EAStream: config request failed, HTTP %d: %s", status, detail);
      return false;
   }

   string body = CharArrayToString(result, 0, WHOLE_ARRAY, CP_UTF8);
   g_ews_public_api_key = EASync_JsonGetRaw(body, 0, StringLen(body), "apikey");
   g_ews_topic = EASync_JsonGetRaw(body, 0, StringLen(body), "topic");
   if(g_ews_public_api_key == "" || g_ews_topic == "")
   {
      Print("EAStream: config endpoint returned an incomplete response");
      return false;
   }
   return true;
}

void EAStream_SendJoin()
{
   string ref = IntegerToString(g_ews_ref++);
   g_ews_join_ref = ref;
   string topic = "realtime:" + g_ews_topic;
   string message =
      "{\"topic\":\"" + EASync_JsonEscape(topic) + "\","
      "\"event\":\"phx_join\",\"payload\":{"
      "\"config\":{\"broadcast\":{\"ack\":false,\"self\":false},"
      "\"presence\":{\"enabled\":false},\"postgres_changes\":[],\"private\":false}},"
      "\"ref\":\"" + ref + "\",\"join_ref\":\"" + ref + "\"}";
   EAStream_SendText(message);
}

void EAStream_SendHeartbeat()
{
   string ref = IntegerToString(g_ews_ref++);
   EAStream_SendText("{\"topic\":\"phoenix\",\"event\":\"heartbeat\",\"payload\":{},\"ref\":\"" + ref + "\",\"join_ref\":null}");
}

//+------------------------------------------------------------------+
//| Builds a compact, ephemeral mark-to-market snapshot. The durable  |
//| positions table remains authoritative for identity/status/actions; |
//| this payload only refreshes fields that can change between syncs. |
//+------------------------------------------------------------------+
string EAStream_BuildPositionState()
{
   string positions = "[";
   int appended = 0;
   int total = PositionsTotal();
   for(int i = 0; i < total; i++)
   {
      ulong ticket = PositionGetTicket(i);
      if(ticket == 0) continue;

      if(appended > 0) positions += ",";
      appended++;
      double sl = PositionGetDouble(POSITION_SL);
      double tp = PositionGetDouble(POSITION_TP);
      positions +=
         "{\"mt5_ticket\":" + IntegerToString((long)ticket) + ","
         "\"volume\":" + DoubleToString(PositionGetDouble(POSITION_VOLUME), 8) + ","
         "\"current_price\":" + DoubleToString(PositionGetDouble(POSITION_PRICE_CURRENT), 8) + ","
         "\"unrealized_pl\":" + DoubleToString(PositionGetDouble(POSITION_PROFIT), 2) + ","
         "\"sl\":" + (sl > 0.0 ? DoubleToString(sl, 8) : "null") + ","
         "\"tp\":" + (tp > 0.0 ? DoubleToString(tp, 8) : "null") + "}";
   }
   return "{\"positions\":" + positions + "]}";
}

//+------------------------------------------------------------------+
//| Broadcast at most once per configured interval and only when the  |
//| aggregate position state changed. One message covers every open   |
//| position, so usage does not multiply with position count.         |
//+------------------------------------------------------------------+
void EAStream_MaybeBroadcastPositionState()
{
   if(!g_ews_joined) return;
   datetime now = TimeCurrent();
   if(now > g_ews_position_stream_requested_until) return;
   if(now - g_ews_last_position_stream_check < g_ews_position_stream_seconds) return;
   g_ews_last_position_stream_check = now;

   string state_json = EAStream_BuildPositionState();
   if(state_json == g_ews_last_position_state) return;

   string ref = IntegerToString(g_ews_ref++);
   string topic = "realtime:" + g_ews_topic;
   string message =
      "{\"topic\":\"" + EASync_JsonEscape(topic) + "\","
      "\"event\":\"broadcast\",\"payload\":{"
      "\"type\":\"broadcast\",\"event\":\"position_state\","
      "\"payload\":" + state_json + "},"
      "\"ref\":\"" + ref + "\",\"join_ref\":\"" + g_ews_join_ref + "\"}";
   EAStream_SendText(message);
   g_ews_last_position_state = state_json;
}

//+------------------------------------------------------------------+
//| 2. Strips scheme://, trailing /path, and :port to get a bare host. |
//+------------------------------------------------------------------+
string EAStream_ExtractHost(const string base_url)
{
   string s = base_url;
   int scheme_pos = StringFind(s, "://");
   if(scheme_pos >= 0)
      s = StringSubstr(s, scheme_pos + 3);

   int slash_pos = StringFind(s, "/");
   if(slash_pos >= 0)
      s = StringSubstr(s, 0, slash_pos);

   int colon_pos = StringFind(s, ":");
   if(colon_pos >= 0)
      s = StringSubstr(s, 0, colon_pos);

   return s;
}

//+------------------------------------------------------------------+
//| 3. 16 random bytes, base64-encoded, for Sec-WebSocket-Key.         |
//+------------------------------------------------------------------+
string EAStream_GenerateWebSocketKey()
{
   uchar raw[16];
   for(int i = 0; i < 16; i++)
      raw[i] = (uchar)(MathRand() % 256);

   uchar empty_key[];
   uchar encoded[];
   int n = CryptEncode(CRYPT_BASE64, raw, empty_key, encoded);
   if(n <= 0)
      return "dGhlIHNhbXBsZSBub25jZQ=="; // RFC6455 example key — degrades gracefully

   return CharArrayToString(encoded, 0, n, CP_UTF8);
}

//+------------------------------------------------------------------+
//| 4. Appends raw bytes to the frame-parse receive buffer.            |
//+------------------------------------------------------------------+
void EAStream_AppendToRecvBuf(const uchar &data[], int len)
{
   if(len <= 0) return;
   int old_len = g_ews_recv_buf_len;
   ArrayResize(g_ews_recv_buf, old_len + len);
   for(int i = 0; i < len; i++)
      g_ews_recv_buf[old_len + i] = data[i];
   g_ews_recv_buf_len = old_len + len;
}

//+------------------------------------------------------------------+
//| 5. Parses one RFC6455 frame out of g_ews_recv_buf, if a complete    |
//|    frame is available. Shifts any remaining buffered bytes to the   |
//|    front and shrinks the buffer on success. Returns false if no     |
//|    complete frame is buffered yet (caller should wait for more).     |
//+------------------------------------------------------------------+
bool EAStream_TryParseFrame(int &opcode, uchar &payload[], int &payload_len)
{
   if(g_ews_recv_buf_len < 2) return false;

   uchar b0 = g_ews_recv_buf[0];
   uchar b1 = g_ews_recv_buf[1];
   opcode = (int)(b0 & 0x0F);
   bool masked = (b1 & 0x80) != 0;
   int len7 = (int)(b1 & 0x7F);

   int pos = 2;
   long full_len;

   if(len7 <= 125)
   {
      full_len = len7;
   }
   else if(len7 == 126)
   {
      if(g_ews_recv_buf_len < 4) return false;
      full_len = ((long)g_ews_recv_buf[2] << 8) | (long)g_ews_recv_buf[3];
      pos = 4;
   }
   else // len7 == 127 — 8-byte extended length. Known limitation: this
        // channel never legitimately sends payloads this large (only
        // short "wake"/"ping"/"pong" text frames), so defensively drop
        // the entire buffer rather than risk parsing a bogus/huge length.
   {
      PrintFormat("EAStream: dropping buffer — unexpected 127-length frame marker");
      g_ews_recv_buf_len = 0;
      ArrayResize(g_ews_recv_buf, 0);
      return false;
   }

   int mask_len = masked ? 4 : 0;
   long frame_total = pos + mask_len + full_len;

   if(g_ews_recv_buf_len < frame_total) return false; // wait for more bytes

   uchar mask_key[4];
   if(masked)
   {
      for(int i = 0; i < 4; i++)
         mask_key[i] = g_ews_recv_buf[pos + i];
      pos += 4;
   }

   payload_len = (int)full_len;
   ArrayResize(payload, payload_len);
   for(int i = 0; i < payload_len; i++)
   {
      uchar b = g_ews_recv_buf[pos + i];
      if(masked)
         b = (uchar)(b ^ mask_key[i % 4]);
      payload[i] = b;
   }

   // Shift any remaining bytes (start of the next frame) to the front.
   int consumed = (int)frame_total;
   int remaining = g_ews_recv_buf_len - consumed;
   if(remaining > 0)
   {
      for(int i = 0; i < remaining; i++)
         g_ews_recv_buf[i] = g_ews_recv_buf[consumed + i];
   }
   g_ews_recv_buf_len = remaining;
   ArrayResize(g_ews_recv_buf, remaining);

   return true;
}

//+------------------------------------------------------------------+
//| 6. Defensive-only path: this server currently only speaks text     |
//|    "ping"/"wake"/"pong", not RFC6455 control-opcode pings, but we   |
//|    reply correctly if it ever does.                                 |
//+------------------------------------------------------------------+
void EAStream_SendPong(const uchar &payload[], int payload_len)
{
   uchar mask_key[4];
   for(int i = 0; i < 4; i++)
      mask_key[i] = (uchar)(MathRand() % 256);

   uchar frame[];
   int header_len = (payload_len <= 125) ? 2 : 4;
   ArrayResize(frame, header_len + 4 + payload_len);

   frame[0] = 0x8A; // FIN + opcode 0xA (pong)
   if(payload_len <= 125)
   {
      frame[1] = (uchar)(0x80 | payload_len);
   }
   else
   {
      frame[1] = (uchar)(0x80 | 126);
      frame[2] = (uchar)((payload_len >> 8) & 0xFF);
      frame[3] = (uchar)(payload_len & 0xFF);
   }

   int pos = header_len;
   for(int i = 0; i < 4; i++)
      frame[pos + i] = mask_key[i];
   pos += 4;

   for(int i = 0; i < payload_len; i++)
      frame[pos + i] = (uchar)(payload[i] ^ mask_key[i % 4]);

   SocketTlsSend(g_ews_socket, frame, ArraySize(frame));
}

//+------------------------------------------------------------------+
//| 7. Builds and sends a masked RFC6455 text frame (client->server     |
//|    frames must always be masked per spec).                          |
//+------------------------------------------------------------------+
void EAStream_SendText(const string text)
{
   uchar text_bytes[];
   int text_len = StringToCharArray(text, text_bytes, 0, StringLen(text), CP_UTF8);
   ArrayResize(text_bytes, text_len); // drop trailing null

   uchar mask_key[4];
   for(int i = 0; i < 4; i++)
      mask_key[i] = (uchar)(MathRand() % 256);

   int header_len = (text_len <= 125) ? 2 : 4;
   uchar frame[];
   ArrayResize(frame, header_len + 4 + text_len);

   frame[0] = 0x81; // FIN + opcode 0x1 (text)
   if(text_len <= 125)
   {
      frame[1] = (uchar)(0x80 | text_len);
   }
   else
   {
      frame[1] = (uchar)(0x80 | 126);
      frame[2] = (uchar)((text_len >> 8) & 0xFF);
      frame[3] = (uchar)(text_len & 0xFF);
   }

   int pos = header_len;
   for(int i = 0; i < 4; i++)
      frame[pos + i] = mask_key[i];
   pos += 4;

   for(int i = 0; i < text_len; i++)
      frame[pos + i] = (uchar)(text_bytes[i] ^ mask_key[i % 4]);

   SocketTlsSend(g_ews_socket, frame, ArraySize(frame));
}

//+------------------------------------------------------------------+
//| 8. Dispatches one decoded frame. "wake" is the entire point of      |
//|    this module: it calls EASync_Run() directly, so a freshly        |
//|    queued command executes immediately instead of waiting for the   |
//|    next poll interval.                                               |
//+------------------------------------------------------------------+
void EAStream_HandleFrame(int opcode, const uchar &payload[], int payload_len)
{
   if(opcode == 0x1) // text
   {
      string text = CharArrayToString(payload, 0, payload_len, CP_UTF8);
      if(StringFind(text, "\"event\":\"broadcast\"") >= 0 &&
         StringFind(text, "position_stream_subscribe") >= 0)
      {
         // Dashboard leases are renewed every 15s. If every viewer leaves,
         // broadcasts stop automatically after this short grace period.
         bool stream_was_inactive = TimeLocal() > g_ews_position_stream_requested_until;
         g_ews_position_stream_requested_until = TimeLocal() + 30;
         if(stream_was_inactive)
         {
            g_ews_last_position_state = "";
            g_ews_last_position_stream_check = 0;
         }
      }
      else if(StringFind(text, "\"event\":\"broadcast\"") >= 0 &&
         StringFind(text, "command_available") >= 0)
      {
         Print("EAStream: command broadcast received — reconciling immediately");
         EASync_Run();
      }
      else if(StringFind(text, "\"event\":\"phx_reply\"") >= 0 &&
              StringFind(text, "\"status\":\"ok\"") >= 0 && !g_ews_joined)
      {
         g_ews_joined = true;
         g_ews_last_position_state = "";
         g_ews_last_position_stream_check = 0;
         EASync_SetPollSeconds(g_ews_healthy_poll_seconds);
         Print("EAStream: terminal wake-up channel joined");
         EASync_Run(); // repair anything queued before/during the join
      }
      else if(StringFind(text, "\"event\":\"phx_error\"") >= 0 ||
              StringFind(text, "\"event\":\"system\"") >= 0)
      {
         Print("EAStream: Realtime channel error; reconnecting with fallback polling");
         SocketClose(g_ews_socket);
         g_ews_socket = INVALID_HANDLE;
         EAStream_ScheduleRetry();
      }
   }
   else if(opcode == 0x8) // close
   {
      Print("EAStream: server closed the Realtime connection; reconnecting");
      SocketClose(g_ews_socket);
      g_ews_socket = INVALID_HANDLE;
      EAStream_ScheduleRetry();
      g_ews_backoff_seconds = 2; // this is expected/benign, don't punish with backoff
   }
   else if(opcode == 0x9) // control ping (defensive/unused by this server today)
   {
      EAStream_SendPong(payload, payload_len);
   }
   // 0xA (pong), 0x2 (binary), 0x0 (continuation): no-op
}

//+------------------------------------------------------------------+
//| 9. Drains whatever's available on the socket, parses every complete |
//|    frame currently buffered, and dispatches each one.                |
//+------------------------------------------------------------------+
void EAStream_PumpFrames()
{
   uint available = SocketIsReadable(g_ews_socket);
   if(available > 0)
   {
      uchar buf[];
      ArrayResize(buf, (int)available);
      int got = SocketTlsReadAvailable(g_ews_socket, buf, (int)available);
      if(got > 0)
      {
         EAStream_AppendToRecvBuf(buf, got);
         g_ews_last_activity = TimeCurrent();
      }
   }

   int opcode, payload_len;
   uchar payload[];
   while(EAStream_TryParseFrame(opcode, payload, payload_len))
   {
      g_ews_last_activity = TimeCurrent();
      EAStream_HandleFrame(opcode, payload, payload_len);
   }
}

//+------------------------------------------------------------------+
//| 10. Opens the TCP+TLS socket and sends the HTTP Upgrade request.    |
//|     Any failure at any step schedules a backoff retry and returns.  |
//+------------------------------------------------------------------+
void EAStream_Connect()
{
   g_ews_last_attempt = TimeCurrent();

   if(g_ews_public_api_key == "" || g_ews_topic == "")
   {
      if(!EAStream_LoadConfig())
      {
         EAStream_ScheduleRetry();
         return;
      }
   }

   if(g_ews_socket != INVALID_HANDLE)
   {
      SocketClose(g_ews_socket);
      g_ews_socket = INVALID_HANDLE;
   }

   g_ews_socket = SocketCreate();
   if(g_ews_socket == INVALID_HANDLE)
   {
      PrintFormat("EAStream: SocketCreate failed, error %d", GetLastError());
      EAStream_ScheduleRetry();
      return;
   }

   SocketTimeouts(g_ews_socket, 5000, 5000);

   if(!SocketConnect(g_ews_socket, g_ews_host, 443, 5000))
   {
      PrintFormat("EAStream: SocketConnect to %s:443 failed, error %d", g_ews_host, GetLastError());
      SocketClose(g_ews_socket);
      g_ews_socket = INVALID_HANDLE;
      EAStream_ScheduleRetry();
      return;
   }

   // v1.0.16 -- SocketTlsHandshake() removed here (was called unconditionally
   // right after SocketConnect() on port 443). Per MQL5's own docs and its
   // official SocketTlsReadAvailable.mq5 example: a port-443 SocketConnect()
   // already yields a TLS-secured socket transparently -- calling the
   // handshake function again on top of that is a redundant negotiation and
   // is exactly what produced the observed "SocketTlsHandshake ... failed,
   // error 5274 (ERR_NETSOCKET_HANDSHAKE_FAILED)" on every single attempt,
   // meaning this Realtime channel never once connected. The
   // SocketTlsSend/SocketTlsReadAvailable calls further below are unchanged
   // and correct -- they already work directly on a freshly SocketConnect()'d
   // port-443 socket with no explicit handshake, exactly like MetaQuotes'
   // own reference example.

   string ws_key = EAStream_GenerateWebSocketKey();
   string request =
      "GET /realtime/v1/websocket?apikey=" + g_ews_public_api_key + "&vsn=1.0.0 HTTP/1.1\r\n"
      "Host: " + g_ews_host + "\r\n"
      "Upgrade: websocket\r\n"
      "Connection: Upgrade\r\n"
      "Sec-WebSocket-Key: " + ws_key + "\r\n"
      "Sec-WebSocket-Version: 13\r\n"
      "\r\n";

   uchar req_bytes[];
   int req_len = StringToCharArray(request, req_bytes, 0, StringLen(request), CP_UTF8);
   ArrayResize(req_bytes, req_len);

   int sent = SocketTlsSend(g_ews_socket, req_bytes, req_len);
   if(sent != req_len)
   {
      PrintFormat("EAStream: handshake request send incomplete (%d/%d bytes)", sent, req_len);
      SocketClose(g_ews_socket);
      g_ews_socket = INVALID_HANDLE;
      EAStream_ScheduleRetry();
      return;
   }

   g_ews_state = EWS_STATE_HANDSHAKING;
   g_ews_handshake_started = TimeCurrent();
   g_ews_hs_len = 0;
   ArrayResize(g_ews_hs_buf, 0);
}

//+------------------------------------------------------------------+
//| 11. Reads the HTTP Upgrade response incrementally until the header  |
//|     terminator is seen, validates the status line, and transitions  |
//|     to OPEN. Any leftover bytes after the header (start of the      |
//|     first WS frame, if it arrived in the same read) are carried     |
//|     into the frame receive buffer.                                   |
//+------------------------------------------------------------------+
void EAStream_PumpHandshake()
{
   if(TimeCurrent() - g_ews_handshake_started > EWS_HANDSHAKE_TIMEOUT)
   {
      Print("EAStream: handshake timed out");
      SocketClose(g_ews_socket);
      g_ews_socket = INVALID_HANDLE;
      EAStream_ScheduleRetry();
      return;
   }

   uint available = SocketIsReadable(g_ews_socket);
   if(available > 0)
   {
      uchar buf[];
      ArrayResize(buf, (int)available);
      int got = SocketTlsReadAvailable(g_ews_socket, buf, (int)available);
      if(got > 0)
      {
         int old_len = g_ews_hs_len;
         ArrayResize(g_ews_hs_buf, old_len + got);
         for(int i = 0; i < got; i++)
            g_ews_hs_buf[old_len + i] = buf[i];
         g_ews_hs_len = old_len + got;
      }
   }

   if(g_ews_hs_len < 4) return; // not enough bytes yet to contain \r\n\r\n

   // Byte-scan for the \r\n\r\n header terminator (0x0D 0x0A 0x0D 0x0A).
   int term_pos = -1;
   for(int i = 0; i <= g_ews_hs_len - 4; i++)
   {
      if(g_ews_hs_buf[i] == 0x0D && g_ews_hs_buf[i + 1] == 0x0A &&
         g_ews_hs_buf[i + 2] == 0x0D && g_ews_hs_buf[i + 3] == 0x0A)
      {
         term_pos = i;
         break;
      }
   }
   if(term_pos < 0) return; // header not complete yet, keep waiting

   // Header text is guaranteed ASCII — safe to convert.
   string header = CharArrayToString(g_ews_hs_buf, 0, term_pos, CP_UTF8);

   bool ok = (StringFind(header, "HTTP/1.1 101") == 0) || (StringFind(header, "HTTP/1.0 101") == 0);
   if(!ok)
   {
      PrintFormat("EAStream: handshake rejected: %s", header);
      SocketClose(g_ews_socket);
      g_ews_socket = INVALID_HANDLE;
      EAStream_ScheduleRetry();
      return;
   }
   // Known limitation: Sec-WebSocket-Accept is NOT cryptographically verified.
   // Any HTTP 101 response is accepted. This is a first-party TLS endpoint and
   // ephemeral-only channel, so durable correctness is unaffected.

   int body_start = term_pos + 4;
   int leftover = g_ews_hs_len - body_start;
   if(leftover > 0)
   {
      uchar tail[];
      ArrayResize(tail, leftover);
      for(int i = 0; i < leftover; i++)
         tail[i] = g_ews_hs_buf[body_start + i];
      EAStream_AppendToRecvBuf(tail, leftover);
   }

   g_ews_state = EWS_STATE_OPEN;
   g_ews_joined = false;
   g_ews_backoff_seconds = 2;
   g_ews_last_activity = TimeCurrent();
   g_ews_last_ping_sent = TimeCurrent();
   EAStream_SendJoin();
   Print("EAStream: Realtime WebSocket connected; joining terminal wake-up channel");
}

//+------------------------------------------------------------------+
//| 12. Public: call once from OnInit, guarded by EnableWebSocketPush.  |
//+------------------------------------------------------------------+
void EAStream_Init(const string base_url, const string api_key,
                   const int fallback_poll_seconds = 10,
                   const int healthy_poll_seconds = 60,
                   const int position_stream_seconds = 2)
{
   g_ews_base_url = base_url;
   g_ews_api_key  = api_key;
   g_ews_host     = EAStream_ExtractHost(base_url);
   g_ews_enabled  = true;
   g_ews_fallback_poll_seconds = (fallback_poll_seconds > 0) ? fallback_poll_seconds : 10;
   g_ews_healthy_poll_seconds = (healthy_poll_seconds > g_ews_fallback_poll_seconds)
      ? healthy_poll_seconds : 60;
   g_ews_position_stream_seconds = (position_stream_seconds > 0) ? position_stream_seconds : 2;
   EASync_SetPollSeconds(g_ews_fallback_poll_seconds);
   g_ews_state    = EWS_STATE_DISCONNECTED;
   g_ews_joined   = false;
   g_ews_join_ref = "";
   g_ews_last_position_stream_check = 0;
   g_ews_position_stream_requested_until = 0;
   g_ews_last_position_state = "";
   g_ews_last_attempt = 0; // forces an immediate first connect attempt
   g_ews_backoff_seconds = 2;
   MathSrand((int)TimeLocal());
   g_ews_hs_len = 0;
   ArrayResize(g_ews_hs_buf, 0);
   g_ews_recv_buf_len = 0;
   ArrayResize(g_ews_recv_buf, 0);
   Print("EAStream: initialized for terminal-scoped Supabase Realtime Broadcast");
}

//+------------------------------------------------------------------+
//| 13. Public: call once from OnDeinit.                                 |
//+------------------------------------------------------------------+
void EAStream_Deinit()
{
   g_ews_enabled = false;
   if(g_ews_socket != INVALID_HANDLE)
   {
      SocketClose(g_ews_socket);
      g_ews_socket = INVALID_HANDLE;
   }
   g_ews_state = EWS_STATE_DISCONNECTED;
   g_ews_joined = false;
   EASync_SetPollSeconds(g_ews_fallback_poll_seconds);
}

//+------------------------------------------------------------------+
//| 14. Public: call every OnTimer tick. Self-gates on state/backoff.   |
//+------------------------------------------------------------------+
void EAStream_OnTimer()
{
   if(!g_ews_enabled) return;

   if(g_ews_state == EWS_STATE_DISCONNECTED)
   {
      if(TimeCurrent() - g_ews_last_attempt >= g_ews_backoff_seconds)
         EAStream_Connect();
      return;
   }

   if(g_ews_state == EWS_STATE_HANDSHAKING)
   {
      EAStream_PumpHandshake();
      return;
   }

   if(g_ews_state == EWS_STATE_OPEN)
   {
      if(!SocketIsConnected(g_ews_socket))
      {
         Print("EAStream: socket dropped, reconnecting");
         SocketClose(g_ews_socket);
         g_ews_socket = INVALID_HANDLE;
         g_ews_state = EWS_STATE_DISCONNECTED;
         g_ews_joined = false;
         EASync_SetPollSeconds(g_ews_fallback_poll_seconds);
         g_ews_backoff_seconds = 2; // drops are expected/benign, don't punish with backoff
         return;
      }

      EAStream_PumpFrames();

      if(TimeCurrent() - g_ews_last_activity > EWS_STALE_SECONDS)
      {
         Print("EAStream: connection stale (no activity for 120s), forcing reconnect");
         SocketClose(g_ews_socket);
         g_ews_socket = INVALID_HANDLE;
         g_ews_state = EWS_STATE_DISCONNECTED;
         g_ews_joined = false;
         EASync_SetPollSeconds(g_ews_fallback_poll_seconds);
         g_ews_backoff_seconds = 2;
         return;
      }

      if(TimeCurrent() - g_ews_last_ping_sent >= EWS_PING_INTERVAL)
      {
         EAStream_SendHeartbeat();
         g_ews_last_ping_sent = TimeCurrent();
      }

      EAStream_MaybeBroadcastPositionState();

   }
}
//+------------------------------------------------------------------+
//============================================================================
// END inlined module: EAStream.mqh
//============================================================================

//============================================================================
// BEGIN inlined module: SymbolMap.mqh
// (originally a separate #include file — merged in for single-file
// deployment; MT5 VPS does not reliably sync sibling .mqh files, so
// this build ships as one self-contained .mq5.)
//============================================================================
//+------------------------------------------------------------------+
//|                                                  SymbolMap.mqh    |
//|  v1.0.12 — Broker symbol -> canonical symbol reporting.           |
//|                                                                    |
//|  Brokers rename symbols (EURUSD.a, GOLD vs XAUUSD, US30.cash, etc). |
//|  This module enumerates every symbol the connected broker exposes   |
//|  and POSTs the full list to /functions/v1/report-symbols, which     |
//|  matches each one against the canonical FX/metals/indices/crypto    |
//|  symbol list server-side and upserts the results into                |
//|  symbol_mappings (exact match, auto-mapped via alias table, or       |
//|  flagged needs_review with candidate suggestions for the user to     |
//|  resolve in the dashboard).                                          |
//|                                                                        |
//|  This module does NOT decide any mapping itself — it is purely a       |
//|  broker-symbol reporter. All matching logic lives server-side in       |
//|  report-symbols so the mapping tables can be improved without an       |
//|  EA update.                                                             |
//|                                                                          |
//|  INTEGRATION (in your main .mq5 EA file, after EASync.mqh so           |
//|  EASync_GetLastResponse()/EASync_JsonGetRaw() are already declared):    |
//|    #include "EASync.mqh"                                               |
//|    #include "SymbolMap.mqh"                                            |
//|                                                                           |
//|    int OnInit() {                                                       |
//|      ...                                                                  |
//|      SymbolMap_Init(SupabaseProjectUrl, TerminalApiKey, SymbolMapRefreshHours); |
//|      EventSetTimer(1);                                                     |
//|      return(INIT_SUCCEEDED);                                              |
//|    }                                                                       |
//|                                                                              |
//|    void OnTimer() {                                                        |
//|      ...                                                                     |
//|      SymbolMap_OnTimer(); // periodic full rescan every refresh_hours        |
//|      // After EASync_Run() has updated g_es_last_response, check the         |
//|      // server-requested flag and force an immediate rescan if set:          |
//|      string last = EASync_GetLastResponse();                                 |
//|      if(last != "" && EASync_JsonGetRaw(last, 0, StringLen(last),            |
//|                                          "force_symbol_rescan") == "true")    |
//|         SymbolMap_ForceRescan();                                              |
//|    }                                                                           |
//|                                                                                  |
//|  This module always does a rescan once on EA startup (via SymbolMap_Init's      |
//|  reset of g_sm_last_rescan_attempt to 0, which SymbolMap_OnTimer picks up        |
//|  on the very first tick since 0 refresh_hours have never elapsed from time       |
//|  zero) so a freshly-attached terminal reports its symbol universe               |
//|  immediately without waiting for the first refresh_hours interval.               |
//|                                                                                     |
//|  KNOWN LIMITATIONS (see mt5_ea/README.md for detail):                              |
//|    - Debounce (SymbolMap_ForceRescan's 30s guard) is purely time-based,             |
//|      not in-flight-tracked. Good enough given this is a low-frequency,               |
//|      non-critical background sync — worst case is one extra POST.                     |
//|    - Enumerates ALL broker symbols via SymbolsTotal(false), including                  |
//|      symbols not in Market Watch. Some brokers expose thousands of                      |
//|      instruments; report-symbols upserts every canonical match it finds,                |
//|      which is intentional (lets the dashboard resolve mappings for                       |
//|      symbols the user hasn't added to Market Watch yet).                                  |
//+------------------------------------------------------------------+
string   g_sm_base_url = "";
string   g_sm_api_key  = "";
int      g_sm_refresh_hours = 24;
datetime g_sm_last_full_rescan   = 0;
datetime g_sm_last_rescan_attempt = 0;

//+------------------------------------------------------------------+
//| Builds { "symbols": ["EURUSD.a", "GOLD", ...] } from every symbol   |
//| the broker exposes (visible or not) and POSTs it to report-symbols. |
//| Mirrors EASync_Run()'s exact WebRequest pattern (headers, error      |
//| 4060 handling, status check).                                        |
//+------------------------------------------------------------------+
void SymbolMap_Run()
{
   g_sm_last_rescan_attempt = TimeCurrent();
   g_sm_last_full_rescan    = TimeCurrent();

   int total = SymbolsTotal(false); // false = every symbol, not just Market Watch
   string symbols_json = "\"symbols\":[";
   for(int i = 0; i < total; i++)
   {
      string name = SymbolName(i, false);
      if(name == "") continue;
      if(i > 0) symbols_json += ",";
      // Symbol names don't contain quotes/backslashes in practice, but
      // escape defensively rather than assume.
      string esc = name;
      StringReplace(esc, "\\", "\\\\");
      StringReplace(esc, "\"", "\\\"");
      symbols_json += "\"" + esc + "\"";
   }
   symbols_json += "]";

   string body = "{" + symbols_json + "}";
   string url  = g_sm_base_url + "/functions/v1/report-symbols";
   string headers = "Content-Type: application/json\r\nx-api-key: " + g_sm_api_key + "\r\n";

   uchar data[];
   int data_len = StringToCharArray(body, data, 0, StringLen(body), CP_UTF8);
   ArrayResize(data, data_len); // drop the trailing null StringToCharArray appends

   uchar result[];
   string result_headers;
   ResetLastError();
   int status = WebRequest("POST", url, headers, 10000, data, result, result_headers);

   if(status == -1)
   {
      int err = GetLastError();
      if(err == 4060)
         PrintFormat("SymbolMap: WebRequest blocked (error 4060) — add %s to Tools > Options > "
                     "Expert Advisors > Allow WebRequest for listed URL.", g_sm_base_url);
      else
         PrintFormat("SymbolMap: WebRequest failed, error %d", err);
      return;
   }

   string response = CharArrayToString(result, 0, WHOLE_ARRAY, CP_UTF8);

   if(status != 200)
   {
      PrintFormat("SymbolMap: report-symbols returned HTTP %d: %s", status, response);
      return;
   }

   long total_canonical = EASync_JsonGetInt(response, 0, StringLen(response), "total_canonical");
   long exact_count      = EASync_JsonGetInt(response, 0, StringLen(response), "exact");
   long auto_mapped      = EASync_JsonGetInt(response, 0, StringLen(response), "auto_mapped");
   long needs_review     = EASync_JsonGetInt(response, 0, StringLen(response), "needs_review");
   long unavailable      = EASync_JsonGetInt(response, 0, StringLen(response), "unavailable");

   PrintFormat("SymbolMap: reported %d broker symbols — %d canonical total "
               "(%d exact, %d auto-mapped, %d needs review, %d unavailable)",
               total, (int)total_canonical, (int)exact_count, (int)auto_mapped,
               (int)needs_review, (int)unavailable);
}

//+------------------------------------------------------------------+
//| Public: call once from OnInit.                                     |
//+------------------------------------------------------------------+
void SymbolMap_Init(const string base_url, const string api_key, const int refresh_hours)
{
   g_sm_base_url = base_url;
   g_sm_api_key  = api_key;
   g_sm_refresh_hours = (refresh_hours > 0) ? refresh_hours : 24;
   g_sm_last_full_rescan    = 0; // forces an immediate first rescan on startup
   g_sm_last_rescan_attempt = 0;
}

//+------------------------------------------------------------------+
//| Public: force an out-of-band rescan (e.g. server set                |
//| force_symbol_rescan=true after the user hit "Rescan Symbols" in     |
//| the dashboard, or connected a new terminal). Debounced to at most    |
//| once per 30s so a burst of ea-sync polls can't trigger a POST storm. |
//+------------------------------------------------------------------+
void SymbolMap_ForceRescan()
{
   if(TimeCurrent() - g_sm_last_rescan_attempt <= 30) return; // debounced
   Print("SymbolMap: force rescan requested");
   SymbolMap_Run();
}

//+------------------------------------------------------------------+
//| Public: call every OnTimer tick. Runs a full rescan on startup and  |
//| then every refresh_hours thereafter.                                 |
//+------------------------------------------------------------------+
void SymbolMap_OnTimer()
{
   int refresh_seconds = g_sm_refresh_hours * 3600;
   if(TimeCurrent() - g_sm_last_full_rescan >= refresh_seconds)
      SymbolMap_Run();
}
//+------------------------------------------------------------------+
//============================================================================
// END inlined module: SymbolMap.mqh
//============================================================================

//============================================================================
// BEGIN inlined module: PriceReporter.mqh
// (originally a separate #include file — merged in for single-file
// deployment; MT5 VPS does not reliably sync sibling .mqh files, so
// this build ships as one self-contained .mq5.)
//============================================================================
//+------------------------------------------------------------------+
//|                                               PriceReporter.mqh   |
//|  v1.0.22 — Multi-timeframe closed-bar reporting.                  |
//|                                                                    |
//|  This module reads the cached ea-sync response that EASync.mqh has |
//|  already fetched, extracts its bound_symbols canonical->broker     |
//|  pairs and selected timeframes, then reports newly CLOSED bars to  |
//|  /functions/v1/report-bars in bounded batches.                     |
//|                                                                    |
//|  It deliberately does NOT make its own ea-sync request: EASync is |
//|  the sole owner of that poll. This keeps bar reporting canonical    |
//|  (server strategy definitions use canonical names) while avoiding   |
//|  a second lookup/network round trip per timer interval.             |
//|                                                                    |
//|  INTEGRATION (in your main .mq5 EA file, after EASync.mqh so        |
//|  EASync_GetLastResponse()/EASync_JsonGetRaw()/EASync_ToIso8601()    |
//|  are already declared):                                             |
//|    #include "EASync.mqh"                                            |
//|    #include "PriceReporter.mqh"                                     |
//|                                                                     |
//|    int OnInit() {                                                   |
//|      ...                                                            |
//|      PriceReporter_Init(SupabaseProjectUrl, TerminalApiKey, 60);   |
//|      EventSetTimer(1);                                               |
//|      return(INIT_SUCCEEDED);                                        |
//|    }                                                                |
//|                                                                     |
//|    void OnTimer() {                                                 |
//|      EASync_OnTimer();                                              |
//|      PriceReporter_OnTimer(); // AFTER EASync_OnTimer: uses fresh   |
//|                              // cached response when a poll ran.   |
//|      ...                                                            |
//|    }                                                                |
//|                                                                     |
//|  REQUIRED ONE-TIME TERMINAL SETUP: add the Supabase base URL to     |
//|  Tools > Options > Expert Advisors > "Allow WebRequest for listed   |
//|  URL". EASync.mqh already documents the same requirement.           |
//+------------------------------------------------------------------+
string   g_pr_base_url = "";
string   g_pr_api_key = "";
int      g_pr_report_interval_seconds = 60;
datetime g_pr_last_report = 0;

// v1.0.22 -- historical warm-up and outage recovery are staggered so a large
// symbol/timeframe selection cannot create an unbounded Edge Function body.
#define PR_BACKFILL_BARS 1000
#define PR_MAX_BACKFILL_SERIES_PER_RUN 2
#define PR_MAX_RECOVERY_SERIES_PER_RUN 2
#define PR_MAX_BARS_PER_REQUEST 2200
string   g_pr_series_keys[];
datetime g_pr_series_last_sent[];
int      g_pr_priority_cursor = 0;
int      g_pr_background_cursor = 0;

//+------------------------------------------------------------------+
//| Finds the session checkpoint for one broker-symbol/timeframe.      |
//+------------------------------------------------------------------+
int PriceReporter_SeriesIndex(const string series_key)
{
   int total = ArraySize(g_pr_series_keys);
   for(int i = 0; i < total; i++)
      if(g_pr_series_keys[i] == series_key) return i;
   return -1;
}

datetime PriceReporter_LastSent(const string series_key)
{
   int index = PriceReporter_SeriesIndex(series_key);
   return (index >= 0) ? g_pr_series_last_sent[index] : 0;
}

void PriceReporter_MarkSent(const string series_key, const datetime bar_time)
{
   int index = PriceReporter_SeriesIndex(series_key);
   if(index < 0)
   {
      index = ArraySize(g_pr_series_keys);
      ArrayResize(g_pr_series_keys, index + 1);
      ArrayResize(g_pr_series_last_sent, index + 1);
      g_pr_series_keys[index] = series_key;
   }
   if(bar_time > g_pr_series_last_sent[index])
      g_pr_series_last_sent[index] = bar_time;
}

//+------------------------------------------------------------------+
//| One currently bound canonical/broker pair read from ea-sync.       |
//+------------------------------------------------------------------+
struct PriceReporterBoundSymbol
{
   string canonical_symbol;
   string broker_symbol;
   string report_timeframes;
   string priority_timeframes;
};

ENUM_TIMEFRAMES PriceReporter_TimeframeEnum(const string timeframe)
{
   if(timeframe == "M1") return PERIOD_M1;
   if(timeframe == "M5") return PERIOD_M5;
   if(timeframe == "M15") return PERIOD_M15;
   if(timeframe == "M30") return PERIOD_M30;
   if(timeframe == "H1") return PERIOD_H1;
   if(timeframe == "H4") return PERIOD_H4;
   if(timeframe == "D1") return PERIOD_D1;
   if(timeframe == "W1") return PERIOD_W1;
   return PERIOD_CURRENT;
}

//+------------------------------------------------------------------+
//| Splits top-level "bound_symbols":[ ... ] into object pairs. This  |
//| deliberately mirrors EASync_ProcessPendingCommands' bracket-depth  |
//| parser rather than assuming a comma split is safe for JSON objects. |
//+------------------------------------------------------------------+
int PriceReporter_ParseBoundSymbols(const string json, PriceReporterBoundSymbol &out_symbols[])
{
   ArrayResize(out_symbols, 0);

   int arr_key = StringFind(json, "\"bound_symbols\":[");
   if(arr_key < 0) return 0;

   int arr_start = arr_key + StringLen("\"bound_symbols\":[");
   if(arr_start >= StringLen(json) || StringGetCharacter(json, arr_start) == ']') return 0;

   int pos = arr_start;
   int json_len = StringLen(json);
   int depth = 0;
   int obj_start = -1;
   int count = 0;

   while(pos < json_len)
   {
      int ch = StringGetCharacter(json, pos);
      if(ch == '{')
      {
         if(depth == 0) obj_start = pos;
         depth++;
      }
      else if(ch == '}')
      {
         depth--;
         if(depth == 0 && obj_start >= 0)
         {
            int obj_end = pos + 1;
            string canonical = EASync_JsonGetRaw(json, obj_start, obj_end, "canonical_symbol");
            string broker    = EASync_JsonGetRaw(json, obj_start, obj_end, "broker_symbol");
            string timeframes = EASync_JsonGetRaw(json, obj_start, obj_end, "report_timeframes");
            string priority_timeframes = EASync_JsonGetRaw(json, obj_start, obj_end, "priority_timeframes");
            if(canonical != "" && broker != "")
            {
               ArrayResize(out_symbols, count + 1);
               out_symbols[count].canonical_symbol = canonical;
               out_symbols[count].broker_symbol = broker;
               // Older ea-sync deployments omit this field; preserve M5.
               out_symbols[count].report_timeframes = (timeframes == "") ? "[\"M5\"]" : timeframes;
               out_symbols[count].priority_timeframes = (priority_timeframes == "") ? "[]" : priority_timeframes;
               count++;
            }
            obj_start = -1;
         }
      }
      else if(ch == ']' && depth == 0)
         break;
      pos++;
   }
   return count;
}

//+------------------------------------------------------------------+
//| Reports newly closed bars for each user-selected symbol/timeframe. |
//| CopyRates start_pos=1 always excludes the live, forming candle.     |
//+------------------------------------------------------------------+
void PriceReporter_Run()
{
   g_pr_last_report = TimeCurrent();

   string last_response = EASync_GetLastResponse();
   if(last_response == "")
   {
      Print("PriceReporter: waiting for first successful ea-sync response with bound_symbols");
      return;
   }

   PriceReporterBoundSymbol bound[];
   int bound_count = PriceReporter_ParseBoundSymbols(last_response, bound);
   if(bound_count <= 0)
   {
      Print("PriceReporter: no bound symbols in cached ea-sync response");
      return;
   }

   string symbols_json = "\"symbols\":[";
   int sent_series = 0;
   int sent_bars = 0;
   int backfill_series = 0;
   int recovery_series = 0;
   string pending_keys[];
   datetime pending_times[];
   string timeframe_names[] = {"M1", "M5", "M15", "M30", "H1", "H4", "D1", "W1"};

   // Build one ordered work queue: active-strategy series first, then every
   // other visible symbol/timeframe. Independent cursors rotate both groups so
   // a slow history download or bounded recovery batch cannot permanently
   // starve series later in the broker's symbol list.
   string candidate_brokers[];
   string candidate_timeframes[];
   int priority_count = 0;
   for(int pass = 0; pass < 2; pass++)
   {
      for(int i = 0; i < bound_count; i++)
      {
         for(int tf_index = 0; tf_index < ArraySize(timeframe_names); tf_index++)
         {
            string timeframe = timeframe_names[tf_index];
            if(StringFind(bound[i].report_timeframes, "\"" + timeframe + "\"") < 0)
               continue;
            bool is_priority = StringFind(bound[i].priority_timeframes, "\"" + timeframe + "\"") >= 0;
            if((pass == 0 && !is_priority) || (pass == 1 && is_priority))
               continue;
            int candidate_index = ArraySize(candidate_brokers);
            ArrayResize(candidate_brokers, candidate_index + 1);
            ArrayResize(candidate_timeframes, candidate_index + 1);
            candidate_brokers[candidate_index] = bound[i].broker_symbol;
            candidate_timeframes[candidate_index] = timeframe;
            if(pass == 0) priority_count++;
         }
      }
   }

   int candidate_count = ArraySize(candidate_brokers);
   int background_count = candidate_count - priority_count;
   for(int work_index = 0; work_index < candidate_count; work_index++)
   {
      int candidate_index;
      if(work_index < priority_count)
         candidate_index = (g_pr_priority_cursor + work_index) % priority_count;
      else
         candidate_index = priority_count + ((g_pr_background_cursor + work_index - priority_count) % background_count);

      string broker_symbol = candidate_brokers[candidate_index];
      string timeframe = candidate_timeframes[candidate_index];
      if(!SymbolInfoInteger(broker_symbol, SYMBOL_SELECT))
      {
         if(!SymbolSelect(broker_symbol, true))
         {
            PrintFormat("PriceReporter: SymbolSelect failed for %s; skipped", broker_symbol);
            continue;
         }
      }

      int digits = (int)SymbolInfoInteger(broker_symbol, SYMBOL_DIGITS);
      if(digits < 0 || digits > 12) digits = 8;

      string series_key = broker_symbol + "|" + timeframe;
      datetime last_sent = PriceReporter_LastSent(series_key);
      bool is_backfill = (last_sent == 0);
      if(is_backfill && backfill_series >= PR_MAX_BACKFILL_SERIES_PER_RUN)
         continue;
      ENUM_TIMEFRAMES period = PriceReporter_TimeframeEnum(timeframe);
      int period_seconds = PeriodSeconds(period);
      int missing_estimate = (period_seconds > 0 && last_sent > 0)
         ? (int)((TimeCurrent() - last_sent) / period_seconds) + 2
         : 1;
      int bars_requested = is_backfill
         ? PR_BACKFILL_BARS
         : MathMin(PR_BACKFILL_BARS, MathMax(1, missing_estimate));
      bool is_recovery = (!is_backfill && bars_requested > 3);
      if(is_recovery && recovery_series >= PR_MAX_RECOVERY_SERIES_PER_RUN)
         continue;
      int remaining_capacity = PR_MAX_BARS_PER_REQUEST - sent_bars;
      if(remaining_capacity <= 0)
         break;
      bars_requested = MathMin(bars_requested, remaining_capacity);
      MqlRates rates[];
      ResetLastError();
      int copied = CopyRates(broker_symbol, period, 1, bars_requested, rates);
      if(copied <= 0)
      {
         if(copied < 0)
            PrintFormat("PriceReporter: CopyRates failed for %s %s, error %d", broker_symbol, timeframe, GetLastError());
         continue;
      }

      string bars_json = "";
      int included = 0;
      datetime newest_time = last_sent;
      for(int r = 0; r < copied; r++)
      {
         if(rates[r].time <= last_sent) continue;
         if(included > 0) bars_json += ",";
         bars_json +=
            "{\"time\":\"" + EASync_ToIso8601(rates[r].time) + "\","
            "\"open\":" + DoubleToString(rates[r].open, digits) + ","
            "\"high\":" + DoubleToString(rates[r].high, digits) + ","
            "\"low\":" + DoubleToString(rates[r].low, digits) + ","
            "\"close\":" + DoubleToString(rates[r].close, digits) + ","
            "\"volume\":" + IntegerToString((long)rates[r].tick_volume) + ","
            "\"spread\":" + IntegerToString((long)rates[r].spread) + ","
            "\"real_volume\":" + IntegerToString((long)rates[r].real_volume) + "}";
         included++;
         sent_bars++;
         if(rates[r].time > newest_time) newest_time = rates[r].time;
      }
      if(included == 0) continue;
      if(is_backfill) backfill_series++;
      if(is_recovery) recovery_series++;

      if(sent_series > 0) symbols_json += ",";
      symbols_json +=
         "{\"broker_symbol\":\"" + EASync_JsonEscape(broker_symbol) + "\","
         "\"timeframe\":\"" + timeframe + "\","
         "\"source_digits\":" + IntegerToString(digits) + ","
         "\"bars\":[" + bars_json + "]}";
      sent_series++;

      int pending_index = ArraySize(pending_keys);
      ArrayResize(pending_keys, pending_index + 1);
      ArrayResize(pending_times, pending_index + 1);
      pending_keys[pending_index] = series_key;
      pending_times[pending_index] = newest_time;
   }

   if(priority_count > 0) g_pr_priority_cursor = (g_pr_priority_cursor + 1) % priority_count;
   if(background_count > 0) g_pr_background_cursor = (g_pr_background_cursor + 1) % background_count;

   if(sent_series == 0)
   {
      Print("PriceReporter: no newly closed bars");
      return;
   }

   string body = "{" + symbols_json + "]}";
   string url = g_pr_base_url + "/functions/v1/report-bars";
   string headers = "Content-Type: application/json\r\nx-api-key: " + g_pr_api_key + "\r\n";

   uchar data[];
   int data_len = StringToCharArray(body, data, 0, StringLen(body), CP_UTF8);
   ArrayResize(data, data_len); // drop the trailing null StringToCharArray appends

   uchar result[];
   string result_headers;
   ResetLastError();
   int status = WebRequest("POST", url, headers, 10000, data, result, result_headers);

   if(status == -1)
   {
      int err = GetLastError();
      if(err == 4060)
         PrintFormat("PriceReporter: WebRequest blocked (error 4060) — add %s to Tools > Options > "
                     "Expert Advisors > Allow WebRequest for listed URL.", g_pr_base_url);
      else
         PrintFormat("PriceReporter: WebRequest failed, error %d", err);
      return;
   }

   string response = CharArrayToString(result, 0, WHOLE_ARRAY, CP_UTF8);
   PrintFormat("PriceReporter: sent %d series / %d newly closed bars, HTTP %d", sent_series, sent_bars, status);
   if(status == 200)
   {
      for(int i = 0; i < ArraySize(pending_keys); i++)
         PriceReporter_MarkSent(pending_keys[i], pending_times[i]);
   }
   else
      PrintFormat("PriceReporter: report-bars returned HTTP %d: %s", status, response);
}

//+------------------------------------------------------------------+
//| Public: call once from OnInit.                                     |
//+------------------------------------------------------------------+
void PriceReporter_Init(const string base_url, const string api_key, const int report_interval_seconds = 60)
{
   g_pr_base_url = base_url;
   g_pr_api_key = api_key;
   g_pr_report_interval_seconds = (report_interval_seconds > 0) ? report_interval_seconds : 60;
   g_pr_last_report = 0; // force an immediate first report after ea-sync has a response
   g_pr_priority_cursor = 0;
   g_pr_background_cursor = 0;
   PrintFormat("PriceReporter: initialized, report_interval_seconds=%d", g_pr_report_interval_seconds);
}

//+------------------------------------------------------------------+
//| Public: call every OnTimer tick after EASync_OnTimer(). Self-gates |
//| by report_interval_seconds, matching SymbolMap_OnTimer's pattern.  |
//+------------------------------------------------------------------+
void PriceReporter_OnTimer()
{
   if(g_pr_base_url == "" || g_pr_api_key == "") return;
   if(TimeCurrent() - g_pr_last_report < g_pr_report_interval_seconds) return;
   PriceReporter_Run();
}
//+------------------------------------------------------------------+
//============================================================================
// END inlined module: PriceReporter.mqh
//============================================================================


//----------------------------------------------------------------------
// Inputs — set these in the "Inputs" tab when attaching the EA to a
// chart. SupabaseApiKey is the plaintext key shown ONCE by the
// dashboard's "Provision API Key" action — see the setup guide.
//----------------------------------------------------------------------
input string SupabaseProjectUrl   = "https://qxlfnscmrhwfcpattqxa.supabase.co"; // Backend URL — leave as-is
input string TerminalApiKey       = "";  // Paste your terminal's mtk_live_... key here
input int    SyncFallbackPollSeconds = 5;  // reconciliation cadence while Realtime is unavailable
input int    SyncHealthyPollSeconds  = 30; // durable account/position snapshot cadence while Realtime is joined
input int    PositionStreamSeconds   = 2;  // ephemeral mark-to-market broadcast cadence; sends only changed state
input int    CalendarSyncMinutes  = 15;  // Economic calendar push interval
input bool   EnableCalendarSync   = true; // Turn off only if this terminal should not push calendar data
input bool   EnableWebSocketPush  = true; // Persistent WebSocket for command wake-ups and ephemeral live position state; durable polling remains the fallback
input int    PriceScanSeconds     = 5;   // local scan only; network sends occur only for newly closed bars
input int    SymbolMapRefreshHours = 24;  // Full broker-symbol rescan interval (also runs once on startup and on-demand from the dashboard)

//+------------------------------------------------------------------+
//| Expert initialization function                                   |
//+------------------------------------------------------------------+
int OnInit()
{
   if(StringLen(TerminalApiKey) == 0)
   {
      Alert("Lucre Hub EA: TerminalApiKey input is empty. Open the dashboard, provision a key for "
            "this terminal, and paste it into the EA's Inputs tab before trading will work.");
      Print("LucreHubEA: missing TerminalApiKey — EA will not sync or trade until this is set.");
      // Do not fail init: allow the chart to keep the EA attached so the user
      // can fix the input without re-dragging the EA onto the chart.
   }

   EASync_Init(SupabaseProjectUrl, TerminalApiKey, SyncFallbackPollSeconds);

   if(EnableCalendarSync)
      CalendarSync_Init(SupabaseProjectUrl, TerminalApiKey, CalendarSyncMinutes * 60);

   if(EnableWebSocketPush)
      EAStream_Init(SupabaseProjectUrl, TerminalApiKey,
                    SyncFallbackPollSeconds, SyncHealthyPollSeconds, PositionStreamSeconds);

   SymbolMap_Init(SupabaseProjectUrl, TerminalApiKey, SymbolMapRefreshHours);

   PriceReporter_Init(SupabaseProjectUrl, TerminalApiKey, PriceScanSeconds);

   // 1s base tick; each module's OnTimer self-gates on its own configured
   // interval, so a single fast timer serves all of them.
   EventSetTimer(1);

   Print("LucreHubEA: initialized. Watch the Experts tab for 'EASync:' log lines to confirm the "
         "first poll succeeds.");
   return(INIT_SUCCEEDED);
}

//+------------------------------------------------------------------+
//| Expert deinitialization function                                 |
//+------------------------------------------------------------------+
void OnDeinit(const int reason)
{
   EventKillTimer();
   EASync_Deinit();
   CalendarSync_Deinit();
   EAStream_Deinit();
   Print("LucreHubEA: deinitialized, reason=", reason);
}

//+------------------------------------------------------------------+
//| Timer function — the EA's entire network loop lives here. Never   |
//| call WebRequest() from OnTick(): it blocks price processing.      |
//+------------------------------------------------------------------+
void OnTimer()
{
   EASync_OnTimer();
   // Must stay after EASync_OnTimer(): PriceReporter uses its cached ea-sync
   // response, including bound_symbols, and should see a fresh response when
   // this tick ran a poll.
   PriceReporter_OnTimer();
   if(EnableCalendarSync)
      CalendarSync_OnTimer();
   if(EnableWebSocketPush)
      EAStream_OnTimer();

   SymbolMap_OnTimer();

   // If the backend flagged this terminal for a symbol rescan (e.g. the user
   // clicked "Rescan Symbols" in the dashboard, or this is a newly-connected
   // terminal), react to it here. EASync_Run() (called above via EASync_OnTimer,
   // or immediately on "wake" via EAStream_HandleFrame) refreshes the cached
   // response that EASync_GetLastResponse() reads.
   string last_sync_response = EASync_GetLastResponse();
   if(last_sync_response != "" &&
      EASync_JsonGetRaw(last_sync_response, 0, StringLen(last_sync_response), "force_symbol_rescan") == "true")
      SymbolMap_ForceRescan();
}

//+------------------------------------------------------------------+
//| Expert tick function — intentionally empty. This EA trades only   |
//| via server-issued commands (EASync_ExecuteCommand), never off its |
//| own chart's price ticks.                                          |
//+------------------------------------------------------------------+
void OnTick()
{
}

//+------------------------------------------------------------------+
//| v1.0.15 — previously the EA had no trade-event hook at all, so    |
//| every open/modify/close waited out EASync's own poll gate         |
//| g_es_poll_seconds before the backend learned about it, on top of |
//| however long the dashboard's poll/Realtime layer then took       |
//| layer then took to notice, together explaining the ~1 minute lag  |
//| reported live for both opening and closing an order. This fires   |
//| on every deal fill (open, close, partial close) and every SL/TP   |
//| or volume modification, and pushes the account/position snapshot  |
//| to Supabase immediately instead of waiting for the next timer.    |
//+------------------------------------------------------------------+
void OnTradeTransaction(const MqlTradeTransaction &trans,
                         const MqlTradeRequest &request,
                         const MqlTradeResult &result)
{
   if(trans.type == TRADE_TRANSACTION_DEAL_ADD ||
      trans.type == TRADE_TRANSACTION_POSITION)
      EASync_ForceSync();
}
//+------------------------------------------------------------------+
