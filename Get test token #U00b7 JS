/**
 * get-test-token.js
 * 
 * Generates a Firebase ID token for Postman testing.
 * 
 * USAGE:
 *   node get-test-token.js
 * 
 * Copy the printed token and paste it into Postman:
 *   Environments → HireRise Local → token variable
 */

'use strict';

require('dotenv').config();
require('./src/config/firebase'); // initializes firebase-admin

const { getAuth } = require('firebase-admin/auth');
const https = require('https');

const TEST_UID  = 'test-user-postman-001';
const TEST_EMAIL = 'test@hirerise.dev';

async function getTestToken() {
  console.log('\n🔑 HireRise — Test Token Generator\n');

  try {
    // Step 1: Create or ensure test user exists
    let user;
    try {
      user = await getAuth().getUserByEmail(TEST_EMAIL);
      console.log(`✅ Test user found: ${user.uid}`);
    } catch (e) {
      if (e.code === 'auth/user-not-found') {
        user = await getAuth().createUser({
          uid:           TEST_UID,
          email:         TEST_EMAIL,
          emailVerified: true,
          displayName:   'Postman Test User',
        });
        console.log(`✅ Test user created: ${user.uid}`);
      } else {
        throw e;
      }
    }

    // Step 2: Create a custom token (signed JWT)
    const customToken = await getAuth().createCustomToken(user.uid, {
      roles: ['user'],
    });

    console.log('\n📋 Custom Token (for exchange only — not for Postman directly):');
    console.log(customToken.substring(0, 60) + '...\n');

    // Step 3: Exchange custom token for ID token via Firebase REST API
    const webApiKey = process.env.FIREBASE_WEB_API_KEY;

    if (!webApiKey) {
      console.log('⚠️  FIREBASE_WEB_API_KEY not set in .env');
      console.log('   Add it to your .env file:');
      console.log('   FIREBASE_WEB_API_KEY=your_web_api_key_from_firebase_console\n');
      console.log('   Then re-run this script to get an ID token automatically.\n');
      console.log('   Alternatively, exchange the custom token manually:');
      console.log('   POST https://identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken?key=YOUR_WEB_API_KEY');
      console.log('   Body: { "token": "<custom_token_above>", "returnSecureToken": true }');
      console.log('   The "idToken" field in the response = your Postman Bearer token\n');
      return;
    }

    // Exchange custom token → ID token
    const idToken = await exchangeCustomToken(customToken, webApiKey);

    console.log('━'.repeat(60));
    console.log('🎯 YOUR POSTMAN TOKEN (copy everything below this line):\n');
    console.log(idToken);
    console.log('\n' + '━'.repeat(60));
    console.log('\n📌 Paste this into Postman:');
    console.log('   Environments → HireRise Local → token → paste here → Save\n');
    console.log('⏱  Token expires in ~1 hour. Run this script again to get a fresh one.\n');

  } catch (err) {
    console.error('❌ Error:', err.message);
    if (err.code === 'auth/configuration-not-found') {
      console.log('\n💡 Tip: You may be using the Firestore emulator but not the Auth emulator.');
      console.log('   Start Auth emulator: firebase emulators:start --only auth,firestore');
    }
  }

  process.exit(0);
}

function exchangeCustomToken(customToken, apiKey) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      token: customToken,
      returnSecureToken: true,
    });

    const options = {
      hostname: 'identitytoolkit.googleapis.com',
      path: `/v1/accounts:signInWithCustomToken?key=${apiKey}`,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
    };

    // If using emulator, override
    if (process.env.FIREBASE_AUTH_EMULATOR_HOST) {
      options.hostname = process.env.FIREBASE_AUTH_EMULATOR_HOST.split(':')[0];
      options.port = process.env.FIREBASE_AUTH_EMULATOR_HOST.split(':')[1];
      options.path = `/identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken?key=${apiKey}`;
      console.log(`🔧 Using Auth Emulator: ${process.env.FIREBASE_AUTH_EMULATOR_HOST}`);
    }

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (parsed.idToken) resolve(parsed.idToken);
          else reject(new Error(parsed.error?.message || 'No idToken in response'));
        } catch (e) {
          reject(new Error('Failed to parse Firebase response'));
        }
      });
    });

    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

getTestToken();