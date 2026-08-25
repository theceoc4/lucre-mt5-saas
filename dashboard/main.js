import { supabase, SUPABASE_URL, SUPABASE_ANON_KEY } from './supabase-client.js';
import {
  provisionTerminalKey,
  tapSignal,
  placeManualOrder,
  modifyPosition,
  closePosition,
  rescanSymbols,
  bindSymbol,
} from './edge-functions.js';

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
const state = {
  session: null,
  profile: null,
  terminals: [],
  activeTerminalId: null,
  strategies: [],
  signals: [],
  signalDeliveries: [],
  tradeHistory: [],
  accountHistory: [],
  pendingCommandId: null,
  agentPolicies: [],
  positions: [],
  pendingSignals: [],
  symbolSettings: [],
  symbolMappings: [],
  calendarEvents: [],
  scenarioStats: [],
  activeTab: 'overview',
  // v1.0.14 — item 3: P/L Over Time card filters (timeframe + manual/auto/all).
  plFilter: { timeframe: '30d', source: 'all' },
};

// Bootstrap pair universe — mirrors the backend's full canonical symbol
// list (supabase/functions/_shared/canonical-symbols.ts). Used ONLY as a
// pre-scan fallback (before a terminal has ever reported its broker symbol
// universe via SymbolMap.mqh) so the Pairs page has something to configure.
// Once symbol_mappings rows exist for a terminal, getAvailableSymbols()
// below takes over and reflects exactly what that broker actually supports
// — v1.0.10 fix: this list used to be hardcoded to 14 FX/metal pairs, which
// both under-represented the Pairs page (no indices/crypto) and let the
// New Position modal accept any free-typed symbol, causing
// "symbol_unavailable" errors outside the Pairs page.
const SYMBOL_UNIVERSE = [
  // FX majors
  'EURUSD', 'GBPUSD', 'AUDUSD', 'NZDUSD', 'USDCAD', 'USDCHF', 'USDJPY',
  // FX crosses
  'EURGBP', 'EURJPY', 'EURCHF', 'EURCAD', 'EURAUD', 'EURNZD',
  'GBPJPY', 'GBPCHF', 'GBPCAD', 'GBPAUD', 'GBPNZD',
  'AUDJPY', 'AUDCHF', 'AUDCAD', 'AUDNZD',
  'NZDJPY', 'NZDCHF', 'NZDCAD', 'CADJPY', 'CADCHF', 'CHFJPY',
  // Metals
  'XAUUSD', 'XAGUSD', 'XPTUSD', 'XPDUSD',
  // Indices
  'US30', 'US500', 'USTEC', 'UK100', 'GER40', 'FRA40', 'EU50', 'JP225', 'AUS200', 'HK50',
  // Crypto
  'BTCUSD', 'ETHUSD', 'LTCUSD', 'XRPUSD', 'BCHUSD', 'ADAUSD', 'SOLUSD', 'DOGEUSD', 'DOTUSD', 'BNBUSD',
];
const TIMEFRAMES = ['M1', 'M5', 'M15', 'M30', 'H1', 'H4', 'D1'];

let volumeChartInstance = null;
let plChartInstance = null;
// Realtime keeps positions/signal queue live while a terminal is active;
// polling remains as a reduced-frequency safety net for missed events.
// v1.0.23 -- a healthy Realtime channel is the primary update path, with a
// once-per-minute reconciliation read. If the channel drops, the dashboard
// automatically switches to an eight-second fallback until it reconnects.
let positionPollIntervalId = null;
const POSITION_POLL_FALLBACK_MS = 8000;
const POSITION_POLL_HEALTHY_MS = 60000;
let realtimeIsHealthy = false;
let realtimeChannel = null;
let realtimeReconnectTimer = null;
let positionStreamRequestIntervalId = null;
let streamedPositionFields = new Map();
const POSITION_STREAM_TTL_MS = 10000;
// Rescan-in-flight poll — checks mt5_terminals.last_symbol_scan_at every 5s
// (up to 60s) after "Rescan Symbols" is clicked, since report-symbols runs
// asynchronously once the EA's next ea-sync poll picks up the flag.
let symbolRescanPollId = null;

// ---------------------------------------------------------------------------
// DOM refs
// ---------------------------------------------------------------------------
const authGate = document.getElementById('auth-gate');
const dashboardRoot = document.getElementById('dashboard-root');
const authForm = document.getElementById('auth-form');
const authMessage = document.getElementById('auth-message');
const authSubmit = document.getElementById('auth-submit');

const accountMenuEmail = document.getElementById('account-menu-email');
const profileAvatar = document.getElementById('profile-avatar');
const terminalStatusLabel = document.getElementById('terminal-status-label');
const textAccountName = document.getElementById('text-account-name');
const terminalSelect = document.getElementById('terminal-select');
const textGreeting = document.getElementById('text-greeting');
const textGreetingSub = document.getElementById('text-greeting-sub');

const balanceWidget = document.getElementById('balance-widget');
const balanceWidgetBalance = document.getElementById('balance-widget-balance');
const balanceWidgetEquity = document.getElementById('balance-widget-equity');
const balanceWidgetMargin = document.getElementById('balance-widget-margin');
const bannerAutotrading = document.getElementById('banner-autotrading');
const bannerCommandStatus = document.getElementById('banner-command-status');

const textSignalTotal = document.getElementById('text-signal-total');
const countExecuted = document.getElementById('count-executed');
const countBlocked = document.getElementById('count-blocked');
const countExpired = document.getElementById('count-expired');
const chartEmptyOverlay = document.getElementById('chart-empty-overlay');
const textChartMonth = document.getElementById('text-chart-month');

const strategyList = document.getElementById('strategy-list');

const textWinrateValue = document.getElementById('text-winrate-value');
const textWinrateSub = document.getElementById('text-winrate-sub');
const winrateGaugeArc = document.getElementById('winrate-gauge-arc');
const textAvgRr = document.getElementById('text-avg-rr');

const textRiskBlocked = document.getElementById('text-risk-blocked');
const textRiskDownweighted = document.getElementById('text-risk-downweighted');
const riskGaugeArc = document.getElementById('risk-gauge-arc');
const textRiskTrend = document.getElementById('text-risk-trend');

