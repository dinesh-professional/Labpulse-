-- ==============================================================================
-- LabPulse Supabase Seed Data: seed.sql
-- Module 05: Safe Development Seed Fixtures
-- ==============================================================================
-- Hygiene Rules:
-- 1. NO real user passwords or plaintext secrets.
-- 2. NO production admin credentials seeded.
-- 3. Idempotent execution via ON CONFLICT DO NOTHING.
-- ------------------------------------------------------------------------------

-- ------------------------------------------------------------------------------
-- 1. Seed Laboratories
-- ------------------------------------------------------------------------------
INSERT INTO public.laboratories (id, name, department, building, room_number, capacity, status)
VALUES
  (
    '11111111-1111-1111-1111-111111111101',
    'Spectroscopy & Analytical Core',
    'Chemical Sciences',
    'Curie Research Wing',
    'CRW-104',
    25,
    'AVAILABLE'
  ),
  (
    '11111111-1111-1111-1111-111111111102',
    'Materials Characterization Suite',
    'Materials Engineering',
    'Faraday Hall',
    'FH-210',
    30,
    'AVAILABLE'
  ),
  (
    '11111111-1111-1111-1111-111111111103',
    'Biomolecular Imaging Facility',
    'Bioengineering',
    'Franklin Center',
    'FC-305',
    15,
    'AVAILABLE'
  ),
  (
    '11111111-1111-1111-1111-111111111104',
    'Thermal & Microfluidics Laboratory',
    'Physics',
    'Bohr Complex',
    'BC-012',
    20,
    'UNDER_MAINTENANCE'
  )
ON CONFLICT (id) DO NOTHING;

-- ------------------------------------------------------------------------------
-- 2. Seed Instruments (Representative Operational States)
-- ------------------------------------------------------------------------------
INSERT INTO public.instruments (
  id, laboratory_id, name, category, model, serial_number, status,
  breakage_fee, required_qualification_level, last_calibration_date,
  next_calibration_due, calibration_frequency_days
)
VALUES
  (
    '22222222-2222-2222-2222-222222222201',
    '11111111-1111-1111-1111-111111111101',
    'Bruker Avance III HD 600 MHz NMR',
    'Spectroscopy',
    'Avance III HD 600',
    'NMR-BRUKER-600-0941',
    'AVAILABLE',
    250.00,
    3,
    now() - interval '30 days',
    now() + interval '60 days',
    90
  ),
  (
    '22222222-2222-2222-2222-222222222202',
    '11111111-1111-1111-1111-111111111101',
    'Agilent 1260 Infinity II HPLC System',
    'Chromatography',
    '1260 Infinity II',
    'HPLC-AGILENT-1260-4412',
    'AVAILABLE',
    100.00,
    2,
    now() - interval '45 days',
    now() + interval '135 days',
    180
  ),
  (
    '22222222-2222-2222-2222-222222222203',
    '11111111-1111-1111-1111-111111111101',
    'Thermo Scientific Q Exactive HF Orbitrap',
    'Mass Spectrometry',
    'Q Exactive HF',
    'MS-THERMO-ORBITRAP-8801',
    'UNDER_CALIBRATION',
    350.00,
    3,
    now() - interval '90 days',
    now() - interval '2 days',
    90
  ),
  (
    '22222222-2222-2222-2222-222222222204',
    '11111111-1111-1111-1111-111111111102',
    'JEOL JSM-7800F Field Emission SEM',
    'Electron Microscopy',
    'JSM-7800F',
    'SEM-JEOL-7800-1109',
    'IN_SESSION',
    400.00,
    4,
    now() - interval '15 days',
    now() + interval '75 days',
    90
  ),
  (
    '22222222-2222-2222-2222-222222222205',
    '11111111-1111-1111-1111-111111111102',
    'Malvern Panalytical Empyrean XRD',
    'X-Ray Diffraction',
    'Empyrean 3rd Gen',
    'XRD-MALVERN-3901',
    'AVAILABLE',
    150.00,
    2,
    now() - interval '60 days',
    now() + interval '120 days',
    180
  ),
  (
    '22222222-2222-2222-2222-222222222206',
    '11111111-1111-1111-1111-111111111103',
    'Zeiss LSM 980 Confocal Microscope',
    'Fluorescence Microscopy',
    'LSM 980 with Airyscan 2',
    'CONFOCAL-ZEISS-980-0023',
    'AVAILABLE',
    200.00,
    2,
    now() - interval '20 days',
    now() + interval '160 days',
    180
  ),
  (
    '22222222-2222-2222-2222-222222222207',
    '11111111-1111-1111-1111-111111111104',
    'TA Instruments Discovery DSC 2500',
    'Thermal Analysis',
    'DSC 2500',
    'DSC-TA-2500-7711',
    'UNDER_MAINTENANCE',
    75.00,
    1,
    now() - interval '120 days',
    now() + interval '60 days',
    180
  ),
  (
    '22222222-2222-2222-2222-222222222208',
    '11111111-1111-1111-1111-111111111104',
    'Eppendorf Centrifuge 5430 R',
    'General Laboratory',
    '5430 R High Speed',
    'CENT-EPP-5430-6623',
    'AVAILABLE',
    0.00,
    0,
    now() - interval '10 days',
    now() + interval '355 days',
    365
  )
