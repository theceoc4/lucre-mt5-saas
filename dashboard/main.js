import { supabase, SUPABASE_URL, SUPABASE_ANON_KEY } from './supabase-client.js';
import {
  provisionTerminalKey,
  tapSignal,
  placeManualOrder,
  modifyPosition,
  closePosition,
  rescanSymbols,
  repairPriceFeed,
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
  symbolSettings: [],
  symbolMappings: [],
  trendStates: [],
  priceFeedStates: [],
  calendarEvents: [],
  scenarioStats: [],
  portfolioRisk: null,
  recentCommands: [],
  notifications: [],
  activeTab: 'overview',
  signalFilter: { pair: 'all', period: '30d' },
  // v1.0.14 — item 3: P/L Over Time card filters (timeframe + manual/auto/all).
  plFilter: { timeframe: '30d', source: 'all' },
};

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
const flippedPairCards = new Set();
const pairRepairsInFlight = new Set();
const PRICE_TIMEFRAMES = ['M1', 'M5', 'M15', 'M30', 'H1', 'H4', 'D1', 'W1'];
const PRICE_TIMEFRAME_SECONDS = {
  M1: 60, M5: 300, M15: 900, M30: 1800,
  H1: 3600, H4: 14400, D1: 86400, W1: 604800,
};

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
const symbolSearchForm = document.getElementById('form-symbol-search');
const symbolSearchInput = document.getElementById('symbol-settings-search');
const buttonPairSymbol = document.getElementById('button-pair-symbol');
const symbolSettingsStatus = document.getElementById('symbol-settings-status');
const symbolSettingsList = document.getElementById('symbol-settings-list');
const symbolMappingStatus = document.getElementById('symbol-mapping-status');
const symbolMappingBody = document.getElementById('symbol-mapping-body');
const plTimeframeSelect = document.getElementById('pl-timeframe-select');
const plSourceSelect = document.getElementById('pl-source-select');
const plSummaryValue = document.getElementById('pl-summary-value');
const signalsPairFilter = document.getElementById('signals-pair-filter');
const signalsPeriodFilter = document.getElementById('signals-period-filter');
const buttonNotifications = document.getElementById('button-notifications');
const notificationPanel = document.getElementById('notification-panel');
const notificationList = document.getElementById('notification-list');
const notificationDot = document.getElementById('notification-dot');
const notificationCount = document.getElementById('notification-count');

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

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[character]);
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
document.getElementById('button-settings')?.addEventListener('click', () => {
  if (symbolSearchInput) symbolSearchInput.value = '';
  if (symbolSettingsStatus) {
    symbolSettingsStatus.hidden = true;
    symbolSettingsStatus.textContent = '';
  }
  renderSymbolSettingsList();
  renderSymbolMappingPanel();
  loadPortfolioRiskSettings();
  window.LucreUI?.openModal('modal-platform-settings');
});

async function loadPortfolioRiskSettings() {
  const form = document.getElementById('form-portfolio-risk');
  if (!form || !state.activeTerminalId) return;
  const { data, error } = await supabase.from('portfolio_risk_settings').select('*').eq('terminal_id', state.activeTerminalId).maybeSingle();
  if (error) { console.error('portfolio risk settings load error', error); return; }
  state.portfolioRisk = data;
  const values = data || { enabled: true, max_total_open_risk_percent: 3, max_symbol_open_risk_percent: 1.5, max_positions_per_symbol: 2, max_daily_realized_loss_percent: 3 };
  form.enabled.checked = values.enabled !== false;
  for (const field of ['max_total_open_risk_percent','max_symbol_open_risk_percent','max_positions_per_symbol','max_daily_realized_loss_percent']) form[field].value = values[field];
}

document.getElementById('form-portfolio-risk')?.addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = event.currentTarget, message = document.getElementById('portfolio-risk-message');
  const payload = { terminal_id: state.activeTerminalId, enabled: form.enabled.checked,
    max_total_open_risk_percent: Number(form.max_total_open_risk_percent.value), max_symbol_open_risk_percent: Number(form.max_symbol_open_risk_percent.value),
    max_positions_per_symbol: Number(form.max_positions_per_symbol.value), max_daily_realized_loss_percent: Number(form.max_daily_realized_loss_percent.value) };
  const { error } = await supabase.from('portfolio_risk_settings').upsert(payload, { onConflict: 'terminal_id' });
  if (message) { message.style.color = error ? 'var(--color-danger)' : 'var(--color-accent)'; message.textContent = error ? error.message : 'Risk limits saved.'; }
  if (!error) state.portfolioRisk = payload;
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
    loadPriceFeedStates();
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
// v1.0.30 -- template parameters plus a validated, declarative rule builder.
// v1.0.12 -- the Symbols field was a native <select multiple>, which (a)
// requires holding Cmd/Ctrl to select more than one pair — most users just
// click each pair in turn, which replaces the previous selection instead
// of adding to it — and (b) can't be multi-selected at all on many mobile
// browsers. Replaced with a single-pick dropdown + explicit "Add" button
// that appends to a persistent, visible chip list (strategySelectedSymbols).
// Each add removes that pair from the dropdown (can't add twice); each
// chip has its own remove button that puts the pair back in the dropdown.
let strategySelectedSymbols = [];
let strategyIndicatorRows = [];
let strategyHasLegacyDefinition = false;

const STRATEGY_KIND_SIGNAL_FAMILY = {
  momentum_breakout: 'breakout',
  confirmed_trend_pullback: 'trend_pullback',
  multi_timeframe_trend_pullback: 'trend_pullback',
  range_mean_reversion: 'vwap_reversion',
  volatility_compression_breakout: 'breakout',
  news_continuation: 'momentum',
  custom_rules: 'momentum',
};

const ACTIVE_STRATEGY_KINDS = Object.keys(STRATEGY_KIND_SIGNAL_FAMILY);
const TIMEFRAME_SIGNAL_TTL_SECONDS = {
  M1: 60, M5: 300, M15: 900, M30: 1800,
  H1: 3600, H4: 14400, D1: 86400, W1: 604800,
};
const STRATEGY_DEFAULT_RISK_PERCENT = {
  momentum_breakout: 0.50,
  confirmed_trend_pullback: 0.35,
  multi_timeframe_trend_pullback: 0.35,
  range_mean_reversion: 0.25,
  volatility_compression_breakout: 0.35,
  news_continuation: 0.20,
  custom_rules: 0.25,
};

const INDICATOR_CATALOG = {
  ema_crossover: {
    label: 'EMA crossover', description: 'Uses the relationship between a fast and slow exponential moving average.',
    params: [
      { key: 'fast_period', label: 'Fast EMA', type: 'number', min: 2, max: 200, step: 1, value: 20 },
      { key: 'slow_period', label: 'Slow EMA', type: 'number', min: 3, max: 400, step: 1, value: 50 },
      { key: 'trigger', label: 'Trigger', type: 'select', value: 'alignment', options: [['alignment', 'Current alignment'], ['fresh_cross', 'Fresh crossover only']] },
    ],
  },
  rsi: {
    label: 'RSI', description: 'Confirms bullish momentum above one level and bearish momentum below another.',
    params: [
      { key: 'period', label: 'Period', type: 'number', min: 2, max: 100, step: 1, value: 14 },
      { key: 'buy_above', label: 'Buy above', type: 'number', min: 1, max: 99, step: 1, value: 55 },
      { key: 'sell_below', label: 'Sell below', type: 'number', min: 1, max: 99, step: 1, value: 45 },
    ],
  },
  adx: {
    label: 'ADX trend strength', description: 'A direction-neutral filter that requires enough trend strength.',
    params: [
      { key: 'period', label: 'Period', type: 'number', min: 2, max: 100, step: 1, value: 14 },
      { key: 'minimum', label: 'Minimum ADX', type: 'number', min: 1, max: 100, step: 1, value: 25 },
    ],
  },
  price_vs_ema: {
    label: 'Price vs EMA', description: 'Requires price to sit above or below an EMA by an ATR-normalized distance.',
    params: [
      { key: 'ema_period', label: 'EMA period', type: 'number', min: 2, max: 400, step: 1, value: 20 },
      { key: 'minimum_atr', label: 'Min distance (ATR)', type: 'number', min: 0, max: 10, step: 0.05, value: 0 },
    ],
  },
  breakout: {
    label: 'Price breakout', description: 'Looks for a close beyond the recent high or low.',
    params: [
      { key: 'lookback', label: 'Lookback bars', type: 'number', min: 3, max: 200, step: 1, value: 20 },
      { key: 'minimum_atr', label: 'Min breakout (ATR)', type: 'number', min: 0, max: 10, step: 0.05, value: 0 },
    ],
  },
  atr_volatility: {
    label: 'ATR volatility', description: 'A direction-neutral filter comparing current ATR with its recent baseline.',
    params: [
      { key: 'period', label: 'ATR period', type: 'number', min: 2, max: 100, step: 1, value: 14 },
      { key: 'baseline', label: 'Baseline bars', type: 'number', min: 10, max: 200, step: 1, value: 50 },
      { key: 'minimum_ratio', label: 'Minimum ratio', type: 'number', min: 0.1, max: 10, step: 0.05, value: 1 },
    ],
  },
  volume_confirmation: {
    label: 'Volume confirmation', description: 'Requires current tick volume to beat its recent median.',
    params: [
      { key: 'lookback', label: 'Baseline bars', type: 'number', min: 5, max: 200, step: 1, value: 30 },
      { key: 'minimum_ratio', label: 'Minimum ratio', type: 'number', min: 0.1, max: 10, step: 0.05, value: 1 },
    ],
  },
  trend_strength: {
    label: 'Trend strength score', description: 'Combines EMA direction, RSI, ADX, and price linearity into a normalized bearish-to-bullish score.',
    params: [
      { key: 'buy_above', label: 'Buy above', type: 'number', min: -100, max: 100, step: 1, value: 35 },
      { key: 'sell_below', label: 'Sell below', type: 'number', min: -100, max: 100, step: 1, value: -35 },
    ],
  },
  linearity: {
    label: 'Price linearity', description: 'Requires a clean directional move instead of choppy back-and-forth price action.',
    params: [
      { key: 'lookback', label: 'Lookback bars', type: 'number', min: 5, max: 200, step: 1, value: 30 },
      { key: 'minimum', label: 'Minimum score', type: 'number', min: 0, max: 1, step: 0.05, value: 0.6 },
    ],
  },
};

function defaultIndicatorRow(indicator, join = 'and') {
  const definition = INDICATOR_CATALOG[indicator];
  return { indicator, join, params: Object.fromEntries(definition.params.map((param) => [param.key, param.value])) };
}

function indicatorParamControl(param, value, index) {
  if (param.type === 'select') {
    return `<select data-indicator-param="${param.key}" data-indicator-index="${index}">${param.options.map(([optionValue, label]) => `<option value="${optionValue}" ${value === optionValue ? 'selected' : ''}>${label}</option>`).join('')}</select>`;
  }
  return `<input data-indicator-param="${param.key}" data-indicator-index="${index}" type="number" min="${param.min}" max="${param.max}" step="${param.step}" value="${value}" />`;
}

