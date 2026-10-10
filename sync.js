/* =====================================================================
   sync.js — CLOUD SYNC (Firebase)
   ---------------------------------------------------------------------
   Keeps your budget the same on every device you sign in on.

   Your data lives in one Firestore document, users/{your account id}:
     budget            — the whole budget, as JSON text
     budgetUpdatedAt   — when it last changed (milliseconds)
     history           — Monthly history, as JSON text
     historyUpdatedAt  — when it last changed

   Each device still keeps its own copy in browser storage, so the app
   opens instantly and works offline. Whenever either copy changes, the
   newer one wins and is copied to the other side.

   app.js owns the data; this file only moves it. It talks to app.js
   through window.budgetApp (read/replace data) and window.budgetCloud
   (app.js calls push() after every save).
   ===================================================================== */

import { firebaseConfig } from "./firebase-config.js";
import { initializeApp } from "https://www.gstatic.com/firebasejs/12.12.0/firebase-app.js";
import { getAuth, onAuthStateChanged, signInWithPopup, signOut, GoogleAuthProvider } from "https://www.gstatic.com/firebasejs/12.12.0/firebase-auth.js";
import {
  initializeFirestore, persistentLocalCache, persistentMultipleTabManager, doc, onSnapshot, setDoc,
  terminate, clearIndexedDbPersistence, waitForPendingWrites,
} from "https://www.gstatic.com/firebasejs/12.12.0/firebase-firestore.js";

const PARTS = ["budget", "history"];
const PUSH_DELAY_MS = 800; // wait for a pause in typing before sending

const $ = (id) => document.getElementById(id);
const syncArea = $("syncArea");
const syncStatus = $("syncStatus");
const syncEmail = $("syncEmail");
const syncButton = $("syncButton");

function setStatus(text) {
  syncStatus.textContent = text;
}

// Sync needs a real web address (not a file opened from disk) and a configured project.
const canSync = location.protocol.startsWith("http") && !firebaseConfig.apiKey.startsWith("PASTE");

if (canSync) {
  start();
}

function start() {
  const app = initializeApp(firebaseConfig);
  const auth = getAuth(app);
  // The local cache lets edits made offline wait and send themselves later.
  const db = initializeFirestore(app, { localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() }) });

  let unsubscribe = null;
  let timers = {};
  let waiting = 0; // sends not yet confirmed by the server
  let flushPending = () => {}; // sends any change still waiting out its typing pause
  syncArea.hidden = false;
  setStatus("Checking sign-in…");

  const idleStatus = () => {
    if (!auth.currentUser) return "Not syncing";
    if (!navigator.onLine) return "Offline · will sync";
    return waiting > 0 ? "Saving…" : "Synced";
  };

  syncButton.addEventListener("click", async () => {
    if (auth.currentUser) {
      // Make sure the cloud has everything first: send what's waiting, then wait for the
      // server to confirm it. Offline, or no answer in 8 seconds, means it isn't saved yet.
      syncButton.disabled = true;
      setStatus("Saving before sign-out…");
      flushPending();
      const saved = await Promise.race([
        waitForPendingWrites(db).then(() => true, () => false),
        new Promise((resolve) => setTimeout(() => resolve(false), navigator.onLine ? 8000 : 0)),
      ]);
      if (!saved && !window.confirm(
        "Some of your latest changes haven't reached the cloud yet (you may be offline). " +
        "Signing out now erases them from this device. Sign out anyway?"
      )) {
        syncButton.disabled = false;
        setStatus(idleStatus());
        return;
      }

      // Sign out, then wipe this device: the budget and Firestore's offline copy.
      setStatus("Signing out…");
      await signOut(auth);
      window.budgetApp.resetForSignOut();
      try {
        await terminate(db);
        await clearIndexedDbPersistence(db);
      } catch (error) {
        console.error(error);
      }
      location.reload(); // start fresh, signed out
      return;
    }
    try {
      await signInWithPopup(auth, new GoogleAuthProvider());
    } catch (error) {
      if (error.code !== "auth/popup-closed-by-user" && error.code !== "auth/cancelled-popup-request") {
        setStatus("Sign-in didn't work. Try again.");
        console.error(error);
      }
    }
  });

  onAuthStateChanged(auth, (user) => {
    unsubscribe?.();
    unsubscribe = null;
    window.budgetCloud = null;
    Object.values(timers).forEach(clearTimeout);
    timers = {};

    if (!user) {
      syncButton.textContent = "Sign in to sync";
      setStatus("Not syncing");
      syncArea.title = "";
      syncEmail.hidden = true;
      return;
    }

    syncButton.textContent = "Sign out";
    syncArea.title = `Syncing as ${user.email}`;
    // Shown on the page too: a phone has no hover, and each account has its own separate budget.
    syncEmail.textContent = user.email;
    syncEmail.hidden = false;
    setStatus("Connecting…");
    const ref = doc(db, "users", user.uid);

    // Send one part now. setDoc queues the write at once (offline too) and settles when the server confirms.
    async function sendNow(part) {
      clearTimeout(timers[part]);
      delete timers[part];
      const local = window.budgetApp.getLocal();
      waiting += 1;
      setStatus(idleStatus());
      try {
        await setDoc(ref, { [part]: local[part], [`${part}UpdatedAt`]: local[`${part}UpdatedAt`] }, { merge: true });
      } catch (error) {
        setStatus("Couldn't save to the cloud");
        console.error(error);
        return;
      } finally {
        waiting -= 1;
      }
      setStatus(idleStatus());
    }

    // After a change, wait for a pause in typing before sending.
    function push(part) {
      clearTimeout(timers[part]);
      timers[part] = setTimeout(() => sendNow(part), PUSH_DELAY_MS);
    }
    window.budgetCloud = { push };
    flushPending = () => Object.keys(timers).forEach(sendNow);

    // includeMetadataChanges: also hear when a cached copy is confirmed by the server.
    unsubscribe = onSnapshot(
      ref,
      { includeMetadataChanges: true },
      (snapshot) => {
        // Only compare against what the server has. A cached copy may be out of date,
        // and our own unsent edits echo back here too.
        if (snapshot.metadata.hasPendingWrites || snapshot.metadata.fromCache) return;
        const remote = snapshot.data() ?? {};

        // First sign-in after signing out on this device: the cloud copy wins outright,
        // so anything typed while signed out can't overwrite your real budget.
        if (window.budgetApp.isCloudFirst()) {
          for (const part of PARTS) {
            if (remote[part] !== undefined) window.budgetApp.applyRemote(part, remote[part], remote[`${part}UpdatedAt`] ?? 0);
          }
          window.budgetApp.clearCloudFirst();
        }

        const local = window.budgetApp.getLocal();

        for (const part of PARTS) {
          let remoteAt = remote[part] === undefined ? -1 : remote[`${part}UpdatedAt`] ?? 0;
          if (part === "budget" && remote.budget && JSON.parse(remote.budget).isExample) remoteAt = 0;
          const localAt = local[`${part}UpdatedAt`];

          if (remoteAt > localAt) {
            window.budgetApp.applyRemote(part, remote[part], remoteAt);
          } else if (localAt > remoteAt && local[part] !== remote[part]) {
            push(part);
          }
        }
        setStatus(idleStatus());
      },
      (error) => {
        setStatus("Couldn't reach the cloud");
        console.error(error);
      }
    );
  });

  window.addEventListener("offline", () => setStatus(idleStatus()));
  window.addEventListener("online", () => setStatus(idleStatus()));
}