ON CONFLICT (id) DO NOTHING;

-- ------------------------------------------------------------------------------
-- 3. Seed Calibration Records
-- ------------------------------------------------------------------------------
INSERT INTO public.calibrations (
  id, instrument_id, calibration_type, date, start_time, end_time,
  start_at, end_at, standard, status, drift, tolerance, notes
)
VALUES
  (
    '33333333-3333-3333-3333-333333333301',
    '22222222-2222-2222-2222-222222222201',
    'NIST Traceable Chemical Shift Calibration',
    CURRENT_DATE - 30,
    '09:00',
    '11:00',
    (CURRENT_DATE - 30)::timestamp + interval '9 hours',
    (CURRENT_DATE - 30)::timestamp + interval '11 hours',
    'NIST SRM 8040 TMS Standard',
    'CALIBRATED',
    '+0.002 ppm',
    '±0.005 ppm',
    'Shimming and field lock stability verified within manufacturer tolerance.'
  ),
  (
    '33333333-3333-3333-3333-333333333302',
    '22222222-2222-2222-2222-222222222203',
    'Mass Accuracy & Detector Calibration',
    CURRENT_DATE,
    '14:00',
    '16:30',
    CURRENT_DATE::timestamp + interval '14 hours',
    CURRENT_DATE::timestamp + interval '16 hours 30 minutes',
    'Pierce Negative Calibration Solution',
    'UNDER_CALIBRATION',
    '+1.2 ppm',
    '±1.0 ppm',
    'Secondary calibration pass underway following quad voltage adjustment.'
  )
ON CONFLICT (id) DO NOTHING;

-- ------------------------------------------------------------------------------
-- 4. Seed Maintenance Records
-- ------------------------------------------------------------------------------
INSERT INTO public.maintenance (
  id, instrument_id, type, description, start_date, end_date,
  start_time, end_time, status, requires_calibration
)
VALUES
  (
    '44444444-4444-4444-4444-444444444401',
    '22222222-2222-2222-2222-222222222207',
    'preventive',
    'Quarterly sensor cell de-gassing and thermal furnace heating element inspection.',
    CURRENT_DATE,
    CURRENT_DATE + 2,
    '08:00',
    '17:00',
    'IN_PROGRESS',
    true
  ),
  (
    '44444444-4444-4444-4444-444444444402',
    '22222222-2222-2222-2222-222222222202',
    'preventive',
    'Semi-annual seal wash replacement and binary pump piston seal renewal.',
    CURRENT_DATE - 45,
    CURRENT_DATE - 45,
    '10:00',
    '13:00',
    'COMPLETED',
    false
  )
ON CONFLICT (id) DO NOTHING;
