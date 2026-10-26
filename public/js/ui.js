const numFmt = new Intl.NumberFormat('en-US');

export function formatNum(n) {
  return numFmt.format(Number(n) || 0);
}

export class UIController {
  constructor({ onThemeChange, onLogout, onJumpTo }) {
    this.onThemeChange = onThemeChange;
    this.onLogout = onLogout;
    this.onJumpTo = onJumpTo;

    this.checkedCountEl = document.getElementById('checkedCount');
    this.onlineCountEl = document.getElementById('onlineCount');
    this.statusDotEl = document.getElementById('statusDot');
    this.instanceBadgeEl = document.getElementById('instanceBadge');
    this.rangeReadoutEl = document.getElementById('rangeReadout');
    this.cellReadoutEl = document.getElementById('cellReadout');
    this.statusCtaEl = document.getElementById('statusCta');
    this.authSlotEl = document.getElementById('authSlot');
    this.toastRegionEl = document.getElementById('toastRegion');
    this.a11yAnnouncerEl = document.getElementById('a11yAnnouncer');
    this.zoomReadoutEl = document.getElementById('zoomResetBtn');

    this.devDialog = document.getElementById('devLoginDialog');
    this.devForm = document.getElementById('devLoginForm');
    this.devNameInput = document.getElementById('devNameInput');
    this.devOidcWrap = document.getElementById('devOidcWrap');

    this.toastTimer = null;
    this.cooldownTimer = null;
    this.cooldownUntilMs = 0;
    this.authState = {
      authenticated: false,
      user: null,
      oidcEnabled: false,
      devLoginEnabled: false,
    };

    this.initTheme();
    this.bindControls();
  }

  initTheme() {
    const saved = localStorage.getItem('omc_theme');
    if (saved === 'light' || saved === 'dark') {
      document.documentElement.setAttribute('data-theme', saved);
    }
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    mq.addEventListener('change', () => this.onThemeChange?.());
  }

  bindControls() {
    const themeBtn = document.getElementById('themeToggleBtn');
    themeBtn?.addEventListener('click', () => {
      const currentAttr = document.documentElement.getAttribute('data-theme');
      const systemDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
      const isDark = currentAttr ? currentAttr === 'dark' : systemDark;
      const next = isDark ? 'light' : 'dark';
      document.documentElement.setAttribute('data-theme', next);
      localStorage.setItem('omc_theme', next);
      this.onThemeChange?.();
    });

    const gotoForm = document.getElementById('gotoForm');
    const gotoInput = document.getElementById('gotoInput');
    gotoForm?.addEventListener('submit', (e) => {
      e.preventDefault();
      const raw = gotoInput.value.trim().replace(/^#/, '');
      if (raw === '') return;
      const idx = Number(raw);
      if (Number.isInteger(idx) && idx >= 0 && idx < 1_000_000) {
        this.onJumpTo?.(idx);
        gotoInput.blur();
      } else {
        this.showToast('Enter a checkbox number between 0 and 999,999.', { alert: true });
      }
    });

    const minimapCard = document.getElementById('minimapCard');
    const minimapToggleBtn = document.getElementById('minimapToggleBtn');
    minimapToggleBtn?.addEventListener('click', () => {
      const collapsed = minimapCard.classList.toggle('collapsed');
      minimapToggleBtn.textContent = collapsed ? '+' : '–';
    });

    const cancelBtn = document.getElementById('devCancelBtn');
    cancelBtn?.addEventListener('click', () => this.devDialog?.close());

    this.devForm?.addEventListener('submit', (e) => {
      e.preventDefault();
      const name = this.devNameInput.value.trim() || 'Engineer';
      const returnTo = `${window.location.pathname}${window.location.hash || ''}`;
      window.location.href = `/auth/dev-login?name=${encodeURIComponent(name)}&returnTo=${encodeURIComponent(returnTo)}`;
    });
  }

  setCheckedCount(count) {
    this.checkedCountEl.textContent = formatNum(count);
  }

  setOnlineCount(count) {
    this.onlineCountEl.textContent = formatNum(Math.max(1, count));
  }

  setInstanceId(instanceId) {
    if (!instanceId) return;
    this.instanceBadgeEl.textContent = instanceId;
    this.instanceBadgeEl.hidden = false;
  }

  setConnectionState(state) {
    this.statusDotEl.classList.remove('reconnecting', 'offline');
    if (state === 'reconnecting') {
      this.statusDotEl.classList.add('reconnecting');
    } else if (state === 'offline') {
      this.statusDotEl.classList.add('offline');
    }
  }

  updateViewportStatus(bounds, cellSize) {
    this.rangeReadoutEl.textContent = `Viewing #${formatNum(bounds.firstIndex)}–#${formatNum(bounds.lastIndex)}`;
    this.zoomReadoutEl.textContent = `${cellSize >= 4 ? Math.round(cellSize) : cellSize}px`;
  }

  updateCellReadout(index) {
    if (index < 0) return;
    const row = Math.floor(index / 1000);
    const col = index % 1000;
    this.cellReadoutEl.textContent = `#${formatNum(index)} (r${row}, c${col})`;
  }

  setAuthState(authState) {
    this.authState = { ...this.authState, ...authState };
    if (authState.instanceId) {
      this.setInstanceId(authState.instanceId);
    }
    this.renderAuthHeader();
    this.renderStatusRight();
  }

  openSignInFlow() {
    const returnTo = `${window.location.pathname}${window.location.hash || ''}`;
    if (this.authState.devLoginEnabled) {
      this.devOidcWrap.hidden = !this.authState.oidcEnabled;
      if (this.devDialog && typeof this.devDialog.showModal === 'function') {
        this.devDialog.showModal();
        this.devNameInput.focus();
        return;
      }
    }
    window.location.href = `/auth/login?returnTo=${encodeURIComponent(returnTo)}`;
  }

  renderAuthHeader() {
    this.authSlotEl.innerHTML = '';
    const { authenticated, user } = this.authState;

    if (!authenticated || !user) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'btn btn-primary';
      btn.textContent = 'Sign in';
      btn.addEventListener('click', () => this.openSignInFlow());
      this.authSlotEl.appendChild(btn);
      return;
    }

    const chip = document.createElement('div');
    chip.className = 'user-chip';

    const avatar = document.createElement('span');
    avatar.className = 'user-avatar';
    if (user.picture) {
      const img = document.createElement('img');
      img.src = user.picture;
      img.alt = '';
      img.referrerPolicy = 'no-referrer';
      avatar.appendChild(img);
    } else {
      avatar.textContent = (user.name || 'U').slice(0, 1).toUpperCase();
    }

    const nameSpan = document.createElement('span');
    nameSpan.className = 'user-name';
    nameSpan.textContent = user.name;

    const logoutBtn = document.createElement('button');
    logoutBtn.type = 'button';
    logoutBtn.className = 'btn btn-subtle btn-sm';
    logoutBtn.textContent = 'Sign out';
    logoutBtn.addEventListener('click', () => this.onLogout?.());

    chip.append(avatar, nameSpan, logoutBtn);
    this.authSlotEl.appendChild(chip);
  }