function renderStrategyIndicators() {
  const list = document.getElementById('strategy-indicator-list');
  const count = document.getElementById('strategy-indicator-count');
  const addButton = document.getElementById('button-add-strategy-indicator');
  const composer = document.getElementById('strategy-indicator-composer');
  const join = document.getElementById('strategy-indicator-join');
  const legacy = document.getElementById('strategy-legacy-notice');
  if (!list) return;
  if (count) count.textContent = `${strategyIndicatorRows.length} / 4`;
  if (legacy) legacy.hidden = !strategyHasLegacyDefinition || strategyIndicatorRows.length > 0;
  list.innerHTML = strategyIndicatorRows.map((row, index) => {
    const definition = INDICATOR_CATALOG[row.indicator];
    if (!definition) return '';
    return `<article class="strategy-indicator-card" data-indicator-row="${index}">
      <div class="strategy-indicator-card-head">
        <div class="strategy-indicator-title">${index > 0 ? `<select class="strategy-inline-join" data-indicator-join="${index}" aria-label="Combine indicator"><option value="and" ${row.join !== 'or' ? 'selected' : ''}>AND</option><option value="or" ${row.join === 'or' ? 'selected' : ''}>OR</option></select>` : ''}<strong>${definition.label}</strong></div>
        <button type="button" class="icon-btn strategy-remove-indicator" data-remove-indicator="${index}" aria-label="Remove ${definition.label}">×</button>
      </div>
      <p>${definition.description}</p>
      <div class="strategy-indicator-params">${definition.params.map((param) => `<label><span>${param.label}</span>${indicatorParamControl(param, row.params?.[param.key] ?? param.value, index)}</label>`).join('')}</div>
    </article>`;
  }).join('') || '<p class="strategy-indicator-empty">Tap + to add your first indicator.</p>';
  if (join) join.hidden = strategyIndicatorRows.length === 0;
  if (addButton) addButton.hidden = strategyIndicatorRows.length >= 4;
  if (strategyIndicatorRows.length >= 4 && composer) composer.hidden = true;
}

function populateIndicatorChoice() {
  const choice = document.getElementById('strategy-indicator-choice');
  if (!choice) return;
  choice.innerHTML = '<option value="">Choose an indicator…</option>' + Object.entries(INDICATOR_CATALOG)
    .map(([value, definition]) => `<option value="${value}">${definition.label}</option>`).join('');
}

document.getElementById('button-add-strategy-indicator')?.addEventListener('click', () => {
  if (strategyIndicatorRows.length >= 4) return;
  const composer = document.getElementById('strategy-indicator-composer');
  populateIndicatorChoice();
  if (composer) composer.hidden = false;
  document.getElementById('strategy-indicator-choice')?.focus();
});

document.getElementById('strategy-indicator-choice')?.addEventListener('change', (event) => {
  const indicator = event.target.value;
  if (!INDICATOR_CATALOG[indicator] || strategyIndicatorRows.length >= 4) return;
  const join = document.getElementById('strategy-indicator-join')?.value || 'and';
  strategyIndicatorRows.push(defaultIndicatorRow(indicator, join));
  strategyHasLegacyDefinition = false;
  event.target.value = '';
  document.getElementById('strategy-indicator-composer').hidden = true;
  renderStrategyIndicators();
});

document.getElementById('strategy-indicator-list')?.addEventListener('input', (event) => {
  const index = Number(event.target.dataset.indicatorIndex);
  const key = event.target.dataset.indicatorParam;
  if (!Number.isInteger(index) || !key || !strategyIndicatorRows[index]) return;
  strategyIndicatorRows[index].params[key] = event.target.type === 'number' ? Number(event.target.value) : event.target.value;
});
document.getElementById('strategy-indicator-list')?.addEventListener('change', (event) => {
  const joinIndex = Number(event.target.dataset.indicatorJoin);
  if (Number.isInteger(joinIndex) && strategyIndicatorRows[joinIndex]) strategyIndicatorRows[joinIndex].join = event.target.value;
});
document.getElementById('strategy-indicator-list')?.addEventListener('click', (event) => {
  const button = event.target.closest('[data-remove-indicator]');
  if (!button) return;
  strategyIndicatorRows.splice(Number(button.dataset.removeIndicator), 1);
  if (strategyIndicatorRows[0]) strategyIndicatorRows[0].join = 'and';
  renderStrategyIndicators();
});

function updateStrategyParameterVisibility() { renderStrategyIndicators(); }
populateIndicatorChoice();

function updateStrategyExecutionHint() {
  const mode = document.getElementById('strategy-execution-mode')?.value;
  const hint = document.getElementById('strategy-execution-hint');
  if (!hint) return;
  hint.textContent = mode === 'auto'
    ? 'Qualified signals can queue MT5 orders automatically after all risk and policy checks pass.'
    : mode === 'manual'
    ? 'Qualified signals wait for your confirmation before an MT5 order is queued.'
    : 'Records hypothetical entries without creating orders.';
}
document.getElementById('strategy-execution-mode')?.addEventListener('change', updateStrategyExecutionHint);

function validateIndicatorStack() {
  const directional = new Set(['ema_crossover', 'rsi', 'price_vs_ema', 'breakout', 'trend_strength', 'linearity']);
  if (strategyIndicatorRows.length > 0 && !strategyIndicatorRows.some((row) => directional.has(row.indicator))) {
    return 'Add at least one directional indicator. ADX, ATR volatility, and Volume confirmation can filter a setup, but cannot choose BUY versus SELL by themselves.';
  }
  for (const [index, row] of strategyIndicatorRows.entries()) {
    const definition = INDICATOR_CATALOG[row.indicator];
    if (!definition) return `Indicator ${index + 1} is not supported.`;
    for (const param of definition.params) {
      if (param.type === 'number' && !Number.isFinite(Number(row.params?.[param.key]))) {
        return `${definition.label}: ${param.label} needs a number.`;
      }
    }
    if (row.indicator === 'ema_crossover' && Number(row.params.fast_period) >= Number(row.params.slow_period)) {
      return 'EMA crossover: the fast period must be lower than the slow period.';
    }
    if ((row.indicator === 'rsi' || row.indicator === 'trend_strength') && Number(row.params.buy_above) <= Number(row.params.sell_below)) {
      return `${definition.label}: “Buy above” must be higher than “Sell below”.`;
    }
  }
  const directionNeutral = new Set(['adx', 'atr_volatility', 'volume_confirmation']);
  for (let index = 1; index < strategyIndicatorRows.length; index++) {
    if (strategyIndicatorRows[index].join === 'or' &&
        (directionNeutral.has(strategyIndicatorRows[index].indicator) || directionNeutral.has(strategyIndicatorRows[index - 1].indicator))) {
      return 'ADX, ATR volatility, and Volume confirmation are filters. Connect them with AND so they do not qualify both BUY and SELL at once.';
    }
  }
  return '';
}

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
    checklist.innerHTML = '<p class="symbol-multiselect-empty">No visible pairs yet — turn one on in Settings first</p>';
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
    'Choose a strategy, the pairs it applies to, and the candle timeframe it should evaluate. Each configuration runs independently.';
  document.getElementById('add-strategy-submit').textContent = 'Add strategy';
  document.getElementById('button-delete-strategy').hidden = true;
  document.getElementById('button-run-strategy-backtest').hidden = true;
  strategyHasLegacyDefinition = false;
}

function openAddStrategyModal() {
  if (!state.activeTerminalId) {
    alert('Connect an MT5 account first — strategies belong to a terminal.');
    return;
  }
  const form = document.getElementById('form-add-strategy');
  form.reset();
  form.execution_mode.value = 'shadow';
  strategyIndicatorRows = [];
  document.getElementById('strategy-indicator-composer').hidden = true;
  updateStrategyParameterVisibility();
  updateStrategyExecutionHint();
  resetStrategyModalToAddMode();
  strategySelectedSymbols = [];
  renderStrategySymbolChips();
  populateStrategySymbolSelect();
  window.LucreUI.openModal('modal-add-strategy');
}

document.getElementById('button-add-strategy')?.addEventListener('click', openAddStrategyModal);
document.getElementById('button-add-strategy-tab')?.addEventListener('click', openAddStrategyModal);

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
  form.kind.value = 'custom_rules';
  form.name.value = strategy.name;
  form.timeframe.value = strategy.timeframe || 'M5';
  form.max_lot_size.value = strategy.max_lot_size;
  form.risk_percent.value = strategy.risk_percent ?? STRATEGY_DEFAULT_RISK_PERCENT[strategy.kind] ?? 0.50;
  form.execution_mode.value = strategy.run_mode === 'shadow' ? 'shadow' : strategy.delivery_mode === 'auto' ? 'auto' : 'manual';
  updateStrategyExecutionHint();
  form.direction_mode.value = strategy.direction_mode || 'both';
  form.cooldown_minutes.value = strategy.cooldown_minutes ?? 0;
  form.max_concurrent_positions.value = strategy.max_concurrent_positions ?? 1;
  form.max_spread_points.value = strategy.max_spread_points ?? '';
  const allowedSessions = strategy.allowed_sessions || ['asia', 'london', 'overlap', 'ny'];
  form.querySelectorAll('input[name="allowed_sessions"]').forEach((input) => { input.checked = allowedSessions.includes(input.value); });
  const config = strategy.config || {};
  const exits = strategy.exit_config || {};
  form.stop_atr.value = exits.stop_atr ?? config.stop_atr ?? 1.8; form.target_r.value = exits.target_r ?? config.target_r ?? 2.2;
  form.breakeven_r.value = exits.breakeven_r ?? 1; form.trailing_start_r.value = exits.trailing_start_r ?? 1.5;
  form.trail_atr.value = exits.trail_atr ?? 1.5;
  strategyIndicatorRows = strategy.rule_definition?.version === 2 && Array.isArray(strategy.rule_definition.indicators)
    ? strategy.rule_definition.indicators.slice(0, 4).map((row, index) => ({
        indicator: row.indicator, join: index === 0 ? 'and' : (row.join === 'or' ? 'or' : 'and'), params: { ...(row.params || {}) },
      })).filter((row) => INDICATOR_CATALOG[row.indicator])
    : [];
  strategyHasLegacyDefinition = strategy.rule_definition?.version !== 2 || strategy.kind !== 'custom_rules';
  updateStrategyParameterVisibility();

  strategySelectedSymbols = (strategy.symbols || []).slice();
  renderStrategySymbolChips();
  populateStrategySymbolSelect();

  document.getElementById('add-strategy-title').textContent = 'Edit strategy';
  document.getElementById('add-strategy-sub').textContent =
    'Update this configuration\'s pairs, delivery mode, or lot size. Changes apply to future signals only — in-flight signals and open positions are unaffected.';
  document.getElementById('add-strategy-submit').textContent = 'Save changes';
  document.getElementById('button-delete-strategy').hidden = false;
  document.getElementById('button-run-strategy-backtest').hidden = false;

  window.LucreUI.openModal('modal-add-strategy');
}

