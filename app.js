/**
 * LabPulse — Centralized Laboratory Instrument Engine
 * Handles instrument filtering, dynamic booking (free), lockout toggles, QR pass generation, & background motion tracking.
 */

document.addEventListener('DOMContentLoaded', () => {
  initCustomCursor();
  initBackgroundParallax();
  initCategoryFilters();
  initBookingEngine();
  initSystemClock();
  initMobileMenu();
  initNoticeDialog();
  initEscHandling();
  initHeroOscilloscope();
  initInteractiveCardTilt();
});

/* ==========================================================================
   1. CUSTOM SMOOTH LERP CURSOR
   ========================================================================== */
function initCustomCursor() {
  const cursor = document.getElementById('custom-cursor');
  const follower = document.getElementById('custom-cursor-follower');
  if (!cursor || !follower) return;

  // Respect reduced-motion preferences: no custom cursor loop at all.
  if (typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    cursor.style.display = 'none';
    follower.style.display = 'none';
    return;
  }

  let mouseX = window.innerWidth / 2, mouseY = window.innerHeight / 2;
  let cursorX = mouseX, cursorY = mouseY;
  let followerX = mouseX, followerY = mouseY;

  window.addEventListener('mousemove', (e) => {
    mouseX = e.clientX;
    mouseY = e.clientY;
  });

  function renderCursor() {
    cursorX += (mouseX - cursorX) * 0.4;
    cursorY += (mouseY - cursorY) * 0.4;
    followerX += (mouseX - followerX) * 0.15;
    followerY += (mouseY - followerY) * 0.15;

    cursor.style.transform = `translate3d(${cursorX}px, ${cursorY}px, 0) translate(-50%, -50%)`;
    follower.style.transform = `translate3d(${followerX}px, ${followerY}px, 0) translate(-50%, -50%)`;

    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(renderCursor);
  }

  if (typeof requestAnimationFrame === 'function') requestAnimationFrame(renderCursor);

  const hoverables = document.querySelectorAll('a, button, select, input, .instrument-card, .floating-card');
  hoverables.forEach(el => {
    el.addEventListener('mouseenter', () => {
      follower.style.opacity = '1';
      follower.style.transform += ' scale(1.5)';
      cursor.style.transform += ' scale(1.3)';
    });

    el.addEventListener('mouseleave', () => {
      follower.style.opacity = '0';
    });
  });
}

/* ==========================================================================
   2. BACKGROUND PARALLAX MOTION TRACKING
   ========================================================================== */
function initBackgroundParallax() {
  // Respect reduced-motion preferences: hero stays static.
  if (typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const bgImg = document.getElementById('hero-bg-img');
  const floatingCards = document.querySelectorAll('.floating-card');

  let mouseX = window.innerWidth / 2;
  let mouseY = window.innerHeight / 2;
  let targetBgX = 0, targetBgY = 0;
  let currentBgX = 0, currentBgY = 0;

  window.addEventListener('mousemove', (e) => {
    mouseX = e.clientX;
    mouseY = e.clientY;
    const normX = (mouseX / window.innerWidth) - 0.5;
    const normY = (mouseY / window.innerHeight) - 0.5;

    targetBgX = normX * -30;
    targetBgY = normY * -30;
  });

  function renderParallax() {
    currentBgX += (targetBgX - currentBgX) * 0.05;
    currentBgY += (targetBgY - currentBgY) * 0.05;

    if (bgImg) {
      bgImg.style.transform = `translate3d(${currentBgX}px, ${currentBgY}px, 0) scale(1.12)`;
    }

    const normX = (mouseX / window.innerWidth) - 0.5;
    const normY = (mouseY / window.innerHeight) - 0.5;

    floatingCards.forEach(card => {
      const depth = parseFloat(card.getAttribute('data-depth')) || 0.15;
      const cardX = normX * (depth * 160);
      const cardY = normY * (depth * 160);
      card.style.transform = `translate3d(${cardX}px, ${cardY}px, 0)`;
    });

    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(renderParallax);
  }

  if (typeof requestAnimationFrame === 'function') requestAnimationFrame(renderParallax);
}

/* ==========================================================================
   3. CATALOG CATEGORY FILTER ENGINE
   ========================================================================== */
function initCategoryFilters() {
  const filterBtns = document.querySelectorAll('.filter-btn');
  const cards = document.querySelectorAll('.instrument-card');

  filterBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      filterBtns.forEach(b => {
        b.classList.remove('active', 'bg-vortex-cyan', 'text-vortex-black', 'font-bold');
        b.classList.add('text-vortex-gray');
      });

      btn.classList.add('active', 'bg-vortex-cyan', 'text-vortex-black', 'font-bold');
      btn.classList.remove('text-vortex-gray');

      const category = btn.getAttribute('data-cat');

      cards.forEach(card => {
        const cardCat = card.getAttribute('data-category');
        if (category === 'ALL' || cardCat === category) {
          card.style.display = 'flex';
        } else {
          card.style.display = 'none';
        }
      });
    });
  });
}