  renderStatusRight() {
    if (this.cooldownUntilMs > Date.now()) {
      return;
    }

    this.statusCtaEl.innerHTML = '';
    if (!this.authState.authenticated) {
      const note = document.createElement('span');
      note.className = 'status-note';
      note.textContent = "You're viewing live. Sign in to check boxes.";

      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'btn btn-primary btn-sm';
      btn.textContent = 'Sign in';
      btn.addEventListener('click', () => this.openSignInFlow());

      this.statusCtaEl.append(note, btn);
    } else {
      const note = document.createElement('span');
      note.className = 'status-note';
      note.textContent = 'Click any cell or press Space to toggle · Drag to pan';
      this.statusCtaEl.appendChild(note);
    }
  }

  startCooldown(retryAfterMs, reason = 'rate') {
    const until = Date.now() + Math.max(1000, retryAfterMs);
    if (until > this.cooldownUntilMs) {
      this.cooldownUntilMs = until;
    }

    if (this.cooldownTimer) {
      clearInterval(this.cooldownTimer);
    }

    const update = () => {
      const remMs = this.cooldownUntilMs - Date.now();
      if (remMs <= 0) {
        clearInterval(this.cooldownTimer);
        this.cooldownTimer = null;
        this.cooldownUntilMs = 0;
        this.renderStatusRight();
        return;
      }
      const secs = Math.max(1, Math.ceil(remMs / 1000));
      this.statusCtaEl.innerHTML = '';
      const note = document.createElement('span');
      note.className = 'status-note alert';
      note.textContent =
        reason === 'blocked'
          ? `Paused for ${secs}s after too many rapid clicks.`
          : `Slow down — you can check more boxes in ${secs}s.`;
      this.statusCtaEl.appendChild(note);
    };

    update();
    this.cooldownTimer = setInterval(update, 250);
  }

  showToast(message, { alert = false, durationMs = 3500, actionLabel = '', onAction = null } = {}) {
    if (this.toastTimer) {
      clearTimeout(this.toastTimer);
      this.toastTimer = null;
    }

    this.toastRegionEl.innerHTML = '';
    const toast = document.createElement('div');
    toast.className = `toast${alert ? ' toast-alert' : ''}`;

    const text = document.createElement('span');
    text.textContent = message;
    toast.appendChild(text);

    if (actionLabel && typeof onAction === 'function') {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'btn btn-subtle btn-sm';
      btn.textContent = actionLabel;
      btn.addEventListener('click', () => {
        this.toastRegionEl.innerHTML = '';
        onAction();
      });
      toast.appendChild(btn);
    }

    this.toastRegionEl.appendChild(toast);

    if (durationMs > 0) {
      this.toastTimer = setTimeout(() => {
        this.toastRegionEl.innerHTML = '';
      }, durationMs);
    }
  }

  announce(text) {
    if (!this.a11yAnnouncerEl) return;
    this.a11yAnnouncerEl.textContent = '';
    setTimeout(() => {
      this.a11yAnnouncerEl.textContent = text;
    }, 20);
  }
}

