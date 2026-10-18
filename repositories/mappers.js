/**
 * Relational-to-Application Domain Mappers (Module 06)
 * Handles bidirectional translation between snake_case PostgreSQL records
 * and camelCase Express/Mongoose API contracts.
 * Preserves both `id` and `_id` so frontend consumers and existing tests
 * continue to function seamlessly without contract breakage.
 */

// ------------------------------------------------------------------------------
// 1. Profiles / Users
// ------------------------------------------------------------------------------
function mapProfileToApp(row) {
  if (!row) return null;
  const idStr = String(row.id);
  return {
    id: idStr,
    _id: idStr,
    name: row.name,
    email: row.email,
    role: row.role,
    department: row.department || null,
    facultyId: row.faculty_id || null,
    studentId: row.student_id || null,
    year: row.year || null,
    section: row.section || null,
    isActive: row.is_active !== false,
    emailVerified: !!row.email_verified,
    tokenVersion: row.token_version || 0,
    createdBy: row.created_by ? String(row.created_by) : null,
    createdAt: row.created_at ? new Date(row.created_at) : new Date(),
    updatedAt: row.updated_at ? new Date(row.updated_at) : new Date(),
    toSafeJSON() {
      return {
        id: this.id,
        name: this.name,
        email: this.email,
        role: this.role,
        department: this.department,
        facultyId: this.facultyId,
        studentId: this.studentId,
        year: this.year,
        section: this.section,
        isActive: this.isActive,
      };
    },
  };
}

function mapAppToProfile(obj) {
  if (!obj) return {};
  const out = {};
  if (obj.id) out.id = obj.id;
  if (obj.name !== undefined) out.name = obj.name;
  if (obj.email !== undefined) out.email = obj.email.toLowerCase().trim();
  if (obj.role !== undefined) out.role = obj.role;
  if (obj.department !== undefined) out.department = obj.department;
  if (obj.facultyId !== undefined) out.faculty_id = obj.facultyId;
  if (obj.studentId !== undefined) out.student_id = obj.studentId;
  if (obj.year !== undefined) out.year = obj.year;
  if (obj.section !== undefined) out.section = obj.section;
  if (obj.isActive !== undefined) out.is_active = obj.isActive;
  if (obj.emailVerified !== undefined) out.email_verified = obj.emailVerified;
  if (obj.tokenVersion !== undefined) out.token_version = obj.tokenVersion;
  if (obj.createdBy !== undefined) out.created_by = obj.createdBy;
  return out;
}

// ------------------------------------------------------------------------------
// 2. Laboratories
// ------------------------------------------------------------------------------
function mapLaboratoryToApp(row) {
  if (!row) return null;
  const idStr = String(row.id);
  return {
    id: idStr,
    _id: idStr,
    name: row.name,
    department: row.department || null,
    building: row.building || null,
    roomNumber: row.room_number || null,
    capacity: row.capacity || 0,
    status: row.status || 'AVAILABLE',
    createdAt: row.created_at ? new Date(row.created_at) : new Date(),
    updatedAt: row.updated_at ? new Date(row.updated_at) : new Date(),
  };
}

function mapAppToLaboratory(obj) {
  if (!obj) return {};
  const out = {};
  if (obj.id) out.id = obj.id;
  if (obj.name !== undefined) out.name = obj.name;
  if (obj.department !== undefined) out.department = obj.department;
  if (obj.building !== undefined) out.building = obj.building;
  if (obj.roomNumber !== undefined) out.room_number = obj.roomNumber;
  if (obj.capacity !== undefined) out.capacity = obj.capacity;
  if (obj.status !== undefined) out.status = obj.status;
  return out;
}

