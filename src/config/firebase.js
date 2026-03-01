'use strict';

require('dotenv').config();

const admin  = require('firebase-admin');
const path   = require('path');
const fs     = require('fs');
const logger = require('../utils/logger');

let db;
let auth;
let storage;

/**
 * Initialize Firebase (supports Test, Emulator, and Production modes)
 */
function initializeFirebase() {

  // ─────────────────────────────────────────────
  // 1️⃣ TEST MODE
  // ─────────────────────────────────────────────
  if (process.env.NODE_ENV === 'test') {

    console.log('⚠ Firebase running in TEST MODE (Mocked)');

    db = {};
    auth = {
      verifyIdToken: async () => ({
        uid: 'test-user',
        email: 'test@example.com',
      }),
    };
    storage = {};

    return;
  }

  // ─────────────────────────────────────────────
  // 2️⃣ Prevent Double Initialization
  // ─────────────────────────────────────────────
  if (admin.apps.length > 0) {
    db      = admin.firestore();
    auth    = admin.auth();
    storage = admin.storage();
    return;
  }

  // ─────────────────────────────────────────────
  // 3️⃣ EMULATOR MODE
  // ─────────────────────────────────────────────
  if (process.env.FIRESTORE_EMULATOR_HOST) {

    const projectId = process.env.FIREBASE_PROJECT_ID || 'hirerise-local';

    console.log('🔥 Firebase running in EMULATOR MODE');

    admin.initializeApp({ projectId });

    db = admin.firestore();
    db.settings({ ignoreUndefinedProperties: true });

    auth    = admin.auth();
    storage = admin.storage();

    return;
  }

  // ─────────────────────────────────────────────
  // 4️⃣ PRODUCTION MODE
  // ─────────────────────────────────────────────
  let credential;

  if (process.env.FIREBASE_SERVICE_ACCOUNT_PATH) {

    const absolutePath = path.resolve(process.env.FIREBASE_SERVICE_ACCOUNT_PATH);

    if (!fs.existsSync(absolutePath)) {
      throw new Error(
        `Firebase service account file not found at: ${absolutePath}\n\n` +
        `Fix ONE of the following in your .env:\n` +
        `Option A: FIREBASE_SERVICE_ACCOUNT_PATH=./secure/firebase-admin.json\n` +
        `Option B: Use individual env vars (FIREBASE_CLIENT_EMAIL + FIREBASE_PRIVATE_KEY)\n` +
        `Option C: Use emulator (set FIRESTORE_EMULATOR_HOST=localhost:8080)`
      );
    }

    const serviceAccount = require(absolutePath);
    credential = admin.credential.cert(serviceAccount);

  } else if (
    process.env.FIREBASE_PROJECT_ID &&
    process.env.FIREBASE_CLIENT_EMAIL &&
    process.env.FIREBASE_PRIVATE_KEY
  ) {

    credential = admin.credential.cert({
      projectId:   process.env.FIREBASE_PROJECT_ID,
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      privateKey:  process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n'),
    });

  } else {

    throw new Error(
      'Firebase credentials not configured.\n\n' +
      'Set either FIREBASE_SERVICE_ACCOUNT_PATH\n' +
      'or FIREBASE_CLIENT_EMAIL + FIREBASE_PRIVATE_KEY\n' +
      'or enable emulator mode.'
    );
  }

  admin.initializeApp({
    credential,
    projectId:     process.env.FIREBASE_PROJECT_ID,
    databaseURL:   process.env.FIREBASE_DATABASE_URL,
    storageBucket: process.env.FIREBASE_STORAGE_BUCKET,
  });

  db = admin.firestore();
  db.settings({ ignoreUndefinedProperties: true });

  auth    = admin.auth();
  storage = admin.storage();

  logger.info('[Firebase] Admin SDK initialized successfully');
}

initializeFirebase();

module.exports = { db, auth, storage, admin };