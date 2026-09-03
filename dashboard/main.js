import { supabase, SUPABASE_URL, SUPABASE_ANON_KEY } from './supabase-client.js';
import {
  provisionTerminalKey,
  tapSignal,
  placeManualOrder,
  modifyPosition,
  closePosition,
  closeAllPositions,
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
  activeView: 'dashboard',
  activeTab: 'overview',
  selectedStrategyId: null,
  signalChartRange: '30d',
  strategyChartRange: '30d',
  signalSessionBands: false,
  strategySessionBands: false,
  signalFilter: { pair: 'all', period: '30d' },
  // v1.0.14 — item 3: P/L Over Time card filters (timeframe + manual/auto/all).
  plFilter: { timeframe: '30d', source: 'all' },
};

let volumeChartInstance = null;
let plChartInstance = null;
let strategyVolumeChartInstance = null;
let strategyPlChartInstance = null;
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
let positionRealtimeChannel = null;
let realtimeCommandSubscribed = false;
let realtimePositionSubscribed = false;
let realtimeReconnectTimer = null;
let positionStreamRequestIntervalId = null;
let positionStreamUiIntervalId = null;
let streamedPositionFields = new Map();
let streamedAccountState = null;
let positionStreamStartedAt = 0;
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
const balanceWidgetFloatingPl = document.getElementById('balance-widget-floating-pl');
const floatingPlSource = document.getElementById('floating-pl-source');
const floatingPlButton = document.getElementById('button-floating-pl');
const bannerAutotrading = document.getElementById('banner-autotrading');
const bannerCommandStatus = document.getElementById('banner-command-status');
const bannerPositionStream = document.getElementById('banner-position-stream');

const textSignalTotal = document.getElementById('text-signal-total');
const countExecuted = document.getElementById('count-executed');
const countBlocked = document.getElementById('count-blocked');
const countExpired = document.getElementById('count-expired');
const chartEmptyOverlay = document.getElementById('chart-empty-overlay');
const signalChartRange = document.getElementById('signal-chart-range');

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
const viewStrategies = document.getElementById('view-strategies');
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
const strategyPageSelect = document.getElementById('strategy-page-select');
const strategyPageEdit = document.getElementById('strategy-page-edit');
const strategyChartRange = document.getElementById('strategy-chart-range');
const signalSessionBands = document.getElementById('signal-session-bands');
const strategySessionBands = document.getElementById('strategy-session-bands');
const timezoneSelect = document.getElementById('timezone-select');
const pushNotificationsButton = document.getElementById('button-push-notifications');
const pushSettingsStatus = document.getElementById('push-settings-status');
const pushPreferenceList = document.getElementById('push-preference-list');
const settingsModalTitle = document.getElementById('settings-modal-title');
const settingsModalSubtitle = document.getElementById('settings-modal-subtitle');
const settingsBackButton = document.getElementById('button-settings-back');
const VAPID_PUBLIC_KEY = 'BJx7Y2wwbHI0Heyu_qooP7C2LYbUPgSd3chuPO_Rnc1PNXQqsldZ5wnkhhDoNyDBdQpA7Gz_eHLwYlTti4tdcaQ';
let pushRegistration = null;
let pushSubscription = null;

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

function deviceTimezone() {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
}

function displayTimezone() {
  return state.profile?.timezone || deviceTimezone();
}

function formatDateTime(value, options = {}) {
  if (!value) return '—';
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: displayTimezone(),
    ...options,
  }).format(date);
}

function formatDate(value, options = {}) {
  if (!value) return '—';
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return new Intl.DateTimeFormat(undefined, { timeZone: displayTimezone(), ...options }).format(date);
}

function zonedDateParts(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: displayTimezone(), year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', hourCycle: 'h23',
  }).formatToParts(date).reduce((result, part) => {
    if (part.type !== 'literal') result[part.type] = Number(part.value);
    return result;
  }, {});
  return { year: parts.year, month: parts.month, day: parts.day, hour: parts.hour };
}

function zonedDateKey(value) {
  const parts = zonedDateParts(value);
  return parts ? `${parts.year}-${String(parts.month).padStart(2, '0')}-${String(parts.day).padStart(2, '0')}` : null;
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
  await disablePushNotifications({ quiet: true });
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

function renderTimezoneSettings() {
  if (!timezoneSelect) return;
  const detected = deviceTimezone();
  const selected = displayTimezone();
  const fallback = [
    'UTC', 'America/New_York', 'America/Chicago', 'America/Denver', 'America/Los_Angeles',
    'America/Toronto', 'America/Vancouver', 'Europe/London', 'Europe/Paris', 'Europe/Berlin',
    'Africa/Johannesburg', 'Asia/Dubai', 'Asia/Kolkata', 'Asia/Singapore', 'Asia/Hong_Kong',
    'Asia/Tokyo', 'Australia/Sydney', 'Pacific/Auckland',
  ];
  const supported = typeof Intl.supportedValuesOf === 'function' ? Intl.supportedValuesOf('timeZone') : fallback;
  const zones = [...new Set([detected, selected, 'UTC', ...supported])];
  timezoneSelect.innerHTML = zones.map((zone) =>
    `<option value="${escapeHtml(zone)}" ${zone === selected ? 'selected' : ''}>${escapeHtml(zone)}${zone === detected ? ' · device' : ''}</option>`
  ).join('');
}

function rerenderTimezoneSurfaces() {
  renderPositions();
  renderPositionsTab();
  renderSignalsTab();
  renderAccountHistoryList();
  renderNewsEventsTab();
  renderVolumeChart();
  renderPlChart();
  renderStrategyPage();
  renderPairsView();
  renderSymbolMappingPanel();
  renderNotifications();
}

const SETTINGS_PAGES = {
  timezone: {
    title: 'Timezone',
    subtitle: 'Choose how dates and times appear across Lucre Hub.',
  },
  notifications: {
    title: 'Notifications',
    subtitle: 'Manage push delivery and the alerts sent to this device.',
  },
  risk: {
    title: 'Risk Management',
    subtitle: 'Control account-wide limits for automatic strategy orders.',
  },
  symbols: {
    title: 'Symbols',
    subtitle: 'Choose visible instruments and manage broker-specific mappings.',
  },
};

function showSettingsPage(page = 'home') {
  const selected = SETTINGS_PAGES[page] ? page : 'home';
  document.querySelectorAll('[data-settings-page]').forEach((panel) => {
    panel.hidden = panel.dataset.settingsPage !== selected;
  });
  if (settingsBackButton) settingsBackButton.hidden = selected === 'home';
  if (settingsModalTitle) settingsModalTitle.textContent = selected === 'home' ? 'Settings' : SETTINGS_PAGES[selected].title;
  if (settingsModalSubtitle) settingsModalSubtitle.textContent = selected === 'home'
    ? 'Choose a category to update your platform preferences.'
    : SETTINGS_PAGES[selected].subtitle;
  const settingsCard = document.querySelector('.settings-modal-card');
  if (settingsCard) settingsCard.scrollTop = 0;
  if (selected !== 'home') {
    window.requestAnimationFrame(() => settingsBackButton?.focus());
  }
}

document.querySelectorAll('[data-settings-page-target]').forEach((button) => {
  button.addEventListener('click', () => showSettingsPage(button.dataset.settingsPageTarget));
});
settingsBackButton?.addEventListener('click', () => showSettingsPage('home'));

document.getElementById('button-settings')?.addEventListener('click', () => {
  if (symbolSearchInput) symbolSearchInput.value = '';
  if (symbolSettingsStatus) {
    symbolSettingsStatus.hidden = true;
    symbolSettingsStatus.textContent = '';
  }
  renderSymbolSettingsList();
  renderSymbolMappingPanel();
  renderTimezoneSettings();
  loadPortfolioRiskSettings();
  loadPushNotificationSettings();
  showSettingsPage('home');
  window.LucreUI?.openModal('modal-platform-settings');
});

function base64UrlToUint8Array(value) {
  const padding = '='.repeat((4 - value.length % 4) % 4);
  const bytes = atob((value + padding).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(bytes, (char) => char.charCodeAt(0));
}

function pushSupported() {
  return window.isSecureContext && 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
}

function isIosBrowserOutsideHomeScreen() {
  const ios = /iPad|iPhone|iPod/.test(navigator.userAgent) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  return ios && !window.navigator.standalone && !window.matchMedia('(display-mode: standalone)').matches;
}

function setPushStatus(message, tone = 'muted') {
  if (!pushSettingsStatus) return;
  pushSettingsStatus.textContent = message;
  pushSettingsStatus.style.color = tone === 'error' ? 'var(--color-negative)'
    : tone === 'success' ? 'var(--color-positive)' : 'var(--color-text-muted)';
}

function renderPushControls() {
  if (!pushNotificationsButton || !pushPreferenceList) return;
  const enabled = Boolean(pushSubscription);
  pushNotificationsButton.textContent = enabled ? 'Disable' : 'Enable';
  pushNotificationsButton.classList.toggle('btn-accent', !enabled);
  pushNotificationsButton.classList.toggle('btn-secondary', enabled);
  pushPreferenceList.querySelectorAll('input').forEach((input) => { input.disabled = !enabled; });
  pushPreferenceList.style.opacity = enabled ? '1' : '0.68';
}

async function registerPushServiceWorker() {
  if (!pushSupported()) return null;
  if (!pushRegistration) {
    pushRegistration = await navigator.serviceWorker.register('/service-worker.js', { scope: '/' });
    await navigator.serviceWorker.ready;
  }
  return pushRegistration;
}

async function savePushSubscription(subscription) {
  const userId = state.session?.user?.id;
  if (!userId || !subscription) return;
  const json = subscription.toJSON();
  const { error } = await supabase.from('push_subscriptions').upsert({
    user_id: userId,
    endpoint: subscription.endpoint,
    p256dh: json.keys?.p256dh,
    auth: json.keys?.auth,
    user_agent: navigator.userAgent.slice(0, 500),
    last_seen_at: new Date().toISOString(),
  }, { onConflict: 'user_id,endpoint' });
  if (error) throw error;
}

async function loadPushNotificationSettings() {
  if (!pushNotificationsButton || !pushPreferenceList) return;
  if (!pushSupported()) {
    pushNotificationsButton.disabled = true;
    setPushStatus(isIosBrowserOutsideHomeScreen()
      ? 'Add Lucre Hub to your iPhone/iPad Home Screen, then open it there to enable notifications.'
      : 'Web push is not supported by this browser or connection.', 'error');
    renderPushControls();
    return;
  }
  try {
    const registration = await registerPushServiceWorker();
    pushSubscription = await registration.pushManager.getSubscription();
    if (pushSubscription) await savePushSubscription(pushSubscription);
    const { data: preferences, error } = await supabase.from('push_notification_preferences')
      .select('terminal_disconnected,position_opened,position_closed,trend_extreme,floating_pl_target')
      .eq('user_id', state.session.user.id).maybeSingle();
    if (error) throw error;
    if (preferences) {
      pushPreferenceList.querySelectorAll('input[name]').forEach((input) => {
        input.checked = preferences[input.name] !== false;
      });
    }
    pushNotificationsButton.disabled = Notification.permission === 'denied';
    setPushStatus(Notification.permission === 'denied'
      ? 'Notifications are blocked in this device’s browser settings.'
      : pushSubscription ? 'Notifications are active on this device.' : 'Notifications are off on this device.',
      pushSubscription ? 'success' : Notification.permission === 'denied' ? 'error' : 'muted');
  } catch (error) {
    console.error('push settings load error', error);
    setPushStatus(`Could not load notification settings: ${error.message}`, 'error');
  }
  renderPushControls();
}

async function enablePushNotifications() {
  if (!pushSupported()) throw new Error('Push notifications are not supported here.');
  if (isIosBrowserOutsideHomeScreen()) throw new Error('On iPhone/iPad, add Lucre Hub to your Home Screen and open it there first.');
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') throw new Error(permission === 'denied'
    ? 'Notifications were blocked. Re-enable them in your browser/device settings.'
    : 'Notification permission was not granted.');
  const registration = await registerPushServiceWorker();
  pushSubscription = await registration.pushManager.getSubscription() || await registration.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: base64UrlToUint8Array(VAPID_PUBLIC_KEY),
  });
  await savePushSubscription(pushSubscription);
  const values = { user_id: state.session.user.id };
  pushPreferenceList.querySelectorAll('input[name]').forEach((input) => { values[input.name] = input.checked; });
  const { error } = await supabase.from('push_notification_preferences').upsert(values, { onConflict: 'user_id' });
  if (error) throw error;
  setPushStatus('Notifications are active on this device.', 'success');
  renderPushControls();
}

