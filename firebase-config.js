/**
 * Firebase config for Koora Jo (Netlify accounts + Google login).
 *
 * SETUP (one-time, free Firebase Spark plan):
 * 1. Go to https://console.firebase.google.com/ and create a project
 * 2. Add a Web app → copy the firebaseConfig object below
 * 3. Authentication → Sign-in method → enable Email/Password AND Google
 * 4. Authentication → Settings → Authorized domains → add koorajo.netlify.app
 * 5. Firestore Database → Create database (start in test mode, then tighten rules)
 * 6. Paste your keys below, commit, and redeploy Netlify
 *
 * Suggested Firestore rules (Auth required for writes):
 *   rules_version = '2';
 *   service cloud.firestore {
 *     match /databases/{database}/documents {
 *       match /users/{uid} {
 *         allow read: if request.auth != null;
 *         allow write: if request.auth != null && request.auth.uid == uid;
 *       }
 *       match /usernames/{name} {
 *         allow read: if true;
 *         allow create: if request.auth != null;
 *         allow update, delete: if false;
 *       }
 *       match /bookings/{id} {
 *         allow read: if request.auth != null;
 *         allow create: if request.auth != null;
 *         allow update: if request.auth != null && resource.data.userId == request.auth.uid;
 *       }
 *       match /games/{id} {
 *         allow read: if true;
 *         allow write: if request.auth != null;
 *       }
 *       match /meta/{doc} {
 *         allow read: if true;
 *         allow write: if request.auth != null;
 *       }
 *     }
 *   }
 */
window.FIREBASE_CONFIG = {
  apiKey: "AIzaSyDaq_bJ8TiinX_a1IVpuwLkx2kt10i8G8o",
  authDomain: "koorajo-saif.firebaseapp.com",
  projectId: "koorajo-saif",
  storageBucket: "koorajo-saif.firebasestorage.app",
  messagingSenderId: "898810326942",
  appId: "1:898810326942:web:c0551e9e6be1868ac7708f",
  measurementId: "G-9Y0C89PDF7"
};

window.FIREBASE_CONFIGURED = !String(window.FIREBASE_CONFIG.apiKey || "").startsWith("PASTE_");