// ------------------------------------------------------------------------------
// 3. Instruments
// ------------------------------------------------------------------------------
function mapInstrumentToApp(row) {
  if (!row) return null;
  const idStr = String(row.id);
  return {
    id: idStr,
    _id: idStr,
    laboratoryId: row.laboratory_id ? String(row.laboratory_id) : null,
    name: row.name,
    category: row.category,
    model: row.model || null,
    serialNumber: row.serial_number,
    status: row.status || 'AVAILABLE',
    breakageFee: row.breakage_fee !== undefined ? Number(row.breakage_fee) : 0,
    requiredQualificationLevel: row.required_qualification_level || 0,
    lastCalibrationDate: row.last_calibration_date ? new Date(row.last_calibration_date) : null,
    nextCalibrationDue: row.next_calibration_due ? new Date(row.next_calibration_due) : null,
    calibrationFrequencyDays: row.calibration_frequency_days || null,
    lifecycleState: row.lifecycle_state || 'COMMISSIONED',
    assetTag: row.asset_tag || null,
    manufacturer: row.manufacturer || null,
    location: row.location || null,
    responsiblePerson: row.responsible_person || null,
    installationDate: row.installation_date ? new Date(row.installation_date) : null,
    decommissionedDate: row.decommissioned_date ? new Date(row.decommissioned_date) : null,
    operationalRestrictions: row.operational_restrictions || null,
    unavailabilityReason: row.unavailability_reason || null,
    notes: row.notes || null,
    createdAt: row.created_at ? new Date(row.created_at) : new Date(),
    updatedAt: row.updated_at ? new Date(row.updated_at) : new Date(),
  };
}

function mapAppToInstrument(obj) {
  if (!obj) return {};
  const out = {};
  if (obj.id) out.id = obj.id;
  if (obj.laboratoryId !== undefined) out.laboratory_id = obj.laboratoryId;
  if (obj.name !== undefined) out.name = obj.name;
  if (obj.category !== undefined) out.category = obj.category;
  if (obj.model !== undefined) out.model = obj.model;
  if (obj.serialNumber !== undefined) out.serial_number = obj.serialNumber;
  if (obj.status !== undefined) out.status = obj.status;
  if (obj.breakageFee !== undefined) out.breakage_fee = obj.breakageFee;
  if (obj.requiredQualificationLevel !== undefined) out.required_qualification_level = obj.requiredQualificationLevel;
  if (obj.lastCalibrationDate !== undefined) out.last_calibration_date = obj.lastCalibrationDate;
  if (obj.nextCalibrationDue !== undefined) out.next_calibration_due = obj.nextCalibrationDue;
  if (obj.calibrationFrequencyDays !== undefined) out.calibration_frequency_days = obj.calibrationFrequencyDays;
  if (obj.lifecycleState !== undefined) out.lifecycle_state = obj.lifecycleState;
  if (obj.assetTag !== undefined) out.asset_tag = obj.assetTag;
  if (obj.manufacturer !== undefined) out.manufacturer = obj.manufacturer;
  if (obj.location !== undefined) out.location = obj.location;
  if (obj.responsiblePerson !== undefined) out.responsible_person = obj.responsiblePerson;
  if (obj.installationDate !== undefined) out.installation_date = obj.installationDate;
  if (obj.decommissionedDate !== undefined) out.decommissioned_date = obj.decommissionedDate;
  if (obj.operationalRestrictions !== undefined) out.operational_restrictions = obj.operationalRestrictions;
  if (obj.unavailabilityReason !== undefined) out.unavailability_reason = obj.unavailabilityReason;
  if (obj.notes !== undefined) out.notes = obj.notes;
  return out;
}

// ------------------------------------------------------------------------------
// 4. Schedules
// ------------------------------------------------------------------------------
function mapScheduleToApp(row) {
  if (!row) return null;
  const idStr = String(row.id);
  return {
    id: idStr,
    _id: idStr,
    degree: row.degree,
    department: row.department,
    year: row.year,
    section: row.section,
    subject: row.subject,
    laboratoryId: row.laboratory_id ? String(row.laboratory_id) : null,
    facultyId: row.faculty_id ? (typeof row.faculty_id === 'object' ? row.faculty_id : String(row.faculty_id)) : null,
    date: row.date ? new Date(row.date) : new Date(),
    startTime: row.start_time ? String(row.start_time).slice(0, 5) : '00:00',
    endTime: row.end_time ? String(row.end_time).slice(0, 5) : '00:00',
    status: row.status || 'SCHEDULED',
    sessionType: row.session_type || null,
    studentCount: row.student_count || 0,
    notes: row.notes || null,
    createdAt: row.created_at ? new Date(row.created_at) : new Date(),
    updatedAt: row.updated_at ? new Date(row.updated_at) : new Date(),
  };
}

