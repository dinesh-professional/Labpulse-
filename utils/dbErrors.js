/**
 * Database Error Translation Utility (Module 06)
 * Normalizes PostgreSQL error codes into consistent LabPulse API errors.
 * Guarantees that internal database error messages, table definitions, or query strings
 * are never leaked to external clients.
 */

function translateDbError(err, context = {}) {
  if (!err) return null;

  // PostgreSQL / Supabase Error Code mappings
  const code = err.code || (err.details && err.details.code);
  const message = err.message || '';

  // 1. Exclusion constraint violation (PostgreSQL 23P01)
  if (code === '23P01' || message.includes('active_booking_no_overlap') || message.includes('exclusion')) {
    return {
      status: 409,
      code: 'BOOKING_CONFLICT',
      message: 'The requested instrument is already booked or reserved during this timeslot.',
    };
  }

  // 2. Unique constraint violation (PostgreSQL 23505 or MongoDB 11000)
  if (code === '23505' || code === 11000 || message.includes('duplicate key') || message.includes('unique constraint')) {
    let field = 'item';
    if (message.includes('email') || (err.details && err.details.includes('email'))) {
      field = 'Email';
    } else if (message.includes('serial_number') || message.includes('serialNumber')) {
      field = 'Serial number';
    } else if (message.includes('faculty_id') || message.includes('facultyId')) {
      field = 'Faculty ID';
    }
    return {
      status: 409,
      code: 'DUPLICATE_RESOURCE',
      message: `${field} is already registered or in use.`,
    };
  }

  // 3. Foreign key violation (PostgreSQL 23503)
  if (code === '23503' || message.includes('foreign key constraint')) {
    return {
      status: 400,
      code: 'INVALID_REFERENCE',
      message: 'Referenced entity does not exist.',
    };
  }

  // 4. Check constraint violation (PostgreSQL 23514)
  if (code === '23514' || message.includes('check constraint')) {
    return {
      status: 422,
      code: 'VALIDATION_ERROR',
      message: 'Data values violate database check constraints.',
    };
  }

  // 5. Not null violation (PostgreSQL 23502)
  if (code === '23502' || message.includes('not-null constraint')) {
    return {
      status: 400,
      code: 'VALIDATION_ERROR',
      message: 'Required database column cannot be null.',
    };
  }

  // Fallback generic database error
  return {
    status: 500,
    code: 'DATABASE_ERROR',
    message: 'An unexpected database error occurred.',
  };
}

module.exports = { translateDbError };
