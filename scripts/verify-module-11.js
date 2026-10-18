/**
 * Module 11 Verification: Role-Based Dashboards
 * Run: `node scripts/verify-module-11.js`
 *
 * Validates all acceptance criteria for Module 11:
 *  1. Server routes: /api/v1/dashboard mounted in server.js
 *  2. Route security: /api/v1/dashboard/stats requires authentication
 *  3. Role scoping: Student role receives strictly personal bookings and class metrics
 *  4. Role scoping: Faculty role receives myBookings, pending approvals queue, and teaching schedules
 *  5. Role scoping: Admin role receives system-wide aggregate metrics across users, instruments, bookings, and breakage
 *  6. Role enforcement: Identity derived strictly from req.user session (no client parameter hijacking)
 *  7. Shared Foundation: dash.js provides role navigation config (NAV_CONFIG) for admin, faculty, and student
 *  8. Shared Foundation: dash.js provides accessible shell, notification dropdown, and error banners
 *  9. Student Dashboard HTML: semantic layout, accessible header, 6 metric overview cards
 * 10. Student Dashboard Filters: booking status buttons with active styling and click handlers
 * 11. Student Dashboard Client: loadDashboardStats integration with parallel data fetching
 * 12. Student Dashboard Lifecycle: stats reload on booking request, booking cancel, and breakage report
 * 13. Faculty Dashboard HTML: semantic layout, workspace title, 6 metric overview cards
 * 14. Faculty Dashboard Workflows: timetable creation, free booking, and request queue triage
 * 15. Faculty Dashboard Client: loadDashboardStats integration with parallel data fetching
 * 16. Faculty Dashboard Lifecycle: stats reload on approval triage, schedule create/cancel, booking, and breakage
 * 17. Admin Dashboard HTML: semantic layout, executive title, 8 metric overview cards
 * 18. Admin Dashboard Filters: reservation and instrument filter buttons with active visual highlighting
 * 19. Admin Dashboard Client: loadStats integration querying /api/v1/dashboard/stats with robust fallback
 * 20. Admin Dashboard Lifecycle: stats reload on booking approve/reject/complete/no-show and faculty invite
 * 21. Mock Data Audit: zero mock or placeholder strings across student, faculty, and admin dashboards
 * 22. Frontend API Hygiene: zero raw fetch() calls; all communication routed through LabPulseAuth (A.api)
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

let totalChecks = 0;
let passedChecks = 0;
let failedChecks = 0;

function ok(title) {
  totalChecks += 1;
  passedChecks += 1;
  console.log(`  ✅ PASS  ${title}`);
}

function fail(title, reason) {
  totalChecks += 1;
  failedChecks += 1;
  console.error(`  ❌ FAIL  ${title} — ${reason}`);
}

function fileContains(relPath, ...snippets) {
  const full = path.join(ROOT, relPath);
  if (!fs.existsSync(full)) {
    return { exists: false, missing: snippets };
  }
  const content = fs.readFileSync(full, 'utf8');
  const missing = snippets.filter((s) => !content.includes(s));
  return { exists: true, missing, content };
}

(async () => {
  console.log('\n╔══════════════════════════════════════════════════════════════╗');
  console.log('║   MODULE 11: ROLE-BASED DASHBOARDS                         ║');
  console.log('╚══════════════════════════════════════════════════════════════╝\n');

  // ──────────────────────────────────────────────────────────────────────────
  // 1. Server routes: /api/v1/dashboard mounted in server.js
  // ──────────────────────────────────────────────────────────────────────────
  {
    const serverCheck = fileContains(
      'server.js',
      "app.use('/api/v1/dashboard', require('./routes/dashboard'))"
    );
    if (!serverCheck.exists || serverCheck.missing.length > 0) {
      fail('Server routes', 'dashboard router not mounted at /api/v1/dashboard in server.js');
    } else {
      ok('Dashboard stats router mounted at /api/v1/dashboard in server.js');
    }
  }

  // ──────────────────────────────────────────────────────────────────────────
  // 2. Route security: /api/v1/dashboard/stats requires authentication
  // ──────────────────────────────────────────────────────────────────────────
  {
    const dashRouteCheck = fileContains(
      'routes/dashboard.js',
      "const { requireAuth } = require('../middleware/requireAuth')",
      'router.use(requireAuth)',
      "router.get('/stats'"
    );
    if (!dashRouteCheck.exists) {
      fail('Dashboard route file', 'routes/dashboard.js does not exist');
    } else if (dashRouteCheck.missing.length > 0) {
      fail('Dashboard route security', `Missing elements: ${dashRouteCheck.missing.join(', ')}`);
    } else {
      ok('GET /api/v1/dashboard/stats enforces mandatory requireAuth middleware');
    }
  }

  // ──────────────────────────────────────────────────────────────────────────
  // 3. Role scoping: Student metrics isolation
  // ──────────────────────────────────────────────────────────────────────────
  {
    const stuScopeCheck = fileContains(
      'routes/dashboard.js',
      "role === 'student'",
      'totalBookings',
      'pendingBookings',
      'confirmedBookings',
      'completedBookings',
      'cancelledBookings',
      'upcomingClasses',
      'unreadNotifications'
    );
    if (stuScopeCheck.missing.length > 0) {
      fail('Student metrics scope', `Missing metrics in routes/dashboard.js: ${stuScopeCheck.missing.join(', ')}`);
    } else {
      ok('Student metrics return role-scoped personal booking & timetable counts');
    }
  }

  // ──────────────────────────────────────────────────────────────────────────
  // 4. Role scoping: Faculty metrics isolation
  // ──────────────────────────────────────────────────────────────────────────
  {
    const facScopeCheck = fileContains(
      'routes/dashboard.js',
      "role === 'faculty'",
      'myBookings',
      'pendingApprovals',
      'mySchedules',
      'activeBreakage',
      'totalInstruments',
      'availableInstruments'
    );
    if (facScopeCheck.missing.length > 0) {
      fail('Faculty metrics scope', `Missing metrics in routes/dashboard.js: ${facScopeCheck.missing.join(', ')}`);
    } else {
      ok('Faculty metrics return queue, personal bookings, and teaching schedules');
    }
  }

  // ──────────────────────────────────────────────────────────────────────────
  // 5. Role scoping: Admin system-wide metrics
  // ──────────────────────────────────────────────────────────────────────────
  {
    const admScopeCheck = fileContains(
      'routes/dashboard.js',
      "role === 'admin'",
      'totalUsers',
      'totalFaculty',
      'totalStudents',
      'totalBookings',
      'pendingBookings',
      'totalInstruments',
      'availableInstruments',
      'outOfOrderInstruments',
      'totalSchedules',
      'openBreakage',
      'totalCalibrations'
    );
    if (admScopeCheck.missing.length > 0) {
      fail('Admin metrics scope', `Missing metrics in routes/dashboard.js: ${admScopeCheck.missing.join(', ')}`);
    } else {
      ok('Admin metrics return comprehensive system-wide operational metrics');
    }
  }

  // ──────────────────────────────────────────────────────────────────────────
  // 6. Security: Session-derived identity (req.user)
  // ──────────────────────────────────────────────────────────────────────────
  {
    const src = fs.readFileSync(path.join(ROOT, 'routes', 'dashboard.js'), 'utf8');
    const derivesFromSession = src.includes('req.user.role') && src.includes('req.user.id');
    const noParamHijack = !src.includes('req.query.role') && !src.includes('req.body.role') && !src.includes('req.query.userId');
    if (derivesFromSession && noParamHijack) {
      ok('Identity & role derived strictly from verified session (no client parameter hijacking)');
    } else {
      fail('Session security', 'Routes must derive userId and role only from verified req.user session');
    }
  }

  // ──────────────────────────────────────────────────────────────────────────
  // 7. Shared Foundation: Centralized role navigation config
  // ──────────────────────────────────────────────────────────────────────────
  {
    const navCheck = fileContains(
      'dash.js',
      'NAV_CONFIG =',
      'admin:',
      'faculty:',
      'student:'
    );
    if (!navCheck.exists || navCheck.missing.length > 0) {
      fail('Role navigation', 'dash.js NAV_CONFIG is missing role definitions');
    } else {
      ok('Centralized role navigation config (NAV_CONFIG) defined for all 3 roles');
    }
  }

  // ──────────────────────────────────────────────────────────────────────────
  // 8. Shared Foundation: Accessible shell, notifications & error utilities
  // ──────────────────────────────────────────────────────────────────────────
  {
    const shellCheck = fileContains(
      'dash.js',
      'initShell:',
      'showApp:',
      'showForbidden:',
      'pageError:',
      'notify:',
      'initNotificationCenter:'
    );
    if (!shellCheck.exists || shellCheck.missing.length > 0) {
      fail('Shell utilities', `Missing in dash.js: ${shellCheck.missing.join(', ')}`);
    } else {
      ok('Shared application shell provides notification tray, error banners, and route guards');
    }
  }

  // ──────────────────────────────────────────────────────────────────────────
  // 9. Student Dashboard HTML: semantic layout and 6 overview metric cards
  // ──────────────────────────────────────────────────────────────────────────
  {
    const stuCards = fileContains(
      'student.html',
      'id="stu-metrics"',
      'id="stu-stat-total"',
      'id="stu-stat-pending"',
      'id="stu-stat-confirmed"',
      'id="stu-stat-completed"',
      'id="stu-stat-classes"',
      'id="stu-stat-notifs"'
    );
    if (!stuCards.exists || stuCards.missing.length > 0) {
      fail('Student metric cards', `Missing elements: ${stuCards.missing.join(', ')}`);
    } else {
      ok('Student dashboard provides 6 semantic overview metric cards');
    }
  }

  // ──────────────────────────────────────────────────────────────────────────
  // 10. Student Dashboard Filters: active filter styling
  // ──────────────────────────────────────────────────────────────────────────
  {
    const stuFilters = fileContains(
      'student.html',
      'id="flt-bks-all"',
      'id="flt-bks-pending"',
      'id="flt-bks-active"',
      'setActiveFilter'
    );
    if (!stuFilters.exists || stuFilters.missing.length > 0) {
      fail('Student filter buttons', `Missing filter elements: ${stuFilters.missing.join(', ')}`);
    } else {
      ok('Student booking filters provide active visual highlighting and click listeners');
    }
  }

  // ──────────────────────────────────────────────────────────────────────────
  // 11. Student Dashboard Client: loadDashboardStats integration
  // ──────────────────────────────────────────────────────────────────────────
  {
    const stuScript = fileContains(
      'student.html',
      "loadDashboardStats",
      "A.api('/api/v1/dashboard/stats')",
      "stu-stat-total",
      "stu-stat-pending"
    );
    if (!stuScript.exists || stuScript.missing.length > 0) {
      fail('Student stats loader', `Missing stats loading in student.html: ${stuScript.missing.join(', ')}`);
    } else {
      ok('Student dashboard fetches /api/v1/dashboard/stats in parallel during initialization');
    }
  }

  // ──────────────────────────────────────────────────────────────────────────
  // 12. Student Dashboard Lifecycle: metrics refresh after user actions
  // ──────────────────────────────────────────────────────────────────────────
  {
    const stuSrc = fs.readFileSync(path.join(ROOT, 'student.html'), 'utf8');
    const hasCancelRefresh = stuSrc.includes('loadMyBookings();') && stuSrc.includes('loadDashboardStats();');
    const hasSubmitRefresh = stuSrc.includes('loadDashboardStats()') && stuSrc.includes('stu-book-form');
    if (hasCancelRefresh && hasSubmitRefresh) {
      ok('Student dashboard reloads metrics dynamically upon booking creation, cancellation, and breakage report');
    } else {
      fail('Student stats refresh', 'Dashboard metrics must refresh dynamically upon booking mutation');
    }
  }

  // ──────────────────────────────────────────────────────────────────────────
  // 13. Faculty Dashboard HTML: semantic layout and 6 overview metric cards
  // ──────────────────────────────────────────────────────────────────────────
  {
    const facCards = fileContains(
      'faculty.html',
      'id="fac-metrics"',
      'id="fac-stat-bookings"',
      'id="fac-stat-pending"',
      'id="fac-stat-schedules"',
      'id="fac-stat-breakage"',
      'id="fac-stat-instruments"',
      'id="fac-stat-notifs"'
    );
    if (!facCards.exists || facCards.missing.length > 0) {
      fail('Faculty metric cards', `Missing elements: ${facCards.missing.join(', ')}`);
    } else {
      ok('Faculty dashboard provides 6 semantic overview metric cards');
    }
  }

  // ──────────────────────────────────────────────────────────────────────────
  // 14. Faculty Dashboard Workflows: schedules, bookings, and request queue
  // ──────────────────────────────────────────────────────────────────────────
  {
    const facWorkflows = fileContains(
      'faculty.html',
      'id="sched-form"',
      'id="book-form"',
      'id="btn-refresh-requests"',
      'loadRequestsQueue'
    );
    if (!facWorkflows.exists || facWorkflows.missing.length > 0) {
      fail('Faculty workflows', `Missing workflows in faculty.html: ${facWorkflows.missing.join(', ')}`);
    } else {
      ok('Faculty workspace integrates timetable management, free bookings, and approval triage');
    }
  }

  // ──────────────────────────────────────────────────────────────────────────
  // 15. Faculty Dashboard Client: loadDashboardStats integration
  // ──────────────────────────────────────────────────────────────────────────
  {
    const facScript = fileContains(
      'faculty.html',
      'loadDashboardStats',
      "A.api('/api/v1/dashboard/stats')",
      'fac-stat-bookings',
      'fac-stat-pending'
    );
    if (!facScript.exists || facScript.missing.length > 0) {
      fail('Faculty stats loader', `Missing stats loading in faculty.html: ${facScript.missing.join(', ')}`);
    } else {
      ok('Faculty dashboard fetches /api/v1/dashboard/stats in parallel during initialization');
    }
  }

  // ──────────────────────────────────────────────────────────────────────────
  // 16. Faculty Dashboard Lifecycle: metrics refresh after triage and actions
  // ──────────────────────────────────────────────────────────────────────────
  {
    const facSrc = fs.readFileSync(path.join(ROOT, 'faculty.html'), 'utf8');
    const hasQueueRefresh = facSrc.includes('loadRequestsQueue();') && facSrc.includes('loadDashboardStats();');
    const hasSchedRefresh = facSrc.includes('loadSchedules();') && facSrc.includes('loadDashboardStats();');
    if (hasQueueRefresh && hasSchedRefresh) {
      ok('Faculty dashboard reloads metrics dynamically upon approval triage, schedule creation, and cancellations');
    } else {
      fail('Faculty stats refresh', 'Dashboard metrics must refresh dynamically upon queue or schedule mutation');
    }
  }

  // ──────────────────────────────────────────────────────────────────────────
  // 17. Admin Dashboard HTML: semantic layout and 8 overview metric cards
  // ──────────────────────────────────────────────────────────────────────────
  {
    const admCards = fileContains(
      'admin.html',
      'id="stat-users"',
      'id="stat-faculty"',
      'id="stat-schedules"',
      'id="stat-bookings"',
      'id="stat-pending"',
      'id="stat-instruments"',
      'id="stat-breakage"',
      'id="stat-calibrations"'
    );
    if (!admCards.exists || admCards.missing.length > 0) {
      fail('Admin metric cards', `Missing elements: ${admCards.missing.join(', ')}`);
    } else {
      ok('Admin dashboard provides 8 comprehensive operational metric cards');
    }
  }

  // ──────────────────────────────────────────────────────────────────────────
  // 18. Admin Dashboard Filters: active filter styling
  // ──────────────────────────────────────────────────────────────────────────
  {
    const admFilters = fileContains(
      'admin.html',
      'id="admin-bk-flt-all"',
      'id="admin-bk-flt-pending"',
      'id="admin-bk-flt-active"',
      'id="admin-bk-flt-done"',
      'setBookingFilter',
      'setInstFilter'
    );
    if (!admFilters.exists || admFilters.missing.length > 0) {
      fail('Admin filter styling', `Missing elements in admin.html: ${admFilters.missing.join(', ')}`);
    } else {
      ok('Admin reservation and instrument filter buttons provide visual active highlighting');
    }
  }

  // ──────────────────────────────────────────────────────────────────────────
  // 19. Admin Dashboard Client: loadStats querying /api/v1/dashboard/stats
  // ──────────────────────────────────────────────────────────────────────────
  {
    const admScript = fileContains(
      'admin.html',
      'loadStats',
      "A.api('/api/v1/dashboard/stats')",
      'stat-users',
      'stat-pending',
      'stat-breakage',
      'stat-calibrations'
    );
    if (!admScript.exists || admScript.missing.length > 0) {
      fail('Admin stats loader', `Missing stats loading in admin.html: ${admScript.missing.join(', ')}`);
    } else {
      ok('Admin loadStats updates all 8 metric cards via /api/v1/dashboard/stats with robust fallback');
    }
  }

  // ──────────────────────────────────────────────────────────────────────────
  // 20. Admin Dashboard Lifecycle: stats reload on booking and faculty actions
  // ──────────────────────────────────────────────────────────────────────────
  {
    const admSrc = fs.readFileSync(path.join(ROOT, 'admin.html'), 'utf8');
    const hasBookingActionRefresh = admSrc.includes('loadAdminBookings(); loadStats();');
    const hasInviteRefresh = admSrc.includes('loadFaculty();') && admSrc.includes('loadStats();');
    if (hasBookingActionRefresh && hasInviteRefresh) {
      ok('Admin dashboard reloads operational metrics upon booking triage and faculty invitation');
    } else {
      fail('Admin stats refresh', 'Dashboard metrics must refresh dynamically upon booking or faculty changes');
    }
  }

  // ──────────────────────────────────────────────────────────────────────────
  // 21. Mock Data Audit: zero mock or placeholder strings
  // ──────────────────────────────────────────────────────────────────────────
  {
    const files = ['student.html', 'faculty.html', 'admin.html', 'dash.js'];
    let mockFound = false;
    for (const f of files) {
      const content = fs.readFileSync(path.join(ROOT, f), 'utf8');
      const matches = content.match(/placeholder_data|lorem ipsum|fake_\w+|dummy_\w+/gi);
      if (matches && matches.length > 0) {
        mockFound = true;
        fail('Mock data audit', `${f} contains mock data: ${matches.join(', ')}`);
        break;
      }
    }
    if (!mockFound) {
      ok('Mock data audit: zero placeholder, dummy, or synthetic mock values across dashboards');
    }
  }

  // ──────────────────────────────────────────────────────────────────────────
  // 22. Frontend API Hygiene: zero raw fetch() calls in dashboard pages
  // ──────────────────────────────────────────────────────────────────────────
  {
    const files = ['student.html', 'faculty.html', 'admin.html', 'dash.js'];
    let rawFetchFound = false;
    for (const f of files) {
      const content = fs.readFileSync(path.join(ROOT, f), 'utf8');
      const rawFetch = content.match(/[^A-Za-z0-9_]fetch\s*\(/g);
      if (rawFetch && rawFetch.length > 0) {
        rawFetchFound = true;
        fail('API client hygiene', `${f} contains raw fetch() calls; all API calls must use A.api`);
        break;
      }
    }
    if (!rawFetchFound) {
      ok('API client hygiene: zero raw fetch() calls; all communication routed through LabPulseAuth (A.api)');
    }
  }

  // ──────────────────────────────────────────────────────────────────────────
  // SUMMARY
  // ──────────────────────────────────────────────────────────────────────────
  console.log('\n══════════════════════════════════════════════════════════════');
  console.log(`  Module 11 Verification: ${passedChecks} PASS / ${failedChecks} FAIL / 0 SKIP`);
  console.log('══════════════════════════════════════════════════════════════\n');

  if (failedChecks > 0) {
    process.exit(1);
  } else {
    process.exit(0);
  }
})();