function strategyBacktestDraft(form, existingStrategy) {
  const numeric = (field, fallback) => Number.isFinite(parseFloat(form[field]?.value)) ? parseFloat(form[field].value) : fallback;
  const replacingLegacyDefinition = strategyIndicatorRows.length > 0;
  return {
    kind: replacingLegacyDefinition ? 'custom_rules' : existingStrategy.kind,
    timeframe: form.timeframe.value,
    symbols: strategySelectedSymbols.slice(),
    config: {
      ...(existingStrategy.config || {}),
      stop_atr: numeric('stop_atr', 1.8),
      target_r: numeric('target_r', 2.2),
    },
    exit_config: {
      stop_atr: numeric('stop_atr', 1.8),
      target_r: numeric('target_r', 2.2),
      breakeven_r: numeric('breakeven_r', 1),
      trailing_start_r: numeric('trailing_start_r', 1.5),
      trail_atr: numeric('trail_atr', 1.5),
      swing_lookback: 5,
      max_stop_atr: 4,
    },
    rule_definition: replacingLegacyDefinition ? {
      version: 2,
      indicators: strategyIndicatorRows.map((row, index) => ({
        indicator: row.indicator,
        join: index === 0 ? 'and' : (row.join === 'or' ? 'or' : 'and'),
        params: { ...row.params },
      })),
    } : existingStrategy.rule_definition,
    direction_mode: form.direction_mode.value,
    allowed_sessions: [...form.querySelectorAll('input[name="allowed_sessions"]:checked')].map((input) => input.value),
    cooldown_minutes: Math.max(0, Math.min(10080, Math.round(numeric('cooldown_minutes', 0)))),
    max_spread_points: form.max_spread_points.value ? numeric('max_spread_points', null) : null,
  };
}

document.getElementById('button-run-strategy-backtest')?.addEventListener('click', async (event) => {
  const form = document.getElementById('form-add-strategy');
  const strategyId = form.edit_id.value;
  const existingStrategy = state.strategies.find((strategy) => strategy.id === strategyId);
  const msg = document.getElementById('add-strategy-message');
  if (!strategyId || !existingStrategy || strategySelectedSymbols.length === 0) return;
  const indicatorError = strategyIndicatorRows.length > 0 ? validateIndicatorStack() : '';
  if (indicatorError) {
    msg.style.color = 'var(--color-danger, #c0432f)';
    msg.textContent = indicatorError;
    return;
  }
  const draft = strategyBacktestDraft(form, existingStrategy);
  if (draft.allowed_sessions.length === 0) {
    msg.style.color = 'var(--color-danger, #c0432f)';
    msg.textContent = 'Select at least one trading session before running the backtest.';
    return;
  }
  const button = event.currentTarget;
  button.disabled = true;
  msg.style.color = 'var(--color-text-muted)';
  msg.textContent = `Testing ${strategySelectedSymbols.length} selected pair${strategySelectedSymbols.length === 1 ? '' : 's'} with the parameters currently shown…`;
  try {
    const { data, error } = await supabase.functions.invoke('strategy-backtest', {
      body: { strategy_id: strategyId, symbols: strategySelectedSymbols, definition_snapshot: draft },
    });
    if (error || data?.error) {
      msg.style.color = 'var(--color-danger, #c0432f)';
      msg.textContent = data?.error || error?.message || 'Backtest failed.';
      return;
    }
    const pct = data.win_rate == null ? '—' : `${Math.round(data.win_rate * 100)}%`;
    const expectancy = data.expectancy_r == null ? '—' : `${Number(data.expectancy_r).toFixed(2)}R`;
    const validation = data.validation_expectancy_r == null ? '—' : `${Number(data.validation_expectancy_r).toFixed(2)}R`;
    const tested = data.symbols_tested?.length || 0;
    const requested = data.symbols_requested?.length || strategySelectedSymbols.length;
    const pairLines = (data.per_symbol || []).map((row) => {
      if (row.status !== 'completed') return `${row.symbol}: skipped — ${row.error}`;
      const pairWins = row.win_rate == null ? '—' : `${Math.round(row.win_rate * 100)}%`;
      const pairExpectancy = row.expectancy_r == null ? '—' : `${Number(row.expectancy_r).toFixed(2)}R`;
      return `${row.symbol}: ${row.trade_count} trades · ${pairWins} wins · ${pairExpectancy}`;
    });
    msg.style.color = 'var(--color-accent)';
    msg.style.whiteSpace = 'pre-line';
    msg.textContent = [`Portfolio (${tested}/${requested} pairs): ${data.trade_count} trades · ${pct} wins · ${expectancy} expectancy · ${validation} validation expectancy.`, ...pairLines, 'Diagnostic only; slippage is not modeled.'].join('\n');
  } finally {
    button.disabled = false;
  }
});

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
  const existingStrategy = state.strategies.find((strategy) => strategy.id === editId);
  if (strategyIndicatorRows.length === 0 && (!existingStrategy || existingStrategy.rule_definition?.version === 2)) {
    msg.textContent = 'Add at least one indicator before saving.';
    return;
  }
  const indicatorError = validateIndicatorStack();
  if (strategyIndicatorRows.length > 0 && indicatorError) {
    msg.textContent = indicatorError;
    return;
  }
  const allowedSessions = [...form.querySelectorAll('input[name="allowed_sessions"]:checked')].map((input) => input.value);
  if (allowedSessions.length === 0) {
    msg.textContent = 'Select at least one trading session.';
    return;
  }

  const existingConfig = existingStrategy?.config || {};
  const numeric = (field, fallback) => Number.isFinite(parseFloat(form[field]?.value)) ? parseFloat(form[field].value) : fallback;
  const config = { ...existingConfig, stop_atr: numeric('stop_atr', 1.8), target_r: numeric('target_r', 2.2) };
  const exitConfig = {
    stop_atr: numeric('stop_atr', 1.8), target_r: numeric('target_r', 2.2),
    breakeven_r: numeric('breakeven_r', 1), trailing_start_r: numeric('trailing_start_r', 1.5),
    trail_atr: numeric('trail_atr', 1.5), swing_lookback: 5, max_stop_atr: 4,
  };
  const replacingLegacyDefinition = strategyIndicatorRows.length > 0;
  const ruleDefinition = replacingLegacyDefinition ? {
    version: 2,
    indicators: strategyIndicatorRows.map((row, index) => ({
      indicator: row.indicator,
      join: index === 0 ? 'and' : (row.join === 'or' ? 'or' : 'and'),
      params: { ...row.params },
    })),
  } : existingStrategy?.rule_definition ?? null;
  const executionMode = form.execution_mode.value;
  const kind = replacingLegacyDefinition || !existingStrategy ? 'custom_rules' : existingStrategy.kind;
  const payload = {
    terminal_id: state.activeTerminalId,
    name: form.name.value.trim(),
    kind,
    signal_family: STRATEGY_KIND_SIGNAL_FAMILY[kind] || 'momentum',
    delivery_mode: executionMode === 'auto' ? 'auto' : 'manual_confirm',
    timeframe: form.timeframe.value,
    signal_ttl_seconds: TIMEFRAME_SIGNAL_TTL_SECONDS[form.timeframe.value] || 300,
    symbols,
    max_lot_size: parseFloat(form.max_lot_size.value) || 0.01,
    risk_percent: Math.min(5, Math.max(0.05, parseFloat(form.risk_percent.value) || 0.50)),
    run_mode: executionMode === 'shadow' ? 'shadow' : 'live',
    direction_mode: form.direction_mode.value,
    allowed_sessions: allowedSessions,
    bias_timeframe: replacingLegacyDefinition ? null : existingStrategy?.bias_timeframe ?? null,
    cooldown_minutes: Math.max(0, Math.min(10080, Math.round(numeric('cooldown_minutes', 0)))),
    max_concurrent_positions: Math.max(1, Math.min(20, Math.round(numeric('max_concurrent_positions', 1)))),
    max_spread_points: form.max_spread_points.value ? numeric('max_spread_points', null) : null,
    config,
    exit_config: exitConfig,
    rule_definition: ruleDefinition,
    definition_version: replacingLegacyDefinition ? 2 : existingStrategy?.definition_version ?? 1,
    promoted_at: executionMode === 'shadow' ? null : existingStrategy?.promoted_at || new Date().toISOString(),
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
  strategyIndicatorRows = [];
  strategyHasLegacyDefinition = false;
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
    select.innerHTML = '<option value="">No visible symbols — manage them in Settings</option>';
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
  document.getElementById('order-volume').value = '0.01';
  document.getElementById('new-order-message').textContent = '';
  populateOrderSymbolSelect();
  window.LucreUI.openModal('modal-new-order');
});

