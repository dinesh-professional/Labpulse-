/**
 * LabPulse shared dashboard UI helpers (Module 02 / 03). Presentation only —
 * authorization stays server-side; these helpers never grant anything.
 */
(function () {
  'use strict';

  /* ─────────────────────────────────────────────────────────────
     1. CENTRALIZED ROLE NAVIGATION CONFIGURATION
     ───────────────────────────────────────────────────────────── */
  var NAV_CONFIG = {
    admin: [
      {
        group: 'Administration',
        items: [
          { label: 'Admin Console', href: 'admin.html', icon: 'grid', id: 'nav-admin-home' },
          { label: 'Faculty Accounts', href: 'admin.html#faculty', icon: 'users', id: 'nav-admin-faculty' },
          { label: 'System Audit Logs', href: 'admin.html#audit', icon: 'shield', id: 'nav-admin-audit' },
        ]
      },
      {
        group: 'Operations & Discovery',
        items: [
          { label: 'Equipment Catalog', href: 'index.html#catalog', icon: 'cpu', id: 'nav-admin-catalog' },
          { label: 'UI Design System', href: 'design-system.html', icon: 'layers', id: 'nav-admin-ds' }
        ]
      }
    ],
    faculty: [
      {
        group: 'Workspace & Teaching',
        items: [
          { label: 'Faculty Workspace', href: 'faculty.html', icon: 'grid', id: 'nav-fac-home' },
          { label: 'Class Schedules', href: 'faculty.html#sched-form', icon: 'calendar', id: 'nav-fac-sched' },
          { label: 'Free Reservations', href: 'faculty.html#book-form', icon: 'clock', id: 'nav-fac-book' },
          { label: 'Breakage Triage', href: 'faculty.html#brk-form', icon: 'alert', id: 'nav-fac-brk' }
        ]
      },
      {
        group: 'Discovery',
        items: [
          { label: 'Equipment Catalog', href: 'index.html#catalog', icon: 'cpu', id: 'nav-fac-catalog' }
        ]
      }
    ],
    student: [
      {
        group: 'Student Portal',
        items: [
          { label: 'My Timetable', href: 'student.html', icon: 'calendar', id: 'nav-stu-home' },
          { label: 'Available Equipment', href: 'student.html#catalog', icon: 'cpu', id: 'nav-stu-catalog' },
          { label: 'Notifications', href: 'student.html#notifs-list', icon: 'bell', id: 'nav-stu-notifs' }
        ]
      },
      {
        group: 'Discovery',
        items: [
          { label: 'Public Showcase', href: 'index.html', icon: 'home', id: 'nav-stu-public' }
        ]
      }
    ]
  };

  var SVG_ICONS = {
    grid: '<svg class="lp-sidebar-icon" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 6a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2H6a2 2 0 01-2-2V6zM14 6a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2h-2a2 2 0 01-2-2V6zM4 16a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2H6a2 2 0 01-2-2v-2zM14 16a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2h-2a2 2 0 01-2-2v-2z"/></svg>',
    users: '<svg class="lp-sidebar-icon" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 4.354a4 4 0 110 5.292M15 21H3v-1a6 6 0 0112 0v1zm0 0h6v-1a6 6 0 00-9-5.197M13 7a4 4 0 11-8 0 4 4 0 018 0z"/></svg>',
    shield: '<svg class="lp-sidebar-icon" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z"/></svg>',
    cpu: '<svg class="lp-sidebar-icon" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 3v2m6-2v2M9 19v2m6-2v2M5 9H3m2 6H3m18-6h-2m2 6h-2M7 19h10a2 2 0 002-2V7a2 2 0 00-2-2H7a2 2 0 00-2 2v10a2 2 0 002 2zM9 9h6v6H9V9z"/></svg>',
    calendar: '<svg class="lp-sidebar-icon" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z"/></svg>',
    clock: '<svg class="lp-sidebar-icon" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z"/></svg>',
    alert: '<svg class="lp-sidebar-icon" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"/></svg>',
    bell: '<svg class="lp-sidebar-icon" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 17h5l-1.405-1.405A2.032 2.032 0 0118 14.158V11a6.002 6.002 0 00-4-5.659V5a2 2 0 10-4 0v.341C7.67 6.165 6 8.388 6 11v3.159c0 .538-.214 1.055-.595 1.436L4 17h5m6 0v1a3 3 0 11-6 0v-1m6 0H9"/></svg>',
    home: '<svg class="lp-sidebar-icon" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M3 12l2-2m0 0l7-7 7 7M5 10v10a1 1 0 001 1h3m10-11l2 2m-2-2v10a1 1 0 01-1 1h-3m-6 0a1 1 0 001-1v-4a1 1 0 011-1h2a1 1 0 011 1v4a1 1 0 001 1m-6 0h6"/></svg>',
    layers: '<svg class="lp-sidebar-icon" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10"/></svg>'
  };

  function esc(v) {
    return String(v === undefined || v === null ? '' : v).replace(/[&<>"']/g,
      function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; });
  }

  function fmtDay(d) {
    try { return new Date(d).toISOString().slice(0, 10); } catch (e) { return ''; }
  }

  /**
   * Generates breadcrumbs markup
   */
  function createBreadcrumbs(crumbs) {
    if (!crumbs || !crumbs.length) return '';
    var items = crumbs.map(function (c, idx) {
      var isLast = idx === crumbs.length - 1;
      if (isLast) {
        return '<span class="text-vortex-cyan font-bold">' + esc(c.label) + '</span>';
      }
      return '<a href="' + esc(c.href) + '" class="hover:text-vortex-white transition-colors">' + esc(c.label) + '</a>';
    });
    return '<nav class="lp-breadcrumb" aria-label="Breadcrumb">' + items.join(' <span class="text-vortex-gray">/</span> ') + '</nav>';
  }

  /**
   * Generates page header markup
   */
  function createPageHeader(title, subtitle, actionsHtml) {
    return (
      '<div class="lp-page-header">' +
        '<div>' +
          '<h1 class="text-2xl sm:text-4xl font-display font-black uppercase tracking-tight text-white">' + esc(title) + '</h1>' +
          (subtitle ? '<p class="font-mono text-xs text-vortex-gray mt-1">' + esc(subtitle) + '</p>' : '') +
        '</div>' +
        (actionsHtml ? '<div class="flex items-center gap-3">' + actionsHtml + '</div>' : '') +
      '</div>'
    );
  }

  /**
   * Centralized application shell initializer.
   * Preserves all required IDs: user-chip, btn-logout.
   */
  function initShell(user) {
    var chip = document.getElementById('user-chip');
    if (chip) chip.textContent = user.name + ' · ' + user.role.toUpperCase();

    var out = document.getElementById('btn-logout');
    if (out) {
      out.addEventListener('click', async function () {
        out.disabled = true;
        try { await window.LabPulseAuth.logout(); }
        finally { window.location.replace('login.html'); }
      });
    }

    // Enhance header with contextual indicators if present
    var header = document.querySelector('header.glass-nav');
    if (header && !header.dataset.shellEnhanced) {
      header.dataset.shellEnhanced = 'true';

      // Insert subtle system telemetry chip into header right
      var headerRight = header.querySelector('.flex.items-center.gap-4');
      if (headerRight) {
        var statusBadge = document.createElement('span');
        statusBadge.className = 'hidden md:inline-flex items-center gap-1.5 text-[11px] font-mono text-emerald-400 border border-emerald-500/30 bg-emerald-500/10 px-2 py-0.5 rounded-full';
        statusBadge.innerHTML = '<span class="w-1.5 h-1.5 rounded-full bg-emerald-400 inline-block"></span> ACTIVE CORE';
        headerRight.insertBefore(statusBadge, headerRight.firstChild);

        initNotificationCenter(user, headerRight);
      }
    }

    return user;
  }

  /* ----------------------------------------------------------------------------
   * Notification Center Component (Module 10)
   * Real-time in-app notification tray with unread badge, SSE sync & quick actions
   * ---------------------------------------------------------------------------- */
  var sseConnection = null;
  var notifPollingTimer = null;
  var cachedNotifications = [];

  function formatRelativeTime(dateInput) {
    if (!dateInput) return '';
    var now = Date.now();
    var then = new Date(dateInput).getTime();
    var diffSec = Math.floor((now - then) / 1000);
    if (isNaN(diffSec) || diffSec < 0) return 'just now';
    if (diffSec < 60) return 'just now';
    var diffMin = Math.floor(diffSec / 60);
    if (diffMin < 60) return diffMin + 'm ago';
    var diffHr = Math.floor(diffMin / 60);
    if (diffHr < 24) return diffHr + 'h ago';
    var diffDay = Math.floor(diffHr / 24);
    if (diffDay < 7) return diffDay + 'd ago';
    return fmtDay(dateInput);
  }

  function getCategoryColor(type) {
    if (!type) return 'text-vortex-cyan border-vortex-cyan/30 bg-vortex-cyan/10';
    if (type.indexOf('cancel') !== -1 || type.indexOf('reject') !== -1 || type.indexOf('fail') !== -1 || type.indexOf('breakage') !== -1) {
      return 'text-vortex-rose border-vortex-rose/30 bg-vortex-rose/10';
    }
    if (type.indexOf('due') !== -1 || type.indexOf('warn') !== -1 || type.indexOf('reminder') !== -1) {
      return 'text-vortex-amber border-vortex-amber/30 bg-vortex-amber/10';
    }
    if (type.indexOf('confirm') !== -1 || type.indexOf('check-in') !== -1 || type.indexOf('complete') !== -1 || type.indexOf('success') !== -1) {
      return 'text-vortex-emerald border-vortex-emerald/30 bg-vortex-emerald/10';
    }
    return 'text-vortex-cyan border-vortex-cyan/30 bg-vortex-cyan/10';
  }

  var notifWrapperEl = null;

  async function loadNotifications(onSuccess) {
    if (!notifWrapperEl) return;
    var listEl = notifWrapperEl.querySelector('.notif-items-list');
    var emptyEl = notifWrapperEl.querySelector('.notif-empty');
    var loadingEl = notifWrapperEl.querySelector('.notif-loading');
    if (loadingEl) loadingEl.classList.remove('hidden');

    try {
      var res = await window.LabPulseAuth.api('/api/v1/notifications?limit=25');
      if (res && res.json && res.json.success) {
        cachedNotifications = res.json.data.notifications || [];
        updateUnreadBadge(res.json.data.unread || 0);
        renderNotificationItems(cachedNotifications);
        if (onSuccess) onSuccess(cachedNotifications);
      }
    } catch (err) {
      console.warn('[notifications] load failed:', err);
    } finally {
      if (loadingEl) loadingEl.classList.add('hidden');
    }
  }

  function updateUnreadBadge(count) {
    if (!notifWrapperEl) return;
    var badge = notifWrapperEl.querySelector('.notif-badge');
    var countEl = notifWrapperEl.querySelector('.notif-count-text');
    var bellBtn = notifWrapperEl.querySelector('.btn-notif-bell');
    if (!badge || !bellBtn) return;

    if (count > 0) {
      badge.classList.remove('hidden');
      badge.textContent = count > 99 ? '99+' : String(count);
      if (countEl) countEl.textContent = count + ' UNREAD';
      bellBtn.setAttribute('aria-label', count + ' unread notifications');
    } else {
      badge.classList.add('hidden');
      if (countEl) countEl.textContent = '0 UNREAD';
      bellBtn.setAttribute('aria-label', 'Notifications (none unread)');
    }
  }

  function renderNotificationItems(items) {
    if (!notifWrapperEl) return;
    var listEl = notifWrapperEl.querySelector('.notif-items-list');
    var emptyEl = notifWrapperEl.querySelector('.notif-empty');
    if (!listEl || !emptyEl) return;

    listEl.innerHTML = '';
    if (!items || items.length === 0) {
      emptyEl.classList.remove('hidden');
      return;
    }
    emptyEl.classList.add('hidden');

    items.forEach(function (n) {
      var card = document.createElement('div');
      card.className = 'p-3 border-b border-vortex-border/70 hover:bg-vortex-border/20 transition-colors cursor-pointer flex gap-3 text-left ' +
        (n.read ? 'opacity-70' : 'bg-vortex-cyan/5 border-l-2 border-l-vortex-cyan');
      card.setAttribute('role', 'article');
      card.setAttribute('data-id', n.id || n._id);

      var colorCls = getCategoryColor(n.type);
      var typeLabel = (n.type || 'NOTIFICATION').replace(/-/g, ' ').toUpperCase();
      var relTime = formatRelativeTime(n.createdAt);
      var fullDate = n.createdAt ? new Date(n.createdAt).toISOString() : '';

      card.innerHTML =
        '<div class="flex-1 min-w-0">' +
          '<div class="flex items-center justify-between gap-2 mb-1">' +
            '<span class="inline-block px-1.5 py-0.5 text-[9px] font-mono border rounded uppercase ' + colorCls + '">' + esc(typeLabel) + '</span>' +
            '<time class="text-[10px] font-mono text-vortex-gray whitespace-nowrap" title="' + esc(fullDate) + '">' + esc(relTime) + '</time>' +
          '</div>' +
          '<h2 class="text-xs font-bold text-vortex-white truncate">' + esc(n.title) + '</h2>' +
          '<p class="text-[11px] text-vortex-gray line-clamp-2 mt-0.5 leading-tight">' + esc(n.message) + '</p>' +
        '</div>' +
        (!n.read
          ? '<button class="text-[10px] font-mono text-vortex-cyan hover:underline self-center p-1" title="Mark as read" data-action="mark-read">●</button>'
          : '');

      card.addEventListener('click', async function () {
        var notifId = n.id || n._id;
        if (!n.read) {
          await markNotificationRead(notifId);
          n.read = true;
          renderNotificationItems(cachedNotifications);
        }
        if (n.entityType === 'booking' && n.entityId) {
          var targetEl = document.querySelector('#booking-' + n.entityId);
          if (targetEl) targetEl.scrollIntoView({ behavior: 'smooth' });
        }
      });

      listEl.appendChild(card);
    });
  }

  async function markNotificationRead(id) {
    if (!id) return;
    try {
      var res = await window.LabPulseAuth.api('/api/v1/notifications/' + id + '/read', { method: 'PATCH' });
      if (res && res.json && res.json.success) {
        cachedNotifications = cachedNotifications.map(function (it) {
          if ((it.id || it._id) === id) it.read = true;
          return it;
        });
        var unread = cachedNotifications.filter(function (it) { return !it.read; }).length;
        updateUnreadBadge(unread);
      }
    } catch (e) {
      console.warn('[notifications] mark read error:', e);
    }
  }

  async function markAllNotificationsRead() {
    try {
      var res = await window.LabPulseAuth.api('/api/v1/notifications/mark-all-read', { method: 'POST' });
      if (res && res.json && res.json.success) {
        cachedNotifications = cachedNotifications.map(function (it) {
          it.read = true;
          return it;
        });
        updateUnreadBadge(0);
        renderNotificationItems(cachedNotifications);
      }
    } catch (e) {
      console.warn('[notifications] mark all read error:', e);
    }
  }

  function handleIncomingRealtimeEvent(notif) {
    if (!notif) return;
    var exists = cachedNotifications.some(function (it) {
      return (it.id || it._id) === (notif.id || notif._id);
    });
    if (!exists) {
      cachedNotifications.unshift(notif);
      var unread = cachedNotifications.filter(function (it) { return !it.read; }).length;
      updateUnreadBadge(unread);
      renderNotificationItems(cachedNotifications);
      notify(notif.title + ': ' + notif.message, false);
    }
  }

  function setupRealtimeStream() {
    if (typeof EventSource === 'undefined') return;
    if (sseConnection) {
      try { sseConnection.close(); } catch (_) {}
      sseConnection = null;
    }

    var token = window.LabPulseAuth.getAccessToken ? window.LabPulseAuth.getAccessToken() : null;
    if (!token) return;

    try {
      sseConnection = new EventSource('/api/v1/notifications/stream?token=' + encodeURIComponent(token));
      sseConnection.addEventListener('notification', function (evt) {
        try {
          var payload = JSON.parse(evt.data);
          handleIncomingRealtimeEvent(payload);
        } catch (_) {}
      });
      sseConnection.onerror = function () {
        // SSE automatic reconnect
      };
    } catch (e) {
      console.warn('[notifications] SSE initialization error:', e);
    }
  }

  function initNotificationCenter(user, container) {
    if (container.querySelector('.notif-wrapper')) return;

    var wrap = document.createElement('div');
    wrap.className = 'notif-wrapper relative inline-block';

    wrap.innerHTML =
      '<button aria-label="Notifications" class="btn-notif-bell glass-input text-vortex-gray hover:text-vortex-white hover:border-vortex-white p-2.5 relative flex items-center justify-center transition-colors min-h-[44px] min-w-[44px]" aria-expanded="false" aria-haspopup="dialog">' +
        SVG_ICONS.bell +
        '<span class="notif-badge hidden absolute -top-1 -right-1 min-w-[18px] h-[18px] px-1 text-[9px] font-mono font-bold bg-vortex-cyan text-vortex-black rounded-full flex items-center justify-center border border-vortex-black leading-none"></span>' +
      '</button>' +
      '<div class="notif-dropdown hidden absolute right-0 mt-2 w-80 sm:w-96 glass-card border border-vortex-border shadow-2xl z-[100] overflow-hidden font-sans text-left" role="dialog" aria-modal="false" aria-label="Notifications Panel">' +
        '<div class="px-4 py-3 border-b border-vortex-border flex items-center justify-between">' +
          '<div class="flex items-center gap-2">' +
            '<span class="text-xs font-display font-black tracking-tight text-vortex-white uppercase">NOTIFICATIONS</span>' +
            '<span class="notif-count-text text-[10px] font-mono px-1.5 py-0.5 rounded border border-vortex-border text-vortex-gray">0 UNREAD</span>' +
          '</div>' +
          '<button class="btn-mark-all-read text-[10px] font-mono text-vortex-cyan hover:underline uppercase transition-colors">MARK ALL READ</button>' +
        '</div>' +
        '<div class="notif-loading hidden p-6 text-center text-xs font-mono text-vortex-gray">LOADING UPDATES…</div>' +
        '<div class="notif-empty hidden p-8 text-center text-xs font-mono text-vortex-gray">NO RECENT NOTIFICATIONS</div>' +
        '<div class="notif-items-list max-h-80 overflow-y-auto divide-y divide-vortex-border/30"></div>' +
      '</div>';

    container.insertBefore(wrap, container.lastChild);
    notifWrapperEl = wrap;

    var bellBtn = wrap.querySelector('.btn-notif-bell');
    var dropEl = wrap.querySelector('.notif-dropdown');
    var markAllBtn = wrap.querySelector('.btn-mark-all-read');

    bellBtn.addEventListener('click', function (e) {
      e.stopPropagation();
      var isHidden = dropEl.classList.contains('hidden');
      if (isHidden) {
        dropEl.classList.remove('hidden');
        bellBtn.setAttribute('aria-expanded', 'true');
        loadNotifications();
      } else {
        dropEl.classList.add('hidden');
        bellBtn.setAttribute('aria-expanded', 'false');
      }
    });

    markAllBtn.addEventListener('click', function (e) {
      e.stopPropagation();
      markAllNotificationsRead();
    });

    document.addEventListener('click', function (e) {
      if (!wrap.contains(e.target)) {
        dropEl.classList.add('hidden');
        bellBtn.setAttribute('aria-expanded', 'false');
      }
    });

    loadNotifications();
    setupRealtimeStream();

    if (notifPollingTimer) clearInterval(notifPollingTimer);
    notifPollingTimer = setInterval(function () {
      if (window.LabPulseAuth.isAuthenticated && window.LabPulseAuth.isAuthenticated()) {
        loadNotifications();
      }
    }, 60000);

    window.addEventListener('beforeunload', function () {
      if (sseConnection) {
        try { sseConnection.close(); } catch (_) {}
      }
    });
  }

  /** Show the 403 block and hide app content (UX only — APIs still enforce). */
  function showForbidden() {
    var app = document.getElementById('dash-app');
    var denied = document.getElementById('dash-denied');
    var loading = document.getElementById('dash-loading');
    if (loading) loading.classList.add('hidden');
    if (app) app.classList.add('hidden');
    if (denied) denied.classList.remove('hidden');
  }

  function showApp() {
    var loading = document.getElementById('dash-loading');
    var app = document.getElementById('dash-app');
    if (loading) loading.classList.add('hidden');
    if (app) app.classList.remove('hidden');
  }

  function pageError(msg) {
    var box = document.getElementById('dash-error');
    if (!box) return;
    if (!msg) { box.classList.add('hidden'); box.textContent = ''; return; }
    box.textContent = msg;
    box.classList.remove('hidden');
  }

  function notify(msg, isError) {
    if (isError) pageError(msg);
    var existing = document.querySelector('#dash-toast');
    if (!existing) {
      existing = document.createElement('div');
      existing.id = 'dash-toast';
      document.body.appendChild(existing);
    }
    existing.className = 'fixed bottom-4 right-4 z-50 px-4 py-3 border font-mono text-xs shadow-lg transition-all duration-300 max-w-sm ' +
      (isError ? 'bg-red-950/90 border-red-500/50 text-red-200' : 'bg-emerald-950/90 border-emerald-500/50 text-emerald-200');
    existing.textContent = msg;
    existing.classList.remove('hidden');
    clearTimeout(existing._t);
    existing._t = setTimeout(function () {
      if (existing) existing.classList.add('hidden');
    }, 4000);
  }

  window.LabPulseDash = {
    esc: esc,
    fmtDay: fmtDay,
    NAV_CONFIG: NAV_CONFIG,
    SVG_ICONS: SVG_ICONS,
    createBreadcrumbs: createBreadcrumbs,
    createPageHeader: createPageHeader,
    initShell: initShell,
    showForbidden: showForbidden,
    showApp: showApp,
    pageError: pageError,
    notify: notify,
    showNotice: notify,
    loadNotifications: loadNotifications,
    markNotificationRead: markNotificationRead,
    markAllNotificationsRead: markAllNotificationsRead,
    initNotificationCenter: initNotificationCenter,
  };
})();