function mapAppToSchedule(obj) {
  if (!obj) return {};
  const out = {};
  if (obj.id) out.id = obj.id;
  if (obj.degree !== undefined) out.degree = obj.degree;
  if (obj.department !== undefined) out.department = obj.department;
  if (obj.year !== undefined) out.year = obj.year;
  if (obj.section !== undefined) out.section = obj.section;
  if (obj.subject !== undefined) out.subject = obj.subject;
  if (obj.laboratoryId !== undefined) out.laboratory_id = obj.laboratoryId;
  if (obj.facultyId !== undefined) out.faculty_id = obj.facultyId;
  if (obj.date !== undefined) out.date = obj.date;
  if (obj.startTime !== undefined) out.start_time = obj.startTime;
  if (obj.endTime !== undefined) out.end_time = obj.endTime;
  if (obj.startAt !== undefined) out.start_at = obj.startAt;
  if (obj.endAt !== undefined) out.end_at = obj.endAt;
  if (obj.status !== undefined) out.status = obj.status;
  if (obj.sessionType !== undefined) out.session_type = obj.sessionType;
  if (obj.studentCount !== undefined) out.student_count = obj.studentCount;
  if (obj.notes !== undefined) out.notes = obj.notes;
  return out;
}

// ------------------------------------------------------------------------------
// 5. Bookings
// ------------------------------------------------------------------------------
function mapBookingToApp(row) {
  if (!row) return null;
  const idStr = String(row.id);
  const out = {
    id: idStr,
    _id: idStr,
    instrumentId: row.instruments
      ? {
          _id: String(row.instruments.id),
          id: String(row.instruments.id),
          name: row.instruments.name,
          category: row.instruments.category,
          model: row.instruments.model,
          status: row.instruments.status,
        }
      : (row.instrument_id ? String(row.instrument_id) : null),
    userId: row.profiles
      ? {
          _id: String(row.profiles.id),
          id: String(row.profiles.id),
          name: row.profiles.name,
          email: row.profiles.email,
        }
      : (row.user_id ? String(row.user_id) : null),
    date: row.date ? new Date(row.date) : new Date(),
    startTime: row.start_time ? String(row.start_time).slice(0, 5) : '00:00',
    endTime: row.end_time ? String(row.end_time).slice(0, 5) : '00:00',
    startAt: row.start_at ? new Date(row.start_at) : null,
    endAt: row.end_at ? new Date(row.end_at) : null,
    purpose: row.purpose,
    status: row.status || 'CONFIRMED',
    qrPassId: row.qr_pass_id ? String(row.qr_pass_id) : null,
    idempotencyKey: row.idempotency_key || null,
    approvalNotes: row.approval_notes || null,
    rejectionReason: row.rejection_reason || null,
    approvedBy: row.approved_by ? String(row.approved_by) : null,
    approvedAt: row.approved_at ? new Date(row.approved_at) : null,
    createdAt: row.created_at ? new Date(row.created_at) : new Date(),
    updatedAt: row.updated_at ? new Date(row.updated_at) : new Date(),
  };
  return out;
}

