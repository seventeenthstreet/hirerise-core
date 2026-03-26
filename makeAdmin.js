'use strict';

const admin = require('firebase-admin');
const path = require('path');

// Load your Firebase service account key
const serviceAccount = require('./serviceAccountKey.json');

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});

async function makeAdmin() {
  try {
    const uid = "dev-admin";

    await admin.auth().setCustomUserClaims(uid, {
      admin: true
    });

    console.log("✅ Admin role granted to:", uid);
    process.exit(0);

  } catch (error) {
    console.error("❌ Error:", error);
    process.exit(1);
  }
}

makeAdmin();