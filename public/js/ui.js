import { DUR, prefersReducedMotion } from './motion.js';

const numFmt = new Intl.NumberFormat('en-US');

export function formatNum(n) {
  return numFmt.format(Number(n) || 0);
}

export class UIController {
  constructor({ budget, onThemeChange, onLogout, onJumpTo, onFindActivity }) {
    this.budget = budget || null;
    this.onThemeChange = onThemeChange;
    this.onLogout = onLogout;
    this.onJumpTo = onJumpTo;
    this.onFindActivity = onFindActivity;

    this.checkedCountEl = document.getElementById('checkedCount');
    this.checkedProgressFillEl = document.getElementById('checkedProgressFill');
    this.onlineCountEl = document.getElementById('onlineCount');
    this.statusDotEl = document.getElementById('statusDot');
    this.instanceBadgeEl = document.getElementById('instanceBadge');
    this.rangeReadoutEl = document.getElementById('rangeReadout');
    this.cellReadoutEl = document.getElementById('cellReadout');
    this.statusCtaEl = document.getElementById('statusCta');
    this.authSlotEl = document.getElementById('authSlot');
    this.mobileAuthSlotEl = document.getElementById('mobileAuthSlot');
    this.toastRegionEl = document.getElementById('toastRegion');
    this.a11yAnnouncerEl = document.getElementById('a11yAnnouncer');

    this.gotoToggleBtnEl = document.getElementById('gotoToggleBtn');
    this.gotoPopoverEl = document.getElementById('gotoPopover');
    this.gotoFormEl = document.getElementById('gotoForm');
    this.gotoInputEl = document.getElementById('gotoInput');
    this.gotoErrorEl = document.getElementById('gotoError');

    this.mobileMenuBtnEl = document.getElementById('mobileMenuBtn');
    this.mobileMenuSheetEl = document.getElementById('mobileMenuSheet');
    this.mobileMenuCloseBtnEl = document.getElementById('mobileMenuCloseBtn');
    this.mobileGotoFormEl = document.getElementById('mobileGotoForm');
    this.mobileGotoInputEl = document.getElementById('mobileGotoInput');
    this.mobileGotoErrorEl = document.getElementById('mobileGotoError');
    this.mobileFindActivityBtnEl = document.getElementById('mobileFindActivityBtn');
    this.mobileThemeBtnEl = document.getElementById('mobileThemeBtn');

    this.findActivityBtnEl = document.getElementById('findActivityBtn');

    this.minimapCardEl = document.getElementById('minimapCard');
    this.minimapPanelEl = document.getElementById('minimapPanel');
    this.minimapToggleBtnEl = document.getElementById('minimapToggleBtn');
    this.minimapExpandBtnEl = document.getElementById('minimapExpandBtn');

    this.firstVisitHintEl = document.getElementById('firstVisitHint');
    this.firstVisitHintTextEl = document.getElementById('firstVisitHintText');
    this.hintCloseBtnEl = document.getElementById('hintCloseBtn');

    this.devDialog = document.getElementById('devLoginDialog');
    this.devForm = document.getElementById('devLoginForm');
    this.devNameInput = document.getElementById('devNameInput');
    this.devOidcWrap = document.getElementById('devOidcWrap');

    this.debugMode = new URLSearchParams(window.location.search).get('debug') === '1';
    this.prevCheckedCount = null;
    this.tickActive = false;

    this.toastTimer = null;
    this.cooldownTimer = null;
    this.cooldownUntilMs = 0;
    this.budgetRaf = 0;
    this.tallyClusterEl = null;
    this.tallyMarks = [];
    this.tallyLabelEl = null;
    this.hintDismissed = false;

    this.authState = {
      authenticated: false,
      user: null,
      oidcEnabled: false,
      devLoginEnabled: false,
    };

    this.initTheme();
    this.initMinimapCollapse();
    this.initFirstVisitHint();
    this.bindControls();
    this.setFindActivityAvailable(false);
  }