function mapAppToBooking(obj) {
  if (!obj) return {};
  const out = {};
  if (obj.id) out.id = obj.id;
  if (obj.instrumentId !== undefined) out.instrument_id = obj.instrumentId;
  if (obj.userId !== undefined) out.user_id = obj.userId;
  if (obj.date !== undefined) out.date = obj.date;
  if (obj.startTime !== undefined) out.start_time = obj.startTime;
  if (obj.endTime !== undefined) out.end_time = obj.endTime;
  if (obj.startAt !== undefined) out.start_at = obj.startAt;
  if (obj.endAt !== undefined) out.end_at = obj.endAt;
  if (obj.purpose !== undefined) out.purpose = obj.purpose;
  if (obj.status !== undefined) out.status = obj.status;
  if (obj.idempotencyKey !== undefined) out.idempotency_key = obj.idempotencyKey;
  if (obj.approvalNotes !== undefined) out.approval_notes = obj.approvalNotes;
  if (obj.rejectionReason !== undefined) out.rejection_reason = obj.rejectionReason;
  if (obj.approvedBy !== undefined) out.approved_by = obj.approvedBy;
  if (obj.approvedAt !== undefined) out.approved_at = obj.approvedAt;
  return out;
}

// ------------------------------------------------------------------------------
// 6. Calibrations
// ------------------------------------------------------------------------------
function mapCalibrationToApp(row) {
  if (!row) return null;
  const idStr = String(row.id);
  return {
    id: idStr,
    _id: idStr,
    instrumentId: row.instrument_id ? String(row.instrument_id) : null,
    technicianId: row.technician_id ? String(row.technician_id) : null,
    calibrationType: row.calibration_type,
    date: row.date ? new Date(row.date) : new Date(),
    startTime: row.start_time ? String(row.start_time).slice(0, 5) : '00:00',
    endTime: row.end_time ? String(row.end_time).slice(0, 5) : '00:00',
    startAt: row.start_at ? new Date(row.start_at) : null,
    endAt: row.end_at ? new Date(row.end_at) : null,
    standard: row.standard || null,
    status: row.status || 'CALIBRATION_SCHEDULED',
    result: row.result || 'PENDING',
    performedDate: row.performed_date ? new Date(row.performed_date) : null,
    referenceStandard: row.reference_standard || null,
    certificateNumber: row.certificate_number || null,
    drift: row.drift || null,
    tolerance: row.tolerance || null,
    certificateUrl: row.certificate_url || null,
    notes: row.notes || null,
    createdAt: row.created_at ? new Date(row.created_at) : new Date(),
    updatedAt: row.updated_at ? new Date(row.updated_at) : new Date(),
  };
}

function mapAppToCalibration(obj) {
  if (!obj) return {};
  const out = {};
  if (obj.id) out.id = obj.id;
  if (obj.instrumentId !== undefined) out.instrument_id = obj.instrumentId;
  if (obj.technicianId !== undefined) out.technician_id = obj.technicianId;
  if (obj.calibrationType !== undefined) out.calibration_type = obj.calibrationType;
  if (obj.date !== undefined) out.date = obj.date;
  if (obj.startTime !== undefined) out.start_time = obj.startTime;
  if (obj.endTime !== undefined) out.end_time = obj.endTime;
  if (obj.startAt !== undefined) out.start_at = obj.startAt;
  if (obj.endAt !== undefined) out.end_at = obj.endAt;
  if (obj.standard !== undefined) out.standard = obj.standard;
  if (obj.status !== undefined) out.status = obj.status;
  if (obj.result !== undefined) out.result = obj.result;
  if (obj.performedDate !== undefined) out.performed_date = obj.performedDate;
  if (obj.referenceStandard !== undefined) out.reference_standard = obj.referenceStandard;
  if (obj.certificateNumber !== undefined) out.certificate_number = obj.certificateNumber;
  if (obj.drift !== undefined) out.drift = obj.drift;
  if (obj.tolerance !== undefined) out.tolerance = obj.tolerance;
  if (obj.certificateUrl !== undefined) out.certificate_url = obj.certificateUrl;
  if (obj.notes !== undefined) out.notes = obj.notes;
  return out;
}

