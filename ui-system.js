/**
 * LabPulse Reusable UI Interaction System (Module 02)
 * Provides accessible, lightweight vanilla UI primitives:
 * - Toast notification pipeline (ARIA live region)
 * - Accessible Modal Dialogs (Focus trap, Esc dismissal, focus restoration)
 * - Button loading states with screen-reader feedback
 * - Table filtering & clipboard utilities
 */
(function () {
  'use strict';

  var activeModal = null;
  var previousActiveElement = null;
  var toastContainer = null;

  /* ──────────────────────────────────────────────
     1. TOAST NOTIFICATION SUBSYSTEM
     ────────────────────────────────────────────── */
  function ensureToastContainer() {
    if (!toastContainer) {
      toastContainer = document.getElementById('lp-toast-container');
      if (!toastContainer) {
        toastContainer = document.createElement('div');
        toastContainer.id = 'lp-toast-container';
        toastContainer.setAttribute('aria-live', 'polite');
        toastContainer.setAttribute('aria-atomic', 'true');
        toastContainer.style.position = 'fixed';
        toastContainer.style.bottom = '1.5rem';
        toastContainer.style.right = '1.5rem';
        toastContainer.style.zIndex = '9990';
        toastContainer.style.display = 'flex';
        toastContainer.style.flexDirection = 'column';
        toastContainer.style.gap = '0.75rem';
        toastContainer.style.maxWidth = '24rem';
        toastContainer.style.pointerEvents = 'none';
        document.body.appendChild(toastContainer);
      }
    }
    return toastContainer;
  }

  function toast(options) {
    options = options || {};
    var title = options.title || 'Notification';
    var message = options.message || '';
    var type = options.type || 'info'; // info, success, warning, error
    var duration = typeof options.duration === 'number' ? options.duration : 4000;

    var container = ensureToastContainer();

    var toastEl = document.createElement('div');
    toastEl.className = 'lp-toast lp-alert lp-alert-' + type;
    toastEl.setAttribute('role', type === 'error' ? 'alert' : 'status');
    toastEl.style.pointerEvents = 'auto';
    toastEl.style.boxShadow = '0 10px 30px rgba(0, 0, 0, 0.5)';
    toastEl.style.margin = '0';
    toastEl.style.transform = 'translateY(1rem)';
    toastEl.style.opacity = '0';
    toastEl.style.transition = 'all 200ms cubic-bezier(0.16, 1, 0.3, 1)';

    var iconMap = {
      success: '✓',
      warning: '⚠',
      error: '✕',
      info: 'ℹ'
    };

    var content = document.createElement('div');
    content.style.flex = '1';

    var titleEl = document.createElement('strong');
    titleEl.style.display = 'block';
    titleEl.style.fontWeight = '700';
    titleEl.style.fontFamily = 'var(--lp-font-mono)';
    titleEl.style.letterSpacing = '0.04em';
    titleEl.textContent = (iconMap[type] || '•') + ' ' + title;
    content.appendChild(titleEl);

    if (message) {
      var msgEl = document.createElement('span');
      msgEl.style.display = 'block';
      msgEl.style.marginTop = '0.25rem';
      msgEl.style.opacity = '0.9';
      msgEl.textContent = message;
      content.appendChild(msgEl);
    }

    var closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.setAttribute('aria-label', 'Dismiss notification');
    closeBtn.textContent = '×';
    closeBtn.style.background = 'none';
    closeBtn.style.border = 'none';
    closeBtn.style.color = 'currentColor';
    closeBtn.style.fontSize = '1.25rem';
    closeBtn.style.cursor = 'pointer';
    closeBtn.style.lineHeight = '1';
    closeBtn.style.padding = '0 0.25rem';

    function dismiss() {
      toastEl.style.opacity = '0';
      toastEl.style.transform = 'translateY(1rem)';
      setTimeout(function () {
        if (toastEl.parentNode) {
          toastEl.parentNode.removeChild(toastEl);
        }
      }, 200);
    }

    closeBtn.addEventListener('click', dismiss);

    toastEl.appendChild(content);
    toastEl.appendChild(closeBtn);
    container.appendChild(toastEl);

    // Animate in
    requestAnimationFrame(function () {
      toastEl.style.opacity = '1';
      toastEl.style.transform = 'translateY(0)';
    });

    if (duration > 0) {
      setTimeout(dismiss, duration);
    }

    return { dismiss: dismiss };
  }

  /* ──────────────────────────────────────────────
     2. ACCESSIBLE MODAL DIALOG CONTROLLER
     ────────────────────────────────────────────── */
  function getFocusableElements(modalEl) {
    return Array.from(modalEl.querySelectorAll(
      'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
    ));
  }

  function handleModalKeyDown(e) {
    if (!activeModal) return;

    // ESC to close
    if (e.key === 'Escape' || e.keyCode === 27) {
      e.preventDefault();
      closeModal(activeModal.id);
      return;
    }

    // Tab key focus trap
    if (e.key === 'Tab' || e.keyCode === 9) {
      var focusables = getFocusableElements(activeModal);
      if (focusables.length === 0) {
        e.preventDefault();
        return;
      }
      var first = focusables[0];
      var last = focusables[focusables.length - 1];

      if (e.shiftKey) {
        if (document.activeElement === first) {
          e.preventDefault();
          last.focus();
        }
      } else {
        if (document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    }
  }

  function openModal(modalId) {
    var modal = document.getElementById(modalId);
    if (!modal) return;

    previousActiveElement = document.activeElement;
    activeModal = modal;

    modal.classList.remove('hidden');
    modal.style.display = 'flex';
    modal.setAttribute('aria-hidden', 'false');

    // Attach trap listener
    document.addEventListener('keydown', handleModalKeyDown);

    // Focus first focusable or dialog
    var focusables = getFocusableElements(modal);
    if (focusables.length > 0) {
      focusables[0].focus();
    } else {
      modal.setAttribute('tabindex', '-1');
      modal.focus();
    }

    document.body.style.overflow = 'hidden';
  }

  function closeModal(modalId) {
    var modal = document.getElementById(modalId) || activeModal;
    if (!modal) return;

    modal.classList.add('hidden');
    modal.style.display = 'none';
    modal.setAttribute('aria-hidden', 'true');

    document.removeEventListener('keydown', handleModalKeyDown);
    activeModal = null;
    document.body.style.overflow = '';

    // Restore focus
    if (previousActiveElement && typeof previousActiveElement.focus === 'function') {
      previousActiveElement.focus();
      previousActiveElement = null;
    }
  }

  /* ──────────────────────────────────────────────
     3. BUTTON LOADING STATE HELPER
     ────────────────────────────────────────────── */
  function setButtonLoading(button, isLoading, loadingText) {
    if (!button) return;
    if (isLoading) {
      button.dataset.originalText = button.innerHTML;
      button.disabled = true;
      button.classList.add('is-loading');
      button.setAttribute('aria-busy', 'true');
      if (loadingText) {
        button.setAttribute('aria-label', loadingText);
      }
    } else {
      button.disabled = false;
      button.classList.remove('is-loading');
      button.removeAttribute('aria-busy');
      if (button.dataset.originalText) {
        button.innerHTML = button.dataset.originalText;
        delete button.dataset.originalText;
      }
      button.removeAttribute('aria-label');
    }
  }

  /* ──────────────────────────────────────────────
     4. CLIPBOARD COPY UTILITY
     ────────────────────────────────────────────── */
  async function copyToClipboard(text, feedbackElement) {
    try {
      await navigator.clipboard.writeText(text);
      if (feedbackElement) {
        var original = feedbackElement.textContent;
        feedbackElement.textContent = 'COPIED!';
        setTimeout(function () {
          feedbackElement.textContent = original;
        }, 1500);
      }
      toast({ title: 'COPIED', message: 'Copied to clipboard.', type: 'success', duration: 2000 });
      return true;
    } catch (err) {
      toast({ title: 'COPY FAILED', message: 'Unable to copy text.', type: 'error' });
      return false;
    }
  }

  // Export to global window namespace
  window.LabPulseUI = {
    toast: toast,
    openModal: openModal,
    closeModal: closeModal,
    setButtonLoading: setButtonLoading,
    copyToClipboard: copyToClipboard
  };
})();