  initTheme() {
    try {
      const saved = localStorage.getItem('omc_theme');
      if (saved === 'light' || saved === 'dark') {
        document.documentElement.setAttribute('data-theme', saved);
      }
    } catch {
      // Ignore storage access errors
    }
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    mq.addEventListener('change', () => this.onThemeChange?.());
  }

  toggleTheme() {
    const currentAttr = document.documentElement.getAttribute('data-theme');
    const systemDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
    const isDark = currentAttr ? currentAttr === 'dark' : systemDark;
    const next = isDark ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', next);
    try {
      localStorage.setItem('omc_theme', next);
    } catch {
      // Ignore storage access errors
    }
    this.onThemeChange?.();
  }

  initMinimapCollapse() {
    const isPhone = window.innerWidth <= 640;
    this.setMinimapCollapsed(isPhone);
  }

  setMinimapCollapsed(collapsed) {
    if (!this.minimapCardEl) return;
    this.minimapCardEl.classList.toggle('collapsed', collapsed);
    if (this.minimapPanelEl) {
      this.minimapPanelEl.hidden = collapsed;
    }
    if (this.minimapExpandBtnEl) {
      this.minimapExpandBtnEl.hidden = !collapsed;
    }
  }

  initFirstVisitHint() {
    if (!this.firstVisitHintEl) return;
    let seen = false;
    try {
      seen = localStorage.getItem('omc:hintSeen') === '1';
    } catch {
      seen = false;
    }
    if (seen) {
      this.hintDismissed = true;
      this.firstVisitHintEl.hidden = true;
      return;
    }

    const isTouch = window.matchMedia('(pointer: coarse)').matches;
    if (this.firstVisitHintTextEl) {
      this.firstVisitHintTextEl.textContent = isTouch
        ? 'Drag to move. Pinch to zoom. Tap a box to check it.'
        : 'Drag to move. Ctrl + scroll or pinch to zoom. Click a box to check it.';
    }
    this.firstVisitHintEl.hidden = false;
  }

  dismissHint() {
    if (this.hintDismissed) return;
    this.hintDismissed = true;
    if (this.firstVisitHintEl) {
      this.firstVisitHintEl.hidden = true;
    }
    try {
      localStorage.setItem('omc:hintSeen', '1');
    } catch {
      // Ignore storage access errors
    }
  }

  openGotoPopover() {
    if (!this.gotoPopoverEl) return;
    this.gotoPopoverEl.hidden = false;
    this.gotoToggleBtnEl?.setAttribute('aria-expanded', 'true');
    if (this.gotoErrorEl) this.gotoErrorEl.hidden = true;
    this.gotoInputEl?.focus();
    this.gotoInputEl?.select();
  }

  closeGotoPopover() {
    if (!this.gotoPopoverEl || this.gotoPopoverEl.hidden) return;
    this.gotoPopoverEl.hidden = true;
    this.gotoToggleBtnEl?.setAttribute('aria-expanded', 'false');
    if (this.gotoErrorEl) this.gotoErrorEl.hidden = true;
  }

  toggleGotoPopover() {
    if (!this.gotoPopoverEl) return;
    if (this.gotoPopoverEl.hidden) {
      this.openGotoPopover();
    } else {
      this.closeGotoPopover();
    }
  }

  openMobileMenu() {
    if (!this.mobileMenuSheetEl) return;
    this.mobileMenuSheetEl.hidden = false;
    this.mobileMenuBtnEl?.setAttribute('aria-expanded', 'true');
    if (this.mobileGotoErrorEl) this.mobileGotoErrorEl.hidden = true;
  }

  closeMobileMenu() {
    if (!this.mobileMenuSheetEl || this.mobileMenuSheetEl.hidden) return;
    this.mobileMenuSheetEl.hidden = true;
    this.mobileMenuBtnEl?.setAttribute('aria-expanded', 'false');
    if (this.mobileGotoErrorEl) this.mobileGotoErrorEl.hidden = true;
  }

  closeAllPopovers() {
    this.closeGotoPopover();
    this.closeMobileMenu();
  }