/* ==========================================================================
   4. RESERVATION ENGINE & MODALS
   ========================================================================== */
function initBookingEngine() {
  const openBtns = document.querySelectorAll('#btn-open-booking, #btn-open-booking-2, #btn-open-booking-mobile');
  const modal = document.getElementById('booking-modal');
  const closeBtn = document.getElementById('close-booking-modal');
  const form = document.getElementById('booking-form');
  const hoursInput = document.getElementById('book-hours');
  const instrumentSelect = document.getElementById('book-instrument-select');

  const qrModal = document.getElementById('qr-modal');
  const closeQrBtn = document.getElementById('close-qr-modal');

  /* Booking is FREE — no rates, no cost math, no grants (Phase 05). */

  openBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      modal.classList.remove('opacity-0', 'pointer-events-none');
      modal.classList.add('opacity-100', 'pointer-events-auto');
      const first = document.getElementById('book-instrument-select');
      if (first) first.focus();
    });
  });

  if (closeBtn) {
    closeBtn.addEventListener('click', () => {
      modal.classList.remove('opacity-100', 'pointer-events-auto');
      modal.classList.add('opacity-0', 'pointer-events-none');
    });
  }

  if (closeQrBtn) {
    closeQrBtn.addEventListener('click', () => {
      qrModal.classList.remove('opacity-100', 'pointer-events-auto');
      qrModal.classList.add('opacity-0', 'pointer-events-none');
    });
  }

  /* Handle Form Submission */
  if (form) {
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      
      const inst = instrumentSelect.value;
      const userName = document.getElementById('book-user-name').value;
      const purpose = document.getElementById('book-purpose').value || 'General research session';
      const date = document.getElementById('book-date').value || '2026-09-10';
      const time = document.getElementById('book-start-time').value || '14:00';
      const hrs = parseInt(hoursInput.value) || 2;
      const resId = `#RES-${Math.floor(1000 + Math.random() * 9000)}`;

      /* Append row to table */
      const tbody = document.getElementById('bookings-table-body');
      const newRow = document.createElement('tr');
      newRow.className = 'hover:bg-zinc-900/50 transition-colors animate-fade-in';
      newRow.innerHTML = `
        <td class="py-4 px-6 font-bold text-vortex-cyan">${resId}</td>
        <td class="py-4 px-6 text-vortex-white font-bold">${escapeHtml(inst)}</td>
        <td class="py-4 px-6">${escapeHtml(userName)}</td>
        <td class="py-4 px-6">${date}, ${time} (${hrs} hrs)</td>
        <td class="py-4 px-6">${escapeHtml(purpose)}</td>
        <td class="py-4 px-6"><span class="bg-vortex-emerald/20 text-vortex-emerald border border-vortex-emerald/40 px-2 py-0.5 text-[10px] font-bold">CONFIRMED</span></td>
        <td class="py-4 px-6 text-right">
          <button data-qr class="border border-vortex-cyan text-vortex-cyan px-3 py-1 text-[11px] hover:bg-vortex-cyan hover:text-vortex-black transition-colors">QR PASS</button>
        </td>
      `;
      newRow.querySelector('[data-qr]').addEventListener('click', () => showCheckInPass(resId, inst, userName));
      tbody.prepend(newRow);

      /* Close booking modal and show QR pass */
      modal.classList.remove('opacity-100', 'pointer-events-auto');
      modal.classList.add('opacity-0', 'pointer-events-none');
      
      showCheckInPass(resId, inst, userName);
      form.reset();
    });
  }
}