async function disablePushNotifications({ quiet = false } = {}) {
  try {
    const registration = pushRegistration || (pushSupported() ? await navigator.serviceWorker.getRegistration('/') : null);
    const subscription = pushSubscription || await registration?.pushManager.getSubscription();
    if (subscription && state.session?.user?.id) {
      await supabase.from('push_subscriptions').delete()
        .eq('user_id', state.session.user.id).eq('endpoint', subscription.endpoint);
      await subscription.unsubscribe();
    }
    pushSubscription = null;
    if (!quiet) setPushStatus('Notifications are off on this device.');
  } catch (error) {
    if (!quiet) throw error;
  } finally {
    renderPushControls();
  }
}

pushNotificationsButton?.addEventListener('click', async () => {
  pushNotificationsButton.disabled = true;
  try {
    if (pushSubscription) await disablePushNotifications();
    else await enablePushNotifications();
  } catch (error) {
    setPushStatus(error.message, 'error');
  } finally {
    pushNotificationsButton.disabled = Notification.permission === 'denied';
  }
});

pushPreferenceList?.addEventListener('change', async () => {
  if (!pushSubscription || !state.session?.user?.id) return;
  const values = { user_id: state.session.user.id };
  pushPreferenceList.querySelectorAll('input[name]').forEach((input) => { values[input.name] = input.checked; });
  const { error } = await supabase.from('push_notification_preferences').upsert(values, { onConflict: 'user_id' });
  setPushStatus(error ? `Could not save preferences: ${error.message}` : 'Notification preferences saved.', error ? 'error' : 'success');
});

document.getElementById('form-timezone-settings')?.addEventListener('submit', async (event) => {
  event.preventDefault();
  const message = document.getElementById('timezone-settings-message');
  const button = event.currentTarget.querySelector('button[type="submit"]');
  const timezone = timezoneSelect?.value || deviceTimezone();
  if (button) button.disabled = true;
  try {
    await accountManagement('update_timezone', { timezone });
    state.profile = { ...(state.profile || {}), timezone };
    if (message) { message.style.color = 'var(--color-accent)'; message.textContent = `Timezone saved as ${timezone}.`; }
    rerenderTimezoneSurfaces();
  } catch (error) {
    if (message) { message.style.color = 'var(--color-negative)'; message.textContent = error.message; }
  } finally {
    if (button) button.disabled = false;
  }
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
// Primary workspaces: account dashboard, strategy analytics, and pairs.
// ---------------------------------------------------------------------------
function setActiveView(view) {
  const nextView = ['dashboard', 'strategies', 'pairs'].includes(view) ? view : 'dashboard';
  state.activeView = nextView;
  const isPairs = nextView === 'pairs';
  viewPairs.hidden = nextView !== 'pairs';
  viewStrategies.hidden = nextView !== 'strategies';
  viewDashboard.hidden = nextView !== 'dashboard';
  document.querySelectorAll('.nav-pill').forEach((pill) => {
    const pillView = pill.dataset.view || 'dashboard';
    pill.classList.toggle('active', pillView === nextView);
  });
  const activePill = document.querySelector(`.nav-pill[data-view="${nextView}"]`);
  if (window.matchMedia('(max-width: 640px)').matches) {
    activePill?.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' });
  }
  if (isPairs) {
    renderPairsView();
    renderSymbolMappingPanel();
    // Refresh both halves of the Pairs view together. Realtime keeps the
    // values moving afterward, but a tab opened after an M30 close must not
    // reuse the trend snapshot cached when the dashboard first booted.
    Promise.all([loadPriceFeedStates(), loadTrendStates()]);
  } else if (nextView === 'strategies') {
    renderStrategyPage();
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
      ? formatDateTime(active.api_key_last_rotated_at)
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
    meta.textContent = `Current key ends in •••• ${result.api_key_last_four} — rotated ${formatDateTime(result.rotated_at)}.`;
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
    entry_surface: 'dashboard',
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
    msg.textContent = 'Position update queued.';
    window.LucreUI.closeModal(document.getElementById('modal-modify-position'));
    msg.textContent = '';
    await loadPositions();
  } catch (err) {
    msg.style.color = 'var(--color-negative)';
    msg.textContent = err.message;
  } finally {
    submitBtn.disabled = false;
  }
});

function showPositionCommandError(message) {
  if (!bannerCommandStatus) return;
  bannerCommandStatus.textContent = message;
  bannerCommandStatus.hidden = false;
}

async function handleClosePosition(positionId, button) {
  const position = state.positions.find((p) => p.id === positionId);
  if (!position || position.status !== 'open' || button?.disabled) return;

  if (button) {
    button.disabled = true;
    button.textContent = 'Closing…';
  }
  if (bannerCommandStatus) bannerCommandStatus.hidden = true;

  try {
    const result = await closePosition(positionId, { client_request_id: crypto.randomUUID() });
    state.pendingCommandId = result.ea_command_id;
    await loadPositions();
  } catch (err) {
    showPositionCommandError(`Position was not queued to close: ${err.message}`);
    renderPositions();
    renderPositionsTab();
  }
}

let closeAllSubmitting = false;

async function handleCloseAllPositions() {
  if (closeAllSubmitting || !state.activeTerminalId
    || !state.positions.some((position) => position.status === 'open')) return;

  closeAllSubmitting = true;
  if (bannerCommandStatus) bannerCommandStatus.hidden = true;
  renderFloatingPl();
  renderCloseAllControls();
  try {
    const result = await closeAllPositions(state.activeTerminalId, { client_request_id: crypto.randomUUID() });
    state.pendingCommandId = result.ea_command_id;
    await loadPositions();
  } catch (error) {
    showPositionCommandError(`Positions were not queued to close: ${error.message}`);
  } finally {
    closeAllSubmitting = false;
    renderFloatingPl();
    renderCloseAllControls();
  }
}

floatingPlButton?.addEventListener('click', handleCloseAllPositions);
document.querySelectorAll('[data-close-all-positions]').forEach((button) => {
  button.addEventListener('click', handleCloseAllPositions);
});

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
      swap: streamed.swap,
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
    const swap = position?.swap === undefined ? 0 : Number(position.swap);
    if (!Number.isFinite(ticket) || !Number.isFinite(volume)
      || !Number.isFinite(currentPrice) || !Number.isFinite(unrealizedPl)
      || !Number.isFinite(swap)) return;
    const sl = position.sl === null ? null : Number(position.sl);
    const tp = position.tp === null ? null : Number(position.tp);
    next.set(String(ticket), {
      receivedAt,
      volume,
      current_price: currentPrice,
      unrealized_pl: unrealizedPl,
      swap,
      sl: sl === null || Number.isFinite(sl) ? sl : null,
      tp: tp === null || Number.isFinite(tp) ? tp : null,
    });
  });
  streamedPositionFields = next;
  const accountFloatingPl = Number(message.account_floating_pl);
  if (Number.isFinite(accountFloatingPl)) {
    streamedAccountState = {
      terminalId,
      receivedAt,
      floating_pl: accountFloatingPl,
      account_credit: Number.isFinite(Number(message.account_credit)) ? Number(message.account_credit) : null,
      positions_profit: Number.isFinite(Number(message.positions_profit)) ? Number(message.positions_profit) : null,
      positions_swap: Number.isFinite(Number(message.positions_swap)) ? Number(message.positions_swap) : null,
    };
  }
  // MT5 is the live source of truth. Hide a position already marked `closing`
  // as soon as the broker-confirmed stream omits it; durable reconciliation
  // can finish its trade-history bookkeeping in the background.
  state.positions = mergeStreamedPositionFields(state.positions.filter((position) => (
    position.status !== 'closing' || next.has(String(position.mt5_ticket))
  )));
  renderPositions();
  renderPositionsTab();
}

