(function () {
  // ---- Theme toggle. The head bootstrap already applied these attributes
  // before first paint; app.js owns subsequent interaction and persistence. ----
  const toggle = document.querySelector('[data-theme-toggle]');
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

  const sunIcon =
    '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="5"/><path d="M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42"/></svg>';
  const moonIcon =
    '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>';

  function applyToggleIcon() {
    toggle.innerHTML = theme === 'dark' ? sunIcon : moonIcon;
    toggle.setAttribute('aria-label', theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode');
  }
  applyToggleIcon();
  updateBrowserThemeColor();

  function applyPalette(nextPalette, { notify = true } = {}) {
    palette = nextPalette === 'soleau-gold' ? 'soleau-gold' : 'lucre';
    root.setAttribute('data-palette', palette);
    remember('lucre:palette', palette);
    updateBrowserThemeColor();
    if (notify) window.dispatchEvent(new CustomEvent('lucre:theme-changed', { detail: { theme, palette } }));
  }

  window.LucreTheme = {
    applyPalette,
    currentPalette: () => palette,
  };

  toggle?.addEventListener('click', () => {
    theme = theme === 'dark' ? 'light' : 'dark';
    root.setAttribute('data-theme', theme);
    remember('lucre:theme', theme);
    applyToggleIcon();
    updateBrowserThemeColor();
    // Let main.js know it should re-render charts with the new CSS colors.
    window.dispatchEvent(new CustomEvent('lucre:theme-changed', { detail: { theme, palette } }));
  });

  // ---- Modal open/close (generic — works for any [data-modal] target) ----
  function openModal(id) {
    const el = document.getElementById(id);
    if (!el) return;
    el.setAttribute('aria-hidden', 'false');
    el.classList.add('is-open');
  }
  function closeModal(el) {
    el.setAttribute('aria-hidden', 'true');
    el.classList.remove('is-open');
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