/* Escape user input before innerHTML insertion (Phase 05 hardening on touched lines). */
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/* Quick Book helper */
function quickBook(instrumentName) {
  const select = document.getElementById('book-instrument-select');
  if (select) {
    select.value = instrumentName;
  }
  const modal = document.getElementById('booking-modal');
  if (modal) {
    modal.classList.remove('opacity-0', 'pointer-events-none');
    modal.classList.add('opacity-100', 'pointer-events-auto');
  }
}

/* Lockout Toggle helper */
function toggleLockout(instrumentName) {
  showNotice(`Lockout toggled for: ${instrumentName}.\nInstrument availability updated in access matrix.`);
}

function renderAccessQrCode(containerId, details) {
  const container = document.getElementById(containerId);
  if (!container) return;
  container.innerHTML = '';

  const idText = details.reservationId || '#RES-9401';
  const instText = details.instrument || 'BRUKER AVANCE 600MHz NMR';
  const holderText = details.holder || 'Samantha Lee';
  const locText = details.location || 'Spectroscopy Wing · Room 304B';
  const winText = details.window || '14:00 - 16:00';
  const statusText = details.status || 'ACTIVE / VERIFIED';
  const interlockText = details.interlock || 'UNLOCKED / GRANTED';

  const qrText = [
    'LABPULSE HARDWARE ACCESS PASS',
    '==============================',
    `RESERVATION : ${idText}`,
    `INSTRUMENT  : ${instText}`,
    `HOLDER      : ${holderText}`,
    `LOCATION    : ${locText}`,
    `WINDOW      : ${winText}`,
    `STATUS      : ${statusText}`,
    `INTERLOCK   : ${interlockText}`,
    'SECURITY    : HMAC-SHA256 VERIFIED'
  ].join('\n');

  try {
    if (typeof QRCode !== 'undefined') {
      new QRCode(container, {
        text: qrText,
        width: 184,
        height: 184,
        colorDark: '#000000',
        colorLight: '#ffffff',
        correctLevel: QRCode.CorrectLevel.M
      });
      return;
    }
  } catch (err) {
    console.warn('QR Code generation fallback:', err);
  }

  const img = document.createElement('img');
  img.src = 'https://api.qrserver.com/v1/create-qr-code/?size=184x184&margin=2&data=' + encodeURIComponent(qrText);
  img.alt = 'Hardware Access QR Code';
  img.className = 'w-full h-full object-contain';
  container.appendChild(img);
}

/* Show QR Pass Modal */
function showCheckInPass(resId, instName, userName) {
  const qrModal = document.getElementById('qr-modal');
  if (!qrModal) return;

  const resEl = document.getElementById('qr-res-id');
  if (resEl) resEl.textContent = resId;
  const instEl = document.getElementById('qr-inst-name');
  if (instEl) instEl.textContent = instName;
  const userEl = document.getElementById('qr-user-name');
  if (userEl) userEl.textContent = `HOLDER: ${userName}`;

  renderAccessQrCode('qr-code-svg', {
    reservationId: resId,
    instrument: instName,
    holder: userName,
    location: 'Spectroscopy Wing · Room 304B',
    window: '14:00 - 16:00',
    status: 'ACTIVE / VERIFIED',
    interlock: 'UNLOCKED / GRANTED'
  });

  qrModal.classList.remove('opacity-0', 'pointer-events-none');
  qrModal.classList.add('opacity-100', 'pointer-events-auto');
  const qrClose = document.getElementById('close-qr-modal');
  if (qrClose) qrClose.focus();
}

function simulateCheckIn() {
  showNotice('Terminal session verified & interlock active.');
  const qrModal = document.getElementById('qr-modal');
  if (qrModal) {
    qrModal.classList.remove('opacity-100', 'pointer-events-auto');
    qrModal.classList.add('opacity-0', 'pointer-events-none');
  }
}