// ------------------------------------------------------------------------------
// 7. Maintenance
// ------------------------------------------------------------------------------
function mapMaintenanceToApp(row) {
  if (!row) return null;
  const idStr = String(row.id);
  return {
    id: idStr,
    _id: idStr,
    instrumentId: row.instrument_id ? String(row.instrument_id) : null,
    technicianId: row.technician_id ? String(row.technician_id) : null,
    type: row.type || 'preventive',
    description: row.description,
    startDate: row.start_date ? new Date(row.start_date) : new Date(),
    endDate: row.end_date ? new Date(row.end_date) : null,
    startTime: row.start_time ? String(row.start_time).slice(0, 5) : null,
    endTime: row.end_time ? String(row.end_time).slice(0, 5) : null,
    status: row.status || 'SCHEDULED',
    requiresCalibration: !!row.requires_calibration,
    workPerformed: row.work_performed || null,
    partsReplaced: row.parts_replaced || null,
    resolutionNotes: row.resolution_notes || null,
    resolvedBy: row.resolved_by ? String(row.resolved_by) : null,
    resolvedAt: row.resolved_at ? new Date(row.resolved_at) : null,
    createdAt: row.created_at ? new Date(row.created_at) : new Date(),
    updatedAt: row.updated_at ? new Date(row.updated_at) : new Date(),
  };
}

function mapAppToMaintenance(obj) {
  if (!obj) return {};
  const out = {};
  if (obj.id) out.id = obj.id;
  if (obj.instrumentId !== undefined) out.instrument_id = obj.instrumentId;
  if (obj.technicianId !== undefined) out.technician_id = obj.technicianId;
  if (obj.type !== undefined) out.type = obj.type;
  if (obj.description !== undefined) out.description = obj.description;
  if (obj.startDate !== undefined) out.start_date = obj.startDate;
  if (obj.endDate !== undefined) out.end_date = obj.endDate;
  if (obj.startTime !== undefined) out.start_time = obj.startTime;
  if (obj.endTime !== undefined) out.end_time = obj.endTime;
  if (obj.status !== undefined) out.status = obj.status;
  if (obj.requiresCalibration !== undefined) out.requires_calibration = obj.requiresCalibration;
  if (obj.workPerformed !== undefined) out.work_performed = obj.workPerformed;
  if (obj.partsReplaced !== undefined) out.parts_replaced = obj.partsReplaced;
  if (obj.resolutionNotes !== undefined) out.resolution_notes = obj.resolutionNotes;
  if (obj.resolvedBy !== undefined) out.resolved_by = obj.resolvedBy;
  if (obj.resolvedAt !== undefined) out.resolved_at = obj.resolvedAt;
  return out;
}

// ------------------------------------------------------------------------------
// 8. Breakage Reports
// ------------------------------------------------------------------------------
function mapBreakageReportToApp(row) {
  if (!row) return null;
  const idStr = String(row.id);
  return {
    id: idStr,
    _id: idStr,
    instrumentId: row.instrument_id ? String(row.instrument_id) : null,
    reportedBy: row.reported_by ? String(row.reported_by) : null,
    issueType: row.issue_type,
    severity: row.severity,
    description: row.description,
    evidence: row.evidence || null,
    status: row.status || 'REPORTED',
    breakageFee: row.breakage_fee !== undefined ? Number(row.breakage_fee) : 0,
    adminReviewedBy: row.admin_reviewed_by ? String(row.admin_reviewed_by) : null,
    confirmedAt: row.confirmed_at ? new Date(row.confirmed_at) : null,
    resolvedAt: row.resolved_at ? new Date(row.resolved_at) : null,
    maintenanceId: row.maintenance_id ? String(row.maintenance_id) : null,
    resolutionNotes: row.resolution_notes || null,
    returnToServiceBy: row.return_to_service_by ? String(row.return_to_service_by) : null,
    returnToServiceAt: row.return_to_service_at ? new Date(row.return_to_service_at) : null,
    createdAt: row.created_at ? new Date(row.created_at) : new Date(),
    updatedAt: row.updated_at ? new Date(row.updated_at) : new Date(),
  };
}

