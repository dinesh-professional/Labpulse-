/**
 * Catalog seed (labs + prototype instruments). Run locally against YOUR database:
 *   MONGODB_URI="..." node scripts/seed-catalog.js
 * - Idempotent: existing records (matched by name / serialNumber) are left untouched.
 * - Seeds a clean slate: all instruments AVAILABLE (states like OUT_OF_ORDER arise
 *   from real breakage reports, never from seed data).
 * - Breakage fees are the spec's illustrative placeholders — configurable per policy.
 */
require('dotenv').config();
const mongoose = require('mongoose');

const DAY = 86400000;
const now = Date.now();
const daysAgo = (n) => new Date(now - n * DAY);
const daysAhead = (n) => new Date(now + n * DAY);

const LABS = [
  { name: 'Nano Tech Lab', department: 'Materials Science', building: 'Nano Tech Bldg', roomNumber: '104', capacity: 20, status: 'AVAILABLE' },
  { name: 'Chemistry Lab', department: 'Chemistry', building: 'Chemistry Hall', roomNumber: 'B-12', capacity: 30, status: 'AVAILABLE' },
  { name: 'Genomics Center', department: 'Genomics Core', building: 'Genomics Center', roomNumber: '302', capacity: 15, status: 'AVAILABLE' },
  { name: 'Bio Lab', department: 'Biology', building: 'Bio Lab', roomNumber: '210', capacity: 25, status: 'AVAILABLE' },
  { name: 'Analytical Core', department: 'Chemistry', building: 'Analytical Core', roomNumber: '118', capacity: 12, status: 'AVAILABLE' },
  { name: 'Cell Biology Lab', department: 'Cell Biology', building: 'Cell Bio Bldg', roomNumber: '405', capacity: 18, status: 'AVAILABLE' },
];

const INSTRUMENTS = [
  { name: 'JEOL JEM-2100F TEM', category: 'MICROSCOPY', model: 'JEM-2100F', serialNumber: 'TEM-2100F-001', status: 'AVAILABLE', breakageFee: 100000, requiredQualificationLevel: 3, lastCalibrationDate: daysAgo(50), nextCalibrationDue: daysAhead(40), calibrationFrequencyDays: 90 },
  { name: 'BRUKER AVANCE 600MHz NMR', category: 'SPECTROSCOPY', model: 'AVANCE III HD 600', serialNumber: 'NMR-600-001', status: 'AVAILABLE', breakageFee: 50000, requiredQualificationLevel: 2, lastCalibrationDate: daysAgo(60), nextCalibrationDue: daysAhead(30), calibrationFrequencyDays: 90 },
  { name: 'ILLUMINA NOVASEQ 6000', category: 'GENOMICS', model: 'NovaSeq 6000', serialNumber: 'NOVASEQ-001', status: 'AVAILABLE', breakageFee: 150000, requiredQualificationLevel: 4, lastCalibrationDate: daysAgo(30), nextCalibrationDue: daysAhead(60), calibrationFrequencyDays: 90 },
  { name: 'BECKMAN OPTIMA XPN ULTRACENTRIFUGE', category: 'CENTRIFUGATION', model: 'Optima XPN-100', serialNumber: 'XPN-001', status: 'AVAILABLE', breakageFee: 60000, requiredQualificationLevel: 1, lastCalibrationDate: daysAgo(20), nextCalibrationDue: daysAhead(70), calibrationFrequencyDays: 90 },
  { name: 'AGILENT 6545 Q-TOF LC/MS', category: 'SPECTROSCOPY', model: '6545 Q-TOF', serialNumber: 'QTOF-6545-001', status: 'AVAILABLE', breakageFee: 75000, requiredQualificationLevel: 3, lastCalibrationDate: daysAgo(45), nextCalibrationDue: daysAhead(45), calibrationFrequencyDays: 90 },
  { name: 'ZEISS LSM 980 CONFOCAL MICROSCOPE', category: 'MICROSCOPY', model: 'LSM 980', serialNumber: 'LSM980-001', status: 'AVAILABLE', breakageFee: 80000, requiredQualificationLevel: 2, lastCalibrationDate: daysAgo(70), nextCalibrationDue: daysAhead(20), calibrationFrequencyDays: 90 },
];

(async () => {
  const uri = process.env.MONGODB_URI || '';
  if (!uri) { console.error('MONGODB_URI is not set.'); process.exit(2); }
  const { connectDB } = require('../config/db');
  await connectDB(uri);
  const Laboratory = require('../models/Laboratory');
  const Instrument = require('../models/Instrument');

  let labsAdded = 0;
  for (const lab of LABS) {
    const exists = await Laboratory.findOne({ name: lab.name }).lean();
    if (!exists) { await Laboratory.create(lab); labsAdded += 1; }
  }
  let instAdded = 0;
  for (const ins of INSTRUMENTS) {
    const exists = await Instrument.findOne({ serialNumber: ins.serialNumber }).lean();
    if (!exists) { await Instrument.create(ins); instAdded += 1; }
  }
  const [labTotal, instTotal] = await Promise.all([Laboratory.countDocuments(), Instrument.countDocuments()]);
  console.log(`Catalog seed done: +${labsAdded} labs (${labTotal} total), +${instAdded} instruments (${instTotal} total).`);
  await mongoose.disconnect();
  process.exit(0);
})().catch((e) => { console.error(`seed-catalog FAIL: ${e.message}`); process.exit(1); });
