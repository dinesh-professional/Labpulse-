/**
 * LabPulse shared auth client (Phase 14) — the ONE frontend API layer for identity.
 * - Access token lives in module memory only. Nothing identity-related touches localStorage.
 * - Role ALWAYS comes from GET /api/v1/auth/me (backend authoritative).
 * - 401 responses trigger exactly one refresh attempt (single-flight), then retry once;
 *   if refresh fails, session is cleared and caller redirects to login. No retry loops.
 * - Refresh token travels in the httpOnly `lp_refresh` cookie (browser sends automatically).
 */
(function () {
  'use strict';

  var accessToken = null;
  var currentUser = null;
  var refreshPromise = null;

  var DASHBOARD_BY_ROLE = { admin: 'admin.html', faculty: 'faculty.html', student: 'student.html' };

  function dashboardFor(role) {
    return DASHBOARD_BY_ROLE[role] || null;
  }

  async function request(path, options) {
    options = options || {};
    var headers = { 'Content-Type': 'application/json' };
    if (accessToken) headers.Authorization = 'Bearer ' + accessToken;
    var res = await fetch(path, {
      method: options.method || 'GET',
      headers: headers,
      body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
    });
    var json = null;
    try { json = await res.json(); } catch (e) { /* non-JSON */ }
    return { status: res.status, json: json };
  }

  function doRefresh() {
    if (!refreshPromise) {
      refreshPromise = (async function () {
        try {
          var r = await request('/api/v1/auth/refresh', { method: 'POST' });
          if (r.status === 200 && r.json && r.json.data && r.json.data.accessToken) {
            accessToken = r.json.data.accessToken;
            return true;
          }
          return false;
        } catch (e) {
          return false;
        } finally {
          var p = refreshPromise;
          refreshPromise = null;
          void p;
        }
      })();
    }
    return refreshPromise;
  }

  /**
   * Authenticated request with single refresh-and-retry. Returns {status, json}.
   * Sets `refreshedExpiredSession=true` when the original call was 401 and refresh saved it.
   */
  async function api(path, options) {
    var first = await request(path, options);
    if (first.status !== 401 || (options && options._retried)) return first;
    var ok = await doRefresh();
    if (!ok) return first;
    var retryOpts = Object.assign({}, options, { _retried: true });
    return request(path, retryOpts);
  }

  /**
   * Authenticated file download with single refresh-and-retry.
   * Creates a blob URL, triggers a download anchor click, and revokes the URL.
   */
  async function download(path, defaultFilename) {
    var headers = {};
    if (accessToken) headers.Authorization = 'Bearer ' + accessToken;
    var res = await fetch(path, { method: 'GET', headers: headers });
    if (res.status === 401) {
      var ok = await doRefresh();
      if (ok && accessToken) {
        headers.Authorization = 'Bearer ' + accessToken;
        res = await fetch(path, { method: 'GET', headers: headers });
      }
    }
    if (!res.ok) throw new Error('Download failed with status ' + res.status);
    var blob = await res.blob();
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = defaultFilename || 'download.csv';
    a.click();
    URL.revokeObjectURL(a.href);
    return true;
  }

  function getUser() {
    return currentUser ? Object.assign({}, currentUser) : null;
  }

  function getAccessToken() {
    return accessToken;
  }

  function isAuthenticated() {
    return !!accessToken && !!currentUser;
  }

  function clearSession() {
    accessToken = null;
    currentUser = null;
  }

  /** Resolve session from refresh cookie. Returns user or null (never throws). */
  async function initSession() {
    clearSession();
    var ok = await doRefresh();
    if (!ok) return null;
    var me = await request('/api/v1/auth/me');
    if (me.status === 200 && me.json && me.json.data && me.json.data.user) {
      currentUser = me.json.data.user;
      return getUser();
    }
    clearSession();
    return null;
  }

  async function login(email, password) {
    clearSession();
    var r = await request('/api/v1/auth/login', { method: 'POST', body: { email: email, password: password } });
    if (r.status === 200 && r.json && r.json.data && r.json.data.accessToken) {
      accessToken = r.json.data.accessToken;
      currentUser = r.json.data.user;
      return { ok: true, user: getUser() };
    }
    clearSession();
    return { ok: false, status: r.status, error: r.json && r.json.error };
  }

  async function logout() {
    try { await request('/api/v1/auth/logout', { method: 'POST' }); } catch (e) { /* offline: still clear */ }
    clearSession();
  }

  async function forgotPassword(email) {
    return request('/api/v1/auth/forgot-password', { method: 'POST', body: { email: email } });
  }

  async function resetPassword(token, password) {
    return request('/api/v1/auth/reset-password', { method: 'POST', body: { token: token, password: password } });
  }

  async function signup(payloadOrName, email, password, extra) {
    var body;
    if (typeof payloadOrName === 'object' && payloadOrName !== null) {
      body = payloadOrName;
    } else {
      body = Object.assign({
        name: payloadOrName,
        email: email,
        password: password,
        confirmPassword: (extra && extra.confirmPassword) || password,
      }, extra || {});
    }
    var r = await request('/api/v1/auth/signup', { method: 'POST', body: body });
    if (r.status >= 200 && r.status < 300) {
      return { ok: true, status: r.status, data: r.json && r.json.data, message: r.json && r.json.message };
    }
    return {
      ok: false,
      status: r.status,
      error: (r.json && r.json.error) || { message: 'Sign-up failed.' },
    };
  }

  async function activate(token, password) {
    var body = { token: token };
    if (password) body.password = password;
    var r = await request('/api/v1/auth/activate', { method: 'POST', body: body });
    if (r.status >= 200 && r.status < 300) {
      return { ok: true, status: r.status, message: r.json && r.json.message };
    }
    return {
      ok: false,
      status: r.status,
      error: (r.json && r.json.error) || { message: 'Activation failed.' },
    };
  }

  /** Page guard for role landings. Returns user or redirects away. */
  async function guard(requiredRole, loginPage) {
    loginPage = loginPage || 'login.html';
    var user = await initSession();
    if (!user) {
      // Via the exported object so host pages/tests observe navigation uniformly.
      window.LabPulseAuth.goToLogin(loginPage);
      return null;
    }
    if (requiredRole && user.role !== requiredRole) {
      return { forbidden: true, user: user };
    }
    return user;
  }

  var ALLOWED_REDIRECTS = {
    admin: ['admin.html'],
    faculty: ['faculty.html'],
    student: ['student.html'],
  };

  function sanitizeInternalRedirect(role, target) {
    if (!target || typeof target !== 'string') return null;
    var clean = target.trim();
    // Disallow external URLs (schemes or protocol-relative '//')
    if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(clean) || clean.startsWith('//')) {
      return null;
    }
    // Extract base page name
    var baseName = clean.split('?')[0].split('#')[0].replace(/^\/+/, '');
    var allowed = ALLOWED_REDIRECTS[role] || [];
    if (allowed.includes(baseName)) {
      return clean;
    }
    return null;
  }

  function goToDashboard(role, requestedRedirect) {
    var safeTarget = sanitizeInternalRedirect(role, requestedRedirect);
    var page = safeTarget || dashboardFor(role);
    window.location.replace(page || 'login.html');
  }

  function goToLogin(loginPage, redirectTarget) {
    var base = loginPage || 'login.html';
    if (redirectTarget && typeof redirectTarget === 'string') {
      var sep = base.includes('?') ? '&' : '?';
      base = base + sep + 'redirect=' + encodeURIComponent(redirectTarget);
    }
    window.location.replace(base);
  }

  window.LabPulseAuth = {
    api: api,
    download: download,
    login: login,
    logout: logout,
    forgotPassword: forgotPassword,
    resetPassword: resetPassword,
    signup: signup,
    activate: activate,
    initSession: initSession,
    guard: guard,
    getUser: getUser,
    getAccessToken: getAccessToken,
    getToken: getAccessToken,
    isAuthenticated: isAuthenticated,
    clearSession: clearSession,
    dashboardFor: dashboardFor,
    sanitizeInternalRedirect: sanitizeInternalRedirect,
    goToDashboard: goToDashboard,
    goToLogin: goToLogin,
  };
})();