const viewDashboard = document.getElementById('view-dashboard');
const viewPairs = document.getElementById('view-pairs');
const pairGrid = document.getElementById('pair-grid');
const buttonRescanSymbols = document.getElementById('button-rescan-symbols');
const buttonAddPair = document.getElementById('button-add-pair');
const addPairRow = document.getElementById('add-pair-row');
const addPairInput = document.getElementById('add-pair-input');
const buttonCancelPair = document.getElementById('button-cancel-pair');
const addPairStatus = document.getElementById('add-pair-status');
const symbolMappingStatus = document.getElementById('symbol-mapping-status');
const symbolMappingBody = document.getElementById('symbol-mapping-body');
const plTimeframeSelect = document.getElementById('pl-timeframe-select');
const plSourceSelect = document.getElementById('pl-source-select');
const plSummaryValue = document.getElementById('pl-summary-value');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function cssVar(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

function hexToRgba(hex, alpha) {
  const h = (hex || '#d7e64e').replace('#', '');
  const r = parseInt(h.substring(0, 2), 16);
  const g = parseInt(h.substring(2, 4), 16);
  const b = parseInt(h.substring(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

function initials(text) {
  if (!text) return '?';
  const parts = text.trim().split(/\s+/);
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[1][0]).toUpperCase();
}

function setAuthMessage(text, isError = true) {
  authMessage.textContent = text || '';
  authMessage.style.color = isError ? 'var(--color-danger, #c0432f)' : 'var(--color-accent)';
}

// ---------------------------------------------------------------------------
// Auth gate visibility
// ---------------------------------------------------------------------------
function showAuthGate() {
  authGate.setAttribute('aria-hidden', 'false');
  authGate.classList.add('is-open');
  dashboardRoot.setAttribute('aria-hidden', 'true');
  dashboardRoot.style.display = 'none';
}

function showDashboard() {
  authGate.setAttribute('aria-hidden', 'true');
  authGate.classList.remove('is-open');
  dashboardRoot.setAttribute('aria-hidden', 'false');
  dashboardRoot.style.display = 'flex';
  // Tab strip is hidden (display:none ancestor) until now, so re-measure the
  // scroll-fade affordance once it actually has layout dimensions.
  requestAnimationFrame(() => window.updateTabRowOverflow?.());
}

// ---------------------------------------------------------------------------
// Auth form (sign in / sign up)
// ---------------------------------------------------------------------------
authForm?.addEventListener('submit', async (e) => {
  e.preventDefault();
  const activeTab = document.querySelector('.auth-tab.active')?.dataset.authTab || 'signin';
  const email = document.getElementById('auth-email').value.trim();
  const password = document.getElementById('auth-password').value;

  authSubmit.disabled = true;
  setAuthMessage('Working…', false);

  try {
    if (activeTab === 'signup') {
      const { data, error } = await supabase.auth.signUp({ email, password });
      if (error) throw error;
      if (data.session) {
        setAuthMessage('Account created.', false);
      } else {
        setAuthMessage('Check your email to confirm your account, then sign in.', false);
      }
    } else {
      const { error } = await supabase.auth.signInWithPassword({ email, password });
      if (error) throw error;
    }
  } catch (err) {
    setAuthMessage(err.message || 'Something went wrong.');
  } finally {
    authSubmit.disabled = false;
  }
});

window.addEventListener('lucre:auth-tab-changed', (e) => {
  authSubmit.textContent = e.detail === 'signup' ? 'Create account' : 'Sign in';
  document.getElementById('auth-password').setAttribute(
    'autocomplete',
    e.detail === 'signup' ? 'new-password' : 'current-password'
  );
  setAuthMessage('');
});

document.getElementById('button-sign-out')?.addEventListener('click', async () => {
  await supabase.auth.signOut();
});

async function accountManagement(action, body = {}) {
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  if (!token) throw new Error('Your session has expired — please sign in again.');
  const res = await fetch(`${SUPABASE_URL}/functions/v1/account-management`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${token}` },
    body: JSON.stringify({ action, ...body }),
  });
  const payload = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(payload.detail || payload.error || 'Account action failed.');
  return payload;
}

document.getElementById('button-account-settings')?.addEventListener('click', () => {
  window.LucreUI?.openModal('modal-account-settings');
});
document.getElementById('form-account-profile')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = e.currentTarget;
  const message = document.getElementById('account-profile-message');
  try {
    await accountManagement('update_profile', Object.fromEntries(new FormData(form)));
    if (message) { message.style.color = 'var(--color-accent)'; message.textContent = 'Profile saved.'; }
    await loadProfile();
  } catch (err) { if (message) { message.style.color = 'var(--color-negative)'; message.textContent = err.message; } }
});
document.getElementById('button-reset-password')?.addEventListener('click', async () => {
  const message = document.getElementById('account-profile-message');
  const { error } = await supabase.auth.resetPasswordForEmail(state.session.user.email, { redirectTo: window.location.origin });
  if (message) { message.style.color = error ? 'var(--color-negative)' : 'var(--color-accent)'; message.textContent = error ? error.message : 'Password-reset email sent.'; }
});
let pendingAccountAction = null;
function openAccountConfirmation(action) {
  pendingAccountAction = action;
  const isDelete = action === 'delete_account';
  document.getElementById('account-confirm-title').textContent = isDelete ? 'Delete account permanently' : 'Reset trading data';
  document.getElementById('account-confirm-copy').textContent = isDelete ? 'This permanently deletes your login, profile, terminals and all associated information. Type DELETE MY ACCOUNT to continue.' : 'This erases all logged trades, sessions, strategies, signals, analytics and terminal connections. Your login and profile remain. Type RESET MY DATA to continue.';
  document.getElementById('account-confirmation-input').value = '';
  document.getElementById('account-confirm-message').textContent = '';
  window.LucreUI?.openModal('modal-account-confirm');
}
document.getElementById('button-reset-account-data')?.addEventListener('click', () => openAccountConfirmation('reset_account_data'));
document.getElementById('button-delete-account')?.addEventListener('click', () => openAccountConfirmation('delete_account'));
document.getElementById('button-confirm-account-action')?.addEventListener('click', async () => {
  const input = document.getElementById('account-confirmation-input');
  const message = document.getElementById('account-confirm-message');
  const expected = pendingAccountAction === 'delete_account' ? 'DELETE MY ACCOUNT' : 'RESET MY DATA';
  if (input.value !== expected) { message.textContent = `Type ${expected} exactly to continue.`; return; }
  try {
    await accountManagement(pendingAccountAction, { confirmation: input.value });
    if (pendingAccountAction === 'delete_account') await supabase.auth.signOut();
    else window.location.reload();
  } catch (err) { message.textContent = err.message; }
});

// ---------------------------------------------------------------------------
// View switching (nav pills) — only two real views exist: dashboard (behind
// Analytics) and pairs (behind Pairs). Every other decorative pill falls
// back to the dashboard view.
// ---------------------------------------------------------------------------
function setActiveView(view) {
  const isPairs = view === 'pairs';
  viewPairs.hidden = !isPairs;
  viewDashboard.hidden = isPairs;
  document.querySelectorAll('.nav-pill').forEach((pill) => {
    const pillView = pill.dataset.view || 'dashboard';
    pill.classList.toggle('active', pillView === view);
  });
  if (isPairs) {
    renderPairsView();
    renderSymbolMappingPanel();
  }
}

document.querySelectorAll('.nav-pill').forEach((pill) => {
  pill.addEventListener('click', (e) => {
    e.preventDefault();
    setActiveView(pill.dataset.view || 'dashboard');
  });
});

// ---------------------------------------------------------------------------
// Connect account modal
// ---------------------------------------------------------------------------
document.getElementById('button-connect-account')?.addEventListener('click', () => {
  window.LucreUI.openModal('modal-connect-account');
});

document.getElementById('form-connect-account')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = e.target;
  const msg = document.getElementById('connect-account-message');
  msg.style.color = 'var(--color-danger, #c0432f)';
  msg.textContent = 'Connecting…';

  const payload = {
    user_id: state.session.user.id,
    label: form.label.value.trim(),
    broker: form.broker.value.trim() || null,
    account_login: form.account_login.value.trim() || null,
    server: form.server.value.trim() || null,
    is_live: form.is_live.checked,
    status: 'disconnected',
  };

  const { error } = await supabase.from('mt5_terminals').insert(payload);
  if (error) {
    msg.textContent = error.message;
    return;
  }

  msg.style.color = 'var(--color-accent)';
  msg.textContent = 'Account connected.';
  form.reset();
  form.is_live.checked = true;
  setTimeout(() => {
    window.LucreUI.closeModal(document.getElementById('modal-connect-account'));
    msg.textContent = '';
  }, 700);

  await loadTerminals();
});

// ---------------------------------------------------------------------------
// Add strategy modal
// ---------------------------------------------------------------------------
// v1.0.11 -- "Add a strategy" now offers a fixed set of pre-built,
// pre-configured strategies (see #strategy-kind options) instead of a
// free-parameter form.
// v1.0.12 -- the Symbols field was a native <select multiple>, which (a)
// requires holding Cmd/Ctrl to select more than one pair — most users just
// click each pair in turn, which replaces the previous selection instead
// of adding to it — and (b) can't be multi-selected at all on many mobile
// browsers. Replaced with a single-pick dropdown + explicit "Add" button
// that appends to a persistent, visible chip list (strategySelectedSymbols).
// Each add removes that pair from the dropdown (can't add twice); each
// chip has its own remove button that puts the pair back in the dropdown.
let strategySelectedSymbols = [];

// v1.0.13 -- public.strategies.signal_family has been NOT NULL (no default)
// since migration 020 (v1.0.3), but no insert path anywhere in this file
// ever supplied it -- every Add-Strategy submission has been failing with
// "null value in column signal_family ... violates not-null constraint"
// since that migration shipped (confirmed: the strategies table has zero
// rows). Maps each implemented strategy `kind` (strategy-signal-engine/
// index.ts) to the architecture spec's signal_family taxonomy (spec §5.2,
// S1-S10 catalog) so the dashboard's Strategies page and the future
// family-level throttle engine can group correctly:
//   vwap_reversion -> vwap_reversion (S2/S8, direct match)
//   orb_breakout   -> breakout        (S3, opening range breakout)
//   bb_fade        -> support_resistance_bounce (S6 -- fades a tested
//                      band/level with rejection-wick confirmation, same
//                      pattern bb_fade's current.close > current.low check
//                      implements against the BB band)
//   ema_trend      -> momentum        (S1 -- fires at the EMA9/EMA21
//                      crossover itself, i.e. momentum continuation, not
//                      a pullback-entry or H4 swing setup)
const STRATEGY_KIND_SIGNAL_FAMILY = {
  vwap_reversion: 'vwap_reversion',
  orb_breakout: 'breakout',
  bb_fade: 'support_resistance_bounce',
  ema_trend: 'momentum',
};

function updateStrategyParameterVisibility() {
  const kind = document.getElementById('strategy-kind')?.value;
  const emaFields = document.getElementById('strategy-ema-parameters');
  if (emaFields) emaFields.hidden = kind !== 'ema_trend';
}

document.getElementById('strategy-kind')?.addEventListener('change', updateStrategyParameterVisibility);

// v1.0.19 -- checkbox-based multi-select popover. Renders a checkbox per
// remaining pair, grouped in the fixed asset-class order from
// groupSymbolsByClass(). The "Add" button (below) reads every currently
// checked box and adds them all to strategySelectedSymbols in one action,
// so several pairs can be picked before a single Add click — no repeated
// open/select/Add cycles, and no Cmd/Ctrl or mobile multi-touch tricks
// required.
function populateStrategySymbolSelect() {
  const toggle = document.getElementById('strategy-symbol-toggle');
  const toggleLabel = document.getElementById('strategy-symbol-toggle-label');
  const checklist = document.getElementById('strategy-symbol-checklist');
  if (!toggle || !checklist) return;
  const available = getAvailableSymbols();
  const remaining = available.filter((s) => !strategySelectedSymbols.includes(s.symbol));

  if (available.length === 0) {
    checklist.innerHTML = '<p class="symbol-multiselect-empty">No mapped pairs yet — bind one on the Pairs page first</p>';
    toggle.disabled = true;
    toggleLabel.textContent = 'No pairs available';
    return;
  }

  if (remaining.length === 0) {
    checklist.innerHTML = '<p class="symbol-multiselect-empty">All bound pairs added</p>';
    toggle.disabled = true;
    toggleLabel.textContent = 'All bound pairs added';
    return;
  }

  toggle.disabled = false;
  toggleLabel.textContent = 'Select pairs…';
  checklist.innerHTML = groupSymbolsByClass(remaining)
    .map(
      ({ label, symbols }) => `
        <div class="symbol-multiselect-group">
          <div class="symbol-multiselect-group-label">${label}</div>
          ${symbols
            .map(
              (sym) => `
            <label class="symbol-multiselect-item">
              <input type="checkbox" value="${sym}" data-symbol-checkbox />
              <span>${sym}</span>
            </label>`
            )
            .join('')}
        </div>`
    )
    .join('');
}

function updateStrategySymbolToggleLabel() {
  const toggleLabel = document.getElementById('strategy-symbol-toggle-label');
  const checklist = document.getElementById('strategy-symbol-checklist');
  if (!toggleLabel || !checklist) return;
  const checkedCount = checklist.querySelectorAll('[data-symbol-checkbox]:checked').length;
  if (checkedCount === 0) {
    if (toggleLabel.textContent !== 'All bound pairs added' && toggleLabel.textContent !== 'No pairs available') {
      toggleLabel.textContent = 'Select pairs…';
    }
  } else {
    toggleLabel.textContent = `${checkedCount} pair${checkedCount === 1 ? '' : 's'} checked`;
  }
}

function closeStrategySymbolPanel() {
  const panel = document.getElementById('strategy-symbol-panel');
  const toggle = document.getElementById('strategy-symbol-toggle');
  if (panel) panel.hidden = true;
  if (toggle) toggle.setAttribute('aria-expanded', 'false');
}

document.getElementById('strategy-symbol-toggle')?.addEventListener('click', (e) => {
  e.stopPropagation();
  const panel = document.getElementById('strategy-symbol-panel');
  const toggle = document.getElementById('strategy-symbol-toggle');
  if (!panel || !toggle || toggle.disabled) return;
  const isOpen = !panel.hidden;
  if (isOpen) {
    closeStrategySymbolPanel();
  } else {
    panel.hidden = false;
    toggle.setAttribute('aria-expanded', 'true');
  }
});

document.getElementById('strategy-symbol-checklist')?.addEventListener('click', (e) => {
  e.stopPropagation();
  if (e.target.matches('[data-symbol-checkbox]')) updateStrategySymbolToggleLabel();
});

document.getElementById('strategy-symbol-panel')?.addEventListener('click', (e) => e.stopPropagation());

// Close the panel on any outside click, mirroring the account-menu/nav-menu
// click-outside pattern already used elsewhere in this app (see app.js).
document.addEventListener('click', () => closeStrategySymbolPanel());

function renderStrategySymbolChips() {
  const list = document.getElementById('strategy-symbols-chips');
  const hint = document.getElementById('strategy-symbols-hint');
  if (!list) return;

  if (strategySelectedSymbols.length === 0) {
    list.innerHTML = '';
    if (hint) hint.textContent = 'No pairs added yet — check one or more above, then click Add.';
    return;
  }

  if (hint) hint.textContent = `${strategySelectedSymbols.length} pair${strategySelectedSymbols.length === 1 ? '' : 's'} added.`;
  list.innerHTML = strategySelectedSymbols
    .map(
      (sym) =>
        `<span class="symbol-chip" data-symbol="${sym}">${sym}<button type="button" aria-label="Remove ${sym}" data-remove-symbol="${sym}">×</button></span>`
    )
    .join('');
}

document.getElementById('strategy-symbols-chips')?.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-remove-symbol]');
  if (!btn) return;
  const sym = btn.getAttribute('data-remove-symbol');
  strategySelectedSymbols = strategySelectedSymbols.filter((s) => s !== sym);
  renderStrategySymbolChips();
  populateStrategySymbolSelect();
});

document.getElementById('button-add-strategy-symbol')?.addEventListener('click', () => {
  const checklist = document.getElementById('strategy-symbol-checklist');
  if (!checklist) return;
  const checked = [...checklist.querySelectorAll('[data-symbol-checkbox]:checked')].map((el) => el.value);
  if (checked.length === 0) return;
  checked.forEach((sym) => {
    if (!strategySelectedSymbols.includes(sym)) strategySelectedSymbols.push(sym);
  });
  renderStrategySymbolChips();
  populateStrategySymbolSelect();
  closeStrategySymbolPanel();
});

function resetStrategyModalToAddMode() {
  const form = document.getElementById('form-add-strategy');
  if (form) form.edit_id.value = '';
  document.getElementById('add-strategy-title').textContent = 'Add a strategy';
  document.getElementById('add-strategy-sub').textContent =
    'Pick a ready-made strategy, choose which of your bound pairs it applies to, and name this configuration. Add as many separate configurations as you like — each one runs independently.';
  document.getElementById('add-strategy-submit').textContent = 'Add strategy';
  document.getElementById('button-delete-strategy').hidden = true;
}

document.getElementById('button-add-strategy')?.addEventListener('click', () => {
  if (!state.activeTerminalId) {
    alert('Connect an MT5 account first — strategies belong to a terminal.');
    return;
  }
  const form = document.getElementById('form-add-strategy');
  form.reset();
  updateStrategyParameterVisibility();
  resetStrategyModalToAddMode();
  strategySelectedSymbols = [];
  renderStrategySymbolChips();
  populateStrategySymbolSelect();
  window.LucreUI.openModal('modal-add-strategy');
});

// v1.0.17 -- edit strategy parameters after creation. Reuses the add-strategy
// modal/form in "edit" mode (edit_id set) rather than a second near-duplicate
// form, so kind/signal_family stay in sync via the same STRATEGY_KIND_SIGNAL_FAMILY
// mapping used at creation time.
function openEditStrategyModal(id) {
  const strategy = state.strategies.find((s) => s.id === id);
  if (!strategy) return;

  const form = document.getElementById('form-add-strategy');
  form.reset();
  form.edit_id.value = strategy.id;
  form.kind.value = strategy.kind;
  form.name.value = strategy.name;
  form.delivery_mode.value = strategy.delivery_mode;
  form.max_lot_size.value = strategy.max_lot_size;
  form.ema_fast_period.value = strategy.config?.ema_fast_period ?? 9;
  form.ema_slow_period.value = strategy.config?.ema_slow_period ?? 21;
  updateStrategyParameterVisibility();

  strategySelectedSymbols = (strategy.symbols || []).slice();
  renderStrategySymbolChips();
  populateStrategySymbolSelect();

  document.getElementById('add-strategy-title').textContent = 'Edit strategy';
  document.getElementById('add-strategy-sub').textContent =
    'Update this configuration\'s pairs, delivery mode, or lot size. Changes apply to future signals only — in-flight signals and open positions are unaffected.';
  document.getElementById('add-strategy-submit').textContent = 'Save changes';
  document.getElementById('button-delete-strategy').hidden = false;

  window.LucreUI.openModal('modal-add-strategy');
}

async function handleDeleteStrategy(id) {
  const strategy = state.strategies.find((s) => s.id === id);
  if (!strategy) return;
  if (
    !confirm(
      `Delete "${strategy.name}"? This stops it from generating new signals. Past signals and trade history for this strategy are kept, but will show as "deleted strategy".`
    )
  )
    return;

  const { error } = await supabase.from('strategies').delete().eq('id', id);
  if (error) {
    alert(`Could not delete strategy: ${error.message}`);
    return;
  }
  await loadStrategies();
  await loadTradeHistory();
}

document.getElementById('button-delete-strategy')?.addEventListener('click', () => {
  const form = document.getElementById('form-add-strategy');
  const id = form.edit_id.value;
  if (!id) return;
  handleDeleteStrategy(id).then(() => {
    window.LucreUI.closeModal(document.getElementById('modal-add-strategy'));
  });
});

document.getElementById('form-add-strategy')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = e.target;
  const msg = document.getElementById('add-strategy-message');
  msg.style.color = 'var(--color-danger, #c0432f)';
  msg.textContent = 'Saving…';

  const symbols = strategySelectedSymbols.slice();

  if (symbols.length === 0) {
    msg.textContent = 'Add at least one pair before saving.';
    return;
  }

  const editId = form.edit_id.value;
  const fastEma = Math.min(99, Math.max(1, parseInt(form.ema_fast_period.value, 10) || 9));
  const slowEma = Math.min(100, Math.max(fastEma + 1, parseInt(form.ema_slow_period.value, 10) || 21));

  const payload = {
    terminal_id: state.activeTerminalId,
    name: form.name.value.trim(),
    kind: form.kind.value,
    signal_family: STRATEGY_KIND_SIGNAL_FAMILY[form.kind.value] || 'momentum',
    delivery_mode: form.delivery_mode.value,
    symbols,
    max_lot_size: parseFloat(form.max_lot_size.value) || 0.01,
    config: form.kind.value === 'ema_trend'
      ? { ...(state.strategies.find((strategy) => strategy.id === editId)?.config || {}), ema_fast_period: fastEma, ema_slow_period: slowEma }
      : (state.strategies.find((strategy) => strategy.id === editId)?.config || {}),
  };

  const { error } = editId
    ? await supabase.from('strategies').update(payload).eq('id', editId)
    : await supabase.from('strategies').insert({ ...payload, enabled: true });
  if (error) {
    msg.textContent = error.message;
    return;
  }

  msg.style.color = 'var(--color-accent)';
  msg.textContent = editId ? 'Strategy updated.' : 'Strategy added.';
  form.reset();
  updateStrategyParameterVisibility();
  resetStrategyModalToAddMode();
  strategySelectedSymbols = [];
  renderStrategySymbolChips();
  setTimeout(() => {
    window.LucreUI.closeModal(document.getElementById('modal-add-strategy'));
    msg.textContent = '';
  }, 700);

  await loadStrategies();
});

// ---------------------------------------------------------------------------
// Terminal API key modal
// ---------------------------------------------------------------------------
document.getElementById('button-terminal-key')?.addEventListener('click', () => {
  openTerminalKeyModal();
});

function openTerminalKeyModal() {
  const active = state.terminals.find((t) => t.id === state.activeTerminalId);
  const meta = document.getElementById('terminal-key-meta');
  const display = document.getElementById('terminal-key-display');
  const warning = document.getElementById('terminal-key-warning');
  const msg = document.getElementById('terminal-key-message');
  display.hidden = true;
  warning.hidden = true;
  msg.textContent = '';

  if (active?.api_key_last_four) {
    const rotated = active.api_key_last_rotated_at
      ? new Date(active.api_key_last_rotated_at).toLocaleString()
      : 'unknown time';
    meta.textContent = `Current key ends in •••• ${active.api_key_last_four} — rotated ${rotated}.`;
  } else {
    meta.textContent = 'No key generated yet for this terminal.';
  }

  window.LucreUI.openModal('modal-terminal-key');
}

document.getElementById('button-generate-key')?.addEventListener('click', async () => {
  if (!state.activeTerminalId) return;
  const btn = document.getElementById('button-generate-key');
  const msg = document.getElementById('terminal-key-message');
  const display = document.getElementById('terminal-key-display');
  const warning = document.getElementById('terminal-key-warning');
  const valueEl = document.getElementById('terminal-key-value');
  const meta = document.getElementById('terminal-key-meta');

  btn.disabled = true;
  msg.style.color = 'var(--color-accent)';
  msg.textContent = 'Generating…';

  try {
    const result = await provisionTerminalKey(state.activeTerminalId);
    valueEl.textContent = result.api_key;
    display.hidden = false;
    warning.hidden = false;
    msg.textContent = 'New key generated.';
    meta.textContent = `Current key ends in •••• ${result.api_key_last_four} — rotated ${new Date(result.rotated_at).toLocaleString()}.`;
    await loadTerminals();
  } catch (err) {
    msg.style.color = 'var(--color-negative)';
    msg.textContent = err.message;
  } finally {
    btn.disabled = false;
  }
});

document.getElementById('button-copy-key')?.addEventListener('click', async () => {
  const valueEl = document.getElementById('terminal-key-value');
  const btn = document.getElementById('button-copy-key');
  try {
    await navigator.clipboard.writeText(valueEl.textContent || '');
    const original = btn.textContent;
    btn.textContent = 'Copied';
    setTimeout(() => {
      btn.textContent = original;
    }, 1500);
  } catch (err) {
    console.error('copy key failed', err);
  }
});

// ---------------------------------------------------------------------------
// New manual order modal
// ---------------------------------------------------------------------------
// v1.0.10 — populates the Symbol dropdown from this terminal's resolved
// symbol_mappings (same source as the Pairs page, see getAvailableSymbols())
// instead of a free-text input. This is the fix for the "symbol_unavailable"
// bug: a manual order placed here can now only ever reference an exact,
// broker-resolved canonical symbol, never a mistyped or unmapped one.
const ASSET_CLASS_LABELS = { fx: 'Forex', metal: 'Metals', index: 'Indices', crypto: 'Crypto' };
// v1.0.19 -- fixed display order for asset-class optgroups, independent of
// which symbols happen to be present/remaining. See groupSymbolsByClass()
// for why this matters.
const ASSET_CLASS_ORDER = ['fx', 'metal', 'index', 'crypto'];

// v1.0.19 -- shared by populateOrderSymbolSelect() and
// populateStrategySymbolSelect(). Both previously grouped symbols into a
// Map keyed by asset class using plain forEach insertion order. Because the
// underlying symbol list is fetched sorted alphabetically by canonical
// symbol (not by asset class), the category that happened to contain the
// alphabetically-first *remaining* symbol determined the Map's insertion
// order. In populateStrategySymbolSelect() specifically, `remaining` shrinks
// every time a pair is added to the strategy, so removing e.g. the
// alphabetically-first Forex pair could make a Crypto pair become the new
// first-scanned symbol -- silently reshuffling Crypto to the top (or
// wherever) each time the dropdown was reopened, with no relation to the
// user's actions. Grouping here always returns categories in the fixed
// ASSET_CLASS_ORDER (with any unrecognized class appended alphabetically at
// the end) so the dropdown's category order never changes based on which
// pairs have already been picked.
function groupSymbolsByClass(symbolList) {
  const byClass = new Map();
  symbolList.forEach((s) => {
    if (!byClass.has(s.asset_class)) byClass.set(s.asset_class, []);
    byClass.get(s.asset_class).push(s.symbol);
  });
  const orderedClasses = [
    ...ASSET_CLASS_ORDER.filter((c) => byClass.has(c)),
    ...[...byClass.keys()].filter((c) => !ASSET_CLASS_ORDER.includes(c)).sort(),
  ];
  return orderedClasses.map((assetClass) => ({
    label: ASSET_CLASS_LABELS[assetClass] || assetClass,
    symbols: byClass.get(assetClass),
  }));
}

function populateOrderSymbolSelect() {
  const select = document.getElementById('order-symbol');
  if (!select) return;
  const available = getAvailableSymbols();

  if (available.length === 0) {
    select.innerHTML = '<option value="">No mapped symbols yet — rescan on the Pairs page</option>';
    select.disabled = true;
    return;
  }

  select.disabled = false;
  select.innerHTML = groupSymbolsByClass(available)
    .map(
      ({ label, symbols }) =>
        `<optgroup label="${label}">${symbols
          .map((sym) => `<option value="${sym}">${sym}</option>`)
          .join('')}</optgroup>`
    )
    .join('');
}

document.getElementById('button-new-order')?.addEventListener('click', () => {
  if (!state.activeTerminalId) {
    alert('Connect an MT5 account first — orders belong to a terminal.');
    return;
  }
  document.getElementById('form-new-order').reset();
  document.getElementById('new-order-message').textContent = '';
  populateOrderSymbolSelect();
  window.LucreUI.openModal('modal-new-order');
});

document.getElementById('form-new-order')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = e.target;
  const msg = document.getElementById('new-order-message');
  const submitBtn = form.querySelector('button[type="submit"]');

  if (!form.symbol.value) {
    msg.style.color = 'var(--color-negative)';
    msg.textContent = 'No mapped symbols available on this terminal yet — rescan on the Pairs page first.';
    return;
  }

  const payload = {
    terminal_id: state.activeTerminalId,
    // v1.0.10 — form.symbol.value now comes from a <select> populated by
    // populateOrderSymbolSelect() from this terminal's resolved symbol
    // mappings, so it is always an exact, broker-resolved canonical symbol.
    symbol: form.symbol.value,
    side: form.side.value,
    volume: parseFloat(form.volume.value),
    client_request_id: crypto.randomUUID(),
  };
  const deviation = form.max_deviation_points.value.trim();
  if (deviation) payload.max_deviation_points = parseInt(deviation, 10);
  const sl = form.sl.value.trim();
  if (sl) payload.sl = parseFloat(sl);
  const slPips = form.sl_pips.value.trim();
  if (slPips) payload.sl_pips = parseFloat(slPips);
  const tp = form.tp.value.trim();
  if (tp) payload.tp = parseFloat(tp);

  if (sl && slPips) {
    msg.style.color = 'var(--color-negative)';
    msg.textContent = 'Order was not sent: use either stop-loss price or stop-loss pips, not both.';
    return;
  }

  submitBtn.disabled = true;
  msg.style.color = 'var(--color-accent)';
  msg.textContent = 'Placing order…';

  try {
    const command = await placeManualOrder(payload);
    state.pendingCommandId = command.ea_command_id;
    form.reset();
    window.LucreUI.closeModal(document.getElementById('modal-new-order'));
    await loadPositions();
  } catch (err) {
    msg.style.color = 'var(--color-negative)';
    msg.textContent = err.message;
  } finally {
    submitBtn.disabled = false;
  }
});

// ---------------------------------------------------------------------------
// Modify / close position
// ---------------------------------------------------------------------------
function openModifyModal(positionId) {
  const position = state.positions.find((p) => p.id === positionId);
  if (!position) return;

  document.getElementById('modify-position-id').value = positionId;
  const slInput = document.getElementById('modify-sl');
  const tpInput = document.getElementById('modify-tp');
  const slClear = document.getElementById('modify-sl-clear');
  const tpClear = document.getElementById('modify-tp-clear');
  slInput.value = '';
  tpInput.value = '';
  slInput.disabled = false;
  tpInput.disabled = false;
  slClear.checked = false;
  tpClear.checked = false;
  slClear.disabled = position.sl == null;
  tpClear.disabled = position.tp == null;
  slInput.placeholder = position.sl != null ? `Current: ${position.sl}` : 'Keep current (none set)';
  tpInput.placeholder = position.tp != null ? `Current: ${position.tp}` : 'Keep current (none set)';
  document.getElementById('modify-position-message').textContent = '';

  window.LucreUI.openModal('modal-modify-position');
}

document.getElementById('modify-sl-clear')?.addEventListener('change', (e) => {
  const slInput = document.getElementById('modify-sl');
  slInput.disabled = e.target.checked;
  if (e.target.checked) slInput.value = '';
});

document.getElementById('modify-tp-clear')?.addEventListener('change', (e) => {
  const tpInput = document.getElementById('modify-tp');
  tpInput.disabled = e.target.checked;
  if (e.target.checked) tpInput.value = '';
});

document.getElementById('form-modify-position')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = e.target;
  const msg = document.getElementById('modify-position-message');
  const submitBtn = form.querySelector('button[type="submit"]');
  const positionId = form.position_id.value;
  const slRaw = form.sl.value.trim();
  const tpRaw = form.tp.value.trim();
  const clearSl = form.clear_sl.checked;
  const clearTp = form.clear_tp.checked;

  if (!slRaw && !tpRaw && !clearSl && !clearTp) {
    msg.style.color = 'var(--color-negative)';
    msg.textContent = 'Enter a stop loss, take profit, or clear one to modify.';
    return;
  }

  const payload = { client_request_id: crypto.randomUUID() };
  if (clearSl) payload.clear_sl = true;
  else if (slRaw) payload.sl = parseFloat(slRaw);
  if (clearTp) payload.clear_tp = true;
  else if (tpRaw) payload.tp = parseFloat(tpRaw);

  submitBtn.disabled = true;
  msg.style.color = 'var(--color-accent)';
  msg.textContent = 'Saving…';

  try {
    await modifyPosition(positionId, payload);
    msg.textContent = 'Position updated.';
    setTimeout(() => {
      window.LucreUI.closeModal(document.getElementById('modal-modify-position'));
      msg.textContent = '';
    }, 700);
    await loadPositions();
  } catch (err) {
    msg.style.color = 'var(--color-negative)';
    msg.textContent = err.message;
  } finally {
    submitBtn.disabled = false;
  }
});

async function handleClosePosition(positionId) {
  const position = state.positions.find((p) => p.id === positionId);
  if (!position) return;
  if (!confirm(`Close ${position.symbol} (${position.volume} lots)? This sends a close command to the EA.`)) return;

  try {
    await closePosition(positionId, { client_request_id: crypto.randomUUID() });
    await loadPositions();
  } catch (err) {
    alert(err.message);
  }
}

// ---------------------------------------------------------------------------
// Position polling
// ---------------------------------------------------------------------------
function startPositionPolling() {
  if (positionPollIntervalId) return;
  const pollMs = realtimeIsHealthy ? POSITION_POLL_HEALTHY_MS : POSITION_POLL_FALLBACK_MS;
  positionPollIntervalId = setInterval(() => {
    if (!state.activeTerminalId) return;
    loadPositions();
    loadPendingSignals();
    refreshActiveTerminalBalance();
    // v1.0.17 -- belt-and-suspenders fallback for the trade_history Realtime
    // subscription added in startRealtime(): if a channel drop/reconnect ever
    // misses an INSERT, metrics still catch up within one poll tick instead
    // of needing a manual reload.
    loadTradeHistory();
  }, pollMs);
}

function stopPositionPolling() {
  if (positionPollIntervalId) clearInterval(positionPollIntervalId);
  positionPollIntervalId = null;
}

function setRealtimeHealth(isHealthy) {
  if (realtimeIsHealthy === isHealthy) return;
  realtimeIsHealthy = isHealthy;
  stopPositionPolling();
  startPositionPolling();
}

function mergeStreamedPositionFields(positions) {
  const now = Date.now();
  return positions.map((position) => {
    const streamed = streamedPositionFields.get(String(position.mt5_ticket));
    if (!streamed || now - streamed.receivedAt > POSITION_STREAM_TTL_MS) return position;
    return {
      ...position,
      volume: streamed.volume,
      current_price: streamed.current_price,
      unrealized_pl: streamed.unrealized_pl,
      sl: streamed.sl,
      tp: streamed.tp,
    };
  });
}

// Ephemeral stream data may update mark-to-market fields only. Database row
// identity and status remain authoritative, preserving modify/close behavior.
function applyStreamedPositionState(terminalId, eventPayload) {
  if (state.activeTerminalId !== terminalId) return;
  const message = eventPayload?.payload?.positions ? eventPayload.payload : eventPayload;
  if (!Array.isArray(message?.positions) || message.positions.length > 100) return;

  const receivedAt = Date.now();
  const next = new Map();
  message.positions.forEach((position) => {
    const ticket = Number(position?.mt5_ticket);
    const volume = Number(position?.volume);
    const currentPrice = Number(position?.current_price);
    const unrealizedPl = Number(position?.unrealized_pl);
    if (!Number.isFinite(ticket) || !Number.isFinite(volume)
      || !Number.isFinite(currentPrice) || !Number.isFinite(unrealizedPl)) return;
    const sl = position.sl === null ? null : Number(position.sl);
    const tp = position.tp === null ? null : Number(position.tp);
    next.set(String(ticket), {
      receivedAt,
      volume,
      current_price: currentPrice,
      unrealized_pl: unrealizedPl,
      sl: sl === null || Number.isFinite(sl) ? sl : null,
      tp: tp === null || Number.isFinite(tp) ? tp : null,
    });
  });
  streamedPositionFields = next;
  state.positions = mergeStreamedPositionFields(state.positions);
  renderPositions();
  renderPositionsTab();
}

function stopPositionStreamRequests() {
  if (positionStreamRequestIntervalId) clearInterval(positionStreamRequestIntervalId);
  positionStreamRequestIntervalId = null;
}

function requestPositionStream() {
  if (!realtimeChannel) return;
  realtimeChannel
    .send({ type: 'broadcast', event: 'position_stream_subscribe', payload: {} })
    .catch((error) => console.warn('[realtime] position stream lease failed', error));
}

function startPositionStreamRequests() {
  stopPositionStreamRequests();
  requestPositionStream();
  positionStreamRequestIntervalId = setInterval(requestPositionStream, 15000);
}

// v1.0.12 -- lightweight balance/equity/margin_level refresh, run on the
// same poll tick as positions. Previously the balance widget had *no*
// polling fallback whatsoever and depended entirely on the (until this
// release, silently broken) mt5_terminals Realtime subscription -- so a
// missed/dropped event meant balance never updated until the user
// switched terminals or reloaded the page. This is a targeted single-row
// fetch, not a full loadTerminals() (which would also re-subscribe
// Realtime and re-fetch every other panel unnecessarily on every tick).
async function refreshActiveTerminalBalance() {
  if (!state.activeTerminalId) return;
  const { data, error } = await supabase
    .from('mt5_terminals')
    .select('id, equity, balance, margin_level, status')
    .eq('id', state.activeTerminalId)
    .maybeSingle();
  if (error || !data) return;
  const idx = state.terminals.findIndex((t) => t.id === data.id);
  if (idx !== -1) {
    state.terminals[idx] = { ...state.terminals[idx], ...data };
    renderBalanceWidget();
  }
}

// ---------------------------------------------------------------------------
// Realtime — live position/signal-queue updates, scoped to the active
// terminal. Falls back on the reduced-frequency poll above for anything
// missed (reconnect gaps, etc).
// ---------------------------------------------------------------------------
function startRealtime(terminalId) {
  stopRealtime();
  streamedPositionFields = new Map();
  if (!terminalId) return;
  const terminal = state.terminals.find((item) => item.id === terminalId);
  const channelName = terminal?.realtime_topic_id
    ? `terminal:${terminal.realtime_topic_id}`
    : `terminal-${terminalId}`;
  realtimeChannel = supabase
    .channel(channelName)
    .on(
      'broadcast',
      { event: 'position_state' },
      (payload) => applyStreamedPositionState(terminalId, payload)
    )
    .on(
      'postgres_changes',
      { event: '*', schema: 'public', table: 'positions', filter: `terminal_id=eq.${terminalId}` },
      () => loadPositions()
    )
    .on(
      'postgres_changes',
      { event: '*', schema: 'public', table: 'signal_deliveries', filter: `terminal_id=eq.${terminalId}` },
      () => loadPendingSignals()
    )
    // v1.0.11 -- balance/equity/margin_level widget and the AutoTrading
    // banner now update live instead of only on load/terminal-switch.
    // v1.0.12 -- this listener was silently dead: mt5_terminals was never
    // added to the supabase_realtime publication (fixed in migration 036),
    // so this callback never fired and the widget only ever reflected
    // whatever loadTerminals() fetched at page-load/terminal-switch time.
    .on(
      'postgres_changes',
      { event: 'UPDATE', schema: 'public', table: 'mt5_terminals', filter: `id=eq.${terminalId}` },
      (payload) => {
        const idx = state.terminals.findIndex((t) => t.id === terminalId);
        if (idx !== -1) {
          state.terminals[idx] = { ...state.terminals[idx], ...payload.new };
          renderBalanceWidget();
        }
      }
    )
    .on(
      'postgres_changes',
      { event: '*', schema: 'public', table: 'ea_commands', filter: `terminal_id=eq.${terminalId}` },
      (payload) => {
        checkAutotradingBanner();
        handleCommandStatus(payload.new);
      }
    )
    // v1.0.17 -- trade_history was never in the supabase_realtime publication
    // (fixed in migration 037), so R:R/Win Ratio/P&L on the Performance,
    // Strategy, and Sessions tabs only ever reflected the snapshot fetched at
    // page-load/terminal-switch time -- a closed trade never updated these
    // widgets without a manual reload. Every INSERT here is a newly finalized
    // close, so a full loadTradeHistory() keeps every metric derived from it
    // live.
    .on(
      'postgres_changes',
      { event: 'INSERT', schema: 'public', table: 'trade_history', filter: `terminal_id=eq.${terminalId}` },
      () => loadTradeHistory()
    )
    .on(
      'postgres_changes',
      { event: 'INSERT', schema: 'public', table: 'mt5_account_history', filter: `terminal_id=eq.${terminalId}` },
      () => loadAccountHistory()
    )
    // v1.0.12 -- previously had no status callback at all, so a dropped/
    // failed channel (network blip, token refresh, etc.) silently fell
    // back to nothing but the local poll loop with no attempt to
    // reconnect. Now logs the state and retries after a short backoff on
    // CHANNEL_ERROR/TIMED_OUT/CLOSED so live updates recover on their own
    // instead of requiring a manual page reload.
    .subscribe((status) => {
      console.log('[realtime]', status, 'terminal', terminalId);
      if (status === 'SUBSCRIBED') {
        setRealtimeHealth(true);
        startPositionStreamRequests();
      }
      if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
        stopPositionStreamRequests();
        setRealtimeHealth(false);
        if (realtimeReconnectTimer) return;
        realtimeReconnectTimer = setTimeout(() => {
          realtimeReconnectTimer = null;
          if (state.activeTerminalId === terminalId) startRealtime(terminalId);
        }, 3000);
      }
    });
}

// v1.0.11 -- surfaces a top-of-dashboard warning when the most recent
// order attempt failed specifically because AutoTrading is off in the
// terminal (see EASync_TradingAllowed() on the EA side), so the user
// doesn't silently wonder why signals/manual taps aren't executing.
async function checkAutotradingBanner() {
  if (!state.activeTerminalId) {
    bannerAutotrading.hidden = true;
    return;
  }
  const { data, error } = await supabase
    .from('ea_commands')
    .select('id, status, error_message, requested_at')
    .eq('terminal_id', state.activeTerminalId)
    .order('requested_at', { ascending: false })
    .limit(1);

  if (error) {
    console.error('checkAutotradingBanner error', error);
    return;
  }
  const latest = data?.[0];
  bannerAutotrading.hidden = !(
    latest &&
    latest.status === 'failed' &&
    latest.error_message === 'autotrading_disabled'
  );
}

function humanizeCommandFailure(error) {
  const labels = {
    autotrading_disabled: 'MT5 AutoTrading is disabled.',
    hard_stop_loss_required: 'A protective stop-loss is required.',
    hard_max_volume_per_order_exceeded: 'The volume exceeds the EA hard limit.',
    broker_volume_step_mismatch: 'The volume does not match this broker’s lot step.',
    hard_max_open_positions_reached: 'The EA account-position limit has been reached.',
    max_open_positions_reached: 'The terminal open-position limit has been reached.',
  };
  return labels[error] || error || 'MT5 did not provide a failure reason.';
}

function handleCommandStatus(command) {
  if (!command || command.id !== state.pendingCommandId) return;
  if (command.status === 'failed' || command.status === 'expired') {
    const message = `Order was not executed: ${humanizeCommandFailure(command.error_message)}`;
    if (bannerCommandStatus) {
      bannerCommandStatus.textContent = message;
      bannerCommandStatus.hidden = false;
    }
    const modalMessage = document.getElementById('new-order-message');
    if (modalMessage) {
      modalMessage.style.color = 'var(--color-negative)';
      modalMessage.textContent = message;
    }
    state.pendingCommandId = null;
  } else if (command.status === 'executed') {
    if (bannerCommandStatus) bannerCommandStatus.hidden = true;
    state.pendingCommandId = null;
  }
}

function stopRealtime() {
  stopPositionStreamRequests();
  if (realtimeReconnectTimer) {
    clearTimeout(realtimeReconnectTimer);
    realtimeReconnectTimer = null;
  }
  if (realtimeChannel) {
    supabase.removeChannel(realtimeChannel);
    realtimeChannel = null;
  }
}

// ---------------------------------------------------------------------------
// Data loaders
// ---------------------------------------------------------------------------
async function loadProfile() {
  const { data, error } = await supabase
    .from('profiles')
    .select('display_name, bio, location, website, trading_style')
    .eq('id', state.session.user.id)
    .maybeSingle();

  if (error) {
    console.error('loadProfile error', error);
    return;
  }
  state.profile = data;

  const displayName = data?.display_name || state.session.user.email?.split('@')[0] || 'there';
  textGreeting.textContent = `Hey, ${displayName} 👋`;
  accountMenuEmail.textContent = state.session.user.email || '';
  document.getElementById('account-menu-button').textContent = initials(displayName);
  const profileForm = document.getElementById('form-account-profile');
  if (profileForm) {
    profileForm.display_name.value = data?.display_name || '';
    profileForm.bio.value = data?.bio || '';
    profileForm.location.value = data?.location || '';
    profileForm.website.value = data?.website || '';
    profileForm.trading_style.value = data?.trading_style || '';
  }
}

async function loadTerminals() {
  const { data, error } = await supabase
    .from('mt5_terminals')
    .select(
      'id, label, broker, account_login, server, is_live, status, equity, balance, margin_level, api_key_last_four, api_key_last_rotated_at, max_manual_lot_size, max_daily_loss_usd, max_open_positions, force_symbol_rescan, last_symbol_scan_at, realtime_topic_id'
    )
    .order('created_at', { ascending: true });

  if (error) {
    console.error('loadTerminals error', error);
    return;
  }
  state.terminals = data || [];

  if (!state.activeTerminalId || !state.terminals.find((t) => t.id === state.activeTerminalId)) {
    state.activeTerminalId = state.terminals[0]?.id || null;
  }

  renderTerminalPicker();
  startRealtime(state.activeTerminalId);
  // loadSymbolMappings must resolve before loadSymbolSettings — the latter
  // reads state.symbolMappings to build the Pairs page's available symbol
  // list (v1.0.10).
  await loadSymbolMappings();
  await Promise.all([
    loadStrategies(),
    loadSignals(),
    loadTradeHistory(),
    loadAccountHistory(),
    loadAgentPolicies(),
    loadPositions(),
    loadPendingSignals(),
    loadSymbolSettings(),
    loadScenarioStats(),
  ]);
}

function renderTerminalPicker() {
  const buttonTerminalKey = document.getElementById('button-terminal-key');

  if (state.terminals.length === 0) {
    terminalStatusLabel.textContent = 'No account connected';
    textAccountName.textContent = 'Connect your MT5 terminal';
    profileAvatar.textContent = '—';
    terminalSelect.hidden = true;
    if (buttonTerminalKey) buttonTerminalKey.hidden = true;
    textGreetingSub.textContent = 'Connect an MT5 account to start seeing live data.';
    renderBalanceWidget();
    return;
  }

  const active = state.terminals.find((t) => t.id === state.activeTerminalId) || state.terminals[0];
  profileAvatar.textContent = initials(active.label);
  textAccountName.textContent = active.label;
  terminalStatusLabel.textContent =
    active.status === 'connected' ? 'Connected' : active.status === 'error' ? 'Connection error' : 'Disconnected · awaiting EA';
  textGreetingSub.textContent =
    active.status === 'connected'
      ? "Here's how your signals performed."
      : 'Your terminal is registered — connect the EA to start streaming live data.';

  if (buttonTerminalKey) buttonTerminalKey.hidden = false;

  renderBalanceWidget();
  checkAutotradingBanner();

  if (state.terminals.length > 1) {
    terminalSelect.hidden = false;
    terminalSelect.innerHTML = state.terminals
      .map((t) => `<option value="${t.id}" ${t.id === state.activeTerminalId ? 'selected' : ''}>${t.label}</option>`)
      .join('');
  } else {
    terminalSelect.hidden = true;
  }
}

terminalSelect?.addEventListener('change', async (e) => {
  state.activeTerminalId = e.target.value;
  renderTerminalPicker();
  startRealtime(state.activeTerminalId);
  stopSymbolRescanPoll();
  await loadSymbolMappings();
  await Promise.all([
    loadStrategies(),
    loadSignals(),
    loadTradeHistory(),
    loadAccountHistory(),
    loadAgentPolicies(),
    loadPositions(),
    loadPendingSignals(),
    loadSymbolSettings(),
    loadScenarioStats(),
  ]);
});

async function loadStrategies() {
  if (!state.activeTerminalId) {
    state.strategies = [];
    renderStrategies();
    renderStrategyStatusTab();
    return;
  }
  const { data, error } = await supabase
    .from('strategies')
    .select(
      'id, name, kind, enabled, delivery_mode, symbols, max_lot_size, signal_ttl_seconds, ' +
        'news_posture, news_window_minutes, news_min_impact, news_exploit_size_multiplier, config'
    )
    .eq('terminal_id', state.activeTerminalId)
    .order('created_at', { ascending: true });

  if (error) {
    console.error('loadStrategies error', error);
    return;
  }
  state.strategies = data || [];
  renderStrategies();
  renderStrategyStatusTab();
}

function renderStrategies() {
  if (state.strategies.length === 0) {
    strategyList.innerHTML =
      '<p class="empty-state-text" id="strategy-empty-state">No strategies yet. Add your first one to get started.</p>';
    return;
  }

  strategyList.innerHTML = state.strategies
    .map((s) => {
      const symbolLabel = (s.symbols || []).slice(0, 2).join(' · ') || s.kind || 'Custom';
      return `
      <div class="mini-table-row" data-strategy-id="${s.id}">
        <span class="avatar-badge" aria-hidden="true">${initials(s.name)}</span>
        <div class="mini-table-meta">
          <div class="strategy-name">${s.name}</div>
          <div class="strategy-sub">${symbolLabel}</div>
        </div>
        <div class="mini-table-stats">
          <label class="strategy-toggle">
            <input type="checkbox" class="strategy-toggle-input" data-strategy-toggle="${s.id}" ${s.enabled ? 'checked' : ''} />
            <span>${s.enabled ? 'Enabled' : 'Disabled'}</span>
          </label>
        </div>
        <div class="inline-actions">
          <button class="btn-secondary btn-xs" type="button" data-edit-strategy="${s.id}">Edit</button>
        </div>
      </div>`;
    })
    .join('');

  strategyList.querySelectorAll('[data-strategy-toggle]').forEach((input) => {
    input.addEventListener('change', async (e) => {
      const id = e.target.dataset.strategyToggle;
      const enabled = e.target.checked;
      const { error } = await supabase.from('strategies').update({ enabled }).eq('id', id);
      if (error) {
        console.error('toggle strategy error', error);
        e.target.checked = !enabled;
        return;
      }
      await loadStrategies();
    });
  });

  // v1.0.17 -- edit/delete strategy parameters after creation.
  strategyList.querySelectorAll('[data-edit-strategy]').forEach((btn) => {
    btn.addEventListener('click', () => openEditStrategyModal(btn.dataset.editStrategy));
  });
  // v1.0.18 -- row-level Delete button removed (see openEditStrategyModal /
  // #button-delete-strategy): deleting a strategy is now only available
  // inside the edit modal, freeing up horizontal space on the row itself
  // and fixing the text-overlap this button previously caused.
}

async function loadSignals() {
  if (!state.activeTerminalId) {
    state.signals = [];
    state.signalDeliveries = [];
    renderSignalSummary();
    renderVolumeChart();
    renderRiskEngine();
    renderSignalsTab();
    renderBlockedTab();
    return;
  }

  const [signalsRes, deliveriesRes] = await Promise.all([
    supabase
      .from('signals')
      .select(
        'id, symbol, side, policy_decision, generated_at, suggested_volume, near_news_event, htf_regime, ' +
          'news_event_id, calendar_events(title, currency, impact)'
      )
      .eq('terminal_id', state.activeTerminalId),
    supabase
      .from('signal_deliveries')
      .select('id, status, delivered_at')
      .eq('terminal_id', state.activeTerminalId),
  ]);

  if (signalsRes.error) console.error('loadSignals error', signalsRes.error);
  if (deliveriesRes.error) console.error('loadSignalDeliveries error', deliveriesRes.error);

  state.signals = signalsRes.data || [];
  state.signalDeliveries = deliveriesRes.data || [];
  renderSignalSummary();
  renderVolumeChart();
  renderRiskEngine();
  renderSignalsTab();
  renderBlockedTab();
}

function renderSignalSummary() {
  const total = state.signals.length;
  const blocked = state.signals.filter((s) => s.policy_decision === 'block').length;
  const executed = state.signalDeliveries.filter((d) => d.status === 'tapped' || d.status === 'auto_executed').length;
  const expired = state.signalDeliveries.filter((d) => d.status === 'expired').length;

  textSignalTotal.textContent = total.toLocaleString();
  countExecuted.textContent = executed.toLocaleString();
  countBlocked.textContent = blocked.toLocaleString();
  countExpired.textContent = expired.toLocaleString();

  textChartMonth.textContent = new Date().toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
  chartEmptyOverlay.style.display = total === 0 ? 'flex' : 'none';
}

// ---------------------------------------------------------------------------
// Open positions
// ---------------------------------------------------------------------------
async function loadPositions() {
  if (!state.activeTerminalId) {
    state.positions = [];
    renderPositions();
    renderPositionsTab();
    return;
  }

  const { data, error } = await supabase
    .from('positions')
    .select('id, mt5_ticket, symbol, side, volume, open_price, current_price, sl, tp, unrealized_pl, status, open_time')
    .eq('terminal_id', state.activeTerminalId)
    .neq('status', 'closed')
    .order('open_time', { ascending: false });

  if (error) {
    console.error('loadPositions error', error);
    return;
  }
  state.positions = mergeStreamedPositionFields(data || []);
  renderPositions();
  renderPositionsTab();
}

function renderPositions() {
  const list = document.getElementById('positions-list');
  if (!list) return;

  if (state.positions.length === 0) {
    list.innerHTML = `<p class="empty-state-text" id="positions-empty-state">${
      state.activeTerminalId
        ? 'No open positions. Place an order to see it here.'
        : 'No open positions. Connect an account and place an order to see it here.'
    }</p>`;
    return;
  }

  list.innerHTML = state.positions
    .map((p) => {
      const plValue = Number(p.unrealized_pl) || 0;
      const plColor = plValue > 0 ? 'var(--color-positive)' : plValue < 0 ? 'var(--color-negative)' : 'var(--color-text-muted)';
      const sideClass = p.side === 'sell' ? 'side-sell' : 'side-buy';
      // v1.0.18 -- a position flagged 'closing' (reported missing from the
      // EA's last poll, pending final confirmation) can no longer be acted
      // on -- position-action already rejects it with a 409 position_not_open
      // error. Show a disabled pending state instead of live buttons so that
      // 409 never surfaces to the user again.
      const isClosing = p.status === 'closing';
      const actionsHtml = isClosing
        ? `<div class="inline-actions"><span class="pending-badge" title="Reconciling with your MT5 terminal — this clears automatically.">Reconciling…</span></div>`
        : `<div class="inline-actions">
            <button class="btn-secondary btn-xs" type="button" data-modify-position="${p.id}">Modify</button>
            <button class="btn-danger btn-xs" type="button" data-close-position="${p.id}">Close</button>
          </div>`;
      return `
        <div class="mini-table-row${isClosing ? ' is-reconciling' : ''}">
          <div class="mini-table-meta">
            <div class="strategy-name">${p.symbol}<span class="side-badge ${sideClass}">${p.side}</span></div>
            <div class="strategy-sub">${p.volume} lots · opened ${new Date(p.open_time).toLocaleString()}</div>
          </div>
          <div class="mini-table-stats">
            <div class="pct" style="color:${plColor}">${plValue >= 0 ? '+' : ''}${plValue.toFixed(2)}</div>
            <div class="count">${p.open_price} → ${p.current_price ?? '—'}</div>
          </div>
          ${actionsHtml}
        </div>`;
    })
    .join('');

  list.querySelectorAll('[data-modify-position]').forEach((btn) => {
    btn.addEventListener('click', () => openModifyModal(btn.dataset.modifyPosition));
  });
  list.querySelectorAll('[data-close-position]').forEach((btn) => {
    btn.addEventListener('click', () => handleClosePosition(btn.dataset.closePosition));
  });
}

// ---------------------------------------------------------------------------
// Signal queue
// ---------------------------------------------------------------------------
async function loadPendingSignals() {
  if (!state.activeTerminalId) {
    state.pendingSignals = [];
    renderSignalQueue();
    return;
  }

  const { data, error } = await supabase
    .from('signal_deliveries')
    .select('id, status, delivered_at, signals(symbol, side, suggested_volume, suggested_sl, suggested_tp, expires_at)')
    .eq('terminal_id', state.activeTerminalId)
    .in('status', ['pending', 'delivered'])
    .order('delivered_at', { ascending: false });

  if (error) {
    console.error('loadPendingSignals error', error);
    return;
  }
  state.pendingSignals = data || [];
  renderSignalQueue();
}

function renderSignalQueue() {
  const list = document.getElementById('signal-queue-list');
  if (!list) return;

  if (state.pendingSignals.length === 0) {
    list.innerHTML = '<p class="empty-state-text" id="signal-queue-empty-state">No pending signals right now.</p>';
    return;
  }

  const now = Date.now();
  list.innerHTML = state.pendingSignals
    .map((d) => {
      const sig = d.signals || {};
      const expired = sig.expires_at ? new Date(sig.expires_at).getTime() < now : false;
      const sideClass = sig.side === 'sell' ? 'side-sell' : 'side-buy';
      return `
        <div class="mini-table-row">
          <div class="mini-table-meta">
            <div class="strategy-name">${sig.symbol || 'Unknown'}<span class="side-badge ${sideClass}">${sig.side || '—'}</span></div>
            <div class="strategy-sub">${sig.suggested_volume ?? '—'} lots · delivered ${
              d.delivered_at ? new Date(d.delivered_at).toLocaleString() : '—'
            }</div>
          </div>
          <div class="mini-table-stats">
            <div class="count">${expired ? 'Expired' : d.status}</div>
          </div>
          <div class="inline-actions">
            <button class="btn-secondary btn-xs" type="button" data-tap-signal="${d.id}" ${expired ? 'disabled' : ''}>Tap to execute</button>
          </div>
        </div>`;
    })
    .join('');

  list.querySelectorAll('[data-tap-signal]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      try {
        await tapSignal(btn.dataset.tapSignal);
        await Promise.all([loadPendingSignals(), loadPositions()]);
      } catch (err) {
        alert(err.message);
        btn.disabled = false;
      }
    });
  });
}

// ---------------------------------------------------------------------------
// Pairs view — fixed symbol universe, per-pair signal/auto-SL-TP settings,
// performance summary, and quick manual Buy/Sell.
// ---------------------------------------------------------------------------
function defaultSymbolSetting(symbol) {
  return {
    id: null,
    symbol,
    enabled: true,
    timeframes: [],
    auto_sl_tp_enabled: false,
    auto_sl_pips: null,
    auto_tp_pips: null,
  };
}

// v1.0.10 — the terminal's actual tradable symbol universe: every
// symbol_mappings row that currently resolves to a broker-native symbol
// (mirrors resolveBrokerSymbol()'s own "is this usable right now" check in
// supabase/functions/_shared/symbol-resolver.ts — keep these two in sync).
// This is the single source of truth for "can an order for this symbol
// actually be placed on this terminal", used by both the Pairs page and
// the New Position modal so neither can offer a symbol the other would
// reject.
function getAvailableSymbols() {
  return (state.symbolMappings || [])
    .filter((m) => m.broker_symbol && m.match_type !== 'unavailable' && !m.needs_review)
    .map((m) => ({ symbol: m.canonical_symbol, asset_class: m.asset_class }));
}

async function loadSymbolSettings() {
  // Prefer the terminal's actually-resolved symbols; fall back to the full
  // bootstrap universe only when no scan has happened yet (symbol_mappings
  // empty), so the Pairs page isn't blank on a brand-new terminal.
  const resolvedSymbols = getAvailableSymbols().map((s) => s.symbol);
  const universe = resolvedSymbols.length > 0 ? resolvedSymbols : SYMBOL_UNIVERSE;

  if (!state.activeTerminalId) {
    state.symbolSettings = SYMBOL_UNIVERSE.map(defaultSymbolSetting);
    if (!viewPairs.hidden) renderPairsView();
    return;
  }

  const { data, error } = await supabase
    .from('symbol_settings')
    .select('id, symbol, enabled, timeframes, auto_sl_tp_enabled, auto_sl_pips, auto_tp_pips')
    .eq('terminal_id', state.activeTerminalId);

  if (error) {
    console.error('loadSymbolSettings error', error);
    return;
  }

  const bySymbol = new Map((data || []).map((row) => [row.symbol, row]));
  state.symbolSettings = universe.map(
    (symbol) => bySymbol.get(symbol) || defaultSymbolSetting(symbol)
  );
  if (!viewPairs.hidden) renderPairsView();
}

async function upsertSymbolSetting(symbol, patch) {
  if (!state.activeTerminalId) return;
  const { data, error } = await supabase
    .from('symbol_settings')
    .upsert(
      { terminal_id: state.activeTerminalId, symbol, ...patch },
      { onConflict: 'terminal_id,symbol' }
    )
    .select('id, symbol, enabled, timeframes, auto_sl_tp_enabled, auto_sl_pips, auto_tp_pips')
    .single();

  if (error) {
    console.error('upsertSymbolSetting error', error);
    alert('Could not save that change. Try again.');
    await loadSymbolSettings();
    return;
  }

  const idx = state.symbolSettings.findIndex((s) => s.symbol === symbol);
  if (idx >= 0) state.symbolSettings[idx] = data;
}

function computeSymbolPerformance(symbol) {
  const trades = state.tradeHistory.filter((t) => t.symbol === symbol);
  if (trades.length === 0) return { count: 0, winRate: null, totalPl: 0 };
  const wins = trades.filter((t) => (t.profit ?? 0) > 0).length;
  const totalPl = trades.reduce((sum, t) => sum + (t.profit ?? 0), 0);
  return { count: trades.length, winRate: Math.round((wins / trades.length) * 100), totalPl };
}

async function handleQuickOrder(symbol, side, btn) {
  if (!state.activeTerminalId) return;
  const terminal = state.terminals.find((t) => t.id === state.activeTerminalId);
  const setting = state.symbolSettings.find((s) => s.symbol === symbol);
  const volume = Number(terminal?.max_manual_lot_size) || 0.01;

  const payload = {
    terminal_id: state.activeTerminalId,
    symbol,
    side,
    volume,
    client_request_id: crypto.randomUUID(),
  };
  if (setting?.auto_sl_tp_enabled) {
    if (setting.auto_sl_pips) payload.sl_pips = setting.auto_sl_pips;
    if (setting.auto_tp_pips) payload.tp_pips = setting.auto_tp_pips;
  }

  const buyBtn = btn.parentElement.querySelector('[data-quick-buy]');
  const sellBtn = btn.parentElement.querySelector('[data-quick-sell]');
  buyBtn.disabled = true;
  sellBtn.disabled = true;

  try {
    await placeManualOrder(payload);
    await loadPositions();
  } catch (err) {
    alert(err.message);
  } finally {
    buyBtn.disabled = false;
    sellBtn.disabled = false;
  }
}

function renderPairsView() {
  if (!pairGrid) return;

  if (!state.activeTerminalId) {
    pairGrid.innerHTML =
      '<p class="empty-state-text">Connect an MT5 account to configure per-pair signals and quick orders.</p>';
    return;
  }

  pairGrid.innerHTML = state.symbolSettings
    .map((s) => {
      const perf = computeSymbolPerformance(s.symbol);
      const plColor =
        perf.totalPl > 0 ? 'var(--color-positive)' : perf.totalPl < 0 ? 'var(--color-negative)' : 'var(--color-text-muted)';
      const perfText =
        perf.count === 0
          ? 'No closed trades yet'
          : `${perf.winRate}% win rate · ${perf.count} trades`;
      const tfChips = TIMEFRAMES.map(
        (tf) =>
          `<button type="button" class="pair-tf-chip ${
            (s.timeframes || []).includes(tf) ? 'active' : ''
          }" data-tf="${tf}" data-symbol="${s.symbol}">${tf}</button>`
      ).join('');

      return `
      <div class="card card-pad pair-card ${s.enabled ? '' : 'is-disabled'}" data-symbol-card="${s.symbol}">
        <div class="pair-card-header">
          <span class="pair-card-name">${s.symbol}</span>
          <label class="strategy-toggle">
            <input type="checkbox" class="strategy-toggle-input" data-pair-enable="${s.symbol}" ${s.enabled ? 'checked' : ''} />
            <span>${s.enabled ? 'On' : 'Off'}</span>
          </label>
        </div>

        <div>
          <div class="pair-card-section-label">Signal timeframes</div>
          <div class="pair-tf-chips" data-tf-group="${s.symbol}">${tfChips}</div>
        </div>

        <div>
          <div class="pair-auto-row">
            <span class="pair-card-section-label" style="margin-bottom:0;">Auto SL/TP</span>
            <label class="strategy-toggle">
              <input type="checkbox" class="strategy-toggle-input" data-auto-sltp-toggle="${s.symbol}" ${s.auto_sl_tp_enabled ? 'checked' : ''} />
              <span>${s.auto_sl_tp_enabled ? 'On' : 'Off'}</span>
            </label>
          </div>
          <div class="pair-auto-fields" data-auto-fields="${s.symbol}" ${s.auto_sl_tp_enabled ? '' : 'hidden'}>
            <div class="field">
              <label>SL (pips)</label>
              <input type="number" min="1" step="any" data-auto-sl-pips="${s.symbol}" value="${s.auto_sl_pips ?? ''}" placeholder="e.g. 20" />
            </div>
            <div class="field">
              <label>TP (pips)</label>
              <input type="number" min="1" step="any" data-auto-tp-pips="${s.symbol}" value="${s.auto_tp_pips ?? ''}" placeholder="e.g. 40" />
            </div>
          </div>
        </div>

        <div class="pair-perf">
          <span>${perfText}</span>
          ${perf.count > 0 ? `<strong style="color:${plColor}">${perf.totalPl >= 0 ? '+' : ''}${perf.totalPl.toFixed(2)}</strong>` : ''}
        </div>

        <div class="pair-actions">
          <button type="button" class="btn-buy" data-quick-buy="${s.symbol}">Buy</button>
          <button type="button" class="btn-sell" data-quick-sell="${s.symbol}">Sell</button>
        </div>
      </div>`;
    })
    .join('');

  pairGrid.querySelectorAll('[data-pair-enable]').forEach((input) => {
    input.addEventListener('change', async (e) => {
      const symbol = e.target.dataset.pairEnable;
      const enabled = e.target.checked;
      await upsertSymbolSetting(symbol, { enabled });
      renderPairsView();
    });
  });

  pairGrid.querySelectorAll('[data-tf-group] .pair-tf-chip').forEach((chip) => {
    chip.addEventListener('click', async () => {
      const symbol = chip.dataset.symbol;
      const tf = chip.dataset.tf;
      const setting = state.symbolSettings.find((s) => s.symbol === symbol);
      const current = new Set(setting?.timeframes || []);
      if (current.has(tf)) current.delete(tf);
      else current.add(tf);
      const timeframes = TIMEFRAMES.filter((t) => current.has(t));
      await upsertSymbolSetting(symbol, { timeframes });
      renderPairsView();
    });
  });

  pairGrid.querySelectorAll('[data-auto-sltp-toggle]').forEach((input) => {
    input.addEventListener('change', async (e) => {
      const symbol = e.target.dataset.autoSltpToggle;
      await upsertSymbolSetting(symbol, { auto_sl_tp_enabled: e.target.checked });
      renderPairsView();
    });
  });

  pairGrid.querySelectorAll('[data-auto-sl-pips], [data-auto-tp-pips]').forEach((input) => {
    input.addEventListener('change', async (e) => {
      const symbol = e.target.dataset.autoSlPips || e.target.dataset.autoTpPips;
      const field = e.target.dataset.autoSlPips ? 'auto_sl_pips' : 'auto_tp_pips';
      const raw = e.target.value.trim();
      const value = raw ? parseFloat(raw) : null;
      await upsertSymbolSetting(symbol, { [field]: value });
    });
  });

  pairGrid.querySelectorAll('[data-quick-buy]').forEach((btn) => {
    btn.addEventListener('click', () => handleQuickOrder(btn.dataset.quickBuy, 'buy', btn));
  });
  pairGrid.querySelectorAll('[data-quick-sell]').forEach((btn) => {
    btn.addEventListener('click', () => handleQuickOrder(btn.dataset.quickSell, 'sell', btn));
  });
}