function mapAppToBreakageReport(obj) {
  if (!obj) return {};
  const out = {};
  if (obj.id) out.id = obj.id;
  if (obj.instrumentId !== undefined) out.instrument_id = obj.instrumentId;
  if (obj.reportedBy !== undefined) out.reported_by = obj.reportedBy;
  if (obj.issueType !== undefined) out.issue_type = obj.issueType;
  if (obj.severity !== undefined) out.severity = obj.severity;
  if (obj.description !== undefined) out.description = obj.description;
  if (obj.evidence !== undefined) out.evidence = obj.evidence;
  if (obj.status !== undefined) out.status = obj.status;
  if (obj.breakageFee !== undefined) out.breakage_fee = obj.breakageFee;
  if (obj.adminReviewedBy !== undefined) out.admin_reviewed_by = obj.adminReviewedBy;
  if (obj.confirmedAt !== undefined) out.confirmed_at = obj.confirmedAt;
  if (obj.resolvedAt !== undefined) out.resolved_at = obj.resolvedAt;
  if (obj.maintenanceId !== undefined) out.maintenance_id = obj.maintenanceId;
  if (obj.resolutionNotes !== undefined) out.resolution_notes = obj.resolutionNotes;
  if (obj.returnToServiceBy !== undefined) out.return_to_service_by = obj.returnToServiceBy;
  if (obj.returnToServiceAt !== undefined) out.return_to_service_at = obj.returnToServiceAt;
  return out;
}

// ------------------------------------------------------------------------------
// 9. Notifications
// ------------------------------------------------------------------------------
function mapNotificationToApp(row) {
  if (!row) return null;
  const idStr = String(row.id);
  return {
    id: idStr,
    _id: idStr,
    userId: row.user_id ? String(row.user_id) : null,
    type: row.type,
    title: row.title,
    message: row.message,
    emailSent: !!row.email_sent,
    emailAttempts: row.email_attempts || 0,
    emailError: row.email_error || null,
    read: !!row.read,
    readAt: row.read_at ? new Date(row.read_at) : null,
    entityType: row.entity_type || null,
    entityId: row.entity_id ? String(row.entity_id) : null,
    dedupKey: row.dedup_key || null,
    createdAt: row.created_at ? new Date(row.created_at) : new Date(),
  };
}

function mapAppToNotification(obj) {
  if (!obj) return {};
  const out = {};
  if (obj.id) out.id = obj.id;
  if (obj.userId !== undefined) out.user_id = obj.userId;
  if (obj.type !== undefined) out.type = obj.type;
  if (obj.title !== undefined) out.title = obj.title;
  if (obj.message !== undefined) out.message = obj.message;
  if (obj.emailSent !== undefined) out.email_sent = obj.emailSent;
  if (obj.emailAttempts !== undefined) out.email_attempts = obj.emailAttempts;
  if (obj.emailError !== undefined) out.email_error = obj.emailError;
  if (obj.read !== undefined) out.read = obj.read;
  if (obj.readAt !== undefined) out.read_at = obj.readAt;
  if (obj.entityType !== undefined) out.entity_type = obj.entityType;
  if (obj.entityId !== undefined) out.entity_id = obj.entityId;
  if (obj.dedupKey !== undefined) out.dedup_key = obj.dedupKey;
  return out;
}

function mapOutboxToApp(row) {
  if (!row) return null;
  const idStr = String(row.id);
  return {
    id: idStr,
    _id: idStr,
    eventId: row.event_id,
    eventType: row.event_type,
    payload: row.payload,
    status: row.status || 'PENDING',
    attempts: row.attempts || 0,
    lastError: row.last_error || null,
    createdAt: row.created_at ? new Date(row.created_at) : new Date(),
    processedAt: row.processed_at ? new Date(row.processed_at) : null,
  };
}

