// get-token.js
const { initializeApp } = require('firebase/app');
const { getAuth, signInWithEmailAndPassword } = require('firebase/auth');

const firebaseConfig = {
  apiKey: process.env.FIREBASE_WEB_API_KEY,
  authDomain: "your-project.firebaseapp.com",
  projectId: "hirerise-prod",
  storageBucket: "hirerise-prod.appspot.com",
  messagingSenderId: "xxxxx",
  appId: "xxxxx"
};

// 🔥 THIS LINE WAS MISSING
const app = initializeApp(firebaseConfig);

const auth = getAuth(app);

signInWithEmailAndPassword(auth, 'abheesh@fixitall.ae', '123456')
  .then(async ({ user }) => {
    const token = await user.getIdToken();
    console.log('\nTOKEN:\n', token);
  })
  .catch(console.error);