// ---------------------------------------------------------------------------
// Broker symbol mapping (v1.0.12+) — canonical symbol <-> broker-native
// symbol name, one row per (terminal, canonical_symbol). Populated by the
// EA's SymbolMap.mqh via report-symbols; resolved here for ambiguous
// (needs_review) matches. Direct authenticated Supabase read/update per the
// RLS policies in migration 031 — no edge function needed for reading or
// resolving, only for triggering a rescan (see rescanSymbols()).
// ---------------------------------------------------------------------------

function stopSymbolRescanPoll() {
  if (symbolRescanPollId) {
    clearInterval(symbolRescanPollId);
    symbolRescanPollId = null;
  }
  if (buttonRescanSymbols) {
    buttonRescanSymbols.disabled = !state.activeTerminalId;
    buttonRescanSymbols.textContent = 'Rescan Symbols';
  }
  if (buttonAddPair) buttonAddPair.disabled = !state.activeTerminalId;
}

async function loadSymbolMappings() {
  if (!state.activeTerminalId) {
    state.symbolMappings = [];
    if (!viewPairs.hidden) renderSymbolMappingPanel();
    return;
  }

  const { data, error } = await supabase
    .from('symbol_mappings')
    .select('id, canonical_symbol, asset_class, broker_symbol, match_type, candidates, needs_review, last_synced_at')
    .eq('terminal_id', state.activeTerminalId)
    .order('canonical_symbol', { ascending: true });

  if (error) {
    console.error('loadSymbolMappings error', error);
    return;
  }

  state.symbolMappings = data || [];
  if (!viewPairs.hidden) renderSymbolMappingPanel();
}