document.getElementById('form-new-order')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = e.target;
  const msg = document.getElementById('new-order-message');
  const side = e.submitter?.dataset.orderSide;
  const orderButtons = Array.from(form.querySelectorAll('[data-order-side]'));

  if (!form.symbol.value) {
    msg.style.color = 'var(--color-negative)';
    msg.textContent = 'No visible symbols are available. Turn one on in Settings first.';
    return;
  }
  if (side !== 'buy' && side !== 'sell') {
    msg.style.color = 'var(--color-negative)';
    msg.textContent = 'Choose BUY or SELL.';
    return;
  }
  const volume = parseFloat(form.volume.value);
  if (!Number.isFinite(volume) || volume <= 0) {
    msg.style.color = 'var(--color-negative)';
    msg.textContent = 'Enter a valid lot size.';
    return;
  }

  const payload = {
    terminal_id: state.activeTerminalId,
    // v1.0.10 — form.symbol.value now comes from a <select> populated by
    // populateOrderSymbolSelect() from this terminal's resolved symbol
    // mappings, so it is always an exact, broker-resolved canonical symbol.
    symbol: form.symbol.value,
    side,
    volume,
    client_request_id: crypto.randomUUID(),
  };
  // Keep the one-click surface simple while honoring any protection defaults
  // already configured for this symbol on its Pairs card.
  const setting = state.symbolSettings.find((s) => s.symbol === form.symbol.value);
  if (setting?.auto_sl_tp_enabled) {
    if (setting.auto_sl_pips) payload.sl_pips = setting.auto_sl_pips;
    if (setting.auto_tp_pips) payload.tp_pips = setting.auto_tp_pips;
  }

  orderButtons.forEach((button) => { button.disabled = true; });
  msg.style.color = 'var(--color-accent)';
  msg.textContent = `Placing ${side.toUpperCase()} order…`;

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
    orderButtons.forEach((button) => { button.disabled = false; });
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
    loadSignals();
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
    .select('id, equity, balance, margin_level, status, terminal_trade_allowed, mql_trade_allowed, account_trade_allowed, account_expert_trade_allowed, trade_capability_reported_at')
    .eq('id', state.activeTerminalId)
    .maybeSingle();
  if (error || !data) return;
  const idx = state.terminals.findIndex((t) => t.id === data.id);
  if (idx !== -1) {
    state.terminals[idx] = { ...state.terminals[idx], ...data };
    renderBalanceWidget();
    checkAutotradingBanner();
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
      { event: '*', schema: 'public', table: 'symbol_trend_state', filter: `terminal_id=eq.${terminalId}` },
      (payload) => {
        const next = payload.new;
        if (!next?.symbol || state.activeTerminalId !== terminalId) return;
        const index = state.trendStates.findIndex((item) => item.symbol === next.symbol);
        if (index >= 0) state.trendStates[index] = next;
        else state.trendStates.push(next);
        if (!viewPairs.hidden) renderPairsView();
      }
    )
    .on(
      'postgres_changes',
      { event: '*', schema: 'public', table: 'price_feed_series_state', filter: `terminal_id=eq.${terminalId}` },
      (payload) => {
        const next = payload.new;
        if (!next?.symbol || !next?.timeframe || state.activeTerminalId !== terminalId) return;
        const index = state.priceFeedStates.findIndex(
          (item) => item.symbol === next.symbol && item.timeframe === next.timeframe
        );
        if (next.desired_enabled === false) {
          if (index >= 0) state.priceFeedStates.splice(index, 1);
        } else if (index >= 0) state.priceFeedStates[index] = next;
        else state.priceFeedStates.push(next);
        pairRepairsInFlight.delete(`${next.symbol}:${next.timeframe}`);
        if (!viewPairs.hidden) renderPairsView();
      }
    )
    .on(
      'postgres_changes',
      { event: '*', schema: 'public', table: 'signal_deliveries', filter: `terminal_id=eq.${terminalId}` },
      (payload) => applySignalDeliveryChange(payload)
    )
    .on(
      'postgres_changes',
      { event: '*', schema: 'public', table: 'signals', filter: `terminal_id=eq.${terminalId}` },
      (payload) => applySignalChange(payload)
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
          checkAutotradingBanner();
        }
      }
    )
    .on(
      'postgres_changes',
      { event: '*', schema: 'public', table: 'ea_commands', filter: `terminal_id=eq.${terminalId}` },
      (payload) => {
        checkAutotradingBanner();
        handleCommandStatus(payload.new);
        applyRecentCommand(payload.new);
      }
    )
    .on(
      'postgres_changes',
      { event: '*', schema: 'public', table: 'strategy_evaluation_state', filter: `terminal_id=eq.${terminalId}` },
      (payload) => {
        const row = payload.new;
        if (!row?.strategy_id || state.activeTerminalId !== terminalId) return;
        const strategy = state.strategies.find((item) => item.id === row.strategy_id);
        if (!strategy) return;
        const rows = strategy.evaluation_states || [];
        const index = rows.findIndex((item) => item.symbol === row.symbol);
        if (index >= 0) rows[index] = row;
        else rows.push(row);
        strategy.evaluation_states = rows;
        renderStrategies();
        renderStrategyWinRates();
        renderStrategyStatusTab();
        renderNotifications();
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
  const terminal = state.terminals.find((item) => item.id === state.activeTerminalId);
  const capabilityAgeMs = terminal?.trade_capability_reported_at
    ? Date.now() - new Date(terminal.trade_capability_reported_at).getTime() : Infinity;
  if (capabilityAgeMs <= 90_000) {
    const capabilityFailures = [
      [terminal.terminal_trade_allowed === false, 'MT5/VPS Algo Trading is disabled at the terminal level.'],
      [terminal.mql_trade_allowed === false, '“Allow Algo Trading” is disabled in this EA’s Properties.'],
      [terminal.account_trade_allowed === false, 'The broker account is currently not permitted to trade.'],
      [terminal.account_expert_trade_allowed === false, 'The broker/account currently blocks Expert Advisor trading.'],
    ];
    const failure = capabilityFailures.find(([blocked]) => blocked)?.[1];
    bannerAutotrading.hidden = !failure;
    if (failure) bannerAutotrading.textContent = `${failure} New orders are blocked until this live MT5 capability becomes available.`;
    return;
  }

  // Compatibility fallback for pre-v1.0.34 EAs. Historical failures expire
  // quickly instead of leaving a permanent warning after MT5 recovers.
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
  const latestAgeMs = latest?.requested_at ? Date.now() - new Date(latest.requested_at).getTime() : Infinity;
  bannerAutotrading.hidden = !(
    latest &&
    latest.status === 'failed' &&
    ['autotrading_disabled', 'terminal_autotrading_disabled', 'ea_live_trading_disabled',
      'account_trading_disabled', 'account_expert_trading_disabled'].includes(latest.error_message) &&
    latestAgeMs <= 120_000
  );
}

function humanizeCommandFailure(error) {
  const labels = {
    autotrading_disabled: 'MT5 AutoTrading is disabled.',
    terminal_autotrading_disabled: 'MT5/VPS Algo Trading is disabled at the terminal level.',
    ea_live_trading_disabled: 'Allow Algo Trading is disabled in this EA’s Properties.',
    account_trading_disabled: 'The broker account is not currently permitted to trade.',
    account_expert_trading_disabled: 'The broker/account currently blocks Expert Advisor trading.',
    hard_stop_loss_required: 'A protective stop-loss is required.',
    hard_max_volume_per_order_exceeded: 'The volume exceeds the EA hard limit.',
    broker_volume_step_mismatch: 'The volume does not match this broker’s lot step.',
    hard_max_open_positions_reached: 'The EA account-position limit has been reached.',
    max_open_positions_reached: 'The terminal open-position limit has been reached.',
    risk_budget_below_min_volume: 'The calculated risk is smaller than this broker’s minimum trade size.',
    risk_calculation_failed: 'MT5 could not calculate the broker-specific risk for this order.',
    risk_sizing_requires_stop_and_volume_cap: 'Adaptive sizing requires a protective stop and maximum lot size.',
    ea_upgrade_required: 'Update the Lucre EA to v1.0.29 or newer to use adaptive risk sizing.',
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

function notificationReadKey() {
  return `lucre:notifications-read:${state.session?.user?.id || 'guest'}:${state.activeTerminalId || 'none'}`;
}

function applySignalDeliveryChange(payload) {
  const row = payload.new?.id ? payload.new : payload.old;
  if (!row?.id) return;
  const index = state.signalDeliveries.findIndex((delivery) => delivery.id === row.id);
  if (payload.eventType === 'DELETE') {
    if (index >= 0) state.signalDeliveries.splice(index, 1);
  } else if (index >= 0) state.signalDeliveries[index] = { ...state.signalDeliveries[index], ...row };
  else state.signalDeliveries.push(row);
  renderSignalSummary();
  renderSignalsTab();
  renderNotifications();
}

function applySignalChange(payload) {
  const row = payload.new?.id ? payload.new : payload.old;
  if (!row?.id) return;
  const index = state.signals.findIndex((signal) => signal.id === row.id);
  if (payload.eventType === 'DELETE') {
    if (index >= 0) state.signals.splice(index, 1);
  } else if (index >= 0) state.signals[index] = { ...state.signals[index], ...row };
  else state.signals.push(row);
  renderSignalSummary();
  renderVolumeChart();
  renderRiskEngine();
  renderSignalsTab();
  renderNotifications();
}

function applyRecentCommand(command) {
  if (!command?.id) return;
  const index = state.recentCommands.findIndex((item) => item.id === command.id);
  if (index >= 0) state.recentCommands[index] = { ...state.recentCommands[index], ...command };
  else state.recentCommands.push(command);
  state.recentCommands.sort((a, b) => new Date(b.requested_at || 0) - new Date(a.requested_at || 0));
  state.recentCommands = state.recentCommands.slice(0, 40);
  renderNotifications();
}

function notificationRelativeTime(value) {
  const seconds = Math.max(0, Math.floor((Date.now() - new Date(value).getTime()) / 1000));
  if (seconds < 60) return 'just now';
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}

function buildNotifications() {
  const items = [];
  const signalById = new Map(state.signals.map((signal) => [signal.id, signal]));

  state.signals.forEach((signal) => {
    const blocked = signal.policy_decision === 'block';
    const adjusted = signal.policy_decision === 'downweight';
    items.push({
      id: `signal:${signal.id}`,
      tone: blocked ? 'error' : adjusted ? 'warn' : 'signal',
      title: blocked ? 'Signal blocked' : adjusted ? 'Signal downweighted' : 'Signal generated',
      detail: `${signal.symbol} ${signal.timeframe || ''} · ${(signal.side || '').toUpperCase()}`,
      at: signal.generated_at,
    });
  });

  state.signalDeliveries
    .filter((delivery) => ['tapped', 'auto_executed', 'failed', 'expired'].includes(delivery.status))
    .forEach((delivery) => {
      const signal = signalById.get(delivery.signal_id);
      const failed = ['failed', 'expired'].includes(delivery.status);
      items.push({
        id: `delivery:${delivery.id}:${delivery.status}`,
        tone: failed ? 'error' : 'success',
        title: failed ? `Signal ${delivery.status}` : 'Signal accepted',
        detail: signal ? `${signal.symbol} ${signal.timeframe || ''} · ${(signal.side || '').toUpperCase()}` : 'Signal delivery updated',
        at: delivery.acted_at || delivery.delivered_at || delivery.created_at,
      });
    });

  state.tradeHistory.forEach((trade) => {
    const pl = Number(trade.net_profit ?? trade.profit ?? 0);
    items.push({
      id: `close:${trade.id}`,
      tone: pl < 0 ? 'warn' : 'success',
      title: 'Position closed',
      detail: `${trade.symbol} · ${pl >= 0 ? '+' : ''}${pl.toFixed(2)} net P/L`,
      at: trade.close_time,
    });
  });

  state.recentCommands
    .filter((command) => ['failed', 'expired'].includes(command.status))
    .forEach((command) => items.push({
      id: `command:${command.id}:${command.status}`,
      tone: 'error',
      title: command.status === 'expired' ? 'Command expired' : 'Trading error',
      detail: `${command.symbol || command.command_type || 'MT5'} · ${humanizeCommandFailure(command.error_message)}`,
      at: command.executed_at || command.requested_at,
    }));

  state.strategies.forEach((strategy) => {
    (strategy.evaluation_states || [])
      .filter((row) => ['command_failed', 'ea_version_blocked', 'broker_mapping_failed', 'stale_candles', 'missing_bars'].includes(row.status))
      .forEach((row) => items.push({
        id: `strategy-health:${strategy.id}:${row.symbol}:${row.status}`,
        tone: 'error',
        title: STRATEGY_HEALTH_LABELS[row.status] || 'Strategy error',
        detail: `${strategy.name} · ${row.symbol} ${row.timeframe || strategy.timeframe || ''}`,
        at: row.last_checked_at,
      }));
  });

  return items
    .filter((item) => item.at)
    .sort((a, b) => new Date(b.at) - new Date(a.at))
    .slice(0, 50);
}

function renderNotifications() {
  state.notifications = buildNotifications();
  if (!notificationList || !notificationDot || !notificationCount || !buttonNotifications) return;
  const readAt = Number(localStorage.getItem(notificationReadKey()) || 0);
  const unread = state.notifications.filter((item) => new Date(item.at).getTime() > readAt).length;
  notificationDot.hidden = unread === 0;
  notificationCount.textContent = `${state.notifications.length} update${state.notifications.length === 1 ? '' : 's'}${unread ? ` · ${unread} new` : ''}`;
  buttonNotifications.setAttribute('aria-label', unread ? `Notifications, ${unread} unread` : 'Notifications');
  notificationList.innerHTML = state.notifications.length
    ? state.notifications.map((item) => `
        <div class="notification-item notification-${item.tone}">
          <span class="notification-item-dot" aria-hidden="true"></span>
          <div><strong>${escapeHtml(item.title)}</strong><p>${escapeHtml(item.detail)}</p><time datetime="${escapeHtml(item.at)}">${notificationRelativeTime(item.at)}</time></div>
        </div>`).join('')
    : '<p class="empty-state-text">No activity yet.</p>';
}

async function loadRecentCommands() {
  if (!state.activeTerminalId) {
    state.recentCommands = [];
    renderNotifications();
    return;
  }
  const { data, error } = await supabase
    .from('ea_commands')
    .select('id, command_type, symbol, status, error_message, requested_at, executed_at')
    .eq('terminal_id', state.activeTerminalId)
    .order('requested_at', { ascending: false })
    .limit(40);
  if (error) {
    console.error('loadRecentCommands error', error);
    return;
  }
  state.recentCommands = data || [];
  renderNotifications();
}

buttonNotifications?.addEventListener('click', () => {
  const willOpen = notificationPanel.hidden;
  notificationPanel.hidden = !willOpen;
  buttonNotifications.setAttribute('aria-expanded', String(willOpen));
});

document.getElementById('button-notifications-read')?.addEventListener('click', () => {
  localStorage.setItem(notificationReadKey(), String(Date.now()));
  renderNotifications();
});

document.addEventListener('click', (event) => {
  if (!notificationPanel || notificationPanel.hidden || event.target.closest('.notification-wrap')) return;
  notificationPanel.hidden = true;
  buttonNotifications?.setAttribute('aria-expanded', 'false');
});

document.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape' || !notificationPanel || notificationPanel.hidden) return;
  notificationPanel.hidden = true;
  buttonNotifications?.setAttribute('aria-expanded', 'false');
  buttonNotifications?.focus();
});

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
  textGreeting.textContent = `Hey, ${displayName}`;
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
      'id, label, broker, account_login, server, is_live, status, equity, balance, margin_level, ea_version, api_key_last_four, api_key_last_rotated_at, max_manual_lot_size, max_daily_loss_usd, max_open_positions, force_symbol_rescan, last_symbol_scan_at, realtime_topic_id'
      + ', terminal_trade_allowed, mql_trade_allowed, account_trade_allowed, account_expert_trade_allowed, trade_capability_reported_at'
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
    loadSymbolSettings(),
    loadTrendStates(),
    loadPriceFeedStates(),
    loadScenarioStats(),
  ]);
  await loadRecentCommands();
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
    loadSymbolSettings(),
    loadTrendStates(),
    loadPriceFeedStates(),
    loadScenarioStats(),
  ]);
  await loadRecentCommands();
});

