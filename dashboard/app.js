(function () {
  // ---- Theme toggle (no localStorage — sandboxed iframes block it) ----
  const toggle = document.querySelector('[data-theme-toggle]');
  const root = document.documentElement;
  let theme = matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  root.setAttribute('data-theme', theme);

  const sunIcon =
    '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="5"/><path d="M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42"/></svg>';
  const moonIcon =
    '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>';

  function applyToggleIcon() {
    toggle.innerHTML = theme === 'dark' ? sunIcon : moonIcon;
    toggle.setAttribute('aria-label', theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode');
  }
  applyToggleIcon();

  toggle?.addEventListener('click', () => {
    theme = theme === 'dark' ? 'light' : 'dark';
    root.setAttribute('data-theme', theme);
    applyToggleIcon();
    // Let main.js know it should re-render charts with the new CSS colors.
    window.dispatchEvent(new CustomEvent('lucre:theme-changed'));
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

  // ---- Mobile nav menu toggle ----
  const navMenuToggle = document.getElementById('nav-menu-toggle');
  const navPills = document.getElementById('nav-pills');

  function closeNavMenu() {
    navMenuToggle?.setAttribute('aria-expanded', 'false');
    navPills?.classList.remove('is-open');
  }

  function openNavMenu() {
    navMenuToggle?.setAttribute('aria-expanded', 'true');
    navPills?.classList.add('is-open');
  }

  navMenuToggle?.addEventListener('click', (e) => {
    e.stopPropagation();
    const isOpen = navMenuToggle.getAttribute('aria-expanded') === 'true';
    if (isOpen) {
      closeNavMenu();
    } else {
      openNavMenu();
      navPills?.querySelector('.nav-pill')?.focus();
    }
  });

  navPills?.addEventListener('click', (e) => {
    e.stopPropagation();
    if (e.target.closest('.nav-pill')) {
      closeNavMenu();
      navMenuToggle?.focus();
    }
  });

  document.addEventListener('click', () => closeNavMenu());

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && navMenuToggle?.getAttribute('aria-expanded') === 'true') {
      closeNavMenu();
      navMenuToggle.focus();
    }
  });

  window.addEventListener('resize', () => {
    if (window.innerWidth > 640) closeNavMenu();
  });

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
