/**
 * Booking Lifecycle State Machine (Module 07)
 * Authoritative service defining allowed booking statuses, transitions,
 * and role-based action permissions.
 */

const BOOKING_STATUS = {
  PENDING_APPROVAL: 'PENDING_APPROVAL',
  CONFIRMED: 'CONFIRMED',
  CHECKED_IN: 'CHECKED_IN',
  COMPLETED: 'COMPLETED',
  CANCELLED: 'CANCELLED',
  REJECTED: 'REJECTED',
  NO_SHOW: 'NO_SHOW',
};

const BLOCKING_STATUSES = [
  BOOKING_STATUS.PENDING_APPROVAL,
  BOOKING_STATUS.CONFIRMED,
  BOOKING_STATUS.CHECKED_IN,
];

const TERMINAL_STATUSES = [
  BOOKING_STATUS.COMPLETED,
  BOOKING_STATUS.CANCELLED,
  BOOKING_STATUS.REJECTED,
  BOOKING_STATUS.NO_SHOW,
];

const STATUS_TRANSITIONS = {
  [BOOKING_STATUS.PENDING_APPROVAL]: [
    BOOKING_STATUS.CONFIRMED,
    BOOKING_STATUS.REJECTED,
    BOOKING_STATUS.CANCELLED,
  ],
  [BOOKING_STATUS.CONFIRMED]: [
    BOOKING_STATUS.CHECKED_IN,
    BOOKING_STATUS.CANCELLED,
    BOOKING_STATUS.NO_SHOW,
    BOOKING_STATUS.COMPLETED,
  ],
  [BOOKING_STATUS.CHECKED_IN]: [
    BOOKING_STATUS.COMPLETED,
  ],
  [BOOKING_STATUS.REJECTED]: [],
  [BOOKING_STATUS.CANCELLED]: [],
  [BOOKING_STATUS.COMPLETED]: [],
  [BOOKING_STATUS.NO_SHOW]: [],
};

/**
 * Validates whether a state transition is legal and authorized for the acting user.
 *
 * @param {string} currentStatus - Active booking status
 * @param {string} targetStatus - Desired target status
 * @param {object} user - Acting authenticated user (with role, _id/id)
 * @param {string} bookingOwnerId - User ID who owns the booking
 * @returns {{ allowed: boolean, status?: number, code?: string, message?: string }}
 */
function validateStatusTransition(currentStatus, targetStatus, user, bookingOwnerId) {
  if (!currentStatus || !targetStatus) {
    return { allowed: false, status: 400, code: 'VALIDATION_ERROR', message: 'Current and target statuses are required.' };
  }

  if (currentStatus === targetStatus) {
    return { allowed: true }; // No-op transition
  }

  const allowedNext = STATUS_TRANSITIONS[currentStatus];
  if (!allowedNext || !allowedNext.includes(targetStatus)) {
    return {
      allowed: false,
      status: 422,
      code: 'INVALID_STATUS_TRANSITION',
      message: `Cannot transition booking from ${currentStatus} to ${targetStatus}.`,
    };
  }

  const role = user.role || 'student';
  const currentUserId = String(user._id || user.id);
  const isOwner = String(bookingOwnerId) === currentUserId;

  // 1. CANCEL: Admin can cancel any; Owner (faculty or student) can cancel own.
  if (targetStatus === BOOKING_STATUS.CANCELLED) {
    if (role === 'admin' || isOwner) {
      return { allowed: true };
    }
    return {
      allowed: false,
      status: 403,
      code: 'FORBIDDEN',
      message: 'You can only cancel your own bookings.',
    };
  }

  // 2. APPROVE / REJECT: Admin or Faculty only.
  if (targetStatus === BOOKING_STATUS.CONFIRMED || targetStatus === BOOKING_STATUS.REJECTED) {
    if (currentStatus === BOOKING_STATUS.PENDING_APPROVAL) {
      if (role === 'admin' || role === 'faculty') {
        return { allowed: true };
      }
      return {
        allowed: false,
        status: 403,
        code: 'FORBIDDEN',
        message: 'Only faculty or administrators can approve or reject booking requests.',
      };
    }
  }

  // 3. CHECK_IN: System/terminal QR scanner or authorized operator.
  if (targetStatus === BOOKING_STATUS.CHECKED_IN) {
    if (role === 'admin' || role === 'faculty') {
      return { allowed: true };
    }
    return {
      allowed: false,
      status: 400,
      code: 'VALIDATION_ERROR',
      message: 'Check-in is handled via terminal QR scan.',
    };
  }

  // 4. COMPLETE: Admin, Faculty, or Owner when session finishes.
  if (targetStatus === BOOKING_STATUS.COMPLETED) {
    if (role === 'admin' || role === 'faculty' || isOwner) {
      return { allowed: true };
    }
    return {
      allowed: false,
      status: 403,
      code: 'FORBIDDEN',
      message: 'Not authorized to complete this booking.',
    };
  }

  // 5. NO_SHOW: Admin or supervising Faculty only.
  if (targetStatus === BOOKING_STATUS.NO_SHOW) {
    if (role === 'admin' || role === 'faculty') {
      return { allowed: true };
    }
    return {
      allowed: false,
      status: 403,
      code: 'FORBIDDEN',
      message: 'Only administrators or faculty can record a no-show.',
    };
  }

  return { allowed: true };
}

module.exports = {
  BOOKING_STATUS,
  BLOCKING_STATUSES,
  TERMINAL_STATUSES,
  STATUS_TRANSITIONS,
  validateStatusTransition,
};