function downloadCertificate(assetCode) {
  showNotice(`Downloading NIST traceable calibration certificate for ${assetCode}...`);
}

function logCalibrationModal() {
  showNotice('Opening NIST calibration entry form.\nNew certification records will update asset compliance logs.');
}

/* ==========================================================================
   5. LIVE SYSTEM CLOCK
   ========================================================================== */
function initSystemClock() {
  const clockEl = document.getElementById('live-clock');
  if (!clockEl) return;

  function updateClock() {
    const now = new Date();
    const hours = String(now.getUTCHours()).padStart(2, '0');
    const minutes = String(now.getUTCMinutes()).padStart(2, '0');
    const seconds = String(now.getUTCSeconds()).padStart(2, '0');
    clockEl.textContent = `${hours}:${minutes}:${seconds} UTC`;
  }

  updateClock();
  setInterval(updateClock, 1000);
}

/* ==========================================================================
   6. MOBILE NAVIGATION (Phase 11 — booking reachable on small screens)
   ========================================================================== */
function initMobileMenu() {
  const openBtn = document.getElementById('btn-mobile-menu');
  const closeBtn = document.getElementById('btn-close-menu');
  const menu = document.getElementById('mobile-menu');
  if (!openBtn || !menu) return;

  function showMenu() {
    menu.classList.remove('hidden');
    menu.classList.add('flex');
    openBtn.setAttribute('aria-expanded', 'true');
    if (closeBtn) closeBtn.focus();
  }

  function hideMenu() {
    menu.classList.add('hidden');
    menu.classList.remove('flex');
    openBtn.setAttribute('aria-expanded', 'false');
  }

  openBtn.addEventListener('click', showMenu);
  if (closeBtn) closeBtn.addEventListener('click', hideMenu);
  menu.querySelectorAll('a, button').forEach(el => el.addEventListener('click', hideMenu));
  menu._hideMenu = hideMenu;
  openBtn._showMenu = showMenu;
}

function isMenuOpen() {
  const menu = document.getElementById('mobile-menu');
  return !!menu && !menu.classList.contains('hidden');
}

function hideMobileMenu() {
  const menu = document.getElementById('mobile-menu');
  if (menu && menu._hideMenu) menu._hideMenu();
}

/* ==========================================================================
   7. NOTICE DIALOG — custom confirmation system (Phase 11, replaces alert())
   ========================================================================== */
function showNotice(message) {
  const modal = document.getElementById('notice-modal');
  const msg = document.getElementById('notice-message');
  if (!modal || !msg) return;
  msg.textContent = message;
  modal.classList.remove('hidden');
  modal.classList.add('flex');
  const btn = document.getElementById('close-notice-modal');
  if (btn) btn.focus();
}

function hideNotice() {
  const modal = document.getElementById('notice-modal');
  if (!modal) return;
  modal.classList.add('hidden');
  modal.classList.remove('flex');
}

function isNoticeOpen() {
  const modal = document.getElementById('notice-modal');
  return !!modal && !modal.classList.contains('hidden');
}

function initNoticeDialog() {
  const btn = document.getElementById('close-notice-modal');
  if (btn) btn.addEventListener('click', hideNotice);
}

/* ==========================================================================
   8. ESC BEHAVIOR + modal visibility helpers (Phase 11)
   ========================================================================== */
function isModalOpen(id) {
  const el = document.getElementById(id);
  return !!el && !el.classList.contains('opacity-0');
}

function closeModal(id) {
  const el = document.getElementById(id);
  if (!el) return;
  el.classList.remove('opacity-100', 'pointer-events-auto');
  el.classList.add('opacity-0', 'pointer-events-none');
}

function initEscHandling() {
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (isNoticeOpen()) { hideNotice(); return; }
    if (isMenuOpen()) { hideMobileMenu(); return; }
    if (isModalOpen('qr-modal')) { closeModal('qr-modal'); return; }
    // Booking modal: close button only — ESC does not close it
    if (isModalOpen('booking-modal')) return;
  });
}

/* ==========================================================================
   9. INTERACTIVE HERO OSCILLOSCOPE WAVEFORM ENGINE
   ========================================================================== */