function stopPositionStreamRequests() {
  if (positionStreamRequestIntervalId) clearInterval(positionStreamRequestIntervalId);
  positionStreamRequestIntervalId = null;
  if (positionStreamUiIntervalId) clearInterval(positionStreamUiIntervalId);
  positionStreamUiIntervalId = null;
}

function requestPositionStream() {
  if (!realtimeChannel) return;
  realtimeChannel
    // This event name deliberately does not contain the legacy public-stream
    // lease name. Pre-v1.0.46 EAs ignore it and therefore cannot accidentally
    // publish private position values on the public command-wake topic.
    .send({ type: 'broadcast', event: 'private_position_lease', payload: {} })
    .catch((error) => console.warn('[realtime] position stream lease failed', error));
}

function startPositionStreamRequests() {
  stopPositionStreamRequests();
  requestPositionStream();
  positionStreamRequestIntervalId = setInterval(requestPositionStream, 15000);
  // Re-evaluate stream freshness locally without adding any Supabase reads or
  // writes. This prevents a dead stream from looking "Live" until the next
  // durable reconciliation poll.
  positionStreamUiIntervalId = setInterval(renderFloatingPl, 2000);
}

function maybeStartPositionStreamRequests() {
  if (realtimeCommandSubscribed && realtimePositionSubscribed) {
    startPositionStreamRequests();
  }
}

function scheduleRealtimeReconnect(terminalId) {
  stopPositionStreamRequests();
  if (realtimeReconnectTimer) return;
  realtimeReconnectTimer = setTimeout(() => {
    realtimeReconnectTimer = null;
    if (state.activeTerminalId === terminalId) startRealtime(terminalId);
  }, 3000);
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
    .select('id, equity, balance, margin_level, floating_pl, account_credit, positions_profit, positions_swap, floating_pl_reported_at, status, terminal_trade_allowed, mql_trade_allowed, account_trade_allowed, account_expert_trade_allowed, trade_capability_reported_at')
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
  streamedAccountState = null;
  positionStreamStartedAt = Date.now();
  if (!terminalId) return;
  const terminal = state.terminals.find((item) => item.id === terminalId);
  const channelName = terminal?.realtime_topic_id
    ? `terminal:${terminal.realtime_topic_id}`
    : `terminal-${terminalId}`;
  const positionChannelName = terminal?.realtime_topic_id
    ? `terminal:${terminal.realtime_topic_id}:positions`
    : null;

  // Mark-to-market values use a separate authenticated Realtime topic. RLS on
  // realtime.messages verifies that the signed-in user owns this terminal.
  // Durable position rows and all modify/close controls remain unchanged.
  if (positionChannelName) {
    positionRealtimeChannel = supabase
      .channel(positionChannelName, {
        config: { private: true, broadcast: { ack: false, self: false } },
      })
      .on(
        'broadcast',
        { event: 'position_state' },
        (payload) => applyStreamedPositionState(terminalId, payload)
      )
      .subscribe((status) => {
        console.log('[position-realtime]', status, 'terminal', terminalId);
        if (status === 'SUBSCRIBED') {
          realtimePositionSubscribed = true;
          maybeStartPositionStreamRequests();
        }
        if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
          realtimePositionSubscribed = false;
          scheduleRealtimeReconnect(terminalId);
        }
      });
  }
  realtimeChannel = supabase
    .channel(channelName)
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
        realtimeCommandSubscribed = true;
        setRealtimeHealth(true);
        maybeStartPositionStreamRequests();
      }
      if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
        realtimeCommandSubscribed = false;
        setRealtimeHealth(false);
        scheduleRealtimeReconnect(terminalId);
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
  renderVolumeChart();
  renderSignalsTab();
  renderStrategyPage();
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
  renderStrategyPage();
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
  realtimeCommandSubscribed = false;
  realtimePositionSubscribed = false;
  streamedAccountState = null;
  positionStreamStartedAt = 0;
  if (realtimeReconnectTimer) {
    clearTimeout(realtimeReconnectTimer);
    realtimeReconnectTimer = null;
  }
  if (realtimeChannel) {
    supabase.removeChannel(realtimeChannel);
    realtimeChannel = null;
  }
  if (positionRealtimeChannel) {
    supabase.removeChannel(positionRealtimeChannel);
    positionRealtimeChannel = null;
  }
}

// ---------------------------------------------------------------------------
// Data loaders
// ---------------------------------------------------------------------------
async function loadProfile() {
  const { data, error } = await supabase
    .from('profiles')
    .select('display_name, bio, location, website, trading_style, timezone')
    .eq('id', state.session.user.id)
    .maybeSingle();

  if (error) {
    console.error('loadProfile error', error);
    return;
  }
  state.profile = data;
  renderTimezoneSettings();

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
      'id, label, broker, account_login, server, is_live, status, equity, balance, margin_level, floating_pl, account_credit, positions_profit, positions_swap, floating_pl_reported_at, ea_version, api_key_last_four, api_key_last_rotated_at, max_manual_lot_size, max_daily_loss_usd, max_open_positions, force_symbol_rescan, last_symbol_scan_at, realtime_topic_id'
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
    renderStrategyPage();
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
  renderStrategyPage();
  renderNotifications();
}

const STRATEGY_HEALTH_LABELS = {
  session_blocked: 'Outside selected session',
  symbol_disabled: 'Pair hidden in Settings',
  missing_bars: 'Waiting for candle history',
  stale_candles: 'Candle feed is stale',
  market_paused: 'Waiting for next broker candle',
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
  const priority = ['command_failed', 'ea_version_blocked', 'broker_mapping_failed', 'stale_candles', 'missing_bars', 'risk_blocked', 'policy_blocked', 'spread_blocked', 'session_blocked', 'market_paused', 'cooldown_blocked', 'direction_blocked', 'no_setup', 'duplicate_bar', 'manual_signal', 'shadow_signal', 'command_queued'];
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

function canonicalSymbolForTrade(tradeOrSymbol) {
  const trade = typeof tradeOrSymbol === 'object' && tradeOrSymbol !== null ? tradeOrSymbol : null;
  const raw = String(trade?.entry_context?.canonical_symbol || trade?.symbol || tradeOrSymbol || '').trim().toUpperCase();
  if (!raw) return '';
  const mapping = state.symbolMappings.find((item) =>
    String(item.canonical_symbol || '').toUpperCase() === raw ||
    String(item.broker_symbol || '').toUpperCase() === raw
  );
  return String(mapping?.canonical_symbol || raw).toUpperCase();
}

function tradeSessionKey(trade) {
  if (trade?.session && trade.session !== 'unknown') return trade.session;
  const capturedAt = trade?.entry_context?.captured_at || trade?.open_time;
  const date = capturedAt ? new Date(capturedAt) : null;
  if (!date || Number.isNaN(date.getTime())) return null;
  const hour = date.getUTCHours();
  if (hour < 7 || hour >= 21) return 'asia';
  if (hour < 12) return 'london';
  if (hour < 16) return 'overlap';
  return 'ny';
}

function isWinningTrade(trade) {
  return trade?.outcome ? trade.outcome === 'win' : Number(trade?.profit ?? 0) > 0;
}

function strategyPerformanceSummary(strategyId) {
  const trades = getVerifiedTradeHistory().filter((trade) => trade.strategy_id === strategyId);
  if (trades.length === 0) return { winRate: null, count: 0, bestSession: null };
  const wins = trades.filter(isWinningTrade).length;
  const sessions = new Map();
  trades.forEach((trade) => {
    const key = tradeSessionKey(trade) || 'unknown';
    const current = sessions.get(key) || { count: 0, wins: 0 };
    current.count += 1;
    if (isWinningTrade(trade)) current.wins += 1;
    sessions.set(key, current);
  });
  const bestSession = [...sessions.entries()]
    .filter(([session]) => session !== 'unknown')
    .sort((a, b) => (b[1].wins / b[1].count) - (a[1].wins / a[1].count) || b[1].count - a[1].count)[0]?.[0];
  return { winRate: Math.round((wins / trades.length) * 100), count: trades.length, bestSession };
}

function strategyBrief(strategy) {
  if (strategy.run_mode === 'shadow') return 'Shadow';
  return strategy.delivery_mode === 'auto' ? 'Auto' : 'Signal Only';
}

const GEAR_ICON = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" aria-hidden="true"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .34 1.87l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.7 1.7 0 0 0-1.87-.34 1.7 1.7 0 0 0-1 1.55V21a2 2 0 1 1-4 0v-.09A1.7 1.7 0 0 0 9 19.36a1.7 1.7 0 0 0-1.87.34l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.7 1.7 0 0 0 4.64 15a1.7 1.7 0 0 0-1.55-1H3a2 2 0 1 1 0-4h.09A1.7 1.7 0 0 0 4.64 9a1.7 1.7 0 0 0-.34-1.87l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.7 1.7 0 0 0 9 4.64a1.7 1.7 0 0 0 1-1.55V3a2 2 0 1 1 4 0v.09a1.7 1.7 0 0 0 1 1.55 1.7 1.7 0 0 0 1.87-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.7 1.7 0 0 0 19.36 9a1.7 1.7 0 0 0 1.55 1H21a2 2 0 1 1 0 4h-.09A1.7 1.7 0 0 0 19.4 15z"/></svg>';

function isTransientStrategyToggleError(error) {
  const message = String(error?.message || error || '');
  return /load failed|failed to fetch|networkerror|network request|fetch/i.test(message);
}

async function persistStrategyEnabled(strategyId, enabled) {
  let lastError = null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const { data, error } = await supabase
        .rpc('set_strategy_enabled', { p_strategy_id: strategyId, p_enabled: enabled })
        .single();
      if (!error) return data;
      lastError = error;
    } catch (error) {
      lastError = error;
    }
    if (!isTransientStrategyToggleError(lastError) || attempt === 2) break;
    await new Promise((resolve) => setTimeout(resolve, 300 * (attempt + 1)));
  }
  throw lastError || new Error('The strategy update could not be confirmed.');
}

