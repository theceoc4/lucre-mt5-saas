// edge-functions.js — v1.0.3
//
// Thin client for the dashboard-facing Supabase Edge Functions. Originally
// shipped in mt5_backend v1.0.1 (provision-terminal-key, signal-action,
// manual-order, position-action); request-symbol-rescan (mt5_backend
// v1.0.12, broker symbol mapping) added below. ea-sync and report-symbols
// are EA-only (custom x-api-key auth, verify_jwt:false) and have no
// dashboard UI counterpart by design — they are not wired here.
//
// Every call re-fetches the current Supabase session and forwards its access
// token as a Bearer credential, matching each function's JWT-verified auth
// model. Known error codes returned by the functions are mapped to short,
// human-readable messages so calling code can show err.message directly.

import { supabase, SUPABASE_URL, SUPABASE_ANON_KEY } from './supabase-client.js';

const ERROR_MESSAGES = {
  missing_authorization: 'Your session has expired — please sign in again.',
  invalid_session: 'Your session has expired — please sign in again.',
  method_not_allowed: 'Something went wrong sending that request.',
  invalid_json_body: 'Something went wrong sending that request.',
  forbidden: "You don't have access to this terminal or position.",
  lookup_failed: 'Something went wrong looking that up. Try again.',
  insert_failed: 'Something went wrong submitting that. Try again.',
  update_failed: 'Something went wrong saving that. Try again.',
  duplicate_request: 'That request was already submitted.',
  already_closing: 'This position is already closing.',

  terminal_id_required: 'Select a terminal first.',
  terminal_not_found: 'That terminal could not be found.',

  symbol_required: 'Symbol is required.',
  invalid_symbol_format: 'Enter a valid symbol (3-20 letters/numbers).',
  symbol_already_mapped: (d) => d?.detail || 'That pair is already tracked for this terminal.',
  side_required: 'Side is required.',
  volume_required: 'Volume is required.',
  invalid_side: 'Side must be buy or sell.',
  invalid_volume: 'Volume must be greater than zero.',
  max_manual_lot_size_exceeded: (d) =>
    `Volume exceeds this terminal's max manual lot size of ${d?.max ?? '—'}.`,
  max_open_positions_reached: (d) =>
    `This terminal already has the maximum of ${d?.max ?? '—'} open positions.`,
  max_daily_loss_reached: (d) =>
    `Daily loss cap of $${d?.max_daily_loss_usd ?? '—'} reached (realized today: $${Number(d?.realized_today ?? 0).toFixed(2)}).`,
  sl_and_sl_pips_conflict: 'Pass either a stop-loss price or a pip distance, not both.',
  tp_and_tp_pips_conflict: 'Pass either a take-profit price or a pip distance, not both.',
  invalid_sl_pips: 'Stop-loss distance must be greater than zero.',
  invalid_tp_pips: 'Take-profit distance must be greater than zero.',

  position_id_required: 'Select a position first.',
  position_not_found: 'That position could not be found.',
  position_not_open: (d) => `This position is no longer open (status: ${d?.status ?? 'unknown'}).`,
  invalid_action: 'Invalid action.',
  sl_or_tp_required_for_modify: 'Enter a stop loss, take profit, or a clear action to modify.',

  signal_delivery_id_required: 'That signal could not be found.',
  signal_delivery_not_found: 'That signal could not be found.',
  signal_not_found: 'That signal could not be found.',
  signal_expired: 'This signal has expired.',
  already_acted: (d) => `This signal was already acted on (status: ${d?.status ?? 'unknown'}).`,
};

function friendlyMessage(code, data) {
  const entry = ERROR_MESSAGES[code];
  if (typeof entry === 'function') return entry(data);
  if (typeof entry === 'string') return entry;
  return data?.detail || (code ? `Something went wrong (${code}).` : 'Something went wrong.');
}

/**
 * Calls a Supabase Edge Function with the current user's session token.
 * Throws an Error with a friendly `.message`; the raw error code, HTTP
 * status, and response body are attached as `.code`, `.status`, `.data`.
 */
export async function callEdgeFunction(name, body) {
  const { data: sessionData, error: sessionError } = await supabase.auth.getSession();
  const token = sessionData?.session?.access_token;
  if (sessionError || !token) {
    throw new Error('Your session has expired — please sign in again.');
  }

  let res;
  try {
    res = await fetch(`${SUPABASE_URL}/functions/v1/${name}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        apikey: SUPABASE_ANON_KEY,
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(body ?? {}),
    });
  } catch (networkErr) {
    console.error(`edge function ${name} network error`, networkErr);
    throw new Error('Could not reach the server. Check your connection and try again.');
  }

  let payload = null;
  try {
    payload = await res.json();
  } catch {
    payload = null;
  }

  if (!res.ok) {
    const code = payload?.error || `http_${res.status}`;
    const err = new Error(friendlyMessage(code, payload || {}));
    err.code = code;
    err.status = res.status;
    err.data = payload;
    throw err;
  }

  return payload;
}

export function provisionTerminalKey(terminal_id) {
  return callEdgeFunction('provision-terminal-key', { terminal_id });
}

export function tapSignal(signal_delivery_id) {
  return callEdgeFunction('signal-action', { signal_delivery_id });
}

export function placeManualOrder(order) {
  return callEdgeFunction('manual-order', order);
}

/**
 * sl/tp: pass a number to set it, or omit the key entirely to leave it
 * unchanged. Pass clear_sl / clear_tp as true to explicitly clear an
 * existing stop loss / take profit to empty (v1.0.2+). clear_sl/clear_tp
 * and sl/tp are independent — don't set both for the same field.
 */
export function modifyPosition(
  position_id,
  { sl, tp, clear_sl, clear_tp, max_deviation_points, client_request_id } = {}
) {
  const body = { position_id, action: 'modify' };
  if (sl !== undefined) body.sl = sl;
  if (tp !== undefined) body.tp = tp;
  if (clear_sl !== undefined) body.clear_sl = clear_sl;
  if (clear_tp !== undefined) body.clear_tp = clear_tp;
  if (max_deviation_points !== undefined) body.max_deviation_points = max_deviation_points;
  if (client_request_id !== undefined) body.client_request_id = client_request_id;
  return callEdgeFunction('position-action', body);
}

export function closePosition(position_id, { max_deviation_points, client_request_id } = {}) {
  const body = { position_id, action: 'close' };
  if (max_deviation_points !== undefined) body.max_deviation_points = max_deviation_points;
  if (client_request_id !== undefined) body.client_request_id = client_request_id;
  return callEdgeFunction('position-action', body);
}

/**
 * Flags a terminal's broker symbol list for a fresh scan (v1.0.12+). The EA
 * picks this up on its next ea-sync poll and reports back via
 * report-symbols, which clears the flag and updates symbol_mappings —
 * there's no synchronous result here, just an acknowledgement that the
 * request was recorded.
 */
export function rescanSymbols(terminal_id) {
  return callEdgeFunction('request-symbol-rescan', { terminal_id });
}

/**
 * Registers a user-typed pair for this terminal (v1.0.14, item 13's "add a
 * pair" workflow). Stores a pending_manual symbol_mappings placeholder and
 * flags the terminal for a fresh rescan — the same force_symbol_rescan flag
 * rescanSymbols() sets, so the existing rescan-poll UI can be reused as-is
 * to show a "searching..." state until the EA's next scan resolves it.
 */
export function bindSymbol(terminal_id, symbol) {
  return callEdgeFunction('bind-symbol', { terminal_id, symbol });
}