function initHeroOscilloscope() {
  const canvas = document.getElementById('hero-oscilloscope-canvas');
  const freqLabel = document.getElementById('oscilloscope-freq');
  if (!canvas) return;

  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  let width = (canvas.width = canvas.offsetWidth || 360);
  let height = (canvas.height = canvas.offsetHeight || 40);

  function resize() {
    if (!canvas.offsetWidth) return;
    width = canvas.width = canvas.offsetWidth;
    height = canvas.height = canvas.offsetHeight || 40;
  }
  window.addEventListener('resize', resize);

  let mouseX = -1000;
  let isHovered = false;

  canvas.addEventListener('mousemove', (e) => {
    const rect = canvas.getBoundingClientRect();
    mouseX = (e.clientX - rect.left) / rect.width;
    isHovered = true;
  });

  canvas.addEventListener('mouseleave', () => {
    isHovered = false;
  });

  let t = 0;
  function draw() {
    t += isHovered ? 0.08 : 0.035;
    ctx.clearRect(0, 0, width, height);

    // Draw central guide baseline
    ctx.strokeStyle = 'rgba(0, 245, 212, 0.15)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, height / 2);
    ctx.lineTo(width, height / 2);
    ctx.stroke();

    // Harmonic telemetry waves
    const waves = [
      { color: 'rgba(0, 245, 212, 0.90)', freq: 0.032, amp: height * 0.32, speed: 1.0, glow: 10 },
      { color: 'rgba(16, 185, 129, 0.70)', freq: 0.052, amp: height * 0.22, speed: 1.35, glow: 6 },
      { color: 'rgba(168, 85, 247, 0.50)', freq: 0.022, amp: height * 0.18, speed: 0.7, glow: 4 }
    ];

    const mouseMod = isHovered && mouseX >= 0 ? 1 + (mouseX - 0.5) * 1.6 : 1;
    if (freqLabel && isHovered) {
      const liveFreq = (599.8 + (mouseX * 0.4)).toFixed(2);
      freqLabel.textContent = `${liveFreq} MHz · BEAM MODULATED`;
    } else if (freqLabel && Math.random() < 0.015) {
      freqLabel.textContent = '599.98 MHz · OPTIMAL';
    }

    waves.forEach(w => {
      ctx.beginPath();
      ctx.strokeStyle = w.color;
      ctx.lineWidth = 1.5;
      ctx.shadowBlur = w.glow;
      ctx.shadowColor = w.color;

      for (let x = 0; x < width; x += 2) {
        const sineVal = Math.sin(x * w.freq * mouseMod + t * w.speed) *
                        Math.cos(x * 0.012 + t * 0.45);
        const y = (height / 2) + sineVal * w.amp;
        if (x === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.stroke();
    });

    if (typeof requestAnimationFrame === 'function') {
      if (typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
      requestAnimationFrame(draw);
    }
  }

  draw();
}

/* ==========================================================================
   10. INTERACTIVE 3D PERSPECTIVE CARD TILT ENGINE
   ========================================================================== */
function initInteractiveCardTilt() {
  if (typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;

  const tiltCards = document.querySelectorAll('.interactive-tilt');
  tiltCards.forEach(card => {
    let bounds = card.getBoundingClientRect();

    card.addEventListener('mouseenter', () => {
      bounds = card.getBoundingClientRect();
    });

    card.addEventListener('mousemove', (e) => {
      const mouseX = e.clientX - bounds.left;
      const mouseY = e.clientY - bounds.top;
      const normX = (mouseX / bounds.width) - 0.5;
      const normY = (mouseY / bounds.height) - 0.5;

      const rotY = normX * 10; // degrees
      const rotX = -normY * 10; // degrees

      card.style.transform = `perspective(1000px) rotateX(${rotX.toFixed(2)}deg) rotateY(${rotY.toFixed(2)}deg) scale3d(1.015, 1.015, 1.015)`;
    });

    card.addEventListener('mouseleave', () => {
      card.style.transform = 'perspective(1000px) rotateX(0deg) rotateY(0deg) scale3d(1, 1, 1)';
    });
  });
}