async function loadStrategies() {
  if (!state.activeTerminalId) {
    state.strategies = [];
    renderStrategies();
    renderStrategyStatusTab();
    renderNotifications();
    return;
  }
  const { data, error } = await supabase
    .from('strategies')
    .select(
      'id, name, kind, timeframe, enabled, delivery_mode, symbols, max_lot_size, risk_percent, signal_ttl_seconds, ' +
        'news_posture, news_window_minutes, news_min_impact, news_exploit_size_multiplier, config, run_mode, bias_timeframe, ' +
        'rule_definition, definition_version, exit_config, allowed_sessions, direction_mode, cooldown_minutes, max_concurrent_positions, max_spread_points, min_shadow_signals, promoted_at'
    )
    .eq('terminal_id', state.activeTerminalId)
    .in('kind', ACTIVE_STRATEGY_KINDS)
    .order('created_at', { ascending: true });

  if (error) {
    console.error('loadStrategies error', error);
    return;
  }
  state.strategies = data || [];
  const [{ data: shadowRows }, { data: backtestRows }, { data: evaluationRows, error: evaluationError }] = await Promise.all([
    supabase.from('strategy_shadow_signals').select('strategy_id,status,result_r').eq('terminal_id', state.activeTerminalId).limit(5000),
    supabase.from('strategy_backtest_runs').select('strategy_id,status,trade_count,expectancy_r,validation_expectancy_r,completed_at').eq('terminal_id', state.activeTerminalId).eq('status', 'completed').order('completed_at', { ascending: false }).limit(500),
    supabase.from('strategy_evaluation_state').select('strategy_id,symbol,timeframe,status,source_bar_time,candle_age_seconds,detail,last_checked_at').eq('terminal_id', state.activeTerminalId),
  ]);
  if (evaluationError) console.error('strategy evaluation health load failed', evaluationError);
  state.strategies.forEach((strategy) => {
    const resolved = (shadowRows || []).filter((row) => row.strategy_id === strategy.id && row.status !== 'pending');
    strategy.shadow_summary = { resolved: resolved.length, expectancy_r: resolved.length ? resolved.reduce((sum, row) => sum + Number(row.result_r || 0), 0) / resolved.length : null };
    strategy.latest_backtest = (backtestRows || []).find((row) => row.strategy_id === strategy.id) || null;
    strategy.evaluation_states = (evaluationRows || []).filter((row) => row.strategy_id === strategy.id);
  });
  renderStrategies();
  renderStrategyWinRates();
  renderStrategyStatusTab();
  renderNotifications();
}

const STRATEGY_HEALTH_LABELS = {
  session_blocked: 'Outside selected session',
  symbol_disabled: 'Pair hidden in Settings',
  missing_bars: 'Waiting for candle history',
  stale_candles: 'Candle feed is stale',
  no_setup: 'No setup on latest candle',
  direction_blocked: 'Direction filter blocked setup',
  spread_blocked: 'Spread above limit',
  cooldown_blocked: 'Cooldown active',
  duplicate_bar: 'Latest candle already handled',
  shadow_signal: 'Shadow signal recorded',
  manual_signal: 'Signal waiting for confirmation',
  ea_version_blocked: 'EA update required',
  policy_blocked: 'Policy blocked setup',
  risk_blocked: 'Risk guardrail blocked setup',
  broker_mapping_failed: 'Broker mapping unavailable',
  command_failed: 'Order queue failed',
  command_queued: 'Automatic order queued',
};

function strategyHealthSummary(strategy) {
  if (!strategy.enabled) return { label: 'Disabled', tone: 'neutral', checked: null };
  const rows = strategy.evaluation_states || [];
  if (rows.length === 0) return { label: 'Waiting for first engine evaluation', tone: 'warn', checked: null };
  const priority = ['command_failed', 'ea_version_blocked', 'broker_mapping_failed', 'stale_candles', 'missing_bars', 'risk_blocked', 'policy_blocked', 'spread_blocked', 'session_blocked', 'cooldown_blocked', 'direction_blocked', 'no_setup', 'duplicate_bar', 'manual_signal', 'shadow_signal', 'command_queued'];
  const status = priority.find((candidate) => rows.some((row) => row.status === candidate)) || rows[0].status;
  const count = rows.filter((row) => row.status === status).length;
  const checked = rows.reduce((latest, row) => !latest || new Date(row.last_checked_at) > new Date(latest) ? row.last_checked_at : latest, null);
  const tone = ['command_failed', 'ea_version_blocked', 'broker_mapping_failed', 'stale_candles', 'missing_bars'].includes(status)
    ? 'danger' : ['command_queued', 'manual_signal', 'shadow_signal'].includes(status) ? 'ok' : 'neutral';
  return { label: `${STRATEGY_HEALTH_LABELS[status] || status}${count > 1 ? ` · ${count} pairs` : ''}`, tone, checked };
}

function strategyHealthAge(checked) {
  if (!checked) return '';
  const seconds = Math.max(0, Math.round((Date.now() - new Date(checked).getTime()) / 1000));
  if (seconds < 60) return 'just now';
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  return `${Math.floor(seconds / 3600)}h ago`;
}

function strategyPerformanceSummary(strategyId) {
  const trades = getVerifiedTradeHistory().filter((trade) => trade.strategy_id === strategyId);
  if (trades.length === 0) return { winRate: null, count: 0, bestSession: null };
  const wins = trades.filter((trade) => (trade.profit ?? 0) > 0).length;
  const sessions = new Map();
  trades.forEach((trade) => {
    const key = trade.session || 'unknown';
    const current = sessions.get(key) || { count: 0, wins: 0 };
    current.count += 1;
    if ((trade.profit ?? 0) > 0) current.wins += 1;
    sessions.set(key, current);
  });
  const bestSession = [...sessions.entries()]
    .filter(([session]) => session !== 'unknown')
    .sort((a, b) => (b[1].wins / b[1].count) - (a[1].wins / a[1].count) || b[1].count - a[1].count)[0]?.[0];
  return { winRate: Math.round((wins / trades.length) * 100), count: trades.length, bestSession };
}

function strategyBrief(strategy) {
  const execution = strategy.run_mode === 'shadow'
    ? 'Shadow'
    : strategy.delivery_mode === 'auto' ? 'Auto' : 'Manual';
  const pairs = (strategy.symbols || []).join(' · ') || 'No pairs';
  return `${execution} · ${pairs} · ${strategy.timeframe || 'M5'} · ${strategy.risk_percent ?? '—'}% risk`;
}

const GEAR_ICON = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" aria-hidden="true"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .34 1.87l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.7 1.7 0 0 0-1.87-.34 1.7 1.7 0 0 0-1 1.55V21a2 2 0 1 1-4 0v-.09A1.7 1.7 0 0 0 9 19.36a1.7 1.7 0 0 0-1.87.34l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.7 1.7 0 0 0 4.64 15a1.7 1.7 0 0 0-1.55-1H3a2 2 0 1 1 0-4h.09A1.7 1.7 0 0 0 4.64 9a1.7 1.7 0 0 0-.34-1.87l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.7 1.7 0 0 0 9 4.64a1.7 1.7 0 0 0 1-1.55V3a2 2 0 1 1 4 0v.09a1.7 1.7 0 0 0 1 1.55 1.7 1.7 0 0 0 1.87-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.7 1.7 0 0 0 19.36 9a1.7 1.7 0 0 0 1.55 1H21a2 2 0 1 1 0 4h-.09A1.7 1.7 0 0 0 19.4 15z"/></svg>';

