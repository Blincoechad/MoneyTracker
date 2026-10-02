/* =====================================================================
   firebase-config.js — which Firebase project to sync with
   ---------------------------------------------------------------------
   Copied from Firebase console → Project settings → Your apps → Web app.
   These values only identify the project; they are not secret. What keeps
   your budget private is the Firestore security rule in firestore.rules,
   which lets each signed-in account read and write only its own data.
   ===================================================================== */

export const firebaseConfig = {
  apiKey: "AIzaSyArCtnw4nExDE3NaOWAvkfhRrqo4BIQpuQ",
  authDomain: "mybudgetdash.firebaseapp.com",
  projectId: "mybudgetdash",
  storageBucket: "mybudgetdash.firebasestorage.app",
  messagingSenderId: "561909771837",
  appId: "1:561909771837:web:56575e42e006405ee58454",
};
