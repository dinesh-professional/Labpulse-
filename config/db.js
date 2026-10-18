/**
 * LabPulse DB connection (Phase 01).
 * Mongoose is the application data-access layer.
 * MongoDB Compass is only a dev/inspection tool, never the app layer.
 */
const mongoose = require('mongoose');

let connecting = false;

async function connectDB(uri) {
  if (!uri) throw new Error('MONGODB_URI is not set');
  if (mongoose.connection.readyState === 1) return mongoose.connection;
  if (connecting) return mongoose.connection;
  connecting = true;
  try {
    mongoose.set('strictQuery', true);
    await mongoose.connect(uri, {
      serverSelectionTimeoutMS: 5000,
    });
    return mongoose.connection;
  } finally {
    connecting = false;
  }
}

function dbState() {
  // 0 disconnected, 1 connected, 2 connecting, 3 disconnecting
  return mongoose.connection.readyState;
}

module.exports = { connectDB, dbState };