  handleGotoSubmit(inputEl, errorEl, onSuccessClose) {
    const raw = (inputEl?.value || '').trim().replace(/^#/, '').replace(/,/g, '');
    if (raw === '') {
      if (errorEl) errorEl.hidden = false;
      return;
    }
    const idx = Number(raw);
    if (Number.isInteger(idx) && idx >= 0 && idx < 1_000_000) {
      if (errorEl) errorEl.hidden = true;
      onSuccessClose?.();
      this.onJumpTo?.(idx);
    } else if (errorEl) {
      errorEl.textContent = 'Enter a number from 0 to 999,999.';
      errorEl.hidden = false;
    }
  }

  bindControls() {
    const themeBtn = document.getElementById('themeToggleBtn');
    themeBtn?.addEventListener('click', () => this.toggleTheme());
    this.mobileThemeBtnEl?.addEventListener('click', () => {
      this.toggleTheme();
      this.closeMobileMenu();
    });

    this.gotoToggleBtnEl?.addEventListener('click', (e) => {
      e.stopPropagation();
      this.toggleGotoPopover();
    });

    this.gotoInputEl?.addEventListener('input', () => {
      if (this.gotoErrorEl) this.gotoErrorEl.hidden = true;
    });

    this.gotoFormEl?.addEventListener('submit', (e) => {
      e.preventDefault();
      this.handleGotoSubmit(this.gotoInputEl, this.gotoErrorEl, () => {
        this.closeGotoPopover();
      });
    });

    this.mobileMenuBtnEl?.addEventListener('click', (e) => {
      e.stopPropagation();
      if (this.mobileMenuSheetEl?.hidden) {
        this.openMobileMenu();
      } else {
        this.closeMobileMenu();
      }
    });

    this.mobileMenuCloseBtnEl?.addEventListener('click', () => this.closeMobileMenu());

    this.mobileGotoInputEl?.addEventListener('input', () => {
      if (this.mobileGotoErrorEl) this.mobileGotoErrorEl.hidden = true;
    });

    this.mobileGotoFormEl?.addEventListener('submit', (e) => {
      e.preventDefault();
      this.handleGotoSubmit(this.mobileGotoInputEl, this.mobileGotoErrorEl, () => {
        this.closeMobileMenu();
      });
    });

    this.findActivityBtnEl?.addEventListener('click', () => {
      this.onFindActivity?.();
    });

    this.mobileFindActivityBtnEl?.addEventListener('click', () => {
      this.closeMobileMenu();
      this.onFindActivity?.();
    });

    document.addEventListener('pointerdown', (e) => {
      if (
        this.gotoPopoverEl &&
        !this.gotoPopoverEl.hidden &&
        !this.gotoPopoverEl.contains(e.target) &&
        !this.gotoToggleBtnEl?.contains(e.target)
      ) {
        this.closeGotoPopover();
      }
      if (
        this.mobileMenuSheetEl &&
        !this.mobileMenuSheetEl.hidden &&
        !this.mobileMenuSheetEl.contains(e.target) &&
        !this.mobileMenuBtnEl?.contains(e.target)
      ) {
        this.closeMobileMenu();
      }
    });

    this.minimapToggleBtnEl?.addEventListener('click', () => {
      this.setMinimapCollapsed(true);
    });

    this.minimapExpandBtnEl?.addEventListener('click', () => {
      this.setMinimapCollapsed(false);
    });

    this.hintCloseBtnEl?.addEventListener('click', () => {
      this.dismissHint();
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
    const safeCount = Math.max(0, Number(count) || 0);
    if (this.checkedCountEl) {
      this.checkedCountEl.textContent = formatNum(safeCount);
      if (
        this.prevCheckedCount !== null &&
        safeCount > this.prevCheckedCount &&
        !this.tickActive &&
        !prefersReducedMotion()
      ) {
        this.tickActive = true;
        this.checkedCountEl.classList.add('ticking');
        setTimeout(() => {
          this.checkedCountEl?.classList.remove('ticking');
          this.tickActive = false;
        }, DUR.slow);
      }
    }
    this.prevCheckedCount = safeCount;

    if (this.checkedProgressFillEl) {
      const pct = Math.min(100, Math.max(0, (safeCount / 1_000_000) * 100));
      this.checkedProgressFillEl.style.width = `${pct}%`;
      this.checkedProgressFillEl.style.minWidth = safeCount > 0 ? '2px' : '0px';
    }
  }

  setOnlineCount(count) {
    if (this.onlineCountEl) {
      this.onlineCountEl.textContent = formatNum(Math.max(1, count));
    }
  }

  setInstanceId(instanceId) {
    if (!instanceId || !this.instanceBadgeEl) return;
    this.instanceBadgeEl.textContent = instanceId;
    this.instanceBadgeEl.hidden = !this.debugMode;
  }

  setConnectionState(state) {
    if (!this.statusDotEl) return;
    this.statusDotEl.classList.remove('reconnecting', 'offline');
    if (state === 'reconnecting') {
      this.statusDotEl.classList.add('reconnecting');
    } else if (state === 'offline') {
      this.statusDotEl.classList.add('offline');
    }
  }

  updateViewportStatus(bounds) {
    if (this.rangeReadoutEl) {
      this.rangeReadoutEl.textContent = `Rows ${formatNum(bounds.rowStart)}–${formatNum(bounds.rowEnd)}`;
    }
  }

  updateCellReadout(index) {
    if (index < 0 || !this.cellReadoutEl) return;
    this.cellReadoutEl.textContent = `Box ${formatNum(index)}`;
  }

  setFindActivityAvailable(hasRecent) {
    const title = hasRecent
      ? 'Jump to recent activity'
      : 'No one has checked a box in the last minute';
    if (this.findActivityBtnEl) {
      this.findActivityBtnEl.disabled = !hasRecent;
      this.findActivityBtnEl.title = title;
    }
    if (this.mobileFindActivityBtnEl) {
      this.mobileFindActivityBtnEl.disabled = !hasRecent;
      this.mobileFindActivityBtnEl.title = title;
    }
  }

  setAuthState(authState) {
    this.authState = { ...this.authState, ...authState };
    if (authState.instanceId) {
      this.setInstanceId(authState.instanceId);
    }
    this.renderAuthHeader();
    this.renderMobileAuth();
    this.renderStatusRight();
  }

  openSignInFlow() {
    this.closeMobileMenu();
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
    if (!this.authSlotEl) return;
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

  renderMobileAuth() {
    if (!this.mobileAuthSlotEl) return;
    this.mobileAuthSlotEl.innerHTML = '';
    const { authenticated, user } = this.authState;

    if (!authenticated || !user) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'btn btn-primary btn-block';
      btn.textContent = 'Sign in';
      btn.addEventListener('click', () => this.openSignInFlow());
      this.mobileAuthSlotEl.appendChild(btn);
      return;
    }

    const logoutBtn = document.createElement('button');
    logoutBtn.type = 'button';
    logoutBtn.className = 'btn btn-subtle btn-block';
    logoutBtn.textContent = `Sign out (${user.name})`;
    logoutBtn.addEventListener('click', () => {
      this.closeMobileMenu();
      this.onLogout?.();
    });
    this.mobileAuthSlotEl.appendChild(logoutBtn);
  }

  renderStatusRight() {
    if (!this.statusCtaEl) return;
    this.statusCtaEl.innerHTML = '';
    this.tallyClusterEl = null;
    this.tallyMarks = [];
    this.tallyLabelEl = null;

    if (!this.authState.authenticated) {
      const desktopNote = document.createElement('span');
      desktopNote.className = 'status-note desktop-only';
      desktopNote.textContent = "You're watching live. Sign in to check boxes.";

      const mobileNote = document.createElement('span');
      mobileNote.className = 'status-note mobile-only';
      mobileNote.textContent = "You're watching live.";

      const mobileBtn = document.createElement('button');
      mobileBtn.type = 'button';
      mobileBtn.className = 'btn btn-primary btn-sm mobile-only';
      mobileBtn.textContent = 'Sign in';
      mobileBtn.addEventListener('click', () => this.openSignInFlow());

      this.statusCtaEl.append(desktopNote, mobileNote, mobileBtn);
      return;
    }

    const cluster = document.createElement('div');
    cluster.className = 'tally-cluster';
    cluster.id = 'tallyCluster';
    cluster.setAttribute('aria-label', 'Click budget');
    cluster.title = 'Click budget (refills automatically)';

    for (let g = 0; g < 2; g++) {
      const group = document.createElement('span');
      group.className = 'tally-group';
      for (let m = 0; m < 5; m++) {
        const mark = document.createElement('span');
        mark.className = 'tally-mark';
        group.appendChild(mark);
        this.tallyMarks.push(mark);
      }
      cluster.appendChild(group);
    }

    const label = document.createElement('span');
    label.className = 'tally-label';
    label.hidden = true;
    cluster.appendChild(label);

    this.tallyClusterEl = cluster;
    this.tallyLabelEl = label;
    this.statusCtaEl.appendChild(cluster);

    this.syncBudget();
  }

  syncBudget() {
    if (!this.tallyClusterEl || !this.budget) return;

    const now = Date.now();
    const isPaused = this.cooldownUntilMs > now;
    this.tallyClusterEl.classList.toggle('paused', isPaused);

    if (isPaused) {
      const remSec = Math.max(1, Math.ceil((this.cooldownUntilMs - now) / 1000));
      const mins = Math.floor(remSec / 60);
      const secs = remSec % 60;
      if (this.tallyLabelEl) {
        this.tallyLabelEl.textContent = `Paused ${mins}:${String(secs).padStart(2, '0')}`;
        this.tallyLabelEl.hidden = false;
      }
      for (let i = 0; i < this.tallyMarks.length; i++) {
        this.tallyMarks[i].classList.remove('empty');
      }
      return;
    }

    if (this.tallyLabelEl) {
      this.tallyLabelEl.hidden = true;
      this.tallyLabelEl.textContent = '';
    }

    const cap = Math.max(1, this.budget.capacity || 10);
    const current = this.budget.level(now);
    const filledCount = Math.round((Math.floor(current) / cap) * 10);

    for (let i = 0; i < this.tallyMarks.length; i++) {
      this.tallyMarks[i].classList.toggle('empty', i >= filledCount);
    }

    if (current < cap && !this.budgetRaf) {
      const step = () => {
        this.budgetRaf = 0;
        if (!this.tallyClusterEl || !this.budget) return;
        const t = Date.now();
        const lvl = this.budget.level(t);
        const filled = Math.round((Math.floor(lvl) / Math.max(1, this.budget.capacity || 10)) * 10);
        for (let i = 0; i < this.tallyMarks.length; i++) {
          this.tallyMarks[i].classList.toggle('empty', i >= filled);
        }
        if (lvl < this.budget.capacity && this.cooldownUntilMs <= t) {
          this.budgetRaf = requestAnimationFrame(step);
        }
      };
      this.budgetRaf = requestAnimationFrame(step);
    }
  }

  shakeBudget() {
    if (!this.tallyClusterEl || prefersReducedMotion()) return;
    this.tallyClusterEl.classList.remove('shaking');
    // Force reflow so rapid clicks re-trigger the animation
    void this.tallyClusterEl.offsetWidth;
    this.tallyClusterEl.classList.add('shaking');
    setTimeout(() => {
      this.tallyClusterEl?.classList.remove('shaking');
    }, DUR.base);
  }

  startCooldown(retryAfterMs, reason = 'blocked') {
    if (reason !== 'blocked') {
      this.budget?.drain();
      this.syncBudget();
      return;
    }

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
        this.syncBudget();
        return;
      }
      this.syncBudget();
    };

    update();
    this.cooldownTimer = setInterval(update, 250);
  }

  showToast(message, { alert = false, durationMs = 3500, actionLabel = '', onAction = null } = {}) {
    if (!this.toastRegionEl) return;
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