function mapAppToOutbox(obj) {
  if (!obj) return {};
  const out = {};
  if (obj.id) out.id = obj.id;
  if (obj.eventId !== undefined) out.event_id = obj.eventId;
  if (obj.eventType !== undefined) out.event_type = obj.eventType;
  if (obj.payload !== undefined) out.payload = obj.payload;
  if (obj.status !== undefined) out.status = obj.status;
  if (obj.attempts !== undefined) out.attempts = obj.attempts;
  if (obj.lastError !== undefined) out.last_error = obj.lastError;
  if (obj.processedAt !== undefined) out.processed_at = obj.processedAt;
  return out;
}

// ------------------------------------------------------------------------------
// 10. QR Access Passes
// ------------------------------------------------------------------------------
function mapQrAccessPassToApp(row) {
  if (!row) return null;
  const idStr = String(row.id);
  return {
    id: idStr,
    _id: idStr,
    bookingId: row.booking_id ? String(row.booking_id) : null,
    tokenHash: row.token_hash,
    expiresAt: row.expires_at ? new Date(row.expires_at) : new Date(),
    checkedInAt: row.checked_in_at ? new Date(row.checked_in_at) : null,
    status: row.status || 'ACTIVE',
    createdAt: row.created_at ? new Date(row.created_at) : new Date(),
    updatedAt: row.updated_at ? new Date(row.updated_at) : new Date(),
  };
}

function mapAppToQrAccessPass(obj) {
  if (!obj) return {};
  const out = {};
  if (obj.id) out.id = obj.id;
  if (obj.bookingId !== undefined) out.booking_id = obj.bookingId;
  if (obj.tokenHash !== undefined) out.token_hash = obj.tokenHash;
  if (obj.expiresAt !== undefined) out.expires_at = obj.expiresAt;
  if (obj.checkedInAt !== undefined) out.checked_in_at = obj.checkedInAt;
  if (obj.status !== undefined) out.status = obj.status;
  return out;
}

// ------------------------------------------------------------------------------
// 11. Operator Qualifications
// ------------------------------------------------------------------------------
function mapOperatorQualificationToApp(row) {
  if (!row) return null;
  const idStr = String(row.id);
  return {
    id: idStr,
    _id: idStr,
    userId: row.user_id ? String(row.user_id) : null,
    instrumentId: row.instrument_id ? String(row.instrument_id) : null,
    scope: row.scope || null,
    category: row.category || null,
    level: row.level || 1,
    certifiedBy: row.certified_by ? String(row.certified_by) : null,
    certifiedAt: row.certified_at ? new Date(row.certified_at) : null,
    expiresAt: row.expires_at ? new Date(row.expires_at) : null,
    status: row.status || 'ACTIVE',
    evidenceUrl: row.evidence_url || null,
    evidenceNotes: row.evidence_notes || null,
    rejectionReason: row.rejection_reason || null,
    revocationReason: row.revocation_reason || null,
    createdAt: row.created_at ? new Date(row.created_at) : new Date(),
    updatedAt: row.updated_at ? new Date(row.updated_at) : new Date(),
  };
}

function mapAppToOperatorQualification(obj) {
  if (!obj) return {};
  const out = {};
  if (obj.id) out.id = obj.id;
  if (obj.userId !== undefined) out.user_id = obj.userId;
  if (obj.instrumentId !== undefined) out.instrument_id = obj.instrumentId;
  if (obj.scope !== undefined) out.scope = obj.scope;
  if (obj.category !== undefined) out.category = obj.category;
  if (obj.level !== undefined) out.level = obj.level;
  if (obj.certifiedBy !== undefined) out.certified_by = obj.certifiedBy;
  if (obj.certifiedAt !== undefined) out.certified_at = obj.certifiedAt;
  if (obj.expiresAt !== undefined) out.expires_at = obj.expiresAt;
  if (obj.status !== undefined) out.status = obj.status;
  if (obj.evidenceUrl !== undefined) out.evidence_url = obj.evidenceUrl;
  if (obj.evidenceNotes !== undefined) out.evidence_notes = obj.evidenceNotes;
  if (obj.rejectionReason !== undefined) out.rejection_reason = obj.rejectionReason;
  if (obj.revocationReason !== undefined) out.revocation_reason = obj.revocationReason;
  return out;
}