async function handleStrategyToggle(input, strategyId) {
  const enabled = input.checked;
  const strategy = state.strategies.find((item) => item.id === strategyId);
  const previous = strategy?.enabled ?? !enabled;
  document.querySelectorAll(`[data-strategy-toggle="${strategyId}"], [data-strategy-card-toggle="${strategyId}"]`)
    .forEach((control) => { control.disabled = true; });
  try {
    const saved = await persistStrategyEnabled(strategyId, enabled);
    if (strategy) strategy.enabled = saved.enabled;
    renderStrategies();
    renderStrategyWinRates();
    renderStrategyStatusTab();
    renderStrategyPage();
    renderNotifications();
  } catch (error) {
    if (strategy) strategy.enabled = previous;
    renderStrategies();
    renderStrategyWinRates();
    renderStrategyStatusTab();
    renderStrategyPage();
    console.error('toggle strategy error', error);
    const message = isTransientStrategyToggleError(error)
      ? 'The browser could not reach Supabase after three attempts. Check the connection and try again.'
      : error?.message || 'The strategy update was rejected.';
    alert(`Couldn't update that strategy: ${message}`);
  }
}

function renderStrategies() {
  if (state.strategies.length === 0) {
    strategyList.innerHTML =
      '<p class="empty-state-text" id="strategy-empty-state">No strategies yet. Add your first one to get started.</p>';
    return;
  }

  strategyList.innerHTML = state.strategies
    .map((s) => `
      <div class="mini-table-row strategy-overview-row" data-strategy-id="${s.id}">
        <div class="mini-table-meta">
          <div class="strategy-name">${escapeHtml(s.name)}</div>
          <div class="strategy-sub">${escapeHtml(strategyBrief(s))}</div>
        </div>
        <label class="strategy-toggle strategy-toggle-icon-only" title="${s.enabled ? 'Disable' : 'Enable'} ${escapeHtml(s.name)}">
          <input type="checkbox" class="strategy-toggle-input" data-strategy-toggle="${s.id}" aria-label="${s.enabled ? 'Disable' : 'Enable'} ${escapeHtml(s.name)}" ${s.enabled ? 'checked' : ''} />
        </label>
        <button class="strategy-gear-button" type="button" data-edit-strategy="${s.id}" aria-label="Edit ${escapeHtml(s.name)}">${GEAR_ICON}</button>
      </div>`)
    .join('');

  strategyList.querySelectorAll('[data-strategy-toggle]').forEach((input) => {
    input.addEventListener('change', (event) => handleStrategyToggle(event.target, event.target.dataset.strategyToggle));
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
    renderStrategyPage();
    renderNotifications();
    return;
  }

  const [signalsRes, deliveriesRes] = await Promise.all([
    supabase
      .from('signals')
      .select(
        'id, strategy_id, symbol, side, timeframe, policy_decision, generated_at, expires_at, suggested_volume, near_news_event, htf_regime, ' +
          'block_reason, news_event_id, calendar_events(title, currency, impact)'
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
  renderStrategyPage();
  renderNotifications();
}

function renderSignalSummary() {
  const summary = summarizeSignalsForRange(state.signals, state.signalDeliveries, state.signalChartRange);

  textSignalTotal.textContent = summary.total.toLocaleString();
  countExecuted.textContent = summary.executed.toLocaleString();
  countBlocked.textContent = summary.blocked.toLocaleString();
  countExpired.textContent = summary.expired.toLocaleString();

  chartEmptyOverlay.style.display = summary.total === 0 ? 'flex' : 'none';
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
    .select('id, mt5_ticket, symbol, side, volume, open_price, current_price, sl, tp, unrealized_pl, swap, status, open_time, source, strategy_id, strategy_name_at_entry, origin_detail')
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

function getPositionInitiator(position) {
  const linkedStrategy = state.strategies.find((strategy) => strategy.id === position.strategy_id);
  const capturedName = String(position.strategy_name_at_entry || linkedStrategy?.name || '').trim();
  const isManualPlaceholder = capturedName === 'Discretionary manual' || capturedName === 'MT5 direct manual';

  if (position.strategy_id || (capturedName && !isManualPlaceholder)) {
    return {
      name: capturedName || 'Strategy',
      detail: position.source === 'manual_tap' ? 'Strategy · Manual signal' : 'Strategy · Auto',
    };
  }

  if (position.origin_detail === 'pairs_one_click') {
    return { name: 'Pairs one-click', detail: 'Manual · Pairs card' };
  }
  if (position.origin_detail === 'mt5_direct_manual' || capturedName === 'MT5 direct manual') {
    return { name: 'MT5 terminal', detail: 'External · Outside dashboard' };
  }
  if (position.source === 'manual_tap') {
    return { name: 'Dashboard signal', detail: 'Manual · Signal accepted' };
  }
  return { name: 'Dashboard order', detail: 'Manual · Dashboard' };
}

function renderPositionRows(list, emptyMessage) {
  if (!list) return;

  if (state.positions.length === 0) {
    list.innerHTML = `<p class="empty-state-text">${emptyMessage}</p>`;
    return;
  }

  const rows = state.positions
    .map((p) => {
      const plValue = Number(p.unrealized_pl) || 0;
      const plColor = plValue > 0 ? 'var(--color-positive)' : plValue < 0 ? 'var(--color-negative)' : 'var(--color-text-muted)';
      const sideClass = p.side === 'sell' ? 'side-sell' : 'side-buy';
      const initiator = getPositionInitiator(p);
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
        <div class="mini-table-row position-table-row${isClosing ? ' is-reconciling' : ''}">
          <div class="mini-table-meta">
            <div class="strategy-name">${escapeHtml(p.symbol)}<span class="side-badge ${sideClass}">${escapeHtml(p.side)}</span></div>
            <div class="strategy-sub">${p.volume} lots · opened ${formatDateTime(p.open_time)}</div>
          </div>
          <div class="position-origin">
            <div class="position-origin-name">${escapeHtml(initiator.name)}</div>
            <div class="position-origin-detail">${escapeHtml(initiator.detail)}</div>
          </div>
          <div class="mini-table-stats">
            <div class="pct" style="color:${plColor}">${plValue >= 0 ? '+' : ''}${plValue.toFixed(2)}</div>
            <div class="count">${p.open_price} → ${p.current_price ?? '—'}</div>
          </div>
          ${actionsHtml}
        </div>`;
    })
    .join('');

  list.innerHTML = `
    <div class="positions-table-head" aria-hidden="true">
      <span>Position</span>
      <span>Initiated by</span>
      <span style="text-align:right">Live P/L</span>
      <span style="text-align:right">Actions</span>
    </div>
    ${rows}`;

  list.querySelectorAll('[data-modify-position]').forEach((btn) => {
    btn.addEventListener('click', () => openModifyModal(btn.dataset.modifyPosition));
  });
  list.querySelectorAll('[data-close-position]').forEach((btn) => {
    btn.addEventListener('click', () => handleClosePosition(btn.dataset.closePosition, btn));
  });
}

function renderPositions() {
  renderPositionRows(
    document.getElementById('positions-list'),
    state.activeTerminalId
      ? 'No open positions. Place an order to see it here.'
      : 'No open positions. Connect an account and place an order to see it here.'
  );
  renderFloatingPl();
  renderCloseAllControls();
}

function renderCloseAllControls() {
  const canClose = Boolean(state.activeTerminalId)
    && state.positions.some((position) => position.status === 'open')
    && !closeAllSubmitting;
  document.querySelectorAll('[data-close-all-positions]').forEach((button) => {
    button.disabled = !canClose;
  });
}

function renderFloatingPl() {
  if (!floatingPlButton || !balanceWidgetFloatingPl) return;
  const active = state.terminals.find((terminal) => terminal.id === state.activeTerminalId);
  const now = Date.now();
  const streamIsCurrent = streamedAccountState?.terminalId === state.activeTerminalId
    && now - streamedAccountState.receivedAt <= POSITION_STREAM_TTL_MS;
  const durableAge = active?.floating_pl_reported_at
    ? now - new Date(active.floating_pl_reported_at).getTime() : Infinity;
  const durableIsCurrent = Number.isFinite(Number(active?.floating_pl)) && durableAge <= 90000;
  const derivedTotal = state.positions.reduce(
    (sum, position) => sum + (Number(position.unrealized_pl) || 0) + (Number(position.swap) || 0),
    0
  );
  const total = streamIsCurrent
    ? streamedAccountState.floating_pl
    : durableIsCurrent ? Number(active.floating_pl) : derivedTotal;
  const source = streamIsCurrent ? 'Live · 2s' : durableIsCurrent ? 'Backup · 30s' : 'Derived · waiting';
  balanceWidgetFloatingPl.textContent = `${total >= 0 ? '+' : ''}${fmtUsd(total)}`;
  if (floatingPlSource) floatingPlSource.textContent = source;
  floatingPlButton.classList.toggle('is-positive', total > 0);
  floatingPlButton.classList.toggle('is-negative', total < 0);
  floatingPlButton.classList.toggle('is-flat', total === 0);
  floatingPlButton.disabled = closeAllSubmitting || !state.activeTerminalId
    || !state.positions.some((position) => position.status === 'open');

  if (bannerPositionStream) {
    const hasOpenPosition = state.positions.some((position) => position.status === 'open');
    const versionParts = String(active?.ea_version || '').match(/\d+/g)?.map(Number) || [];
    const normalizedVersion = versionParts.length === 2
      ? [versionParts[0], 0, versionParts[1]] : versionParts.slice(0, 3);
    const supportsAccountStream = normalizedVersion.length === 3
      && (normalizedVersion[0] > 1
        || (normalizedVersion[0] === 1 && normalizedVersion[1] > 0)
        || (normalizedVersion[0] === 1 && normalizedVersion[1] === 0 && normalizedVersion[2] >= 47));
    const streamGraceElapsed = positionStreamStartedAt > 0 && now - positionStreamStartedAt > 12000;
    if (active?.status === 'connected' && !supportsAccountStream) {
      bannerPositionStream.textContent = `EA ${active.ea_version || 'unknown'} does not provide broker-authoritative live P/L. Install LucreHubEA-v1.47.mq5 to enable it.`;
      bannerPositionStream.hidden = false;
    } else if (hasOpenPosition && supportsAccountStream && streamGraceElapsed && !streamIsCurrent) {
      bannerPositionStream.textContent = 'The private MT5 P/L stream is unavailable. Displaying the durable 30-second account snapshot until it reconnects.';
      bannerPositionStream.hidden = false;
    } else {
      bannerPositionStream.hidden = true;
    }
  }
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
    .select('symbol, score, direction, strength, confidence, regime, timeframe_scores, components, source_bar_times, source_bar_time, model_version, computed_at')
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
    .select('symbol,timeframe,latest_bar_time,oldest_bar_time,history_bar_count,last_received_at,desired_enabled,bootstrap_required,status,last_error,repair_requested_at,collector_state,collector_attempt_count,collector_last_error,collector_reported_at,collector_next_retry_at,source_latest_bar_time,last_upload_status,last_success_at,expected_bar_time,source_tick_time,ingest_lag_seconds')
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
  const canonicalSymbol = canonicalSymbolForTrade(symbol);
  const trades = getVerifiedTradeHistory().filter((trade) =>
    canonicalSymbolForTrade(trade) === canonicalSymbol && trade.close_time
  );
  const todayKey = zonedDateKey(new Date());
  const todayTrades = trades.filter((trade) => zonedDateKey(trade.close_time) === todayKey);
  const dailyPl = todayTrades.reduce((sum, trade) => sum + Number(trade.profit ?? 0), 0);

  if (trades.length === 0) {
    return { count: 0, winRate: null, totalPl: 0, bestSession: null, dailyPl, dailyCount: 0 };
  }

  const wins = trades.filter(isWinningTrade).length;
  const totalPl = trades.reduce((sum, trade) => sum + Number(trade.profit ?? 0), 0);
  const sessions = new Map();
  trades.forEach((trade) => {
    const session = tradeSessionKey(trade);
    if (!session) return;
    const current = sessions.get(session) || { count: 0, wins: 0 };
    current.count += 1;
    if (isWinningTrade(trade)) current.wins += 1;
    sessions.set(session, current);
  });
  const bestSession = [...sessions.entries()]
    .sort((left, right) =>
      (right[1].wins / right[1].count) - (left[1].wins / left[1].count) ||
      right[1].count - left[1].count
    )[0]?.[0] ?? null;

  return {
    count: trades.length,
    winRate: Math.round((wins / trades.length) * 100),
    totalPl,
    bestSession,
    dailyPl,
    dailyCount: todayTrades.length,
  };
}

function trendMeterPresentation(symbol) {
  const trend = state.trendStates.find((item) => item.symbol === symbol);
  if (!trend || trend.regime === 'insufficient_data' || trend.model_version !== 'trend-strength-v3') {
    return { score: 0, position: 50, status: 'Warming up', detail: 'Waiting for the M30 trend model to process 120 closed candles.' };
  }
  const score = Math.max(-100, Math.min(100, Number(trend.score) || 0));
  const m30Feed = priceFeedPresentation(symbol, 'M30');
  const stale = !m30Feed.available && m30Feed.tone !== 'waiting';
  const words = {
    volatility_shock: 'Volatility shock',
    trending: 'Trending',
    ranging: 'Ranging',
    transition: 'Transition',
  };
  const direction = trend.direction === 'bullish' ? 'bullish' : trend.direction === 'bearish' ? 'bearish' : 'neutral';
  const strength = trend.strength === 'neutral' ? 'Neutral' : `${trend.strength[0].toUpperCase()}${trend.strength.slice(1)} ${direction}`;
  const status = stale ? `${strength} · Market data paused` : `${strength} · ${words[trend.regime] || 'Transition'}`;
  const components = trend.components || {};
  const participation = Number(components.volume_ratio);
  const alignment = Number(components.h1_alignment);
  const detailParts = [
    `M30 quality ${Math.round((Number(components.regime_quality) || 0) * 100)}%`,
    Number.isFinite(participation) ? `volume ${participation.toFixed(2)}×` : null,
    Number.isFinite(alignment) ? `H1 alignment ${Math.round(alignment * 100)}%` : null,
    components.extended ? 'price extended' : null,
  ].filter(Boolean);
  return {
    score,
    position: (score + 100) / 2,
    status,
    detail: detailParts.join(' · ') || 'M30 direction, regime quality, broker volume and H1 context.',
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
    const now = Date.now();
    const reportedAt = row.collector_reported_at ? new Date(row.collector_reported_at).getTime() : 0;
    const requestedAt = row.repair_requested_at ? new Date(row.repair_requested_at).getTime() : 0;
    const collectorRecent = Number.isFinite(reportedAt) && reportedAt > 0 && now - reportedAt < 90_000;
    const requestRecent = Number.isFinite(requestedAt) && requestedAt > 0 && now - requestedAt < 90_000;
    const collectorState = row.collector_state || 'idle';
    const collectorLabels = {
      sync_requested: 'Queued',
      waiting_history: 'Waiting on MT5',
      ready: 'History ready',
      uploading: 'Uploading',
      retry_backoff: 'Retry scheduled',
      error: 'Repair failed',
    };
    const repairing = collectorState !== 'error' && (collectorRecent || requestRecent);
    const label = collectorState === 'error'
      ? 'Repair failed'
      : repairing
        ? (collectorLabels[collectorState] || 'Queued')
        : 'Repair stalled';
    const error = row.collector_last_error || row.last_error;
    const retry = row.collector_next_retry_at ? ' · retry scheduled' : '';
    return {
      available: false,
      repairing,
      label,
      detail: `${Number(row.history_bar_count) || 0} candles stored · ${label}${retry}${error ? ` · ${error}` : ''}`,
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
  const collectorReportedMs = row.collector_reported_at ? new Date(row.collector_reported_at).getTime() : 0;
  const collectorIsRecent = Number.isFinite(collectorReportedMs) && Date.now() - collectorReportedMs < 90_000;
  if (['market_closed', 'ready'].includes(row.collector_state) && collectorIsRecent) {
    const stateLabels = {
      market_closed: 'Market paused',
      ready: 'Awaiting candle close',
    };
    return {
      available: true,
      tone: 'waiting',
      label: stateLabels[row.collector_state] || 'Awaiting broker',
      detail: `${Number(row.history_bar_count).toLocaleString()} candles · ${
        row.collector_state === 'market_closed'
          ? 'broker session is paused'
          : 'waiting for the next real broker candle to close'
      }`,
      row,
    };
  }
  const timeframeSeconds = PRICE_TIMEFRAME_SECONDS[timeframe] || 60;
  const staleAfterMs = Math.max(180, timeframeSeconds * 2.5) * 1000;
  const latestMs = new Date(row.latest_bar_time).getTime();
  const stale = !Number.isFinite(latestMs) || Date.now() - latestMs > staleAfterMs;
  return {
    available: !stale,
    tone: stale ? 'unavailable' : 'available',
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
    entry_surface: 'pairs',
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
      const bestSessionLabel = perf.bestSession
        ? SESSION_LABELS[perf.bestSession] || perf.bestSession
        : '—';
      const dailyPlColor = perf.dailyPl > 0
        ? 'var(--color-positive)'
        : perf.dailyPl < 0
          ? 'var(--color-negative)'
          : 'var(--color-text)';
      const dailyPlLabel = `${perf.dailyPl > 0 ? '+' : ''}${fmtUsd(perf.dailyPl)}`;
      const timeframeButtons = PRICE_TIMEFRAMES.map((timeframe) => {
        const feed = priceFeedPresentation(s.symbol, timeframe);
        const key = `${s.symbol}:${timeframe}`;
        const loading = pairRepairsInFlight.has(key) || Boolean(feed.repairing);
        const feedDetail = escapeHtml(feed.detail);
        return `<button type="button"
          class="pair-timeframe-status is-${feed.tone || (feed.available ? 'available' : 'unavailable')}${loading ? ' is-loading' : ''}"
          data-repair-symbol="${s.symbol}" data-repair-timeframe="${timeframe}"
          aria-label="${s.symbol} ${timeframe}: ${feed.label}. ${feedDetail}"
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

            <div class="pair-performance-row" aria-label="${s.symbol} performance summary">
              <div class="pair-performance-stat" title="Win rate from ${perf.count} verified closed trade${perf.count === 1 ? '' : 's'}">
                <span>Win %</span>
                <strong>${perf.winRate == null ? '—' : `${perf.winRate}%`}</strong>
              </div>
              <div class="pair-performance-stat" title="Highest verified win-rate session for ${s.symbol}">
                <span>Best Session</span>
                <strong>${bestSessionLabel}</strong>
              </div>
              <div class="pair-performance-stat" title="Broker profit from ${perf.dailyCount} verified trade${perf.dailyCount === 1 ? '' : 's'} closed today">
                <span>Daily P/L</span>
                <strong style="color:${dailyPlColor}">${dailyPlLabel}</strong>
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
            </div>

            <div class="pair-feed-section">
              <div class="pair-feed-heading">
                <span class="pair-card-section-label">Timeframes</span>
                <span>Tap red to repair</span>
              </div>
              <div class="pair-timeframe-row" aria-label="${s.symbol} candle feed availability">
                ${timeframeButtons}
              </div>
              <div class="pair-feed-legend"><span><i class="is-available"></i>Current</span><span><i class="is-waiting"></i>Awaiting broker</span><span><i class="is-unavailable"></i>Needs attention</span></div>
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
    symbolMappingStatus.textContent = `Last scanned ${formatDateTime(when)}.`;
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
    renderStrategyPage();
    renderNotifications();
    return;
  }
  const { data, error } = await supabase
    .from('trade_history')
    .select(
      'id, symbol, side, volume, profit, net_profit, r_multiple, open_time, close_time, strategy_id, session, htf_regime, near_news_event, news_event_id, outcome, source, profit_verified, entry_context'
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
  renderStrategyPage();
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
  const cutoffs = {
    today: 0,
    '7d': now - 7 * 86400000,
    '30d': now - 30 * 86400000,
    all: 0,
  };
  const filtered = state.signals.filter((signal) => {
    const pairMatches = state.signalFilter.pair === 'all' || signal.symbol === state.signalFilter.pair;
    const generatedAt = new Date(signal.generated_at || 0).getTime();
    const periodMatches = state.signalFilter.period === 'today'
      ? zonedDateKey(signal.generated_at) === zonedDateKey(new Date())
      : generatedAt >= (cutoffs[state.signalFilter.period] ?? cutoffs['30d']);
    return pairMatches && periodMatches;
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
            <div class="strategy-sub">${s.timeframe || '—'} · ${formatDateTime(s.generated_at)}</div>
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

function formatTradeDuration(durationMs) {
  const minutes = Math.max(0, durationMs / 60000);
  if (minutes < 1) return '<1m';
  if (minutes < 60) return `${Math.round(minutes)}m`;
  if (minutes < 1440) return `${(minutes / 60).toFixed(1)}h`;
  return `${(minutes / 1440).toFixed(1)}d`;
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

  const summaryHtml = `
    <div class="stat-summary-row">
      <div class="stat-summary-item"><div class="stat-value">${formatTradeDuration(avgMin * 60000)}</div><div class="stat-label">Avg hold time</div></div>
      <div class="stat-summary-item"><div class="stat-value">${formatTradeDuration(medianMin * 60000)}</div><div class="stat-label">Median hold time</div></div>
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
      const dateLabel = formatDateTime(t.occurred_at);
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
        formatDateTime(ev.event_time)
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
  renderFloatingPl();
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
    input.addEventListener('change', (event) => handleStrategyToggle(event.target, event.target.dataset.strategyCardToggle));
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

function selectedStrategy() {
  return state.strategies.find((strategy) => strategy.id === state.selectedStrategyId) || null;
}

function strategyScopedData(strategyId) {
  const signals = state.signals.filter((signal) => signal.strategy_id === strategyId);
  const signalIds = new Set(signals.map((signal) => signal.id));
  const deliveries = state.signalDeliveries.filter((delivery) => signalIds.has(delivery.signal_id));
  const trades = getVerifiedTradeHistory().filter((trade) => trade.strategy_id === strategyId && trade.close_time);
  const executedSignalIds = new Set(
    deliveries
      .filter((delivery) => ['tapped', 'auto_executed'].includes(delivery.status))
      .map((delivery) => delivery.signal_id)
  );
  const expiredSignalIds = new Set(
    deliveries.filter((delivery) => delivery.status === 'expired').map((delivery) => delivery.signal_id)
  );
  return {
    signals,
    deliveries,
    trades,
    executed: executedSignalIds.size,
    blocked: signals.filter((signal) => signal.policy_decision === 'block').length,
    expired: expiredSignalIds.size,
    executedSignalIds,
  };
}

function dateOrdinal(parts) {
  return Date.UTC(parts.year, parts.month - 1, parts.day);
}

function chartDateLabel(ordinal) {
  return new Intl.DateTimeFormat(undefined, { timeZone: 'UTC', month: 'short', day: 'numeric' }).format(new Date(ordinal));
}

function sessionForUtcHour(hour) {
  if (hour < 7 || hour >= 21) return 'asia';
  if (hour < 12) return 'london';
  if (hour < 16) return 'overlap';
  return 'ny';
}

function sessionForZonedHour(localDateParts, localHour) {
  const targetKey = `${localDateParts.year}-${localDateParts.month}-${localDateParts.day}`;
  const anchor = Date.UTC(localDateParts.year, localDateParts.month - 1, localDateParts.day, 12);
  for (let offset = -36; offset <= 36; offset += 1) {
    const candidate = new Date(anchor + offset * 3600000);
    const parts = zonedDateParts(candidate);
    if (parts && `${parts.year}-${parts.month}-${parts.day}` === targetKey && parts.hour === localHour) {
      return sessionForUtcHour(candidate.getUTCHours());
    }
  }
  return null;
}

function buildSignalChartBuckets(range) {
  const nowParts = zonedDateParts(new Date());
  const todayOrdinal = dateOrdinal(nowParts);
  if (range === 'today') {
    return Array.from({ length: 24 }, (_, hour) => {
      const hourLabel = new Intl.DateTimeFormat(undefined, { timeZone: 'UTC', hour: 'numeric' })
        .format(new Date(Date.UTC(2000, 0, 1, hour)));
      return {
        key: `${nowParts.year}-${nowParts.month}-${nowParts.day}-${hour}`,
        label: hourLabel,
        session: sessionForZonedHour(nowParts, hour),
      };
    });
  }

  if (range === 'year') {
    const todayDay = new Date(todayOrdinal).getUTCDay();
    const currentWeek = todayOrdinal - (todayDay === 0 ? 6 : todayDay - 1) * 86400000;
    return Array.from({ length: 52 }, (_, index) => {
      const startOrdinal = currentWeek - (51 - index) * 7 * 86400000;
      return { startOrdinal, endOrdinal: startOrdinal + 7 * 86400000, label: chartDateLabel(startOrdinal) };
    });
  }

  const dayCount = range === '7d' ? 7 : 30;
  return Array.from({ length: dayCount }, (_, index) => {
    const ordinal = todayOrdinal - (dayCount - 1 - index) * 86400000;
    const date = new Date(ordinal);
    return {
      key: `${date.getUTCFullYear()}-${date.getUTCMonth() + 1}-${date.getUTCDate()}`,
      label: chartDateLabel(ordinal),
    };
  });
}

function buildSignalChartSeries(signals, executedSignalIds, range) {
  const buckets = buildSignalChartBuckets(range);
  const executed = new Array(buckets.length).fill(0);
  const blocked = new Array(buckets.length).fill(0);
  let signalCount = 0;
  signals.forEach((signal) => {
    const index = signalChartBucketIndex(signal, buckets, range);
    if (index < 0) return;
    signalCount += 1;
    if (signal.policy_decision === 'block') blocked[index] += 1;
    else if (executedSignalIds.has(signal.id)) executed[index] += 1;
  });
  return { labels: buckets.map((bucket) => bucket.label), sessions: buckets.map((bucket) => bucket.session || null), executed, blocked, signalCount };
}

function signalChartBucketIndex(signal, buckets, range) {
  const parts = zonedDateParts(signal.generated_at);
  if (!parts) return -1;
  if (range === 'today') {
    return buckets.findIndex((bucket) => bucket.key === `${parts.year}-${parts.month}-${parts.day}-${parts.hour}`);
  }
  if (range === 'year') {
    const ordinal = dateOrdinal(parts);
    return buckets.findIndex((bucket) => ordinal >= bucket.startOrdinal && ordinal < bucket.endOrdinal);
  }
  return buckets.findIndex((bucket) => bucket.key === `${parts.year}-${parts.month}-${parts.day}`);
}

function signalsInChartRange(signals, range) {
  const buckets = buildSignalChartBuckets(range);
  return signals.filter((signal) => signalChartBucketIndex(signal, buckets, range) >= 0);
}

function summarizeSignalsForRange(signals, deliveries, range) {
  const filteredSignals = signalsInChartRange(signals, range);
  const signalIds = new Set(filteredSignals.map((signal) => signal.id));
  const executedIds = new Set(deliveries
    .filter((delivery) => signalIds.has(delivery.signal_id) && ['tapped', 'auto_executed'].includes(delivery.status))
    .map((delivery) => delivery.signal_id));
  const expiredIds = new Set(deliveries
    .filter((delivery) => signalIds.has(delivery.signal_id) && delivery.status === 'expired')
    .map((delivery) => delivery.signal_id));
  return {
    total: filteredSignals.length,
    executed: executedIds.size,
    blocked: filteredSignals.filter((signal) => signal.policy_decision === 'block').length,
    expired: expiredIds.size,
  };
}

function sessionBandsPlugin(sessions, enabled) {
  const colors = {
    asia: 'rgba(74, 115, 148, 0.10)',
    london: 'rgba(215, 230, 78, 0.075)',
    overlap: 'rgba(195, 88, 63, 0.075)',
    ny: 'rgba(76, 138, 94, 0.085)',
  };
  return {
    id: `session-bands-${Math.random().toString(36).slice(2)}`,
    beforeDatasetsDraw(chart) {
      if (!enabled || !sessions?.length || !chart.chartArea) return;
      const { ctx, chartArea } = chart;
      const width = chartArea.width / sessions.length;
      const groups = [];
      sessions.forEach((session, index) => {
        const previous = groups[groups.length - 1];
        if (previous?.session === session) previous.end = index + 1;
        else groups.push({ session, start: index, end: index + 1 });
      });
      ctx.save();
      groups.filter((group) => group.session).forEach((group) => {
        const left = chartArea.left + group.start * width;
        const bandWidth = (group.end - group.start) * width;
        ctx.fillStyle = colors[group.session] || 'rgba(255,255,255,0.04)';
        ctx.fillRect(left, chartArea.top, bandWidth, chartArea.height);
        ctx.fillStyle = cssVar('--color-text-faint') || '#99a496';
        ctx.font = '600 9px Inter, sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'top';
        ctx.fillText(SESSION_LABELS[group.session] || group.session, left + bandWidth / 2, chartArea.top + 5);
      });
      ctx.restore();
    },
  };
}

function signalChartOptions(series, textFaint) {
  return {
    responsive: true,
    maintainAspectRatio: false,
    interaction: { intersect: false },
    plugins: { legend: { display: false }, tooltip: { enabled: true } },
    scales: {
      x: {
        display: true,
        ticks: { color: textFaint, font: { size: 10 }, maxRotation: 0, autoSkip: true, maxTicksLimit: series.labels.length <= 7 ? 7 : 9 },
        grid: { display: false },
        border: { display: false },
      },
      y: {
        position: 'right',
        beginAtZero: true,
        suggestedMax: Math.max(...series.executed, ...series.blocked, 0) === 0 ? 10 : undefined,
        ticks: { color: textFaint, font: { size: 11 }, precision: 0 },
        grid: { display: false },
        border: { display: false },
      },
    },
  };
}

function renderStrategyVolumeChart(scoped) {
  const canvas = document.getElementById('strategyVolumeChart');
  if (!canvas || typeof Chart === 'undefined') return;
  if (strategyVolumeChartInstance) strategyVolumeChartInstance.destroy();

  const series = buildSignalChartSeries(scoped.signals, scoped.executedSignalIds, state.strategyChartRange);
  const emptyOverlay = document.getElementById('strategy-page-chart-empty');
  if (emptyOverlay) emptyOverlay.style.display = series.signalCount === 0 ? 'flex' : 'none';

  const accent = cssVar('--color-accent') || '#d7e64e';
  const textFaint = cssVar('--color-text-faint') || '#99a496';
  const surfaceSunken = cssVar('--color-surface-sunken') || '#eef1e9';
  const ctx = canvas.getContext('2d');
  const gradient = ctx.createLinearGradient(0, 0, 0, 220);
  gradient.addColorStop(0, hexToRgba(accent, 0.35));
  gradient.addColorStop(1, hexToRgba(accent, 0.02));

  strategyVolumeChartInstance = new Chart(ctx, {
    plugins: [sessionBandsPlugin(series.sessions, state.strategySessionBands && state.strategyChartRange === 'today')],
    data: {
      labels: series.labels,
      datasets: [
        { type: 'bar', label: 'Blocked', data: series.blocked, backgroundColor: surfaceSunken, borderRadius: 3, barPercentage: 0.55, categoryPercentage: 0.9, order: 2 },
        { type: 'line', label: 'Executed', data: series.executed, borderColor: accent, borderWidth: 2.5, pointRadius: 0, tension: 0.45, fill: true, backgroundColor: gradient, order: 1 },
      ],
    },
    options: signalChartOptions(series, textFaint),
  });
}

function renderStrategyPlChart(trades) {
  const canvas = document.getElementById('strategyPlChart');
  if (!canvas || typeof Chart === 'undefined') return;
  if (strategyPlChartInstance) strategyPlChartInstance.destroy();
  const positive = cssVar('--color-positive') || '#4c8a5e';
  const negative = cssVar('--color-negative') || '#c3583f';
  const textFaint = cssVar('--color-text-faint') || '#99a496';
  const byDate = new Map();
  trades.slice().sort((a, b) => new Date(a.close_time) - new Date(b.close_time)).forEach((trade) => {
    const label = formatDate(trade.close_time, { month: 'short', day: 'numeric' });
    byDate.set(label, (byDate.get(label) || 0) + Number(trade.profit ?? 0));
  });
  let running = 0;
  const values = [...byDate.values()].map((value) => (running += value));
  const labels = byDate.size ? [...byDate.keys()] : ['No closed trades'];
  const data = byDate.size ? values : [0];
  const color = byDate.size ? (running >= 0 ? positive : negative) : textFaint;
  strategyPlChartInstance = new Chart(canvas.getContext('2d'), {
    type: 'line',
    data: { labels, datasets: [{ label: 'Broker P/L', data, borderColor: color, backgroundColor: hexToRgba(color, 0.14), fill: true, tension: 0.3, pointRadius: 0, pointHoverRadius: 4, borderWidth: 2 }] },
    options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false } }, scales: { x: { display: false }, y: { display: false } } },
  });
}

function renderStrategyNewsPolicy(strategy) {
  const container = document.getElementById('strategy-page-news-policy');
  if (!container || !strategy) return;
  const posture = strategy.news_posture || 'avoid';
  const isExploit = posture === 'exploit';
  container.innerHTML = `
    <div class="news-policy-panel strategy-page-news-card">
      <div class="news-policy-head">
        <span class="news-policy-title">${escapeHtml(strategy.name)}</span>
        <span class="tag-badge ${NEWS_POSTURE_TAG_CLASS[posture] || 'tag-neutral'}">${NEWS_POSTURE_LABEL[posture] || posture}</span>
      </div>
      <div class="news-policy-fields">
        <label class="news-policy-field"><span>Policy</span><select data-strategy-page-news-field="news_posture"><option value="avoid" ${posture === 'avoid' ? 'selected' : ''}>Avoid</option><option value="neutral" ${posture === 'neutral' ? 'selected' : ''}>Neutral</option><option value="exploit" ${posture === 'exploit' ? 'selected' : ''}>Exploit</option></select></label>
        <label class="news-policy-field"><span>Min impact</span><select data-strategy-page-news-field="news_min_impact"><option value="low" ${strategy.news_min_impact === 'low' ? 'selected' : ''}>Low</option><option value="medium" ${strategy.news_min_impact === 'medium' || !strategy.news_min_impact ? 'selected' : ''}>Medium</option><option value="high" ${strategy.news_min_impact === 'high' ? 'selected' : ''}>High</option></select></label>
        <label class="news-policy-field"><span>Window (min)</span><input type="number" min="1" max="240" step="1" value="${strategy.news_window_minutes ?? 30}" data-strategy-page-news-field="news_window_minutes" /></label>
        <label class="news-policy-field ${isExploit ? '' : 'is-disabled'}"><span>Exploit size ×</span><input type="number" min="0.1" max="3" step="0.1" value="${strategy.news_exploit_size_multiplier ?? 1.5}" data-strategy-page-news-field="news_exploit_size_multiplier" ${isExploit ? '' : 'disabled'} /></label>
      </div>
      <p class="news-policy-hint">${NEWS_POSTURE_HINTS[posture] || ''}</p>
    </div>`;

  container.querySelectorAll('[data-strategy-page-news-field]').forEach((control) => {
    control.addEventListener('change', async (event) => {
      const field = event.target.dataset.strategyPageNewsField;
      let value = event.target.value;
      if (field === 'news_window_minutes') value = Math.max(1, Math.min(240, parseInt(value, 10) || 30));
      if (field === 'news_exploit_size_multiplier') value = Math.max(0.1, Math.min(3, parseFloat(value) || 1.5));
      event.target.disabled = true;
      const { error } = await supabase.from('strategies').update({ [field]: value }).eq('id', strategy.id);
      if (error) {
        console.error('update strategy page news policy error', error);
        alert(`Couldn't save that change: ${error.message}`);
        await loadStrategies();
        return;
      }
      strategy[field] = value;
      renderStrategyPage();
      renderStrategyStatusTab();
    });
  });
}

function renderStrategyPage() {
  if (!viewStrategies || !strategyPageSelect) return;
  const empty = document.getElementById('strategy-page-empty');
  const content = document.getElementById('strategy-page-content');
  if (state.strategies.length === 0) {
    state.selectedStrategyId = null;
    strategyPageSelect.innerHTML = '<option>No strategies</option>';
    strategyPageSelect.disabled = true;
    strategyPageEdit.disabled = true;
    empty.hidden = false;
    content.hidden = true;
    return;
  }

  if (!state.strategies.some((strategy) => strategy.id === state.selectedStrategyId)) {
    state.selectedStrategyId = state.strategies.find((strategy) => strategy.enabled)?.id || state.strategies[0].id;
  }
  const strategy = selectedStrategy();
  const scoped = strategyScopedData(strategy.id);
  const signalSummary = summarizeSignalsForRange(scoped.signals, scoped.deliveries, state.strategyChartRange);
  strategyPageSelect.disabled = false;
  strategyPageEdit.disabled = false;
  strategyPageSelect.innerHTML = state.strategies.map((item) =>
    `<option value="${item.id}" ${item.id === strategy.id ? 'selected' : ''}>${escapeHtml(item.name)}${item.enabled ? '' : ' (disabled)'}</option>`
  ).join('');
  empty.hidden = true;
  content.hidden = false;

  document.getElementById('strategy-page-signal-description').textContent = `${strategy.name} · ${strategy.timeframe || 'M5'} · ${(strategy.symbols || []).length} pair${(strategy.symbols || []).length === 1 ? '' : 's'}`;
  document.getElementById('strategy-page-signal-total').textContent = signalSummary.total.toLocaleString();
  document.getElementById('strategy-page-executed').textContent = signalSummary.executed.toLocaleString();
  document.getElementById('strategy-page-blocked').textContent = signalSummary.blocked.toLocaleString();
  document.getElementById('strategy-page-expired').textContent = signalSummary.expired.toLocaleString();
  if (strategyChartRange) strategyChartRange.value = state.strategyChartRange;
  if (strategySessionBands) strategySessionBands.checked = state.strategySessionBands;

  const brokerPl = scoped.trades.reduce((sum, trade) => sum + Number(trade.profit ?? 0), 0);
  const netPl = scoped.trades.reduce((sum, trade) => sum + Number(trade.net_profit ?? trade.profit ?? 0), 0);
  const costs = netPl - brokerPl;
  const plTotal = document.getElementById('strategy-page-pl-total');
  plTotal.textContent = scoped.trades.length ? `${brokerPl >= 0 ? '+' : '−'}$${Math.abs(brokerPl).toFixed(2)}` : '—';
  plTotal.style.color = scoped.trades.length ? (brokerPl >= 0 ? 'var(--color-positive)' : 'var(--color-negative)') : '';
  document.getElementById('strategy-page-pl-detail').textContent = scoped.trades.length
    ? `Broker P/L · Net after costs ${netPl >= 0 ? '+' : '−'}$${Math.abs(netPl).toFixed(2)} · Costs ${costs >= 0 ? '+' : '−'}$${Math.abs(costs).toFixed(2)}`
    : 'No verified closed trades yet';

  const pairStats = new Map();
  const sessionStats = new Map();
  scoped.trades.forEach((trade) => {
    const symbol = canonicalSymbolForTrade(trade) || 'Unknown';
    const pair = pairStats.get(symbol) || { count: 0, wins: 0, net: 0 };
    pair.count += 1;
    if (isWinningTrade(trade)) pair.wins += 1;
    pair.net += Number(trade.net_profit ?? trade.profit ?? 0);
    pairStats.set(symbol, pair);
    const session = tradeSessionKey(trade);
    if (session) {
      const stats = sessionStats.get(session) || { count: 0, wins: 0 };
      stats.count += 1;
      if (isWinningTrade(trade)) stats.wins += 1;
      sessionStats.set(session, stats);
    }
  });
  const topPair = [...pairStats.entries()].sort((a, b) => b[1].net - a[1].net || b[1].count - a[1].count)[0];
  const bestSession = [...sessionStats.entries()].sort((a, b) => (b[1].wins / b[1].count) - (a[1].wins / a[1].count) || b[1].count - a[1].count)[0];
  const wins = scoped.trades.filter(isWinningTrade).length;
  const winRate = scoped.trades.length ? Math.round((wins / scoped.trades.length) * 100) : null;
  const tradesWithR = scoped.trades.filter((trade) => trade.r_multiple != null && Number.isFinite(Number(trade.r_multiple)));
  const averageR = tradesWithR.length ? tradesWithR.reduce((sum, trade) => sum + Number(trade.r_multiple), 0) / tradesWithR.length : null;
  const tradesWithDuration = scoped.trades.filter((trade) => {
    const opened = trade.open_time ? new Date(trade.open_time).getTime() : NaN;
    const closed = trade.close_time ? new Date(trade.close_time).getTime() : NaN;
    return Number.isFinite(opened) && Number.isFinite(closed) && closed >= opened;
  });
  const averageDurationMs = tradesWithDuration.length
    ? tradesWithDuration.reduce((sum, trade) => sum + (new Date(trade.close_time).getTime() - new Date(trade.open_time).getTime()), 0) / tradesWithDuration.length
    : null;
  const blockedPct = scoped.signals.length ? Math.round((scoped.blocked / scoped.signals.length) * 100) : 0;

  document.getElementById('strategy-page-top-pair').textContent = topPair?.[0] || '—';
  document.getElementById('strategy-page-top-pair-detail').textContent = topPair ? `${topPair[1].net >= 0 ? '+' : '−'}$${Math.abs(topPair[1].net).toFixed(2)} net · ${topPair[1].count} trades` : 'No closed trades';
  document.getElementById('strategy-page-best-session').textContent = bestSession ? SESSION_LABELS[bestSession[0]] || bestSession[0] : '—';
  document.getElementById('strategy-page-best-session-detail').textContent = bestSession ? `${Math.round((bestSession[1].wins / bestSession[1].count) * 100)}% win · ${bestSession[1].count} trades` : 'No session data';
  document.getElementById('strategy-page-blocked-total').textContent = scoped.blocked.toLocaleString();
  document.getElementById('strategy-page-blocked-detail').textContent = `${blockedPct}% of ${scoped.signals.length.toLocaleString()} signals`;
  document.getElementById('strategy-page-win-rate').textContent = winRate == null ? '—' : `${winRate}%`;
  document.getElementById('strategy-page-win-detail').textContent = scoped.trades.length ? `${wins} wins · ${scoped.trades.length} trades` : 'No closed trades';
  document.getElementById('strategy-page-average-r').textContent = averageR == null ? '—' : `${averageR.toFixed(2)}R`;
  document.getElementById('strategy-page-average-r-detail').textContent = tradesWithR.length ? `${tradesWithR.length} risk-defined trades` : 'No risk-defined outcomes';
  document.getElementById('strategy-page-average-duration').textContent = averageDurationMs == null ? '—' : formatTradeDuration(averageDurationMs);
  document.getElementById('strategy-page-average-duration-detail').textContent = tradesWithDuration.length ? `${tradesWithDuration.length} completed trades` : 'No closed trades';

  const blockedSignals = scoped.signals
    .filter((signal) => signal.policy_decision === 'block')
    .sort((left, right) => new Date(right.generated_at) - new Date(left.generated_at));
  const blockedList = document.getElementById('strategy-page-blocked-list');
  document.getElementById('strategy-page-blocked-list-count').textContent =
    `${blockedSignals.length.toLocaleString()} blocked`;
  blockedList.innerHTML = blockedSignals.length
    ? blockedSignals.map((signal) => {
        const side = signal.side === 'sell' ? 'sell' : 'buy';
        const fallbackReason = signal.near_news_event
          ? 'Directional news policy'
          : 'Adaptive policy or risk guardrail';
        return `<div class="strategy-blocked-row">
          <strong>${escapeHtml(signal.symbol)}</strong>
          <span class="side-badge side-${side}">${side.toUpperCase()}</span>
          <time datetime="${escapeHtml(signal.generated_at)}">${formatDateTime(signal.generated_at)}</time>
          <span class="strategy-blocked-reason">${escapeHtml(signal.block_reason || fallbackReason)}</span>
        </div>`;
      }).join('')
    : '<p class="empty-state-text">No blocked signals for this strategy.</p>';

  renderStrategyVolumeChart(scoped);
  renderStrategyPlChart(scoped.trades);
  renderStrategyNewsPolicy(strategy);
}

strategyPageSelect?.addEventListener('change', (event) => {
  state.selectedStrategyId = event.target.value;
  renderStrategyPage();
});
signalChartRange?.addEventListener('change', (event) => {
  state.signalChartRange = event.target.value;
  if (state.signalChartRange !== 'today') {
    state.signalSessionBands = false;
    if (signalSessionBands) signalSessionBands.checked = false;
  }
  renderSignalSummary();
  renderVolumeChart();
});
strategyChartRange?.addEventListener('change', (event) => {
  state.strategyChartRange = event.target.value;
  if (state.strategyChartRange !== 'today') {
    state.strategySessionBands = false;
    if (strategySessionBands) strategySessionBands.checked = false;
  }
  renderStrategyPage();
});
signalSessionBands?.addEventListener('change', (event) => {
  state.signalSessionBands = event.target.checked;
  if (state.signalSessionBands) {
    state.signalChartRange = 'today';
    if (signalChartRange) signalChartRange.value = 'today';
  }
  renderSignalSummary();
  renderVolumeChart();
});
strategySessionBands?.addEventListener('change', (event) => {
  state.strategySessionBands = event.target.checked;
  if (state.strategySessionBands) {
    state.strategyChartRange = 'today';
    if (strategyChartRange) strategyChartRange.value = 'today';
  }
  renderStrategyPage();
});
strategyPageEdit?.addEventListener('click', () => {
  if (state.selectedStrategyId) openEditStrategyModal(state.selectedStrategyId);
});
document.getElementById('strategy-page-add')?.addEventListener('click', () => {
  openAddStrategyModal();
});

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

  const executedSignalIds = new Set(
    state.signalDeliveries
      .filter((delivery) => ['tapped', 'auto_executed'].includes(delivery.status))
      .map((delivery) => delivery.signal_id)
  );
  const series = buildSignalChartSeries(state.signals, executedSignalIds, state.signalChartRange);
  if (chartEmptyOverlay) chartEmptyOverlay.style.display = series.signalCount === 0 ? 'flex' : 'none';

  const ctx = canvas.getContext('2d');
  const gradient = ctx.createLinearGradient(0, 0, 0, 220);
  gradient.addColorStop(0, hexToRgba(accent, 0.35));
  gradient.addColorStop(1, hexToRgba(accent, 0.02));

  volumeChartInstance = new Chart(ctx, {
    plugins: [sessionBandsPlugin(series.sessions, state.signalSessionBands && state.signalChartRange === 'today')],
    data: {
      labels: series.labels,
      datasets: [
        {
          type: 'bar',
          label: 'Blocked',
          data: series.blocked,
          backgroundColor: surfaceSunken,
          borderRadius: 3,
          barPercentage: 0.55,
          categoryPercentage: 0.9,
          order: 2,
        },
        {
          type: 'line',
          label: 'Executed',
          data: series.executed,
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
    options: signalChartOptions(series, textFaint),
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
    const key = formatDate(t.close_time, { month: 'short', day: 'numeric' });
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
  if (state.activeView === 'strategies') renderStrategyPage();
});

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
async function bootDashboard() {
  await loadProfile();
  await Promise.all([loadTerminals(), loadCalendarEvents()]);
  await loadPushNotificationSettings();
  const launch = new URLSearchParams(window.location.search);
  const launchView = launch.get('view');
  const launchTab = launch.get('tab');
  if (['dashboard', 'strategies', 'pairs'].includes(launchView)) setActiveView(launchView);
  if (launchView === 'dashboard' && launchTab) setActiveTab(launchTab);
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
  state.activeView = 'dashboard';
  state.selectedStrategyId = null;
  state.signalChartRange = '30d';
  state.strategyChartRange = '30d';
  state.signalSessionBands = false;
  state.strategySessionBands = false;
  state.agentPolicies = [];
  state.positions = [];
  streamedAccountState = null;
  streamedPositionFields = new Map();
  state.symbolSettings = [];
  state.symbolMappings = [];
  state.trendStates = [];
  state.calendarEvents = [];
  state.scenarioStats = [];
  state.signalFilter = { pair: 'all', period: '30d' };
  if (signalsPeriodFilter) signalsPeriodFilter.value = '30d';
  if (signalChartRange) signalChartRange.value = '30d';
  if (strategyChartRange) strategyChartRange.value = '30d';
  if (signalSessionBands) signalSessionBands.checked = false;
  if (strategySessionBands) strategySessionBands.checked = false;
  if (notificationPanel) notificationPanel.hidden = true;
  renderNotifications();
  setActiveView('dashboard');
  setActiveTab('overview');
  stopPositionPolling();
  stopRealtime();
  stopSymbolRescanPoll();
  pushSubscription = null;
  renderPushControls();
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