async function resolveSymbolMapping(mappingId, brokerSymbol, rowEl) {
  rowEl?.classList.add('is-saving');
  const { data, error } = await supabase
    .from('symbol_mappings')
    .update({ broker_symbol: brokerSymbol, match_type: 'manual', needs_review: false })
    .eq('id', mappingId)
    .select('id, canonical_symbol, asset_class, broker_symbol, match_type, candidates, needs_review, last_synced_at')
    .single();

  if (error) {
    console.error('resolveSymbolMapping error', error);
    alert('Could not save that mapping. Try again.');
    rowEl?.classList.remove('is-saving');
    return;
  }

  const idx = state.symbolMappings.findIndex((m) => m.id === mappingId);
  if (idx >= 0) state.symbolMappings[idx] = data;
  renderSymbolMappingPanel();
}

function renderSymbolMappingPanel() {
  if (!symbolMappingBody || !symbolMappingStatus) return;

  if (!state.activeTerminalId) {
    symbolMappingStatus.textContent = 'Connect an account to see broker symbol mapping.';
    symbolMappingBody.innerHTML = '';
    if (buttonRescanSymbols) buttonRescanSymbols.disabled = true;
    if (buttonAddPair) buttonAddPair.disabled = true;
    return;
  }

  const terminal = state.terminals.find((t) => t.id === state.activeTerminalId);
  if (buttonRescanSymbols) buttonRescanSymbols.disabled = symbolRescanPollId ? true : false;
  if (buttonAddPair) buttonAddPair.disabled = false;

  if (terminal?.force_symbol_rescan) {
    symbolMappingStatus.textContent = 'Rescan requested — waiting for the EA to report back (usually under a minute).';
  } else if (terminal?.last_symbol_scan_at) {
    const when = new Date(terminal.last_symbol_scan_at);
    symbolMappingStatus.textContent = `Last scanned ${when.toLocaleString()}.`;
  } else {
    symbolMappingStatus.textContent = 'No scan yet — click Rescan Symbols once your EA is connected (needs LucreHubEA v1.0.12+).';
  }

  if (state.symbolMappings.length === 0) {
    symbolMappingBody.innerHTML =
      '<p class="empty-state-text">No broker symbol data yet. Connect your EA and click Rescan Symbols to map your broker\'s pairs, metals, indices, and crypto symbols to the canonical names used across the dashboard.</p>';
    return;
  }

  const searching = state.symbolMappings.filter((m) => m.match_type === 'pending_manual');
  const needsReview = state.symbolMappings.filter((m) => m.needs_review);
  const unavailable = state.symbolMappings.filter((m) => !m.needs_review && m.match_type === 'unavailable');
  const resolved = state.symbolMappings.length - needsReview.length - unavailable.length - searching.length;

  const summary = `
    <div class="symbol-mapping-summary">
      <span class="tag-badge tag-ok">${resolved} mapped</span>
      ${searching.length ? `<span class="tag-badge tag-warn">${searching.length} searching\u2026 (${searching.map((m) => m.canonical_symbol).join(', ')})</span>` : ''}
      ${needsReview.length ? `<span class="tag-badge tag-warn">${needsReview.length} need review</span>` : ''}
      ${unavailable.length ? `<span class="tag-badge tag-neutral">${unavailable.length} unavailable</span>` : ''}
    </div>`;

  if (needsReview.length === 0) {
    symbolMappingBody.innerHTML = `${summary}<p class="empty-state-text">All broker symbols with a clear match are mapped. ${
      unavailable.length ? `${unavailable.length} canonical symbol(s) have no matching instrument at this broker.` : ''
    }</p>`;
    return;
  }

  const rows = needsReview
    .map((m) => {
      const options = (m.candidates || [])
        .map((c) => `<option value="${c}">${c}</option>`)
        .join('');
      return `
      <tr class="symbol-mapping-row" data-mapping-row="${m.id}">
        <td>${m.canonical_symbol}</td>
        <td>${m.asset_class}</td>
        <td>
          <select data-mapping-select="${m.id}">
            <option value="">Choose broker symbol…</option>
            ${options}
          </select>
        </td>
        <td><button type="button" class="btn-secondary btn-xs" data-mapping-save="${m.id}" disabled>Save</button></td>
      </tr>`;
    })
    .join('');

  symbolMappingBody.innerHTML = `
    ${summary}
    <div class="symbol-mapping-table-wrap">
      <table class="symbol-mapping-table">
        <thead>
          <tr><th>Canonical symbol</th><th>Asset class</th><th>Candidates seen at last scan</th><th></th></tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    </div>`;

  symbolMappingBody.querySelectorAll('[data-mapping-select]').forEach((select) => {
    select.addEventListener('change', (e) => {
      const id = e.target.dataset.mappingSelect;
      const saveBtn = symbolMappingBody.querySelector(`[data-mapping-save="${id}"]`);
      if (saveBtn) saveBtn.disabled = !e.target.value;
    });
  });

  symbolMappingBody.querySelectorAll('[data-mapping-save]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const id = btn.dataset.mappingSave;
      const select = symbolMappingBody.querySelector(`[data-mapping-select="${id}"]`);
      const rowEl = symbolMappingBody.querySelector(`[data-mapping-row="${id}"]`);
      if (!select?.value) return;
      btn.disabled = true;
      await resolveSymbolMapping(id, select.value, rowEl);
    });
  });
}