// ------------------------------------------------------------------------------
// 11b. Laboratory Memberships
// ------------------------------------------------------------------------------
function mapLaboratoryMembershipToApp(row) {
  if (!row) return null;
  const idStr = String(row.id);
  return {
    id: idStr,
    _id: idStr,
    userId: row.user_id ? String(row.user_id) : null,
    laboratoryId: row.laboratory_id ? String(row.laboratory_id) : null,
    role: row.role || 'MEMBER',
    assignedBy: row.assigned_by ? String(row.assigned_by) : null,
    assignedAt: row.assigned_at ? new Date(row.assigned_at) : new Date(),
    createdAt: row.created_at ? new Date(row.created_at) : new Date(),
    updatedAt: row.updated_at ? new Date(row.updated_at) : new Date(),
  };
}

function mapAppToLaboratoryMembership(obj) {
  if (!obj) return {};
  const out = {};
  if (obj.id) out.id = obj.id;
  if (obj.userId !== undefined) out.user_id = obj.userId;
  if (obj.laboratoryId !== undefined) out.laboratory_id = obj.laboratoryId;
  if (obj.role !== undefined) out.role = obj.role;
  if (obj.assignedBy !== undefined) out.assigned_by = obj.assignedBy;
  if (obj.assignedAt !== undefined) out.assigned_at = obj.assignedAt;
  return out;
}

// ------------------------------------------------------------------------------
// 12. Audit Logs
// ------------------------------------------------------------------------------
function mapAuditLogToApp(row) {
  if (!row) return null;
  const idStr = String(row.id);
  return {
    id: idStr,
    _id: idStr,
    userId: row.user_id ? String(row.user_id) : null,
    actorRole: row.actor_role || null,
    action: row.action,
    resource: row.resource,
    resourceId: row.resource_id || null,
    status: row.status || 'SUCCESS',
    laboratoryId: row.laboratory_id ? String(row.laboratory_id) : null,
    details: row.details || null,
    ipAddress: row.ip_address || null,
    userAgent: row.user_agent || null,
    createdAt: row.created_at ? new Date(row.created_at) : new Date(),
  };
}

function mapAppToAuditLog(obj) {
  if (!obj) return {};
  const out = {};
  if (obj.id) out.id = obj.id;
  if (obj.userId !== undefined) out.user_id = obj.userId;
  if (obj.actorRole !== undefined) out.actor_role = obj.actorRole;
  if (obj.action !== undefined) out.action = obj.action;
  if (obj.resource !== undefined) out.resource = obj.resource;
  if (obj.resourceId !== undefined) out.resource_id = obj.resourceId;
  if (obj.status !== undefined) out.status = obj.status;
  if (obj.laboratoryId !== undefined) out.laboratory_id = obj.laboratoryId;
  if (obj.details !== undefined) out.details = obj.details;
  if (obj.ipAddress !== undefined) out.ip_address = obj.ipAddress;
  if (obj.userAgent !== undefined) out.user_agent = obj.userAgent;
  return out;
}

module.exports = {
  mapProfileToApp,
  mapAppToProfile,
  mapLaboratoryToApp,
  mapAppToLaboratory,
  mapInstrumentToApp,
  mapAppToInstrument,
  mapScheduleToApp,
  mapAppToSchedule,
  mapBookingToApp,
  mapAppToBooking,
  mapCalibrationToApp,
  mapAppToCalibration,
  mapMaintenanceToApp,
  mapAppToMaintenance,
  mapBreakageReportToApp,
  mapAppToBreakageReport,
  mapNotificationToApp,
  mapAppToNotification,
  mapOutboxToApp,
  mapAppToOutbox,
  mapQrAccessPassToApp,
  mapAppToQrAccessPass,
  mapOperatorQualificationToApp,
  mapAppToOperatorQualification,
  mapLaboratoryMembershipToApp,
  mapAppToLaboratoryMembership,
  mapAuditLogToApp,
  mapAppToAuditLog,
};
