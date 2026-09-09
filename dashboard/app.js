(function () {
  // ---- Appearance. The head bootstrap already applied these attributes
  // before first paint; app.js owns subsequent interaction and persistence. ----
  const themeInputs = [...document.querySelectorAll('input[name="dashboard_theme"]')];
  const root = document.documentElement;
  let theme = root.dataset.theme === 'dark' ? 'dark' : 'light';
  let palette = root.dataset.palette || 'lucre';
  root.setAttribute('data-theme', theme);

  function remember(key, value) {
    try { localStorage.setItem(key, value); } catch (_) { /* Embedded previews may block storage. */ }
  }

  function updateBrowserThemeColor() {
    const color = getComputedStyle(root).getPropertyValue('--color-page-bg').trim();
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', color || '#17251a');
  }

  function syncThemeInputs() {
    themeInputs.forEach((input) => { input.checked = input.value === theme; });
  }
  syncThemeInputs();
  updateBrowserThemeColor();

  function applyTheme(nextTheme, { notify = true } = {}) {
    theme = nextTheme === 'dark' ? 'dark' : 'light';
    root.setAttribute('data-theme', theme);
    remember('lucre:theme', theme);
    syncThemeInputs();
    updateBrowserThemeColor();
    if (notify) window.dispatchEvent(new CustomEvent('lucre:theme-changed', { detail: { theme, palette } }));
  }

  function applyPalette(nextPalette, { notify = true } = {}) {
    palette = ['lucre', 'soleau-gold', 'seaside'].includes(nextPalette) ? nextPalette : 'lucre';
    root.setAttribute('data-palette', palette);
    remember('lucre:palette', palette);
    updateBrowserThemeColor();
    if (notify) window.dispatchEvent(new CustomEvent('lucre:theme-changed', { detail: { theme, palette } }));
  }

  window.LucreTheme = {
    applyPalette,
    applyTheme,
    currentPalette: () => palette,
    currentTheme: () => theme,
  };

  themeInputs.forEach((input) => input.addEventListener('change', () => {
    if (input.checked) applyTheme(input.value);
  }));

  // ---- Modal open/close (generic — works for any [data-modal] target) ----
  const modalFocusReturn = new WeakMap();
  let activeModal = null;

  function setModalIsolation(modal) {
    activeModal = modal;
    document.body.classList.toggle('has-open-modal', Boolean(modal));
    [...document.body.children].forEach((child) => {
      if (child.tagName === 'SCRIPT') return;
      if (modal && child !== modal) child.setAttribute('inert', '');
      else child.removeAttribute('inert');
    });
    document.querySelectorAll('.modal-overlay').forEach((overlay) => {
      if (modal && overlay !== modal) overlay.setAttribute('inert', '');
      else overlay.removeAttribute('inert');
    });
    if (modal) modal.removeAttribute('inert');
  }

  function openModal(id) {
    const el = document.getElementById(id);
    if (!el) return;
    modalFocusReturn.set(el, document.activeElement);
    el.setAttribute('aria-hidden', 'false');
    el.classList.add('is-open');
    setModalIsolation(el);
  }
  function closeModal(el) {
    if (!el) return;
    el.setAttribute('aria-hidden', 'true');
    el.classList.remove('is-open');
    const nextOpen = [...document.querySelectorAll('.modal-overlay.is-open')].pop() || null;
    setModalIsolation(nextOpen);
    const returnTarget = modalFocusReturn.get(el);
    const nextTarget = returnTarget instanceof HTMLElement && (!nextOpen || nextOpen.contains(returnTarget))
      ? returnTarget
      : nextOpen?.querySelector('input:not([disabled]), textarea:not([disabled]), select:not([disabled]), button:not([disabled]), [tabindex]:not([tabindex="-1"])');
    if (nextTarget instanceof HTMLElement) window.requestAnimationFrame(() => nextTarget.focus({ preventScroll: true }));
  }
  window.LucreUI = { openModal, closeModal };

  document.querySelectorAll('.modal-overlay').forEach((overlay) => {
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) closeModal(overlay);
    });
    overlay.querySelectorAll('[data-modal-close]').forEach((btn) => {
      btn.addEventListener('click', () => closeModal(overlay));
    });
  });

  document.addEventListener('focusin', (event) => {
    if (!activeModal || activeModal.contains(event.target)) return;
    const fallback = activeModal.querySelector('input:not([disabled]), textarea:not([disabled]), select:not([disabled]), button:not([disabled]), [tabindex]:not([tabindex="-1"])');
    fallback?.focus({ preventScroll: true });
  });

  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Tab' || !activeModal) return;
    const focusable = [...activeModal.querySelectorAll('input:not([disabled]), textarea:not([disabled]), select:not([disabled]), button:not([disabled]), [href], [tabindex]:not([tabindex="-1"])')]
      .filter((element) => element.getClientRects().length > 0);
    if (!focusable.length) return;
    const first = focusable[0], last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  });

  // ---- Account menu toggle ----
  const accountBtn = document.getElementById('account-menu-button');
  const accountMenu = document.getElementById('account-menu');
  accountBtn?.addEventListener('click', (e) => {
    e.stopPropagation();
    const isOpen = accountMenu.getAttribute('aria-hidden') === 'false';
    accountMenu.setAttribute('aria-hidden', isOpen ? 'true' : 'false');
  });
  document.addEventListener('click', () => {
    accountMenu?.setAttribute('aria-hidden', 'true');
  });
  accountMenu?.addEventListener('click', (e) => e.stopPropagation());

  // ---- Auth tab switcher (Sign in / Create account) ----
  const authTabs = document.querySelectorAll('[data-auth-tab]');
  authTabs.forEach((tab) => {
    tab.addEventListener('click', () => {
      authTabs.forEach((t) => t.classList.remove('active'));
      tab.classList.add('active');
      window.dispatchEvent(new CustomEvent('lucre:auth-tab-changed', { detail: tab.dataset.authTab }));
    });
  });
})();