async function refreshActiveTerminalScanStatus() {
  if (!state.activeTerminalId) return null;
  const { data, error } = await supabase
    .from('mt5_terminals')
    .select('force_symbol_rescan, last_symbol_scan_at')
    .eq('id', state.activeTerminalId)
    .single();
  if (error) {
    console.error('refreshActiveTerminalScanStatus error', error);
    return null;
  }
  const idx = state.terminals.findIndex((t) => t.id === state.activeTerminalId);
  if (idx >= 0) state.terminals[idx] = { ...state.terminals[idx], ...data };
  return data;
}

buttonRescanSymbols?.addEventListener('click', async () => {
  if (!state.activeTerminalId) return;
  buttonRescanSymbols.disabled = true;
  buttonRescanSymbols.textContent = 'Requesting…';
  try {
    await rescanSymbols(state.activeTerminalId);
  } catch (err) {
    alert(err.message);
    buttonRescanSymbols.disabled = false;
    buttonRescanSymbols.textContent = 'Rescan Symbols';
    return;
  }

  buttonRescanSymbols.textContent = 'Scanning…';
  await refreshActiveTerminalScanStatus();
  renderSymbolMappingPanel();

  let attempts = 0;
  symbolRescanPollId = setInterval(async () => {
    attempts += 1;
    const status = await refreshActiveTerminalScanStatus();
    const stillPending = status?.force_symbol_rescan;
    if (!stillPending || attempts >= 12) {
      stopSymbolRescanPoll();
      await loadSymbolMappings();
    } else {
      renderSymbolMappingPanel();
    }
  }, 5000);
});