function renderStrategies() {
  if (state.strategies.length === 0) {
    strategyList.innerHTML =
      '<p class="empty-state-text" id="strategy-empty-state">No strategies yet. Add your first one to get started.</p>';
    return;
  }

  strategyList.innerHTML = state.strategies
    .map((s) => {
      const health = strategyHealthSummary(s);
      return `
      <div class="mini-table-row strategy-overview-row" data-strategy-id="${s.id}">
        <div class="mini-table-meta">
          <div class="strategy-name">${escapeHtml(s.name)}</div>
          <div class="strategy-sub">${escapeHtml(strategyBrief(s))}${s.run_mode === 'shadow' ? ` · ${s.shadow_summary?.resolved || 0}/${s.min_shadow_signals || 20} shadow signals resolved` : ''}</div>
          <div class="strategy-health strategy-health-${health.tone}"><span class="strategy-health-dot"></span>${health.label}${health.checked ? ` · checked ${strategyHealthAge(health.checked)}` : ''}</div>
        </div>
        <div class="mini-table-stats"></div>
        <label class="strategy-toggle strategy-toggle-icon-only" title="${s.enabled ? 'Disable' : 'Enable'} ${escapeHtml(s.name)}">
          <input type="checkbox" class="strategy-toggle-input" data-strategy-toggle="${s.id}" aria-label="${s.enabled ? 'Disable' : 'Enable'} ${escapeHtml(s.name)}" ${s.enabled ? 'checked' : ''} />
        </label>
        <button class="strategy-gear-button" type="button" data-edit-strategy="${s.id}" aria-label="Edit ${escapeHtml(s.name)}">${GEAR_ICON}</button>
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
    renderNotifications();
    return;
  }

  const [signalsRes, deliveriesRes] = await Promise.all([
    supabase
      .from('signals')
      .select(
        'id, symbol, side, timeframe, policy_decision, generated_at, expires_at, suggested_volume, near_news_event, htf_regime, ' +
          'news_event_id, calendar_events(title, currency, impact)'
      )
      .eq('terminal_id', state.activeTerminalId),
    supabase
      .from('signal_deliveries')
      .select('id, signal_id, status, delivered_at, acted_at, created_at')
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
  renderNotifications();
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

function renderPositionRows(list, emptyMessage) {
  if (!list) return;

  if (state.positions.length === 0) {
    list.innerHTML = `<p class="empty-state-text">${emptyMessage}</p>`;
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
            <button class="position-action-button is-modify" type="button" data-modify-position="${p.id}">Modify</button>
            <button class="position-action-button is-close" type="button" data-close-position="${p.id}">Close</button>
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

function renderPositions() {
  renderPositionRows(
    document.getElementById('positions-list'),
    state.activeTerminalId
      ? 'No open positions. Place an order to see it here.'
      : 'No open positions. Connect an account and place an order to see it here.'
  );
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
// This is the single source of truth for "has this symbol been mapped to a
// tradable instrument on this terminal". Visibility is layered on separately
// by getAvailableSymbols() using symbol_settings.enabled.
function getResolvedSymbols() {
  return (state.symbolMappings || [])
    .filter((m) => m.broker_symbol && m.match_type !== 'unavailable' && !m.needs_review)
    .map((m) => ({ symbol: m.canonical_symbol, asset_class: m.asset_class }));
}

function getAvailableSymbols() {
  const bySymbol = new Map(state.symbolSettings.map((setting) => [setting.symbol, setting]));
  return getResolvedSymbols().filter(({ symbol }) => bySymbol.get(symbol)?.enabled !== false);
}

async function loadTrendStates() {
  if (!state.activeTerminalId) {
    state.trendStates = [];
    if (!viewPairs.hidden) renderPairsView();
    return;
  }
  const { data, error } = await supabase
    .from('symbol_trend_state')
    .select('symbol, score, direction, strength, confidence, regime, timeframe_scores, source_bar_time, computed_at')
    .eq('terminal_id', state.activeTerminalId);
  if (error) {
    console.error('loadTrendStates error', error);
    return;
  }
  state.trendStates = data || [];
  if (!viewPairs.hidden) renderPairsView();
}

async function loadPriceFeedStates() {
  if (!state.activeTerminalId) {
    state.priceFeedStates = [];
    if (!viewPairs.hidden) renderPairsView();
    return;
  }
  const { data, error } = await supabase
    .from('price_feed_series_state')
    .select('symbol,timeframe,latest_bar_time,oldest_bar_time,history_bar_count,last_received_at,desired_enabled,bootstrap_required,status,last_error,repair_requested_at')
    .eq('terminal_id', state.activeTerminalId)
    .eq('desired_enabled', true);
  if (error) {
    console.error('loadPriceFeedStates error', error);
    return;
  }
  state.priceFeedStates = data || [];
  if (!viewPairs.hidden) renderPairsView();
}

async function loadSymbolSettings() {
  // Only scanned and broker-resolved symbols are configurable or visible.
  const resolvedSymbols = getResolvedSymbols().map((s) => s.symbol);

  if (!state.activeTerminalId) {
    state.symbolSettings = [];
    refreshSymbolVisibilitySurfaces();
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
  state.symbolSettings = resolvedSymbols.map(
    (symbol) => bySymbol.get(symbol) || defaultSymbolSetting(symbol)
  );
  refreshSymbolVisibilitySurfaces();
}

function refreshSymbolVisibilitySurfaces() {
  renderSymbolSettingsList();
  if (!viewPairs.hidden) renderPairsView();
  populateOrderSymbolSelect();
  populateStrategySymbolSelect();
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
  else state.symbolSettings.push(data);
  refreshSymbolVisibilitySurfaces();
}

async function setSymbolVisibility(symbol, enabled) {
  const setting = state.symbolSettings.find((item) => item.symbol === symbol);
  if (!setting) return;
  setting.enabled = enabled;
  refreshSymbolVisibilitySurfaces();
  await upsertSymbolSetting(symbol, { enabled });
}

function renderSymbolSettingsList() {
  if (!symbolSettingsList) return;
  if (!state.activeTerminalId) {
    symbolSettingsList.innerHTML = '<p class="empty-state-text">Connect an MT5 account to manage symbols.</p>';
    if (buttonPairSymbol) buttonPairSymbol.hidden = true;
    return;
  }

  const query = (symbolSearchInput?.value || '').trim().toUpperCase();
  const resolved = getResolvedSymbols().filter(({ symbol }) => !query || symbol.includes(query));
  const exactMatch = getResolvedSymbols().some(({ symbol }) => symbol === query);
  if (buttonPairSymbol) {
    buttonPairSymbol.hidden = !query || exactMatch;
    buttonPairSymbol.textContent = query ? `Pair ${query}` : 'Pair symbol';
  }

  if (resolved.length === 0) {
    symbolSettingsList.innerHTML = `<p class="empty-state-text">${
      query ? `No paired symbol matches ${query}. Pair it to search this terminal.` : 'No paired symbols yet. Scan the terminal or search for one above.'
    }</p>`;
    return;
  }

  const settingBySymbol = new Map(state.symbolSettings.map((setting) => [setting.symbol, setting]));
  symbolSettingsList.innerHTML = resolved
    .map(({ symbol, asset_class: assetClass }) => {
      const enabled = settingBySymbol.get(symbol)?.enabled !== false;
      const mapping = state.symbolMappings.find((item) => item.canonical_symbol === symbol);
      return `
        <div class="symbol-settings-row">
          <div class="symbol-settings-identity">
            <strong>${symbol}</strong>
            <span>${assetClass || 'symbol'}${mapping?.broker_symbol && mapping.broker_symbol !== symbol ? ` · ${mapping.broker_symbol}` : ''}</span>
          </div>
          <label class="strategy-toggle">
            <input type="checkbox" class="strategy-toggle-input" data-symbol-visibility="${symbol}" ${enabled ? 'checked' : ''} />
            <span>${enabled ? 'On' : 'Off'}</span>
          </label>
        </div>`;
    })
    .join('');

  symbolSettingsList.querySelectorAll('[data-symbol-visibility]').forEach((input) => {
    input.addEventListener('change', (event) => {
      setSymbolVisibility(event.target.dataset.symbolVisibility, event.target.checked);
    });
  });
}

function computeSymbolPerformance(symbol) {
  const trades = state.tradeHistory.filter((t) => t.symbol === symbol);
  if (trades.length === 0) return { count: 0, winRate: null, totalPl: 0 };
  const wins = trades.filter((t) => (t.profit ?? 0) > 0).length;
  const totalPl = trades.reduce((sum, t) => sum + (t.profit ?? 0), 0);
  return { count: trades.length, winRate: Math.round((wins / trades.length) * 100), totalPl };
}

function trendMeterPresentation(symbol) {
  const trend = state.trendStates.find((item) => item.symbol === symbol);
  if (!trend || trend.regime === 'insufficient_data') {
    return { score: 0, position: 50, status: 'Warming up', detail: 'Waiting for at least 60 closed candles.' };
  }
  const score = Math.max(-100, Math.min(100, Number(trend.score) || 0));
  const sourceTime = trend.source_bar_time ? new Date(trend.source_bar_time).getTime() : 0;
  const stale = !sourceTime || Date.now() - sourceTime > 5 * 60 * 1000;
  const words = {
    volatility_shock: 'Volatility shock',
    trending: 'Trending',
    ranging: 'Ranging',
    transition: 'Transition',
  };
  const direction = trend.direction === 'bullish' ? 'bullish' : trend.direction === 'bearish' ? 'bearish' : 'neutral';
  const strength = trend.strength === 'neutral' ? 'Neutral' : `${trend.strength[0].toUpperCase()}${trend.strength.slice(1)} ${direction}`;
  const status = stale ? `${strength} · Market data paused` : `${strength} · ${words[trend.regime] || 'Transition'}`;
  const breakdown = Object.entries(trend.timeframe_scores || {})
    .map(([timeframe, value]) => `${timeframe} ${Number(value?.score) >= 0 ? '+' : ''}${Math.round(Number(value?.score) || 0)}`)
    .join(' · ');
  return {
    score,
    position: (score + 100) / 2,
    status,
    detail: breakdown || 'Layered EMA, RSI, DMI/ADX, persistence and volatility regime score.',
    stale,
  };
}

function compactAge(isoTime) {
  if (!isoTime) return 'never';
  const seconds = Math.max(0, Math.round((Date.now() - new Date(isoTime).getTime()) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}

function priceFeedPresentation(symbol, timeframe) {
  const row = state.priceFeedStates.find(
    (item) => item.symbol === symbol && item.timeframe === timeframe
  );
  if (!row) return { available: false, label: 'Missing', detail: 'No feed manifest exists yet.', row: null };
  if (row.bootstrap_required || ['pending', 'bootstrapping', 'incomplete', 'error'].includes(row.status)) {
    const repairing = row.status === 'pending' || row.status === 'bootstrapping';
    return {
      available: false,
      label: repairing ? 'Refreshing' : 'Incomplete',
      detail: `${Number(row.history_bar_count) || 0} candles stored${row.last_error ? ` · ${row.last_error}` : ''}`,
      row,
    };
  }
  if (Number(row.history_bar_count) < 240 || !row.latest_bar_time) {
    return {
      available: false,
      label: 'History short',
      detail: `${Number(row.history_bar_count) || 0} candles stored; at least 240 are required.`,
      row,
    };
  }
  const timeframeSeconds = PRICE_TIMEFRAME_SECONDS[timeframe] || 60;
  const staleAfterMs = Math.max(180, timeframeSeconds * 2.5) * 1000;
  const latestMs = new Date(row.latest_bar_time).getTime();
  const stale = !Number.isFinite(latestMs) || Date.now() - latestMs > staleAfterMs;
  return {
    available: !stale,
    label: stale ? 'Stale' : 'Available',
    detail: `${Number(row.history_bar_count).toLocaleString()} candles · latest ${compactAge(row.latest_bar_time)}`,
    row,
  };
}

async function handlePriceFeedRepair(symbol, timeframe, button) {
  if (!state.activeTerminalId) return;
  const key = `${symbol}:${timeframe}`;
  if (pairRepairsInFlight.has(key)) return;
  pairRepairsInFlight.add(key);
  button.disabled = true;
  button.classList.add('is-loading');
  button.setAttribute('aria-label', `Refreshing ${symbol} ${timeframe}`);
  try {
    await repairPriceFeed(state.activeTerminalId, symbol, timeframe);
    await loadPriceFeedStates();
    pairRepairsInFlight.delete(key);
    renderPairsView();
    if (button?.isConnected) {
      button.disabled = false;
      button.classList.remove('is-loading');
      button.setAttribute('aria-label', `Refresh requested for ${symbol} ${timeframe}`);
      button.title = `Refresh requested for ${symbol} ${timeframe}; the EA will upload the clean snapshot.`;
    }
  } catch (error) {
    pairRepairsInFlight.delete(key);
    alert(error.message || `Could not refresh ${symbol} ${timeframe}.`);
    renderPairsView();
    if (button?.isConnected) {
      button.disabled = false;
      button.classList.remove('is-loading');
    }
  }
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

  const visibleSettings = state.symbolSettings.filter((setting) => setting.enabled);
  if (visibleSettings.length === 0) {
    pairGrid.innerHTML = '<p class="empty-state-text">No symbols are visible. Open Settings to turn on the pairs you want to use.</p>';
    return;
  }

  pairGrid.innerHTML = visibleSettings
    .map((s) => {
      const perf = computeSymbolPerformance(s.symbol);
      const trend = trendMeterPresentation(s.symbol);
      const plColor =
        perf.totalPl > 0 ? 'var(--color-positive)' : perf.totalPl < 0 ? 'var(--color-negative)' : 'var(--color-text-muted)';
      const perfText =
        perf.count === 0
          ? 'No closed trades yet'
          : `${perf.winRate}% win rate · ${perf.count} trades`;
      const timeframeButtons = PRICE_TIMEFRAMES.map((timeframe) => {
        const feed = priceFeedPresentation(s.symbol, timeframe);
        const key = `${s.symbol}:${timeframe}`;
        const loading = pairRepairsInFlight.has(key) || Boolean(feed.row?.bootstrap_required);
        const feedDetail = escapeHtml(feed.detail);
        return `<button type="button"
          class="pair-timeframe-status ${feed.available ? 'is-available' : 'is-unavailable'}${loading ? ' is-loading' : ''}"
          data-repair-symbol="${s.symbol}" data-repair-timeframe="${timeframe}"
          aria-label="${s.symbol} ${timeframe}: ${loading ? 'refreshing' : feed.label}. ${feedDetail}"
          title="${feedDetail}${feed.available ? '' : ' · Tap to refresh'}"
          ${feed.available || loading ? 'disabled' : ''}>${timeframe}</button>`;
      }).join('');
      const flipped = flippedPairCards.has(s.symbol);
      return `
      <article class="pair-card-shell${flipped ? ' is-flipped' : ''}" data-symbol-card="${s.symbol}" tabindex="0" aria-label="${s.symbol} pair card. ${flipped ? 'Feed health side shown' : 'Trading side shown'}. Press Enter to flip.">
        <div class="pair-card-inner">
          <section class="card card-pad pair-card pair-card-face pair-card-front" aria-hidden="${flipped}">
            <div class="pair-card-header">
              <span class="pair-card-name">${s.symbol}</span>
              <div class="pair-card-head-actions">
                <button type="button" class="pair-flip-button" data-pair-flip="${s.symbol}" aria-label="View ${s.symbol} feed health">Health ↻</button>
                <label class="strategy-toggle">
                  <input type="checkbox" class="strategy-toggle-input" data-pair-enable="${s.symbol}" checked />
                  <span>On</span>
                </label>
              </div>
            </div>

            <div class="pair-strength${trend.stale ? ' is-stale' : ''}" aria-label="Trend strength: ${trend.status}" title="${trend.detail}">
              <div class="pair-strength-heading">
                <span class="pair-card-section-label">Trend Strength</span>
                <span class="pair-strength-pending">${trend.status}</span>
              </div>
              <div class="pair-strength-bar" role="meter" aria-valuemin="-100" aria-valuemax="100" aria-valuenow="${Math.round(trend.score)}"><span style="left:${trend.position}%"></span></div>
              <div class="pair-strength-labels"><span>SELL</span><span>BUY</span></div>
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

            <div class="pair-actions">
              <button type="button" class="btn-sell" data-quick-sell="${s.symbol}">Sell</button>
              <button type="button" class="btn-buy" data-quick-buy="${s.symbol}">Buy</button>
            </div>
          </section>

          <section class="card card-pad pair-card pair-card-face pair-card-back" aria-hidden="${!flipped}">
            <div class="pair-card-header">
              <div>
                <span class="pair-card-name">${s.symbol}</span>
                <p class="pair-card-back-subtitle">Price-history health</p>
              </div>
              <button type="button" class="pair-flip-button" data-pair-flip="${s.symbol}" aria-label="Return to ${s.symbol} trading controls">Trading ↻</button>
            </div>

            <div class="pair-feed-section">
              <div class="pair-feed-heading">
                <span class="pair-card-section-label">Timeframes</span>
                <span>Tap red to repair</span>
              </div>
              <div class="pair-timeframe-row" aria-label="${s.symbol} candle feed availability">
                ${timeframeButtons}
              </div>
              <div class="pair-feed-legend"><span><i class="is-available"></i>Current</span><span><i class="is-unavailable"></i>Needs attention</span></div>
            </div>

            <div class="pair-winrate-panel">
              <span class="pair-card-section-label">Pair win rate</span>
              <strong>${perf.winRate == null ? '—' : `${perf.winRate}%`}</strong>
              <span>${perfText}</span>
              ${perf.count > 0 ? `<small style="color:${plColor}">${perf.totalPl >= 0 ? '+' : ''}${perf.totalPl.toFixed(2)} realized P/L</small>` : ''}
            </div>

            <p class="pair-card-back-note">Health uses closed broker candles stored for this terminal. A green timeframe has sufficient history and a current latest candle.</p>
          </section>
        </div>
      </article>`;
    })
    .join('');

  const flipCard = (symbol, card, restoreFocus = false) => {
    const flipped = !flippedPairCards.has(symbol);
    if (flipped) flippedPairCards.add(symbol);
    else flippedPairCards.delete(symbol);

    const targetCard = card || pairGrid.querySelector(`[data-symbol-card="${symbol}"]`);
    if (!targetCard) return;

    targetCard.classList.toggle('is-flipped', flipped);
    targetCard.setAttribute(
      'aria-label',
      `${symbol} pair card. ${flipped ? 'Feed health side shown' : 'Trading side shown'}. Press Enter to flip.`
    );
    targetCard.querySelector('.pair-card-front')?.setAttribute('aria-hidden', String(flipped));
    targetCard.querySelector('.pair-card-back')?.setAttribute('aria-hidden', String(!flipped));
    if (restoreFocus) targetCard.focus({ preventScroll: true });
  };

  pairGrid.querySelectorAll('[data-symbol-card]').forEach((card) => {
    card.addEventListener('click', (event) => {
      if (event.target.closest('button,input,label,select,a')) return;
      flipCard(card.dataset.symbolCard, card);
    });
    card.addEventListener('keydown', (event) => {
      if (event.target !== card || !['Enter', ' '].includes(event.key)) return;
      event.preventDefault();
      flipCard(card.dataset.symbolCard, card, true);
    });
  });

  pairGrid.querySelectorAll('[data-pair-flip]').forEach((button) => {
    button.addEventListener('click', () => {
      const card = button.closest('[data-symbol-card]');
      flipCard(button.dataset.pairFlip, card);
    });
  });

  pairGrid.querySelectorAll('[data-repair-symbol]').forEach((button) => {
    button.addEventListener('click', () => handlePriceFeedRepair(
      button.dataset.repairSymbol,
      button.dataset.repairTimeframe,
      button
    ));
  });

  pairGrid.querySelectorAll('[data-pair-enable]').forEach((input) => {
    input.addEventListener('change', async (e) => {
      const symbol = e.target.dataset.pairEnable;
      const enabled = e.target.checked;
      await setSymbolVisibility(symbol, enabled);
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
    buttonRescanSymbols.textContent = 'Scan terminal';
  }
  if (buttonPairSymbol) buttonPairSymbol.disabled = false;
}

async function loadSymbolMappings() {
  if (!state.activeTerminalId) {
    state.symbolMappings = [];
    renderSymbolSettingsList();
    renderSymbolMappingPanel();
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
  renderSymbolSettingsList();
  renderSymbolMappingPanel();
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
  await loadSymbolSettings();
  renderSymbolMappingPanel();
}

function renderSymbolMappingPanel() {
  if (!symbolMappingBody || !symbolMappingStatus) return;

  if (!state.activeTerminalId) {
    symbolMappingStatus.textContent = 'Connect an account to see broker symbol mapping.';
    symbolMappingBody.innerHTML = '';
    if (buttonRescanSymbols) buttonRescanSymbols.disabled = true;
    return;
  }

  const terminal = state.terminals.find((t) => t.id === state.activeTerminalId);
  if (buttonRescanSymbols) buttonRescanSymbols.disabled = symbolRescanPollId ? true : false;

  if (terminal?.force_symbol_rescan) {
    symbolMappingStatus.textContent = 'Rescan requested — waiting for the EA to report back (usually under a minute).';
  } else if (terminal?.last_symbol_scan_at) {
    const when = new Date(terminal.last_symbol_scan_at);
    symbolMappingStatus.textContent = `Last scanned ${when.toLocaleString()}.`;
  } else {
    symbolMappingStatus.textContent = 'No scan yet — scan the terminal once your EA is connected.';
  }

  if (state.symbolMappings.length === 0) {
    symbolMappingBody.innerHTML =
      '<p class="empty-state-text">No broker symbol data yet. Connect your EA and scan the terminal to discover its pairs, metals, indices, and crypto symbols.</p>';
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
    buttonRescanSymbols.textContent = 'Scan terminal';
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
      await loadSymbolSettings();
    } else {
      renderSymbolMappingPanel();
    }
  }, 5000);
});

symbolSearchInput?.addEventListener('input', () => {
  symbolSearchInput.value = symbolSearchInput.value.toUpperCase().replace(/[^A-Z0-9]/g, '');
  renderSymbolSettingsList();
});

// Search doubles as the pair-new-symbol workflow. Filtering the local list
// performs no network request; submitting an unmatched symbol asks the EA to
// scan once, then the existing short-lived scan poll resolves the mapping.
symbolSearchForm?.addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!state.activeTerminalId || !symbolSearchInput) return;

  const symbol = symbolSearchInput.value.trim().toUpperCase();
  if (!symbol) return;
  if (getResolvedSymbols().some((item) => item.symbol === symbol)) return;

  if (buttonPairSymbol) buttonPairSymbol.disabled = true;
  if (symbolSettingsStatus) {
    symbolSettingsStatus.hidden = false;
    symbolSettingsStatus.style.color = 'var(--color-text-muted)';
    symbolSettingsStatus.textContent = `Searching this terminal for ${symbol}…`;
  }

  try {
    await bindSymbol(state.activeTerminalId, symbol);
  } catch (err) {
    if (symbolSettingsStatus) {
      symbolSettingsStatus.style.color = 'var(--color-negative)';
      symbolSettingsStatus.textContent = err.message;
    }
    if (buttonPairSymbol) buttonPairSymbol.disabled = false;
    return;
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
      await loadSymbolMappings();
      await loadSymbolSettings();
      const paired = getResolvedSymbols().some((item) => item.symbol === symbol);
      if (symbolSettingsStatus) {
        symbolSettingsStatus.hidden = false;
        symbolSettingsStatus.style.color = paired ? 'var(--color-positive)' : 'var(--color-negative)';
        symbolSettingsStatus.textContent = paired
          ? `${symbol} is paired and visible.`
          : `${symbol} was not found on this terminal. Check the broker symbol and try again.`;
      }
      if (paired) symbolSearchInput.value = '';
      if (buttonPairSymbol) buttonPairSymbol.disabled = false;
      renderSymbolSettingsList();
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
    renderNotifications();
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
  renderStrategyStatusTab();
  renderNotifications();
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
// Analytics tab strip — Overview / Signals / Positions / Sessions / Risk Score /
// Win Rate / News / Strategies. Blocked outcomes remain inside Signals; trade
// duration now lives on Overview.
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
  const symbols = [...new Set(state.signals.map((signal) => signal.symbol).filter(Boolean))].sort();
  if (signalsPairFilter) {
    const selected = state.signalFilter.pair;
    signalsPairFilter.innerHTML = '<option value="all">All pairs</option>' + symbols
      .map((symbol) => `<option value="${escapeHtml(symbol)}">${escapeHtml(symbol)}</option>`)
      .join('');
    signalsPairFilter.value = symbols.includes(selected) ? selected : 'all';
    state.signalFilter.pair = signalsPairFilter.value;
  }

  const now = Date.now();
  const startOfToday = new Date();
  startOfToday.setHours(0, 0, 0, 0);
  const cutoffs = {
    today: startOfToday.getTime(),
    '7d': now - 7 * 86400000,
    '30d': now - 30 * 86400000,
    all: 0,
  };
  const filtered = state.signals.filter((signal) => {
    const pairMatches = state.signalFilter.pair === 'all' || signal.symbol === state.signalFilter.pair;
    const generatedAt = new Date(signal.generated_at || 0).getTime();
    return pairMatches && generatedAt >= (cutoffs[state.signalFilter.period] ?? cutoffs['30d']);
  });

  if (filtered.length === 0) {
    list.innerHTML =
      `<p class="empty-state-text">${state.signals.length ? 'No signals match these filters.' : 'No signals yet. Once your EA is connected and generating signals, they\'ll show up here.'}</p>`;
    return;
  }
  const sorted = [...filtered].sort(
    (a, b) => new Date(b.generated_at || 0) - new Date(a.generated_at || 0)
  );
  list.innerHTML = sorted
    .map((s) => {
      const sideClass = s.side === 'sell' ? 'side-sell' : 'side-buy';
      const actionableDelivery = state.signalDeliveries.find(
        (delivery) => delivery.signal_id === s.id && ['pending', 'delivered'].includes(delivery.status)
      );
      const expired = s.expires_at ? new Date(s.expires_at).getTime() < now : false;
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
            <div class="strategy-sub">${s.timeframe || '—'} · ${s.generated_at ? new Date(s.generated_at).toLocaleString() : '—'}</div>
            ${signalNewsDetail(s)}
          </div>
          <div class="mini-table-stats signal-row-actions">
            ${decisionTag}
            ${actionableDelivery ? `<button class="btn-secondary btn-xs" type="button" data-tab-tap-signal="${actionableDelivery.id}" ${expired ? 'disabled' : ''}>${expired ? 'Expired' : 'Execute'}</button>` : ''}
          </div>
        </div>`;
    })
    .join('');

  list.querySelectorAll('[data-tab-tap-signal]').forEach((button) => {
    button.addEventListener('click', async () => {
      button.disabled = true;
      try {
        await tapSignal(button.dataset.tabTapSignal);
        await Promise.all([loadSignals(), loadPositions()]);
      } catch (error) {
        alert(error.message);
        button.disabled = false;
      }
    });
  });
}

