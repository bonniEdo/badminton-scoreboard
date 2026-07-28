const firebaseConfig = {
  apiKey: "AIzaSyA4nfnsIBGLua60tZDVpWoKQKlY1BDjuvU",
  authDomain: "badminton-scoreboard-898a5.firebaseapp.com",
  databaseURL: "https://badminton-scoreboard-898a5-default-rtdb.asia-southeast1.firebasedatabase.app",
  projectId: "badminton-scoreboard-898a5",
  storageBucket: "badminton-scoreboard-898a5.firebasestorage.app",
  messagingSenderId: "1049093037710",
  appId: "1:1049093037710:web:b2f33852920a4892eef3df",
  measurementId: "G-HFQG0FBYH6"
};

const TARGET_SCORE = 15;
const SCORE_CAP = 17;
const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);
const displayOnly = params.get("view") === "display";
const rawMatchId = (params.get("match") || "default").trim();
const matchId = rawMatchId.replace(/[.#$\/\[\]]/g, "-").slice(0, 60) || "default";
const storageKey = `badminton-scoreboard:generic:${matchId}`;

let state = loadLocalState();
let dbApi = null;
let roomRef = null;
let toastTimer = null;
let queuedWrite = false;
let writePending = false;

function defaultState() {
  return {
    version: 3,
    scores: {
      A: { 1: null, 2: null },
      B: { 1: null, 2: null }
    },
    currentGame: 1,
    updatedAt: Date.now()
  };
}

function scoreValue(value) {
  if (value === null || value === undefined || value === "" || Number.isNaN(Number(value))) {
    return null;
  }
  return Math.min(SCORE_CAP, Math.max(0, Math.trunc(Number(value))));
}

function normalizeState(value) {
  const source = value && typeof value === "object" ? value : defaultState();
  const legacyMatch = source.matches?.[source.currentMatch || 1];
  const scoreSource = legacyMatch?.scores || source.scores || {};

  return {
    version: 3,
    scores: {
      A: { 1: scoreValue(scoreSource.A?.[1]), 2: scoreValue(scoreSource.A?.[2]) },
      B: { 1: scoreValue(scoreSource.B?.[1]), 2: scoreValue(scoreSource.B?.[2]) }
    },
    currentGame: Math.min(2, Math.max(1, Number(source.currentGame ?? source.currentSet) || 1)),
    updatedAt: Number(source.updatedAt) || Date.now()
  };
}

function loadLocalState() {
  try {
    const saved = localStorage.getItem(storageKey);
    return saved ? normalizeState(JSON.parse(saved)) : defaultState();
  } catch {
    return defaultState();
  }
}

function gameWinner(gameNumber) {
  const a = Number(state.scores.A[gameNumber] ?? 0);
  const b = Number(state.scores.B[gameNumber] ?? 0);
  const high = Math.max(a, b);
  const finished = high === SCORE_CAP || (high >= TARGET_SCORE && Math.abs(a - b) >= 2);
  if (!finished || a === b) return null;
  return a > b ? "A" : "B";
}

function totals() {
  return {
    A: Number(state.scores.A[1] ?? 0) + Number(state.scores.A[2] ?? 0),
    B: Number(state.scores.B[1] ?? 0) + Number(state.scores.B[2] ?? 0)
  };
}

function formatScore(value) {
  return value === null ? "–" : String(value);
}

function render() {
  const total = totals();

  for (const team of ["A", "B"]) {
    for (const game of [1, 2]) {
      const element = $(`${team}${game}`);
      const value = state.scores[team][game];
      element.textContent = formatScore(value);
      element.classList.toggle("empty", value === null);
      element.classList.toggle("current", game === state.currentGame);
      element.classList.toggle("winner", gameWinner(game) === team);
    }
  }

  $("totalA").textContent = total.A;
  $("totalB").textContent = total.B;
  $("totalA").classList.toggle("leader", total.A > total.B);
  $("totalB").classList.toggle("leader", total.B > total.A);
  $("currentA").textContent = state.scores.A[state.currentGame] ?? 0;
  $("currentB").textContent = state.scores.B[state.currentGame] ?? 0;

  document.querySelectorAll(".gameHead").forEach((element) => {
    element.classList.toggle("current", Number(element.dataset.game) === state.currentGame);
  });

  document.querySelectorAll(".gameButton").forEach((element) => {
    element.classList.toggle("active", Number(element.dataset.pickGame) === state.currentGame);
  });
}

function save() {
  state.updatedAt = Date.now();
  try {
    localStorage.setItem(storageKey, JSON.stringify(state));
  } catch {}

  if (!roomRef || !dbApi) {
    queuedWrite = true;
    return;
  }

  queuedWrite = false;
  writePending = true;
  const payload = JSON.parse(JSON.stringify(state));
  dbApi.set(roomRef, payload)
    .then(() => {
      if (state.updatedAt === payload.updatedAt) writePending = false;
    })
    .catch(() => {
      queuedWrite = true;
      writePending = false;
      if (!displayOnly) showToast("即時同步連線失敗");
    });
}

function showToast(message) {
  const toast = $("toast");
  toast.textContent = message;
  toast.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove("show"), 1800);
}

function changeScore(team, delta) {
  const game = state.currentGame;

  if (gameWinner(game) && delta > 0) {
    showToast("本局已結束，如需修正請按 −1");
    return;
  }

  const current = Number(state.scores[team][game] ?? 0);
  state.scores[team][game] = Math.min(SCORE_CAP, Math.max(0, current + delta));

  if (delta > 0 && gameWinner(game) && game === 1) {
    state.currentGame = 2;
    showToast("第 1 局結束，已切換到第 2 局");
  }

  render();
  save();
}

function selectGame(game) {
  state.currentGame = game;
  render();
  save();
}

function clearScores() {
  const hasScore = ["A", "B"].some((team) =>
    [1, 2].some((game) => state.scores[team][game] !== null)
  );
  if (!hasScore) return;

  const confirmed = confirm("確定要清空白隊與藍隊的全部比分嗎？");
  if (!confirmed) return;

  state = defaultState();
  render();
  save();
  showToast("比分已清空，可以開始下一場");
}

function bindControls() {
  $("plusA").addEventListener("click", () => changeScore("A", 1));
  $("minusA").addEventListener("click", () => changeScore("A", -1));
  $("plusB").addEventListener("click", () => changeScore("B", 1));
  $("minusB").addEventListener("click", () => changeScore("B", -1));
  $("clearButton").addEventListener("click", clearScores);

  document.querySelectorAll("[data-pick-game]").forEach((button) => {
    button.addEventListener("click", () => selectGame(Number(button.dataset.pickGame)));
  });

  document.querySelectorAll(".score").forEach((button) => {
    button.addEventListener("click", () => {
      if (!displayOnly) selectGame(Number(button.dataset.game));
    });
  });
}

async function connectFirebase() {
  try {
    const [{ initializeApp }, authApi, database] = await Promise.all([
      import("https://www.gstatic.com/firebasejs/10.12.5/firebase-app.js"),
      import("https://www.gstatic.com/firebasejs/10.12.5/firebase-auth.js"),
      import("https://www.gstatic.com/firebasejs/10.12.5/firebase-database.js")
    ]);
    const app = initializeApp(firebaseConfig);
    const auth = authApi.getAuth(app);
    await auth.authStateReady();
    if (!auth.currentUser) {
      await authApi.signInAnonymously(auth);
    }

    const db = database.getDatabase(app);
    database.goOnline(db);
    dbApi = database;
    roomRef = database.ref(db, `matches/${matchId}`);

    database.onValue(roomRef, (snapshot) => {
      const remote = snapshot.val();
      if (remote) {
        const remoteState = normalizeState(remote);
        if (displayOnly || !writePending || remoteState.updatedAt >= state.updatedAt) {
          state = remoteState;
          try {
            localStorage.setItem(storageKey, JSON.stringify(state));
          } catch {}
          render();
        }
      } else {
        save();
      }
    }, () => {
      if (!displayOnly) showToast("即時同步連線失敗");
    });

    if (queuedWrite) save();
  } catch (error) {
    console.error("Firebase sync failed:", error);
    if (!displayOnly) showToast("即時同步連線失敗");
  }
}

if (displayOnly) document.body.classList.add("displayOnly");
if (!displayOnly) bindControls();
render();
connectFirebase();