// v1.0.14 — item 13 "add a new pair" workflow. Reveals the inline form,
// submits the typed symbol to bind-symbol (stores a pending_manual
// symbol_mappings row + flags the terminal for rescan), then reuses the
// exact same rescan-poll pattern as buttonRescanSymbols above to detect
// resolution and refresh the mapping panel once the EA's next scan lands.
buttonAddPair?.addEventListener('click', () => {
  if (!state.activeTerminalId || !addPairRow) return;
  addPairRow.hidden = false;
  if (addPairStatus) {
    addPairStatus.hidden = true;
    addPairStatus.textContent = '';
  }
  addPairInput?.focus();
});

buttonCancelPair?.addEventListener('click', () => {
  if (!addPairRow) return;
  addPairRow.hidden = true;
  if (addPairInput) addPairInput.value = '';
  if (addPairStatus) {
    addPairStatus.hidden = true;
    addPairStatus.textContent = '';
  }
});

addPairRow?.addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!state.activeTerminalId || !addPairInput) return;

  const symbol = addPairInput.value.trim().toUpperCase();
  if (!symbol) return;

  const submitBtn = document.getElementById('button-submit-pair');
  if (submitBtn) submitBtn.disabled = true;
  if (buttonCancelPair) buttonCancelPair.disabled = true;
  if (addPairStatus) {
    addPairStatus.hidden = false;
    addPairStatus.textContent = 'Searching…';
  }

  try {
    await bindSymbol(state.activeTerminalId, symbol);
  } catch (err) {
    if (addPairStatus) addPairStatus.textContent = err.message;
    if (submitBtn) submitBtn.disabled = false;
    if (buttonCancelPair) buttonCancelPair.disabled = false;
    return;
  }

  // Same reveal + poll pattern as the rescan button: hide the form, show
  // the "searching…" state on the mapping panel (renderSymbolMappingPanel's
  // pending_manual bucket), and poll force_symbol_rescan until the EA's
  // next scan resolves it or we give up after ~1 minute.
  addPairRow.hidden = true;
  addPairInput.value = '';
  if (submitBtn) submitBtn.disabled = false;
  if (buttonCancelPair) buttonCancelPair.disabled = false;
  if (addPairStatus) {
    addPairStatus.hidden = false;
    addPairStatus.textContent = `Searching for ${symbol}…`;
  }

  await refreshActiveTerminalScanStatus();
  await loadSymbolMappings();

  stopSymbolRescanPoll();
  let attempts = 0;
  symbolRescanPollId = setInterval(async () => {
    attempts += 1;
    const status = await refreshActiveTerminalScanStatus();
    const stillPending = status?.force_symbol_rescan;
    if (!stillPending || attempts >= 12) {
      stopSymbolRescanPoll();
      if (addPairStatus) {
        addPairStatus.hidden = true;
        addPairStatus.textContent = '';
      }
      await loadSymbolMappings();
    } else {
      renderSymbolMappingPanel();
    }
  }, 5000);
});

async function loadTradeHistory() {
  if (!state.activeTerminalId) {
    state.tradeHistory = [];
    renderWinRate();
    renderPlChart();
    renderSessionsTab();
    renderWinRateTab();
    renderDurationTab();
    return;
  }
  const { data, error } = await supabase
    .from('trade_history')
    .select(
      'id, symbol, side, volume, profit, net_profit, r_multiple, open_time, close_time, strategy_id, session, htf_regime, near_news_event, news_event_id, outcome, source, profit_verified'
    )
    .eq('terminal_id', state.activeTerminalId)
    .order('close_time', { ascending: true });

  if (error) {
    console.error('loadTradeHistory error', error);
    return;
  }
  state.tradeHistory = data || [];
  renderWinRate();
  renderPlChart();
  renderStrategyWinRates();
  renderSessionsTab();
  renderWinRateTab();
  renderDurationTab();
  if (!viewPairs.hidden) renderPairsView();
}

async function loadAccountHistory() {
  if (!state.activeTerminalId) {
    state.accountHistory = [];
    renderAccountHistoryList();
    return;
  }
  const { data, error } = await supabase
    .from('mt5_account_history')
    .select('deal_ticket, position_id, symbol, side, entry_type, deal_type, volume, price, profit, commission, swap, fee, occurred_at, comment')
    .eq('terminal_id', state.activeTerminalId)
    .order('occurred_at', { ascending: false })
    .limit(2000);
  if (error) {
    console.error('loadAccountHistory error', error);
    return;
  }
  state.accountHistory = data || [];
  renderAccountHistoryList();
}

// v1.0.18 -- rows with profit_verified === false were reconciled without an
// EA-supplied profit/close-price (see ea-sync's self-healing reconciler),
// so profit=0/outcome='breakeven' on them is a placeholder, not a real
// result. Every performance metric below excludes them so a stale EA build
// can't masquerade its missing data as real 0% / $0.00 performance; the UI
// separately surfaces how many are pending verification instead of silently
// dropping them.
function getVerifiedTradeHistory() {
  return state.tradeHistory.filter((t) => t.profit_verified !== false);
}
function getPendingVerificationCount() {
  return state.tradeHistory.filter((t) => t.profit_verified === false).length;
}

// v1.0.19 -- shared clickable/underlined "N pending verification" snippet
// used everywhere the metrics widgets mention pending trades. Clicking it
// opens the Account History modal pre-filtered to "Pending verification"
// so there's always a clear answer to "where do I go look" instead of a
// dead-end count with no explanation.
const PENDING_VERIFICATION_TOOLTIP =
  "Closed without your MT5 terminal confirming a final profit/loss (e.g. a brief connectivity gap). Excluded from every stat until verified -- click to view, or wait for your EA's next sync to clear it automatically.";
function pendingVerificationLink(count, label) {
  return `<span class="pending-verification-link" data-open-account-history="pending" title="${PENDING_VERIFICATION_TOOLTIP}">${label ?? `${count} pending verification`}</span>`;
}

function renderStrategyWinRates() {
  // Attach a computed win rate + trade count onto each strategy row, if we have trade history.
  strategyList.querySelectorAll('.mini-table-row').forEach((row) => {
    const id = row.dataset.strategyId;
    const trades = getVerifiedTradeHistory().filter((t) => t.strategy_id === id);
    const pendingCount = state.tradeHistory.filter(
      (t) => t.strategy_id === id && t.profit_verified === false
    ).length;
    const statsEl = row.querySelector('.mini-table-stats');
    if (!statsEl) return;
    if (trades.length === 0) {
      statsEl.innerHTML = pendingCount > 0
        ? `<div class="count">${pendingVerificationLink(pendingCount)}</div>`
        : '';
      return;
    }
    const wins = trades.filter((t) => (t.profit ?? 0) > 0).length;
    const pct = Math.round((wins / trades.length) * 100);
    const countLabel = pendingCount > 0
      ? `${trades.length} trades · ${pendingVerificationLink(pendingCount, `${pendingCount} pending`)}`
      : `${trades.length} trades`;
    statsEl.innerHTML = `<div class="pct">${pct}%</div><div class="count">${countLabel}</div>`;
  });
}

function renderWinRate() {
  const verified = getVerifiedTradeHistory();
  const total = verified.length;
  const pending = getPendingVerificationCount();
  if (total === 0) {
    textWinrateValue.textContent = '—';
    textWinrateSub.innerHTML = pending > 0 ? `${pendingVerificationLink(pending, `${pending} trades pending verification`)}` : 'No trades yet';
    textAvgRr.textContent = '—';
    winrateGaugeArc.setAttribute('stroke-dasharray', '0 157.08');
    return;
  }
  const wins = verified.filter((t) => (t.profit ?? 0) > 0).length;
  const pct = Math.round((wins / total) * 100);
  const avgRr =
    verified.reduce((sum, t) => sum + (t.r_multiple ?? 0), 0) / total;

  textWinrateValue.textContent = `${pct}%`;
  textWinrateSub.innerHTML = pending > 0
    ? `${pct >= 55 ? 'On target' : 'Below target'} · ${pendingVerificationLink(pending)}`
    : pct >= 55 ? 'On target' : 'Below target';
  textAvgRr.textContent = avgRr.toFixed(1);

  const arcLength = 157.08;
  const filled = (pct / 100) * arcLength;
  winrateGaugeArc.setAttribute('stroke-dasharray', `${filled.toFixed(1)} ${(arcLength - filled).toFixed(1)}`);
}

async function loadAgentPolicies() {
  if (!state.activeTerminalId) {
    state.agentPolicies = [];
    renderRiskEngine();
    return;
  }
  const { data, error } = await supabase
    .from('agent_policies')
    .select('id, decision')
    .eq('terminal_id', state.activeTerminalId);

  if (error) {
    console.error('loadAgentPolicies error', error);
    return;
  }
  state.agentPolicies = data || [];
  renderRiskEngine();
}

function renderRiskEngine() {
  const blocked = state.signals.filter((s) => s.policy_decision === 'block').length;
  // v1.0.19 -- previously read state.agentPolicies (the scenario-level
  // adaptive throttle ladder table), which stays empty until scenario_stats
  // has accumulated verified trades per session/htf_regime/news scenario --
  // a cold-start condition that could persist indefinitely. The dashboard's
  // own signal feed already carries a per-signal policy_decision (including
  // 'downweight'), so count directly from state.signals for an accurate,
  // immediately-available number instead of waiting on the ladder to warm up.
  const downweighted = state.signals.filter((s) => s.policy_decision === 'downweight').length;

  textRiskBlocked.textContent = `${blocked.toLocaleString()} signals`;
  textRiskDownweighted.textContent = `${downweighted.toLocaleString()} signals`;

  if (state.signals.length === 0) {
    textRiskTrend.textContent = 'Adaptive risk engine warms up once trade history exists';
    riskGaugeArc.setAttribute('stroke-dasharray', '0 157.08');
    return;
  }

  const total = state.signals.length;
  const blockedPct = total > 0 ? blocked / total : 0;
  const arcLength = 157.08;
  const filled = blockedPct * arcLength;
  riskGaugeArc.setAttribute('stroke-dasharray', `${filled.toFixed(1)} ${(arcLength - filled).toFixed(1)}`);
  textRiskTrend.textContent = `${Math.round(blockedPct * 100)}% of signals blocked by risk rules`;
}

// ---------------------------------------------------------------------------
// Analytics tab strip — Signals / Overview / Positions / Sessions / Blocked /
// Risk Score / Win Rate / Duration / News Events / Strategy Status
// ---------------------------------------------------------------------------
const SESSION_LABELS = { asia: 'Asia', london: 'London', ny: 'New York', overlap: 'Overlap' };
const IMPACT_LABELS = { high: 'High', medium: 'Medium', low: 'Low' };

function setActiveTab(tab) {
  state.activeTab = tab;
  document.querySelectorAll('.tab-row .tab').forEach((link) => {
    const isActive = link.dataset.tab === tab;
    link.classList.toggle('active', isActive);
    link.setAttribute('aria-selected', isActive ? 'true' : 'false');
  });
  document.querySelectorAll('.tab-panel').forEach((panel) => {
    const isActive = panel.dataset.tabPanel === tab;
    panel.classList.toggle('active', isActive);
    panel.hidden = !isActive;
  });
}

document.querySelectorAll('.tab-row .tab').forEach((link) => {
  link.addEventListener('click', (e) => {
    e.preventDefault();
    setActiveTab(link.dataset.tab);
    link.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'nearest' });
  });
});

// Mobile scroll-fade affordance: hints that more tabs are reachable by swiping.
const tabRowEl = document.querySelector('.tab-row');
const tabRowWrapEl = document.querySelector('.tab-row-wrap');
if (tabRowEl && tabRowWrapEl) {
  const updateTabRowOverflow = () => {
    const hasOverflow = tabRowEl.scrollWidth - tabRowEl.clientWidth - tabRowEl.scrollLeft > 4;
    tabRowWrapEl.classList.toggle('has-overflow', hasOverflow);
  };
  window.updateTabRowOverflow = updateTabRowOverflow;
  tabRowEl.addEventListener('scroll', updateTabRowOverflow, { passive: true });
  window.addEventListener('resize', updateTabRowOverflow);
  updateTabRowOverflow();
}

// Shared "why did the news policy touch this signal" line for the Signals
// and Blocked tabs. news_event_id/near_news_event/htf_regime/
// suggested_volume all come from apply_news_policy() (migrations 026/027) —
// this just surfaces what the trigger already recorded, it doesn't
// recompute the decision.
function signalNewsDetail(s) {
  if (!s.near_news_event) return '';
  const ev = s.calendar_events;
  const label = ev ? `${ev.title}${ev.currency ? ` (${ev.currency})` : ''}` : 'a nearby event';
  const regimeTag = s.htf_regime ? ` · ${s.htf_regime[0].toUpperCase()}${s.htf_regime.slice(1)} regime` : '';
  return `<div class="strategy-sub news-figures">Near news: ${label} · suggested ${
    s.suggested_volume ?? '—'
  } lots${regimeTag}</div>`;
}

function renderSignalsTab() {
  const list = document.getElementById('tab-signals-list');
  if (!list) return;
  if (state.signals.length === 0) {
    list.innerHTML =
      '<p class="empty-state-text">No signals yet. Once your EA is connected and generating signals, they\'ll show up here.</p>';
    return;
  }
  const sorted = [...state.signals].sort(
    (a, b) => new Date(b.generated_at || 0) - new Date(a.generated_at || 0)
  );
  list.innerHTML = sorted
    .map((s) => {
      const sideClass = s.side === 'sell' ? 'side-sell' : 'side-buy';
      const decisionTag =
        s.policy_decision === 'block'
          ? '<span class="tag-badge tag-danger">Blocked</span>'
          : s.policy_decision === 'downweight'
          ? '<span class="tag-badge tag-warn">Downweighted</span>'
          : '<span class="tag-badge tag-ok">OK</span>';
      return `
        <div class="mini-table-row">
          <div class="mini-table-meta">
            <div class="strategy-name">${s.symbol || 'Unknown'}<span class="side-badge ${sideClass}">${s.side || '—'}</span></div>
            <div class="strategy-sub">${s.generated_at ? new Date(s.generated_at).toLocaleString() : '—'}</div>
            ${signalNewsDetail(s)}
          </div>
          <div class="mini-table-stats">${decisionTag}</div>
        </div>`;
    })
    .join('');
}

function renderBlockedTab() {
  const list = document.getElementById('tab-blocked-list');
  if (!list) return;
  const blocked = state.signals.filter(
    (s) => s.policy_decision === 'block' || s.policy_decision === 'downweight'
  );
  if (blocked.length === 0) {
    list.innerHTML =
      '<p class="empty-state-text">No blocked signals. The risk engine hasn\'t intervened on anything yet.</p>';
    return;
  }
  const sorted = [...blocked].sort(
    (a, b) => new Date(b.generated_at || 0) - new Date(a.generated_at || 0)
  );
  list.innerHTML = sorted
    .map((s) => {
      const sideClass = s.side === 'sell' ? 'side-sell' : 'side-buy';
      const decisionTag =
        s.policy_decision === 'block'
          ? '<span class="tag-badge tag-danger">Blocked</span>'
          : '<span class="tag-badge tag-warn">Downweighted</span>';
      return `
        <div class="mini-table-row">
          <div class="mini-table-meta">
            <div class="strategy-name">${s.symbol || 'Unknown'}<span class="side-badge ${sideClass}">${s.side || '—'}</span></div>
            <div class="strategy-sub">${s.generated_at ? new Date(s.generated_at).toLocaleString() : '—'}</div>
            ${signalNewsDetail(s)}
          </div>
          <div class="mini-table-stats">${decisionTag}</div>
        </div>`;
    })
    .join('');
}

