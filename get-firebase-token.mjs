import { initializeApp } from "firebase/app";
import { getAuth, signInWithEmailAndPassword } from "firebase/auth";

const firebaseConfig = {
  apiKey: process.env.FIREBASE_WEB_API_KEY,
  authDomain: "hirerise-prod.firebaseapp.com",
};

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);

const email = "test@hirerise.local";
const password = "Test@12345";

const cred = await signInWithEmailAndPassword(auth, email, password);
const token = await cred.user.getIdToken(true);

console.log(token);