signalsPairFilter?.addEventListener('change', (event) => {
  state.signalFilter.pair = event.target.value;
  renderSignalsTab();
});

signalsPeriodFilter?.addEventListener('change', (event) => {
  state.signalFilter.period = event.target.value;
  renderSignalsTab();
});

function renderPositionsTab() {
  renderPositionRows(
    document.getElementById('tab-positions-list'),
    state.activeTerminalId
      ? 'No open positions. Place an order to see it here.'
      : 'No open positions. Connect an account and place an order to see it here.'
  );
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
      const symbolLabel = `${(s.symbols || []).join(' · ') || 'No pairs'} · ${s.timeframe || 'M5'}`;
      const statusTag = s.enabled ? '<span class="tag-badge tag-ok">Enabled</span>' : '<span class="tag-badge tag-neutral">Disabled</span>';
      const posture = s.news_posture || 'avoid';
      const isExploit = posture === 'exploit';
      const postureTagClass = NEWS_POSTURE_TAG_CLASS[posture] || 'tag-neutral';
      const postureLabel = NEWS_POSTURE_LABEL[posture] || posture;
      const health = strategyHealthSummary(s);
      const performance = strategyPerformanceSummary(s.id);
      const pairHealth = (s.evaluation_states || [])
        .map((row) => {
          const actionable = ['stale_candles', 'missing_bars'].includes(row.status);
          const label = `${row.symbol} · ${STRATEGY_HEALTH_LABELS[row.status] || row.status}`;
          return actionable
            ? `<button type="button" class="strategy-pair-health is-actionable" data-strategy-feed-repair="${row.symbol}" data-strategy-feed-timeframe="${row.timeframe || s.timeframe || 'M5'}" title="Refresh ${row.symbol} ${row.timeframe || s.timeframe || 'M5'} history"><strong>${row.symbol}</strong> · ${STRATEGY_HEALTH_LABELS[row.status] || row.status}</button>`
            : `<span class="strategy-pair-health"><strong>${row.symbol}</strong> · ${STRATEGY_HEALTH_LABELS[row.status] || row.status}</span>`;
        })
        .join('');
      return `
        <article class="strategy-management-card" data-strategy-card="${s.id}">
          <div class="strategy-management-head">
            <div class="mini-table-meta">
              <div class="strategy-name">${escapeHtml(s.name)}${statusTag}</div>
              <div class="strategy-sub">${escapeHtml(symbolLabel)} · ${
        deliveryLabels[s.delivery_mode] || s.delivery_mode || '—'
      } · ${s.risk_percent ?? '—'}% risk · max ${s.max_lot_size ?? '—'} lots · TTL ${s.signal_ttl_seconds ?? '—'}s</div>
            </div>
            <div class="strategy-management-metrics">
              <div><span>Win rate</span><strong>${performance.winRate == null ? '—' : `${performance.winRate}%`}</strong><small>${performance.count} trades</small></div>
              <div><span>Best session</span><strong>${performance.bestSession ? SESSION_LABELS[performance.bestSession] || performance.bestSession : '—'}</strong><small>verified history</small></div>
            </div>
            <div class="strategy-management-actions">
              <label class="strategy-toggle strategy-toggle-icon-only" title="${s.enabled ? 'Disable' : 'Enable'} ${escapeHtml(s.name)}">
                <input type="checkbox" class="strategy-toggle-input" data-strategy-card-toggle="${s.id}" aria-label="${s.enabled ? 'Disable' : 'Enable'} ${escapeHtml(s.name)}" ${s.enabled ? 'checked' : ''} />
              </label>
              <button class="strategy-gear-button" type="button" data-strategy-card-edit="${s.id}" aria-label="Edit ${escapeHtml(s.name)}">${GEAR_ICON}</button>
            </div>
          </div>
          <div class="strategy-management-health">
            <div class="strategy-health strategy-health-${health.tone}"><span class="strategy-health-dot"></span>${health.label}${health.checked ? ` · checked ${strategyHealthAge(health.checked)}` : ''}</div>
            ${pairHealth ? `<div class="strategy-pair-health-list">${pairHealth}</div>` : ''}
          </div>
        <div class="news-policy-panel" data-strategy-id="${s.id}">
          <div class="news-policy-head">
            <span class="news-policy-title">Directional news policy</span>
            <span class="tag-badge ${postureTagClass}">${postureLabel}</span>
          </div>
          <div class="news-policy-fields">
            <label class="news-policy-field">
              <span>Policy</span>
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
        </div>
        </article>`;
    })
    .join('');

  list.querySelectorAll('[data-strategy-card-toggle]').forEach((input) => {
    input.addEventListener('change', async (event) => {
      const enabled = event.target.checked;
      const { error } = await supabase.from('strategies').update({ enabled }).eq('id', event.target.dataset.strategyCardToggle);
      if (error) {
        event.target.checked = !enabled;
        alert(`Couldn't update that strategy: ${error.message}`);
        return;
      }
      await loadStrategies();
    });
  });

  list.querySelectorAll('[data-strategy-card-edit]').forEach((button) => {
    button.addEventListener('click', () => openEditStrategyModal(button.dataset.strategyCardEdit));
  });

  list.querySelectorAll('[data-strategy-feed-repair]').forEach((button) => {
    button.addEventListener('click', () => handlePriceFeedRepair(
      button.dataset.strategyFeedRepair,
      button.dataset.strategyFeedTimeframe,
      button
    ));
  });

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
  state.recentCommands = [];
  state.notifications = [];
  state.agentPolicies = [];
  state.positions = [];
  state.symbolSettings = [];
  state.symbolMappings = [];
  state.trendStates = [];
  state.calendarEvents = [];
  state.scenarioStats = [];
  state.signalFilter = { pair: 'all', period: '30d' };
  if (signalsPeriodFilter) signalsPeriodFilter.value = '30d';
  if (notificationPanel) notificationPanel.hidden = true;
  renderNotifications();
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