function renderPositionsTab() {
  const list = document.getElementById('tab-positions-list');
  if (!list) return;
  if (state.positions.length === 0) {
    list.innerHTML =
      '<p class="empty-state-text">No open positions. Connect an account and place an order to see it here.</p>';
    return;
  }
  list.innerHTML = state.positions
    .map((p) => {
      const plValue = Number(p.unrealized_pl) || 0;
      const plColor =
        plValue > 0 ? 'var(--color-positive)' : plValue < 0 ? 'var(--color-negative)' : 'var(--color-text-muted)';
      const sideClass = p.side === 'sell' ? 'side-sell' : 'side-buy';
      return `
        <div class="mini-table-row">
          <div class="mini-table-meta">
            <div class="strategy-name">${p.symbol}<span class="side-badge ${sideClass}">${p.side}</span></div>
            <div class="strategy-sub">${p.volume} lots · SL ${p.sl ?? '—'} · TP ${p.tp ?? '—'} · opened ${new Date(
        p.open_time
      ).toLocaleString()}</div>
          </div>
          <div class="mini-table-stats">
            <div class="pct" style="color:${plColor}">${plValue >= 0 ? '+' : ''}${plValue.toFixed(2)}</div>
            <div class="count">${p.open_price} → ${p.current_price ?? '—'}</div>
          </div>
        </div>`;
    })
    .join('');
}

function renderSessionsTab() {
  const list = document.getElementById('tab-sessions-list');
  if (!list) return;
  const closed = getVerifiedTradeHistory().filter((t) => t.close_time);
  const pending = getPendingVerificationCount();
  if (closed.length === 0) {
    list.innerHTML = pending > 0
      ? `<p class="empty-state-text">${pendingVerificationLink(pending, `${pending} trade${pending === 1 ? '' : 's'} pending verification`)} (missing EA-reported profit data). Session breakdowns will appear once verified trades close.</p>`
      : '<p class="empty-state-text">No closed trades yet. Session breakdowns appear once trades close.</p>';
    return;
  }
  const bySession = new Map();
  closed.forEach((t) => {
    const key = t.session || 'unknown';
    if (!bySession.has(key)) bySession.set(key, []);
    bySession.get(key).push(t);
  });
  const order = ['asia', 'london', 'ny', 'overlap', 'unknown'];
  const keys = [...bySession.keys()].sort((a, b) => order.indexOf(a) - order.indexOf(b));
  list.innerHTML = keys
    .map((key) => {
      const trades = bySession.get(key);
      const wins = trades.filter((t) => (t.profit ?? 0) > 0).length;
      const winRate = Math.round((wins / trades.length) * 100);
      const avgR = trades.reduce((sum, t) => sum + (t.r_multiple ?? 0), 0) / trades.length;
      return `
        <div class="mini-table-row">
          <div class="mini-table-meta">
            <div class="strategy-name">${SESSION_LABELS[key] || 'Unknown'}</div>
            <div class="strategy-sub">${trades.length} closed trades</div>
          </div>
          <div class="mini-table-stats">
            <div class="pct">${winRate}%</div>
            <div class="count">avg ${avgR.toFixed(2)}R</div>
          </div>
        </div>`;
    })
    .join('');
}

function renderWinRateTab() {
  const list = document.getElementById('tab-winrate-list');
  if (!list) return;
  const closed = getVerifiedTradeHistory().filter((t) => t.close_time);
  const pending = getPendingVerificationCount();
  if (closed.length === 0) {
    list.innerHTML = pending > 0
      ? `<p class="empty-state-text">${pendingVerificationLink(pending, `${pending} trade${pending === 1 ? '' : 's'} pending verification`)} (missing EA-reported profit data).</p>`
      : '<p class="empty-state-text">No trades yet.</p>';
    return;
  }
  const wins = closed.filter((t) => (t.outcome ? t.outcome === 'win' : (t.profit ?? 0) > 0)).length;
  const losses = closed.filter((t) => (t.outcome ? t.outcome === 'loss' : (t.profit ?? 0) < 0)).length;
  const breakeven = closed.length - wins - losses;
  const avgR = closed.reduce((sum, t) => sum + (t.r_multiple ?? 0), 0) / closed.length;

  const bySymbol = new Map();
  closed.forEach((t) => {
    if (!bySymbol.has(t.symbol)) bySymbol.set(t.symbol, []);
    bySymbol.get(t.symbol).push(t);
  });

  const summaryHtml = `
    <div class="stat-summary-row">
      <div class="stat-summary-item"><div class="stat-value">${closed.length}</div><div class="stat-label">Closed trades</div></div>
      <div class="stat-summary-item"><div class="stat-value">${wins}</div><div class="stat-label">Wins</div></div>
      <div class="stat-summary-item"><div class="stat-value">${losses}</div><div class="stat-label">Losses</div></div>
      <div class="stat-summary-item"><div class="stat-value">${breakeven}</div><div class="stat-label">Breakeven</div></div>
      <div class="stat-summary-item"><div class="stat-value">${avgR.toFixed(2)}R</div><div class="stat-label">Avg R-multiple</div></div>
    </div>${pending > 0 ? `<p class="field-hint">${pendingVerificationLink(pending, `${pending} additional trade${pending === 1 ? '' : 's'} pending verification`)} and excluded above.</p>` : ''}`;

  const rowsHtml = [...bySymbol.entries()]
    .sort((a, b) => b[1].length - a[1].length)
    .map(([symbol, trades]) => {
      const symWins = trades.filter((t) => (t.profit ?? 0) > 0).length;
      const pct = Math.round((symWins / trades.length) * 100);
      return `
        <div class="mini-table-row">
          <div class="mini-table-meta">
            <div class="strategy-name">${symbol}</div>
            <div class="strategy-sub">${trades.length} closed trades</div>
          </div>
          <div class="mini-table-stats">
            <div class="pct">${pct}%</div>
            <div class="count">win rate</div>
          </div>
        </div>`;
    })
    .join('');

  list.innerHTML = summaryHtml + rowsHtml;
}

function renderDurationTab() {
  const list = document.getElementById('tab-duration-list');
  if (!list) return;
  const closed = getVerifiedTradeHistory().filter((t) => t.open_time && t.close_time);
  const pending = getPendingVerificationCount();
  if (closed.length === 0) {
    list.innerHTML = pending > 0
      ? `<p class="empty-state-text">${pendingVerificationLink(pending, `${pending} trade${pending === 1 ? '' : 's'} pending verification`)} (missing EA-reported profit data).</p>`
      : '<p class="empty-state-text">No closed trades yet.</p>';
    return;
  }
  const durationsMin = closed.map(
    (t) => (new Date(t.close_time).getTime() - new Date(t.open_time).getTime()) / 60000
  );
  const avgMin = durationsMin.reduce((sum, m) => sum + m, 0) / durationsMin.length;
  const sorted = [...durationsMin].sort((a, b) => a - b);
  const medianMin = sorted[Math.floor(sorted.length / 2)];

  const buckets = [
    { label: '< 15 min', test: (m) => m < 15 },
    { label: '15 – 60 min', test: (m) => m >= 15 && m < 60 },
    { label: '1 – 4 hours', test: (m) => m >= 60 && m < 240 },
    { label: '4+ hours', test: (m) => m >= 240 },
  ];

  const formatDuration = (min) => {
    if (min < 60) return `${Math.round(min)}m`;
    if (min < 1440) return `${(min / 60).toFixed(1)}h`;
    return `${(min / 1440).toFixed(1)}d`;
  };

  const summaryHtml = `
    <div class="stat-summary-row">
      <div class="stat-summary-item"><div class="stat-value">${formatDuration(avgMin)}</div><div class="stat-label">Avg hold time</div></div>
      <div class="stat-summary-item"><div class="stat-value">${formatDuration(medianMin)}</div><div class="stat-label">Median hold time</div></div>
      <div class="stat-summary-item"><div class="stat-value">${closed.length}</div><div class="stat-label">Closed trades</div></div>
    </div>`;

  const rowsHtml = buckets
    .map((b) => {
      const count = durationsMin.filter(b.test).length;
      const pct = Math.round((count / durationsMin.length) * 100);
      return `
        <div class="mini-table-row">
          <div class="mini-table-meta">
            <div class="strategy-name">${b.label}</div>
          </div>
          <div class="mini-table-stats">
            <div class="pct">${count}</div>
            <div class="count">${pct}% of trades</div>
          </div>
        </div>`;
    })
    .join('');

  list.innerHTML = summaryHtml + rowsHtml;
}

// ---------------------------------------------------------------------------
// Account history modal (v1.0.19) -- scrollable list of every trade in
// trade_history for the active terminal. Opened from the "Positions Closed
// →" link on the P&L card, and from any "pending verification" note
// elsewhere on the dashboard (via pendingVerificationLink() above), so
// there's always a clear place to go look instead of a dead-end count.
// ---------------------------------------------------------------------------
function renderAccountHistoryList() {
  const list = document.getElementById('account-history-list');
  if (!list) return;
  const rows = [...state.accountHistory];

  if (rows.length === 0) {
    list.innerHTML = `<p class="empty-state-text">${
      'No MT5 account history has arrived yet. Compile the current EA and let it complete its initial sync.'
    }</p>`;
    return;
  }

  list.innerHTML = rows
    .map((t) => {
      const dateLabel = t.occurred_at ? new Date(t.occurred_at).toLocaleString() : '—';
      const profit = Number(t.profit || 0);
      const net = profit + Number(t.commission || 0) + Number(t.swap || 0) + Number(t.fee || 0);
      const profitCell = `<span class="hist-pl ${profit > 0 ? 'positive' : profit < 0 ? 'negative' : ''}">${profit >= 0 ? '+' : ''}${profit.toFixed(2)} <small>MT5 profit</small></span>`;
      const netCell = `<span class="hist-pl ${net > 0 ? 'positive' : net < 0 ? 'negative' : ''}">${net >= 0 ? '+' : ''}${net.toFixed(2)} <small>net</small></span>`;
      return `
        <div class="account-history-row">
          <div><span class="hist-symbol">${t.symbol || 'Account event'}</span> <span class="hist-side">${t.side || '—'}</span></div>
          <div class="hist-date">${dateLabel}</div>
          <div>${t.volume ?? '—'} lots</div>
          <div>${profitCell}<br/>${netCell}</div>
        </div>`;
    })
    .join('');
}

function openAccountHistoryModal() {
  renderAccountHistoryList();
  window.LucreUI?.openModal('modal-account-history');
}

document.getElementById('link-open-account-history')?.addEventListener('click', () => openAccountHistoryModal('all'));
document.getElementById('link-open-account-history')?.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' || e.key === ' ') {
    e.preventDefault();
    openAccountHistoryModal('all');
  }
});

// Event delegation: the pending-verification links above are re-rendered
// dynamically inside various tab/card innerHTML blocks, so a single
// document-level listener catches all of them regardless of when they
// were inserted.
document.addEventListener('click', (e) => {
  const trigger = e.target.closest('[data-open-account-history]');
  if (!trigger) return;
  openAccountHistoryModal(trigger.dataset.openAccountHistory);
});

async function loadCalendarEvents() {
  // v1.0.17 -- shortened from 100 to 30: the tab now shows a short, most-
  // recent-first list in a fixed-height scrollable card (see #tab-news-
  // events-list in style.css) instead of a long unbounded page-stretching
  // list, so a smaller page of the truly newest events is both faster to
  // load and matches the new bounded UI.
  const { data, error } = await supabase
    .from('calendar_events')
    .select(
      'id, event_time, country, currency, impact, title, affected_symbols, is_global, ' +
        'forecast, previous, actual, higher_is_bullish, source'
    )
    .order('event_time', { ascending: false })
    .limit(30);

  if (error) {
    console.error('loadCalendarEvents error', error);
    state.calendarEvents = [];
    renderNewsEventsTab();
    return;
  }
  state.calendarEvents = data || [];
  renderNewsEventsTab();
}

// Client-side mirror of apply_news_policy()'s Phase 2 "has this released and
// which way did it break" check (migration 027) — for display only. The
// authoritative, pair-aware decision runs server-side per signal; this just
// tells the user, at the calendar-event level, whether the market already
// has enough data to know which way the surprise leaned for `currency`.
function calendarEventBias(ev) {
  if (ev.actual === null || ev.actual === undefined) return null;
  const baseline = ev.forecast ?? ev.previous;
  if (baseline === null || baseline === undefined) return null;
  const surprise = ev.actual - baseline;
  if (surprise === 0) return 'neutral';
  const higherIsBullish = ev.higher_is_bullish ?? true; // guess_higher_is_bullish() default
  const bullish = surprise > 0 ? higherIsBullish : !higherIsBullish;
  return bullish ? 'bullish' : 'bearish';
}

function renderNewsEventsTab() {
  const list = document.getElementById('tab-news-events-list');
  if (!list) return;
  if (state.calendarEvents.length === 0) {
    list.innerHTML = '<p class="empty-state-text">No calendar events loaded yet.</p>';
    return;
  }
  list.innerHTML = state.calendarEvents
    .map((ev) => {
      const impactClass = ev.impact === 'high' ? 'tag-danger' : ev.impact === 'medium' ? 'tag-warn' : 'tag-neutral';
      const symbols = ev.is_global ? 'All symbols' : (ev.affected_symbols || []).join(' · ') || '—';
      const currencyTag = ev.currency ? `<span class="tag-badge tag-neutral">${ev.currency}</span>` : '';

      const bias = calendarEventBias(ev);
      const biasTag =
        bias === 'bullish'
          ? `<span class="tag-badge tag-ok">${ev.currency || 'Bullish'} bullish</span>`
          : bias === 'bearish'
          ? `<span class="tag-badge tag-danger">${ev.currency || 'Bearish'} bearish</span>`
          : bias === 'neutral'
          ? '<span class="tag-badge tag-neutral">Neutral surprise</span>'
          : '';

      const hasForecastOrActual = ev.forecast !== null || ev.actual !== null;
      const figuresLine = hasForecastOrActual
        ? `<div class="strategy-sub news-figures">Forecast ${fmtNum(ev.forecast)} · Previous ${fmtNum(
            ev.previous
          )} · Actual ${fmtNum(ev.actual)}</div>`
        : '';

      return `
        <div class="mini-table-row">
          <div class="mini-table-meta">
            <div class="strategy-name">${ev.title}<span class="tag-badge ${impactClass}">${
        IMPACT_LABELS[ev.impact] || ev.impact || '—'
      }</span>${currencyTag}${biasTag}</div>
            <div class="strategy-sub">${ev.country || '—'} · ${symbols} · ${
        ev.event_time ? new Date(ev.event_time).toLocaleString() : '—'
      }</div>
            ${figuresLine}
          </div>
        </div>`;
    })
    .join('');
}

function fmtNum(n) {
  return n === null || n === undefined ? '—' : Number(n).toLocaleString(undefined, { maximumFractionDigits: 3 });
}

function fmtUsd(n) {
  if (n === null || n === undefined) return '—';
  return Number(n).toLocaleString(undefined, { style: 'currency', currency: 'USD', maximumFractionDigits: 2 });
}

// ---------------------------------------------------------------------------
// Account balance widget (v1.0.11) -- sourced straight from mt5_terminals,
// kept live via the realtime channel below (see startRealtime).
// ---------------------------------------------------------------------------
function renderBalanceWidget() {
  const active = state.terminals.find((t) => t.id === state.activeTerminalId);
  if (!active) {
    balanceWidget.hidden = true;
    bannerAutotrading.hidden = true;
    return;
  }
  balanceWidget.hidden = false;
  balanceWidgetBalance.textContent = fmtUsd(active.balance);
  balanceWidgetEquity.textContent = fmtUsd(active.equity);
  balanceWidgetMargin.textContent =
    active.margin_level === null || active.margin_level === undefined ? '—' : `${fmtNum(active.margin_level)}%`;
}

async function loadScenarioStats() {
  if (!state.activeTerminalId) {
    state.scenarioStats = [];
    renderRiskScoreTab();
    return;
  }
  const { data, error } = await supabase
    .from('scenario_stats')
    .select(
      'id, symbol, session, htf_regime, near_news_event, trade_count, shrunk_win_rate, avg_r_multiple, computed_at'
    )
    .eq('terminal_id', state.activeTerminalId)
    .order('trade_count', { ascending: false });

  if (error) {
    console.error('loadScenarioStats error', error);
    return;
  }
  state.scenarioStats = data || [];
  renderRiskScoreTab();
}

