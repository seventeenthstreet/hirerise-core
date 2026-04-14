'use strict';

const admin = require('firebase-admin');

// load your firebase service account
const serviceAccount = require('./serviceAccountKey.json');

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});

async function generateToken() {
  try {
    const uid = "dev-admin";

    const customToken = await admin.auth().createCustomToken(uid);

    console.log("\n✅ CUSTOM TOKEN:\n");
    console.log(customToken);

    process.exit(0);
  } catch (error) {
    console.error("❌ Error generating token:", error);
    process.exit(1);
  }
}

generateToken();