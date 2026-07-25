/**
 * Cloud auth + persistence for Netlify (Firebase Auth + Firestore).
 * Falls back to localStorage when firebase-config.js is not filled in,
 * or when Flask /api is available (handled by index.html).
 */
(function (global) {
  "use strict";

  const LS_KEY = "koora_jo_store_v1";
  let fbApp = null;
  let fbAuth = null;
  let fbDb = null;
  let cloudReady = false;
  let gamesSeeded = false;

  function lsInitials(name) {
    const p = String(name || "")
      .trim()
      .split(/\s+/)
      .filter(Boolean);
    if (!p.length) return "?";
    if (p.length === 1) return p[0].slice(0, 2).toUpperCase();
    return (p[0][0] + p[p.length - 1][0]).toUpperCase();
  }

  function lsGateCode() {
    const c = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
    let s = "";
    for (let i = 0; i < 4; i++) s += c[Math.floor(Math.random() * c.length)];
    return "KJ-" + s;
  }

  function publicUser(u) {
    if (!u) return null;
    return {
      id: u.id,
      name: u.name,
      username: u.username,
      email: u.email,
      initials: u.initials,
      location: u.location,
    };
  }

  function seedBootstrap(user, games, bookings, reservations) {
    return {
      sport: global.KOORA.sport,
      facilities: global.KOORA.facilities,
      areas: global.KOORA.areas,
      games: games || global.KOORA.games || [],
      bookings: bookings || [],
      reservations: reservations || [],
      user: publicUser(user),
      ammanCenter: global.KOORA.ammanCenter,
      defaultLocation: global.KOORA.defaultLocation,
      authenticated: !!user,
      metrics: global.KOORA.metrics,
    };
  }

  /* ─── localStorage fallback (dev / no Firebase keys) ─── */
  function lsLoad() {
    try {
      return (
        JSON.parse(localStorage.getItem(LS_KEY) || "null") || {
          users: [],
          games: null,
          bookings: [],
          reservations: [],
          sessionUserId: null,
        }
      );
    } catch (_) {
      return {
        users: [],
        games: null,
        bookings: [],
        reservations: [],
        sessionUserId: null,
      };
    }
  }
  function lsSave(store) {
    localStorage.setItem(LS_KEY, JSON.stringify(store));
  }

  async function apiLocal(path, opts = {}) {
    const method = (opts.method || "GET").toUpperCase();
    const body = opts.body ? JSON.parse(opts.body) : {};
    const store = lsLoad();
    if (!store.games)
      store.games = JSON.parse(JSON.stringify(global.KOORA.games || []));
    const AREAS = global.KOORA.areas || [];
    const FACILITIES = global.KOORA.facilities || [];
    const DEFAULT_LOCATION = global.KOORA.defaultLocation;

    const findUser = (login) => {
      const key = String(login || "")
        .trim()
        .toLowerCase();
      return (store.users || []).find(
        (u) => u.username === key || u.email === key
      );
    };
    const sessionUser = () =>
      (store.users || []).find((u) => u.id === store.sessionUserId) || null;

    if (path === "/api/me" && method === "GET") {
      const user = sessionUser();
      return {
        authenticated: !!user,
        user: publicUser(user),
        bootstrap: seedBootstrap(
          user,
          store.games,
          user ? store.bookings.filter((b) => b.userId === user.id) : [],
          store.reservations
        ),
      };
    }
    if (path === "/api/logout" && method === "POST") {
      store.sessionUserId = null;
      lsSave(store);
      return { ok: true };
    }
    if (path === "/api/signup" && method === "POST") {
      const name = String(body.name || "").trim();
      const username = String(body.username || "")
        .trim()
        .toLowerCase();
      const email = String(body.email || "")
        .trim()
        .toLowerCase();
      const password = String(body.password || "");
      if (name.length < 2) throw new Error("Enter your full name");
      if (!/^[a-z0-9_]{3,20}$/.test(username))
        throw new Error(
          "Username must be 3–20 characters (letters, numbers, _)"
        );
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
        throw new Error("Enter a valid email");
      if (password.length < 6)
        throw new Error("Password must be at least 6 characters");
      if (findUser(username) || findUser(email))
        throw new Error("Username or email already registered");
      const area =
        AREAS.find((a) => a.name === body.area) || DEFAULT_LOCATION;
      const user = {
        id: "u" + Date.now(),
        name,
        username,
        email,
        password,
        initials: lsInitials(name),
        location: { name: area.name, lat: area.lat, lng: area.lng },
        created_at: new Date().toISOString(),
      };
      store.users.push(user);
      store.sessionUserId = user.id;
      lsSave(store);
      return {
        user: publicUser(user),
        bootstrap: seedBootstrap(user, store.games, [], store.reservations),
      };
    }
    if (path === "/api/login" && method === "POST") {
      const user = findUser(body.login);
      if (!user || user.password !== String(body.password || ""))
        throw new Error("Wrong username/email or password");
      store.sessionUserId = user.id;
      lsSave(store);
      return {
        user: publicUser(user),
        bootstrap: seedBootstrap(
          user,
          store.games,
          store.bookings.filter((b) => b.userId === user.id),
          store.reservations
        ),
      };
    }
    if (path === "/api/google" && method === "POST") {
      throw new Error(
        "Google login needs Firebase. Paste your keys in firebase-config.js"
      );
    }
    if (path === "/api/location" && method === "POST") {
      const user = sessionUser();
      if (!user) throw new Error("Please log in first");
      user.location = {
        name: body.name || "my location",
        lat: +body.lat,
        lng: +body.lng,
      };
      lsSave(store);
      return { user: publicUser(user) };
    }
    if (path === "/api/book" && method === "POST") {
      const user = sessionUser();
      if (!user) throw new Error("Please log in first");
      const fac = FACILITIES.find((f) => f.id === body.facId);
      if (!fac) throw new Error("Unknown facility");
      const key = `${fac.id}|${body.date}|${body.start}`;
      if ((store.reservations || []).includes(key))
        throw new Error("That slot was just taken — pick another time");
      store.reservations = store.reservations || [];
      store.reservations.push(key);
      const fee = 1,
        total = +body.price + fee;
      const booking = {
        id: "b" + Date.now(),
        userId: user.id,
        username: user.username,
        kind: "court",
        sport: fac.sport,
        facId: fac.id,
        date: body.date,
        start: +body.start,
        end: +body.end,
        total,
        players: +body.players || 10,
        code: lsGateCode(),
        cancelled: false,
        created_at: new Date().toISOString(),
      };
      store.bookings.unshift(booking);
      if (body.share) {
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        const target = new Date(body.date + "T00:00:00");
        const off = Math.round((target - today) / 86400000);
        store.games.unshift({
          id: "g" + Date.now(),
          sport: fac.sport,
          fac: fac.id,
          host: user.name.split(" ")[0],
          hostUsername: user.username,
          players: [user.username],
          dayOffset: off,
          hour: Math.floor(+body.start / 60),
          min: +body.start % 60,
          dur: fac.slot,
          total: +body.players || 10,
          perHead: Math.round((total / (+body.players || 10)) * 2) / 2,
          level: "Mixed",
          note: "Open spots. Pay your share at the gate.",
          mine: true,
          ownerId: user.id,
        });
      }
      lsSave(store);
      return {
        booking,
        toast: body.share
          ? "Booked full field & listed as a drop-in game"
          : `Full field booked · ${booking.code}`,
        games: store.games,
        bookings: store.bookings.filter((b) => b.userId === user.id),
        reservations: store.reservations,
        bootstrap: seedBootstrap(
          user,
          store.games,
          store.bookings.filter((b) => b.userId === user.id),
          store.reservations
        ),
      };
    }
    if (path === "/api/join" && method === "POST") {
      const user = sessionUser();
      if (!user) throw new Error("Please log in first");
      const game = (store.games || []).find((g) => g.id === body.gameId);
      if (!game) throw new Error("Game not found");
      if (game.players.length >= game.total) throw new Error("Game is full");
      if (game.players.includes(user.username))
        throw new Error("You're already in this game");
      game.players.push(user.username);
      const fac = FACILITIES.find((f) => f.id === game.fac);
      const d = new Date();
      d.setDate(d.getDate() + game.dayOffset);
      const booking = {
        id: "b" + Date.now(),
        userId: user.id,
        username: user.username,
        kind: "game",
        gameId: game.id,
        sport: game.sport,
        facId: fac.id,
        date: d.toISOString().slice(0, 10),
        start: game.hour * 60 + game.min,
        end: game.hour * 60 + game.min + game.dur,
        total: game.perHead,
        players: 1,
        host: game.host,
        code: lsGateCode(),
        cancelled: false,
        created_at: new Date().toISOString(),
      };
      store.bookings.unshift(booking);
      lsSave(store);
      return {
        booking,
        toast: `You're in ${game.host}'s game`,
        games: store.games,
        bookings: store.bookings.filter((b) => b.userId === user.id),
        bootstrap: seedBootstrap(
          user,
          store.games,
          store.bookings.filter((b) => b.userId === user.id),
          store.reservations
        ),
      };
    }
    if (path === "/api/cancel" && method === "POST") {
      const user = sessionUser();
      if (!user) throw new Error("Please log in first");
      const booking = (store.bookings || []).find(
        (b) => b.id === body.bookingId && b.userId === user.id
      );
      if (!booking) throw new Error("Booking not found");
      booking.cancelled = true;
      if (booking.kind === "court") {
        const key = `${booking.facId}|${booking.date}|${booking.start}`;
        store.reservations = (store.reservations || []).filter((k) => k !== key);
      } else if (booking.kind === "game") {
        const game = (store.games || []).find((g) => g.id === booking.gameId);
        if (game)
          game.players = game.players.filter((p) => p !== user.username);
      }
      lsSave(store);
      return {
        bookings: store.bookings.filter((b) => b.userId === user.id),
        games: store.games,
        reservations: store.reservations,
        bootstrap: seedBootstrap(
          user,
          store.games,
          store.bookings.filter((b) => b.userId === user.id),
          store.reservations
        ),
        toast: "Booking cancelled · full refund issued",
      };
    }
    if (path === "/api/chat" && method === "POST") {
      if (!sessionUser()) throw new Error("Please log in first");
      const q = String(body.message || "").toLowerCase();
      let text =
        "I can help with venues, prices, and drop-in games. Try asking about football, padel, or what's open tonight.";
      if (/tonight|open|available/.test(q))
        text = `There are about <b>${global.KOORA.metrics?.slotsTonight || 0} slots</b> open tonight across Amman. Browse the Book field tab to reserve one.`;
      else if (/cheap|price|afford/.test(q))
        text =
          "Prices usually range from about <b>15–90 JD</b> depending on the venue and peak hours.";
      else if (/book|how/.test(q))
        text =
          "Pick a venue → choose a time → confirm. You can also list it as a drop-in so others can join and split the cost.";
      else if (/padel|football|basket/.test(q))
        text =
          "Use the sport filters on the home page to see matching venues and open drop-in games.";
      return {
        text,
        chips: ["What's open tonight?", "Cheapest venues", "How do I book?"],
      };
    }
    throw new Error("Not available offline");
  }

  /* ─── Firebase ─── */
  let authReadyPromise = null;

  function initFirebase() {
    if (!global.FIREBASE_CONFIGURED || !global.firebase) return false;
    try {
      fbApp = firebase.apps.length
        ? firebase.app()
        : firebase.initializeApp(global.FIREBASE_CONFIG);
      fbAuth = firebase.auth();
      fbDb = firebase.firestore();
      cloudReady = true;
      return true;
    } catch (err) {
      console.warn("Firebase init failed:", err);
      cloudReady = false;
      return false;
    }
  }

  // Firebase restores the session asynchronously — wait for the first
  // auth-state event before deciding whether the user is logged in.
  function waitForAuth() {
    if (!fbAuth) return Promise.resolve(null);
    if (!authReadyPromise) {
      authReadyPromise = new Promise((resolve) => {
        const stop = fbAuth.onAuthStateChanged(
          (u) => {
            stop();
            resolve(u);
          },
          () => {
            stop();
            resolve(null);
          }
        );
        setTimeout(() => resolve(fbAuth.currentUser), 7000);
      });
    }
    return authReadyPromise;
  }

  function withTimeout(promise, ms) {
    return new Promise((resolve, reject) => {
      const t = setTimeout(
        () => reject(new Error("Cloud request timed out")),
        ms
      );
      promise.then(
        (v) => {
          clearTimeout(t);
          resolve(v);
        },
        (e) => {
          clearTimeout(t);
          reject(e);
        }
      );
    });
  }

  const PROFILE_CACHE = "koora_cloud_profile";
  function cacheProfile(p) {
    try {
      localStorage.setItem(PROFILE_CACHE + "_" + p.id, JSON.stringify(p));
    } catch (_) {}
  }
  function cachedProfile(uid) {
    try {
      return JSON.parse(
        localStorage.getItem(PROFILE_CACHE + "_" + uid) || "null"
      );
    } catch (_) {
      return null;
    }
  }

  // Minimal profile derived from the Firebase Auth user when Firestore
  // is unreachable (e.g. database not created yet).
  function derivedProfile(fbUser) {
    const email = (fbUser.email || "").toLowerCase();
    const name = fbUser.displayName || email.split("@")[0] || "Player";
    let username = (email.split("@")[0] || "player")
      .replace(/[^a-z0-9_]/gi, "")
      .toLowerCase()
      .slice(0, 20);
    if (username.length < 3)
      username = "player" + String(fbUser.uid || "0000").slice(0, 4).toLowerCase();
    const loc = global.KOORA.defaultLocation || {
      name: "3rd Circle",
      lat: 31.9518,
      lng: 35.9105,
    };
    return {
      id: fbUser.uid,
      name,
      username,
      email,
      initials: lsInitials(name),
      location: { name: loc.name, lat: loc.lat, lng: loc.lng },
      provider: "derived",
      created_at: new Date().toISOString(),
    };
  }

  function isDbError(err) {
    const code = (err && err.code) || "";
    return (
      /permission-denied|unavailable|failed-precondition|not-found|resource-exhausted|deadline/.test(
        String(code)
      ) ||
      /timed out|firestore|PERMISSION_DENIED|transport errored/i.test(
        String((err && err.message) || "")
      )
    );
  }
  function friendlyDbError(err) {
    if (isDbError(err))
      return "Cloud database isn't set up — in Firebase console open Firestore Database → Create database, then retry.";
    return (err && err.message) || "Something went wrong";
  }

  // Once Firestore proves unreachable (e.g. database not created),
  // stop hitting it for the rest of the session so the UI stays fast.
  let dbDown = false;

  async function ensureGamesSeeded() {
    if (gamesSeeded || !fbDb || dbDown) return;
    try {
      const snap = await withTimeout(
        fbDb.collection("games").limit(1).get(),
        6000
      );
      if (snap.empty) {
        const batch = fbDb.batch();
        (global.KOORA.games || []).forEach((g) => {
          batch.set(fbDb.collection("games").doc(g.id), g);
        });
        await withTimeout(batch.commit(), 6000);
      }
      gamesSeeded = true;
    } catch (err) {
      // Firestore missing or rules deny guest writes — seed games from bootstrap.js instead
      if (isDbError(err)) dbDown = true;
      console.warn("Cloud games seed skipped:", err && err.message);
    }
  }

  // Never throws — falls back to bootstrap.js seed so the app always renders.
  async function loadCloudState(uid) {
    const fallback = {
      user: uid ? cachedProfile(uid) : null,
      games: global.KOORA.games || [],
      bookings: [],
      reservations: [],
    };
    if (dbDown) return fallback;
    await ensureGamesSeeded();
    if (dbDown) return fallback;

    const [gamesRes, userRes, bookingsRes, resRes] = await Promise.allSettled([
      withTimeout(fbDb.collection("games").get(), 7000),
      uid
        ? withTimeout(fbDb.collection("users").doc(uid).get(), 7000)
        : Promise.resolve(null),
      uid
        ? withTimeout(
            fbDb.collection("bookings").where("userId", "==", uid).get(),
            7000
          )
        : Promise.resolve(null),
      withTimeout(fbDb.collection("meta").doc("reservations").get(), 7000),
    ]);
    for (const r of [gamesRes, userRes, bookingsRes, resRes]) {
      if (r.status === "rejected" && isDbError(r.reason)) dbDown = true;
    }

    let user = fallback.user;
    let games = fallback.games;
    let bookings = [];
    let reservations = [];
    if (gamesRes.status === "fulfilled" && !gamesRes.value.empty)
      games = gamesRes.value.docs.map((d) => ({ id: d.id, ...d.data() }));
    if (userRes.status === "fulfilled" && userRes.value && userRes.value.exists)
      user = { id: uid, ...userRes.value.data() };
    if (bookingsRes.status === "fulfilled" && bookingsRes.value)
      bookings = bookingsRes.value.docs
        .map((d) => ({ id: d.id, ...d.data() }))
        .sort((a, b) =>
          String(b.created_at || "").localeCompare(String(a.created_at || ""))
        );
    if (
      resRes.status === "fulfilled" &&
      resRes.value.exists &&
      Array.isArray(resRes.value.data().keys)
    )
      reservations = resRes.value.data().keys;
    return { user, games, bookings, reservations };
  }

  // Resolve a full profile for a signed-in Firebase user:
  // Firestore doc → cached copy → derived from the auth account.
  async function resolveProfile(fbUser, stUser) {
    if (stUser) {
      cacheProfile(stUser);
      return stUser;
    }
    if (dbDown) return cachedProfile(fbUser.uid) || derivedProfile(fbUser);
    try {
      const profile = await withTimeout(upsertGoogleProfile(fbUser), 8000);
      cacheProfile(profile);
      return profile;
    } catch (err) {
      if (isDbError(err)) dbDown = true;
      return cachedProfile(fbUser.uid) || derivedProfile(fbUser);
    }
  }

  async function claimUsername(username, uid, email) {
    const ref = fbDb.collection("usernames").doc(username);
    await fbDb.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      if (snap.exists && snap.data().uid !== uid) {
        throw new Error("Username already taken");
      }
      tx.set(ref, { uid, email });
    });
  }

  function friendlyAuthError(err) {
    const code = err && err.code;
    if (code === "auth/email-already-in-use")
      return "Email already registered — try logging in";
    if (code === "auth/wrong-password" || code === "auth/user-not-found" || code === "auth/invalid-credential")
      return "Wrong username/email or password";
    if (code === "auth/weak-password") return "Password must be at least 6 characters";
    if (code === "auth/popup-closed-by-user") return "Google sign-in was cancelled";
    if (code === "auth/unauthorized-domain")
      return "Add this site to Firebase Authorized domains";
    return (err && err.message) || "Authentication failed";
  }

  async function upsertGoogleProfile(fbUser) {
    const ref = fbDb.collection("users").doc(fbUser.uid);
    const snap = await ref.get();
    if (snap.exists) return { id: fbUser.uid, ...snap.data() };

    const email = (fbUser.email || "").toLowerCase();
    let base = (email.split("@")[0] || "player")
      .replace(/[^a-z0-9_]/gi, "")
      .toLowerCase()
      .slice(0, 16);
    if (base.length < 3) base = "player" + Math.floor(Math.random() * 900 + 100);
    let username = base;
    for (let i = 0; i < 20; i++) {
      const uRef = fbDb.collection("usernames").doc(username);
      const uSnap = await uRef.get();
      if (!uSnap.exists) break;
      username = (base + (i + 2)).slice(0, 20);
    }
    const name = fbUser.displayName || username;
    const loc = global.KOORA.defaultLocation || {
      name: "3rd Circle",
      lat: 31.9518,
      lng: 35.9105,
    };
    const profile = {
      name,
      username,
      email,
      initials: lsInitials(name),
      location: { name: loc.name, lat: loc.lat, lng: loc.lng },
      provider: "google",
      created_at: new Date().toISOString(),
    };
    await claimUsername(username, fbUser.uid, email);
    await ref.set(profile);
    return { id: fbUser.uid, ...profile };
  }

  async function apiCloud(path, opts = {}) {
    try {
      return await apiCloudInner(path, opts);
    } catch (err) {
      // Intentional errors ("Game is full", …) pass through unchanged;
      // raw Firestore failures become an actionable message.
      throw new Error(friendlyDbError(err));
    }
  }

  async function apiCloudInner(path, opts = {}) {
    const method = (opts.method || "GET").toUpperCase();
    const body = opts.body ? JSON.parse(opts.body) : {};
    const FACILITIES = global.KOORA.facilities || [];
    const AREAS = global.KOORA.areas || [];
    const DEFAULT_LOCATION = global.KOORA.defaultLocation;

    if (path === "/api/me" && method === "GET") {
      const fbUser = await waitForAuth();
      if (!fbUser) {
        const st = await loadCloudState(null);
        return {
          authenticated: false,
          user: null,
          bootstrap: seedBootstrap(null, st.games, [], st.reservations),
        };
      }
      const st = await loadCloudState(fbUser.uid);
      const user = await resolveProfile(fbUser, st.user);
      return {
        authenticated: true,
        user: publicUser(user),
        bootstrap: seedBootstrap(user, st.games, st.bookings, st.reservations),
      };
    }

    if (path === "/api/logout" && method === "POST") {
      await fbAuth.signOut();
      return { ok: true };
    }

    if (path === "/api/signup" && method === "POST") {
      const name = String(body.name || "").trim();
      const username = String(body.username || "")
        .trim()
        .toLowerCase();
      const email = String(body.email || "")
        .trim()
        .toLowerCase();
      const password = String(body.password || "");
      if (name.length < 2) throw new Error("Enter your full name");
      if (!/^[a-z0-9_]{3,20}$/.test(username))
        throw new Error(
          "Username must be 3–20 characters (letters, numbers, _)"
        );
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
        throw new Error("Enter a valid email");
      if (password.length < 6)
        throw new Error("Password must be at least 6 characters");

      // Username uniqueness check is best-effort when the DB is unreachable
      try {
        const unameSnap = await withTimeout(
          fbDb.collection("usernames").doc(username).get(),
          6000
        );
        if (unameSnap.exists) throw new Error("Username already registered");
      } catch (err) {
        if (!isDbError(err)) throw err;
      }

      let cred;
      try {
        cred = await fbAuth.createUserWithEmailAndPassword(email, password);
      } catch (err) {
        throw new Error(friendlyAuthError(err));
      }
      const area =
        AREAS.find((a) => a.name === body.area) || DEFAULT_LOCATION;
      const profile = {
        name,
        username,
        email,
        initials: lsInitials(name),
        location: { name: area.name, lat: area.lat, lng: area.lng },
        provider: "password",
        created_at: new Date().toISOString(),
      };
      try {
        await claimUsername(username, cred.user.uid, email);
        await fbDb.collection("users").doc(cred.user.uid).set(profile);
      } catch (err) {
        if (err && err.message === "Username already taken") {
          try {
            await cred.user.delete();
          } catch (_) {}
          throw err;
        }
        // Firestore unreachable — account exists in Auth; keep a local copy
        console.warn("Cloud profile save failed:", err && err.message);
      }
      const user = { id: cred.user.uid, ...profile };
      cacheProfile(user);
      const st = await loadCloudState(user.id);
      return {
        user: publicUser(user),
        bootstrap: seedBootstrap(user, st.games, [], st.reservations),
      };
    }

    if (path === "/api/login" && method === "POST") {
      const login = String(body.login || "")
        .trim()
        .toLowerCase();
      const password = String(body.password || "");
      let email = login;
      if (!login.includes("@")) {
        let snap = null;
        try {
          snap = await withTimeout(
            fbDb.collection("usernames").doc(login).get(),
            6000
          );
        } catch (err) {
          throw new Error(
            "Couldn't look up that username — try logging in with your email instead"
          );
        }
        if (!snap.exists) throw new Error("Wrong username/email or password");
        email = snap.data().email;
      }
      try {
        await fbAuth.signInWithEmailAndPassword(email, password);
      } catch (err) {
        throw new Error(friendlyAuthError(err));
      }
      const fbUser = fbAuth.currentUser;
      const st = await loadCloudState(fbUser.uid);
      const user = await resolveProfile(fbUser, st.user);
      return {
        user: publicUser(user),
        bootstrap: seedBootstrap(user, st.games, st.bookings, st.reservations),
      };
    }

    if (path === "/api/google" && method === "POST") {
      const provider = new firebase.auth.GoogleAuthProvider();
      let result;
      try {
        result = await fbAuth.signInWithPopup(provider);
      } catch (err) {
        if (
          err &&
          (err.code === "auth/popup-blocked" ||
            err.code === "auth/operation-not-supported-in-this-environment")
        ) {
          // Fall back to full-page redirect; boot() picks the session up on return
          await fbAuth.signInWithRedirect(provider);
          return new Promise(() => {});
        }
        throw new Error(friendlyAuthError(err));
      }
      const fbUser = result.user;
      const st = await loadCloudState(fbUser.uid);
      const user = await resolveProfile(fbUser, st.user);
      return {
        user: publicUser(user),
        bootstrap: seedBootstrap(user, st.games, st.bookings, st.reservations),
      };
    }

    if (path === "/api/location" && method === "POST") {
      const fbUser = fbAuth.currentUser;
      if (!fbUser) throw new Error("Please log in first");
      const location = {
        name: body.name || "my location",
        lat: +body.lat,
        lng: +body.lng,
      };
      const cached = cachedProfile(fbUser.uid);
      if (cached) cacheProfile({ ...cached, location });
      try {
        await withTimeout(
          fbDb.collection("users").doc(fbUser.uid).set({ location }, { merge: true }),
          7000
        );
        const snap = await withTimeout(
          fbDb.collection("users").doc(fbUser.uid).get(),
          7000
        );
        if (snap.exists)
          return { user: publicUser({ id: fbUser.uid, ...snap.data() }) };
      } catch (err) {
        console.warn("Cloud location save failed:", err && err.message);
      }
      const user = cachedProfile(fbUser.uid) || derivedProfile(fbUser);
      return { user: publicUser({ ...user, location }) };
    }

    if (path === "/api/book" && method === "POST") {
      const fbUser = fbAuth.currentUser;
      if (!fbUser) throw new Error("Please log in first");
      const user = await resolveProfile(fbUser, null);
      const fac = FACILITIES.find((f) => f.id === body.facId);
      if (!fac) throw new Error("Unknown facility");
      const key = `${fac.id}|${body.date}|${body.start}`;
      const resRef = fbDb.collection("meta").doc("reservations");
      await fbDb.runTransaction(async (tx) => {
        const snap = await tx.get(resRef);
        const keys = snap.exists ? snap.data().keys || [] : [];
        if (keys.includes(key))
          throw new Error("That slot was just taken — pick another time");
        tx.set(resRef, { keys: [...keys, key] }, { merge: true });
      });
      const fee = 1,
        total = +body.price + fee;
      const bookingRef = fbDb.collection("bookings").doc();
      const booking = {
        userId: user.id,
        username: user.username,
        kind: "court",
        sport: fac.sport,
        facId: fac.id,
        date: body.date,
        start: +body.start,
        end: +body.end,
        total,
        players: +body.players || 10,
        code: lsGateCode(),
        cancelled: false,
        created_at: new Date().toISOString(),
      };
      await bookingRef.set(booking);
      booking.id = bookingRef.id;
      if (body.share) {
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        const target = new Date(body.date + "T00:00:00");
        const off = Math.round((target - today) / 86400000);
        const gameRef = fbDb.collection("games").doc();
        await gameRef.set({
          sport: fac.sport,
          fac: fac.id,
          host: user.name.split(" ")[0],
          hostUsername: user.username,
          players: [user.username],
          dayOffset: off,
          hour: Math.floor(+body.start / 60),
          min: +body.start % 60,
          dur: fac.slot,
          total: +body.players || 10,
          perHead: Math.round((total / (+body.players || 10)) * 2) / 2,
          level: "Mixed",
          note: "Open spots. Pay your share at the gate.",
          mine: true,
          ownerId: user.id,
        });
      }
      const st = await loadCloudState(user.id);
      return {
        booking,
        toast: body.share
          ? "Booked full field & listed as a drop-in game"
          : `Full field booked · ${booking.code}`,
        games: st.games,
        bookings: st.bookings,
        reservations: st.reservations,
        bootstrap: seedBootstrap(
          user,
          st.games,
          st.bookings,
          st.reservations
        ),
      };
    }

    if (path === "/api/join" && method === "POST") {
      const fbUser = fbAuth.currentUser;
      if (!fbUser) throw new Error("Please log in first");
      const user = await resolveProfile(fbUser, null);
      const gameRef = fbDb.collection("games").doc(body.gameId);
      let game;
      await fbDb.runTransaction(async (tx) => {
        const snap = await tx.get(gameRef);
        if (!snap.exists) throw new Error("Game not found");
        game = { id: snap.id, ...snap.data() };
        if (game.players.length >= game.total) throw new Error("Game is full");
        if (game.players.includes(user.username))
          throw new Error("You're already in this game");
        const players = [...game.players, user.username];
        tx.update(gameRef, { players });
        game.players = players;
      });
      const fac = FACILITIES.find((f) => f.id === game.fac);
      const d = new Date();
      d.setDate(d.getDate() + game.dayOffset);
      const bookingRef = fbDb.collection("bookings").doc();
      const booking = {
        userId: user.id,
        username: user.username,
        kind: "game",
        gameId: game.id,
        sport: game.sport,
        facId: fac.id,
        date: d.toISOString().slice(0, 10),
        start: game.hour * 60 + game.min,
        end: game.hour * 60 + game.min + game.dur,
        total: game.perHead,
        players: 1,
        host: game.host,
        code: lsGateCode(),
        cancelled: false,
        created_at: new Date().toISOString(),
      };
      await bookingRef.set(booking);
      booking.id = bookingRef.id;
      const st = await loadCloudState(user.id);
      return {
        booking,
        toast: `You're in ${game.host}'s game`,
        games: st.games,
        bookings: st.bookings,
        bootstrap: seedBootstrap(
          user,
          st.games,
          st.bookings,
          st.reservations
        ),
      };
    }

    if (path === "/api/cancel" && method === "POST") {
      const fbUser = fbAuth.currentUser;
      if (!fbUser) throw new Error("Please log in first");
      const bookingRef = fbDb.collection("bookings").doc(body.bookingId);
      const snap = await bookingRef.get();
      if (!snap.exists || snap.data().userId !== fbUser.uid)
        throw new Error("Booking not found");
      const booking = { id: snap.id, ...snap.data() };
      await bookingRef.update({ cancelled: true });
      if (booking.kind === "court") {
        const key = `${booking.facId}|${booking.date}|${booking.start}`;
        const resRef = fbDb.collection("meta").doc("reservations");
        await fbDb.runTransaction(async (tx) => {
          const r = await tx.get(resRef);
          const keys = r.exists ? r.data().keys || [] : [];
          tx.set(
            resRef,
            { keys: keys.filter((k) => k !== key) },
            { merge: true }
          );
        });
      } else if (booking.kind === "game" && booking.gameId) {
        const profile = await resolveProfile(fbUser, null);
        const username = profile.username;
        const gameRef = fbDb.collection("games").doc(booking.gameId);
        await fbDb.runTransaction(async (tx) => {
          const g = await tx.get(gameRef);
          if (!g.exists) return;
          const players = (g.data().players || []).filter((p) => p !== username);
          tx.update(gameRef, { players });
        });
      }
      const st = await loadCloudState(fbUser.uid);
      const user = st.user;
      return {
        bookings: st.bookings,
        games: st.games,
        reservations: st.reservations,
        bootstrap: seedBootstrap(
          user,
          st.games,
          st.bookings,
          st.reservations
        ),
        toast: "Booking cancelled · full refund issued",
      };
    }

    if (path === "/api/chat" && method === "POST") {
      if (!fbAuth.currentUser) throw new Error("Please log in first");
      const q = String(body.message || "").toLowerCase();
      let text =
        "I can help with venues, prices, and drop-in games. Try asking about football, padel, or what's open tonight.";
      if (/tonight|open|available/.test(q))
        text = `There are about <b>${global.KOORA.metrics?.slotsTonight || 0} slots</b> open tonight across Amman. Browse the Book field tab to reserve one.`;
      else if (/cheap|price|afford/.test(q))
        text =
          "Prices usually range from about <b>15–90 JD</b> depending on the venue and peak hours.";
      else if (/book|how/.test(q))
        text =
          "Pick a venue → choose a time → confirm. You can also list it as a drop-in so others can join and split the cost.";
      else if (/padel|football|basket/.test(q))
        text =
          "Use the sport filters on the home page to see matching venues and open drop-in games.";
      return {
        text,
        chips: ["What's open tonight?", "Cheapest venues", "How do I book?"],
      };
    }

    throw new Error("Not available");
  }

  function isCloud() {
    return cloudReady;
  }

  async function apiStatic(path, opts) {
    if (cloudReady) return apiCloud(path, opts);
    return apiLocal(path, opts);
  }

  // init immediately if SDKs already loaded
  initFirebase();

  global.KooraCloud = {
    initFirebase,
    isCloud,
    apiStatic,
    lsInitials,
  };
})(window);