function renderRiskScoreTab() {
  const list = document.getElementById('tab-risk-score-list');
  if (!list) return;
  if (state.scenarioStats.length === 0) {
    list.innerHTML =
      '<p class="empty-state-text">No scenario data yet. Scores appear after enough closed trades accumulate per scenario.</p>';
    return;
  }
  list.innerHTML = state.scenarioStats
    .map((s) => {
      const winRatePct = Math.round((s.shrunk_win_rate ?? 0) * 100);
      const regimeLabel = s.htf_regime ? s.htf_regime[0].toUpperCase() + s.htf_regime.slice(1) : '—';
      const newsTag = s.near_news_event ? ' · near news' : '';
      return `
        <div class="mini-table-row">
          <div class="mini-table-meta">
            <div class="strategy-name">${s.symbol}</div>
            <div class="strategy-sub">${SESSION_LABELS[s.session] || s.session || '—'} · ${regimeLabel}${newsTag} · ${
        s.trade_count
      } trades</div>
          </div>
          <div class="mini-table-stats">
            <div class="pct">${winRatePct}%</div>
            <div class="count">avg ${(s.avg_r_multiple ?? 0).toFixed(2)}R</div>
          </div>
        </div>`;
    })
    .join('');
}

// Human-readable summary of what a posture actually does, mirrored from the
// backend logic it configures (apply_news_policy(), migrations 026 + 027) —
// kept in sync by hand since this is the only place a user reads it as prose
// rather than SQL.
const NEWS_POSTURE_HINTS = {
  avoid:
    'Graduated pre-news caution scaled by impact, forecast availability, and proximity to release — ' +
    'the tighter the window and the higher the impact, the more it blocks or downweights. ' +
    'A signal that opposes a just-released, confirmed move is still blocked regardless of posture.',
  neutral:
    'No pre-news caution and no post-news size boost. Nearby events are still tagged on the signal ' +
    'for visibility, but news proximity never changes the policy decision.',
  exploit:
    'Accepts pre-news exposure by design — no caution before release. After the event fires, signals ' +
    'aligned with the confirmed directional move are sized up by the multiplier below (+25% more if the ' +
    'symbol is in a trending regime). A signal opposed to the confirmed move is still blocked.',
};
const NEWS_POSTURE_TAG_CLASS = { avoid: 'tag-warn', neutral: 'tag-neutral', exploit: 'tag-ok' };
const NEWS_POSTURE_LABEL = { avoid: 'Avoid', neutral: 'Neutral', exploit: 'Exploit' };

function renderStrategyStatusTab() {
  const list = document.getElementById('tab-strategy-status-list');
  if (!list) return;
  if (state.strategies.length === 0) {
    list.innerHTML =
      '<p class="empty-state-text">No strategies yet. Add your first one to get started.</p>';
    return;
  }
  const deliveryLabels = { auto: 'Auto', manual_confirm: 'Manual confirm' };
  list.innerHTML = state.strategies
    .map((s) => {
      const symbolLabel = (s.symbols || []).join(' · ') || s.kind || 'Custom';
      const statusTag = s.enabled ? '<span class="tag-badge tag-ok">Enabled</span>' : '<span class="tag-badge tag-neutral">Disabled</span>';
      const posture = s.news_posture || 'avoid';
      const isExploit = posture === 'exploit';
      const postureTagClass = NEWS_POSTURE_TAG_CLASS[posture] || 'tag-neutral';
      const postureLabel = NEWS_POSTURE_LABEL[posture] || posture;
      return `
        <div class="mini-table-row">
          <div class="mini-table-meta">
            <div class="strategy-name">${s.name}${statusTag}</div>
            <div class="strategy-sub">${symbolLabel} · ${
        deliveryLabels[s.delivery_mode] || s.delivery_mode || '—'
      } · max ${s.max_lot_size ?? '—'} lots · TTL ${s.signal_ttl_seconds ?? '—'}s</div>
          </div>
        </div>
        <div class="news-policy-panel" data-strategy-id="${s.id}">
          <div class="news-policy-head">
            <span class="news-policy-title">Directional news policy</span>
            <span class="tag-badge ${postureTagClass}">${postureLabel}</span>
          </div>
          <div class="news-policy-fields">
            <label class="news-policy-field">
              <span>Posture</span>
              <select data-news-field="news_posture" data-strategy-id="${s.id}">
                <option value="avoid" ${posture === 'avoid' ? 'selected' : ''}>Avoid</option>
                <option value="neutral" ${posture === 'neutral' ? 'selected' : ''}>Neutral</option>
                <option value="exploit" ${posture === 'exploit' ? 'selected' : ''}>Exploit</option>
              </select>
            </label>
            <label class="news-policy-field">
              <span>Min impact</span>
              <select data-news-field="news_min_impact" data-strategy-id="${s.id}">
                <option value="low" ${s.news_min_impact === 'low' ? 'selected' : ''}>Low</option>
                <option value="medium" ${s.news_min_impact === 'medium' || !s.news_min_impact ? 'selected' : ''}>Medium</option>
                <option value="high" ${s.news_min_impact === 'high' ? 'selected' : ''}>High</option>
              </select>
            </label>
            <label class="news-policy-field">
              <span>Window (min)</span>
              <input type="number" min="1" max="240" step="1" data-news-field="news_window_minutes"
                     data-strategy-id="${s.id}" value="${s.news_window_minutes ?? 30}" />
            </label>
            <label class="news-policy-field ${isExploit ? '' : 'is-disabled'}">
              <span>Exploit size ×</span>
              <input type="number" min="0.1" max="3" step="0.1" data-news-field="news_exploit_size_multiplier"
                     data-strategy-id="${s.id}" value="${s.news_exploit_size_multiplier ?? 1.5}"
                     ${isExploit ? '' : 'disabled'} />
            </label>
          </div>
          <p class="news-policy-hint">${NEWS_POSTURE_HINTS[posture] || ''}</p>
        </div>`;
    })
    .join('');

  list.querySelectorAll('[data-news-field]').forEach((el) => {
    el.addEventListener('change', async (e) => {
      const target = e.target;
      const strategyId = target.dataset.strategyId;
      const field = target.dataset.newsField;
      let value = target.value;

      if (field === 'news_window_minutes') {
        value = Math.max(1, Math.min(240, parseInt(value, 10) || 30));
      } else if (field === 'news_exploit_size_multiplier') {
        value = Math.max(0.1, Math.min(3, parseFloat(value) || 1.5));
      }

      const { error } = await supabase
        .from('strategies')
        .update({ [field]: value })
        .eq('id', strategyId);

      if (error) {
        console.error('update news policy error', error);
        alert(`Couldn't save that change: ${error.message}`);
        await loadStrategies();
        return;
      }

      const strategy = state.strategies.find((s) => s.id === strategyId);
      if (strategy) strategy[field] = value;
      renderStrategyStatusTab();
    });
  });
}

// ---------------------------------------------------------------------------
// Charts (empty-safe — Chart.js renders a flat/blank series until real data exists)
// ---------------------------------------------------------------------------
function renderVolumeChart() {
  const canvas = document.getElementById('volumeChart');
  if (!canvas || typeof Chart === 'undefined') return;
  if (volumeChartInstance) volumeChartInstance.destroy();

  const accent = cssVar('--color-accent') || '#d7e64e';
  const textFaint = cssVar('--color-text-faint') || '#99a496';
  const surfaceSunken = cssVar('--color-surface-sunken') || '#eef1e9';

  const daysInMonth = new Date(new Date().getFullYear(), new Date().getMonth() + 1, 0).getDate();
  const days = Array.from({ length: daysInMonth }, (_, i) => i + 1);

  const executedByDay = new Array(daysInMonth).fill(0);
  const blockedByDay = new Array(daysInMonth).fill(0);
  state.signals.forEach((s) => {
    if (!s.generated_at) return;
    const day = new Date(s.generated_at).getDate() - 1;
    if (day < 0 || day >= daysInMonth) return;
    if (s.policy_decision === 'block') blockedByDay[day] += 1;
    else executedByDay[day] += 1;
  });

  const ctx = canvas.getContext('2d');
  const gradient = ctx.createLinearGradient(0, 0, 0, 220);
  gradient.addColorStop(0, hexToRgba(accent, 0.35));
  gradient.addColorStop(1, hexToRgba(accent, 0.02));

  volumeChartInstance = new Chart(ctx, {
    data: {
      labels: days.map(String),
      datasets: [
        {
          type: 'bar',
          label: 'Blocked',
          data: blockedByDay,
          backgroundColor: surfaceSunken,
          borderRadius: 3,
          barPercentage: 0.55,
          categoryPercentage: 0.9,
          order: 2,
        },
        {
          type: 'line',
          label: 'Executed',
          data: executedByDay,
          borderColor: accent,
          borderWidth: 2.5,
          pointRadius: 0,
          tension: 0.45,
          fill: true,
          backgroundColor: gradient,
          order: 1,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { intersect: false },
      plugins: { legend: { display: false }, tooltip: { enabled: true } },
      scales: {
        x: { display: false },
        y: {
          position: 'right',
          beginAtZero: true,
          suggestedMax: Math.max(...executedByDay, ...blockedByDay, 0) === 0 ? 10 : undefined,
          ticks: { color: textFaint, font: { size: 11 }, precision: 0 },
          grid: { display: false },
          border: { display: false },
        },
      },
    },
  });
}

// v1.0.14 — item 3 rewrite. The card used to show win/loss COUNTS per day
// with no timeframe or manual/auto filter and never reflected manual trades
// distinctly. Now: cumulative $ P/L line, timeframe selector (7d/30d/90d/All)
// via state.plFilter.timeframe, and a Manual/Auto/All toggle via
// state.plFilter.source keyed off trade_history.source
// ('auto_signal' | 'manual_tap' | 'manual_order').
function getFilteredTradeHistoryForPl() {
  const { timeframe, source } = state.plFilter;
  const now = Date.now();
  const cutoffMs =
    timeframe === '7d' ? 7 * 24 * 60 * 60 * 1000 :
    timeframe === '30d' ? 30 * 24 * 60 * 60 * 1000 :
    timeframe === '90d' ? 90 * 24 * 60 * 60 * 1000 :
    null; // 'all'

  return getVerifiedTradeHistory().filter((t) => {
    if (!t.close_time) return false;
    if (cutoffMs !== null && now - new Date(t.close_time).getTime() > cutoffMs) return false;
    if (source === 'auto' && t.source !== 'auto_signal') return false;
    if (source === 'manual' && t.source !== 'manual_tap' && t.source !== 'manual_order') return false;
    return true;
  });
}

function renderPlChart() {
  const canvas = document.getElementById('plChart');
  if (!canvas || typeof Chart === 'undefined') return;
  if (plChartInstance) plChartInstance.destroy();

  const positive = cssVar('--color-positive') || '#4c8a5e';
  const negative = cssVar('--color-negative') || '#c3583f';
  const textFaint = cssVar('--color-text-faint') || '#99a496';

  const trades = getFilteredTradeHistoryForPl()
    .slice()
    .sort((a, b) => new Date(a.close_time) - new Date(b.close_time));

  // Bucket by day and accumulate running $ P/L across the filtered set so
  // the line reflects manual trades too, not just auto signals.
  const byDate = new Map();
  trades.forEach((t) => {
    const key = new Date(t.close_time).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
    byDate.set(key, (byDate.get(key) || 0) + Number(t.profit ?? 0));
  });

  const tradePlTotal = trades.reduce((sum, t) => sum + Number(t.profit ?? 0), 0);
  const netTotal = trades.reduce((sum, t) => sum + Number(t.net_profit ?? t.profit ?? 0), 0);
  if (plSummaryValue) {
    if (trades.length === 0) {
      plSummaryValue.textContent = '—';
      plSummaryValue.style.color = '';
    } else {
      const sign = tradePlTotal >= 0 ? '+' : '−';
      plSummaryValue.textContent = `${sign}$${Math.abs(tradePlTotal).toFixed(2)}`;
      plSummaryValue.style.color = tradePlTotal >= 0 ? positive : negative;
    }
  }
  const plSummaryDetail = document.getElementById('pl-summary-detail');
  if (plSummaryDetail) {
    if (trades.length === 0) {
      plSummaryDetail.textContent = '';
    } else {
      const netSign = netTotal >= 0 ? '+' : '−';
      const costs = netTotal - tradePlTotal;
      plSummaryDetail.textContent = `Net after costs ${netSign}$${Math.abs(netTotal).toFixed(2)} · Costs ${costs >= 0 ? '+' : '−'}$${Math.abs(costs).toFixed(2)}`;
    }
  }

  let labels = ['No closed trades'];
  let cumulative = [0];
  let lineColor = textFaint;

  if (byDate.size > 0) {
    labels = [...byDate.keys()];
    let running = 0;
    cumulative = [...byDate.values()].map((delta) => {
      running += delta;
      return running;
    });
    lineColor = running >= 0 ? positive : negative;
  }

  plChartInstance = new Chart(canvas.getContext('2d'), {
    type: 'line',
    data: {
      labels,
      datasets: [
        {
          label: 'Cumulative P/L',
          data: cumulative,
          borderColor: lineColor,
          backgroundColor: hexToRgba(lineColor, 0.15),
          fill: true,
          tension: 0.3,
          pointRadius: 0,
          pointHoverRadius: 4,
          borderWidth: 2,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { intersect: false, mode: 'index' },
      plugins: {
        legend: { display: false },
        tooltip: {
          enabled: true,
          callbacks: {
            label: (ctx) => `P/L: ${ctx.parsed.y >= 0 ? '+' : '−'}$${Math.abs(ctx.parsed.y).toFixed(2)}`,
          },
        },
      },
      scales: {
        x: {
          ticks: { color: textFaint, font: { size: 10 }, autoSkip: true, maxRotation: 0 },
          grid: { display: false },
          border: { display: false },
        },
        y: { display: false },
      },
    },
  });
}

plTimeframeSelect?.addEventListener('change', (e) => {
  state.plFilter.timeframe = e.target.value;
  renderPlChart();
});

plSourceSelect?.addEventListener('change', (e) => {
  state.plFilter.source = e.target.value;
  renderPlChart();
});

window.addEventListener('lucre:theme-changed', () => {
  renderVolumeChart();
  renderPlChart();
});

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
async function bootDashboard() {
  await loadProfile();
  await Promise.all([loadTerminals(), loadCalendarEvents()]);
  startPositionPolling();
}

function resetDashboardState() {
  state.profile = null;
  state.terminals = [];
  state.activeTerminalId = null;
  state.strategies = [];
  state.signals = [];
  state.signalDeliveries = [];
  state.tradeHistory = [];
  state.agentPolicies = [];
  state.positions = [];
  state.pendingSignals = [];
  state.symbolSettings = [];
  state.symbolMappings = [];
  state.calendarEvents = [];
  state.scenarioStats = [];
  setActiveTab('overview');
  stopPositionPolling();
  stopRealtime();
  stopSymbolRescanPoll();
}

// v1.0.11 -- iOS was showing its native "Save Password?" alert at
// seemingly random moments after sign-in, including right after placing an
// order. Root cause: #auth-form (and its #auth-password input) was only
// ever hidden via aria-hidden/class/display -- it stayed permanently
// mounted in the DOM even after a successful login. Safari's password-save
// heuristic can defer showing that sheet until a later DOM/navigation
// event, so it was firing coincidentally with unrelated later form
// submissions (like the order form) rather than at sign-in itself.
// Fix: physically remove the auth form from the DOM on sign-in and
// reinsert it at the exact same position on sign-out, using a placeholder
// comment node so re-login still works normally.
const authFormPlaceholder = document.createComment('auth-form-placeholder');
let authFormDetached = false;

function detachAuthForm() {
  if (authFormDetached || !authForm || !authForm.parentNode) return;
  authForm.parentNode.insertBefore(authFormPlaceholder, authForm);
  authForm.remove();
  authFormDetached = true;
}

function reattachAuthForm() {
  if (!authFormDetached || !authFormPlaceholder.parentNode) return;
  authFormPlaceholder.parentNode.insertBefore(authForm, authFormPlaceholder);
  authFormPlaceholder.remove();
  authFormDetached = false;
}

supabase.auth.onAuthStateChange((_event, session) => {
  state.session = session;
  if (session) {
    showDashboard();
    setAuthMessage('');
    authForm?.reset();
    detachAuthForm();
    bootDashboard();
  } else {
    resetDashboardState();
    reattachAuthForm();
    showAuthGate();
  }
});

supabase.auth.getSession().then(({ data }) => {
  state.session = data.session;
  if (data.session) {
    showDashboard();
    detachAuthForm();
    bootDashboard();
  } else {
    showAuthGate();
  }
});
