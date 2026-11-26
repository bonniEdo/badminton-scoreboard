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

const TARGET_SCORE = 21;
const CHANGE_ENDS_SCORE = 11;
const $ = (id) => document.getElementById(id);
const env = window.SCOREBOARD_ENV || {};

function safeScheduleId(value, fallback) {
  const id = String(value ?? "").trim().replace(/[.#$\/\[\]]/g, "-").slice(0, 40);
  return id && !["__proto__", "prototype", "constructor"].includes(id) ? id : fallback;
}

function parseSchedule(value) {
  const rows = Array.isArray(value)
    ? value
    : String(value || "")
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line && !line.startsWith("#"))
        .map((line) => line.split("|"));

  const seen = new Set();
  return rows.flatMap((row, index) => {
    const values = Array.isArray(row)
      ? row
      : [row.id ?? row.number, row.type ?? row.category, row.teamA, row.teamB];
    const id = safeScheduleId(values[0], String(index + 1));
    if (seen.has(id)) return [];
    seen.add(id);

    return [{
      id,
      number: String(values[0] ?? index + 1).trim() || String(index + 1),
      type: String(values[1] ?? "羽球").trim() || "羽球",
      teamA: String(values[2] ?? "").trim(),
      teamB: String(values[3] ?? "").trim()
    }];
  });
}

const schedule = parseSchedule(env.MATCH_SCHEDULE);
if (!schedule.length) {
  schedule.push({ id: "1", number: "1", type: "羽球", teamA: "藍隊", teamB: "黑隊" });
}

const configuredMatchId = safeScheduleId(env.CURRENT_MATCH, schedule[0].id);
const defaultMatchId = schedule.some((match) => match.id === configuredMatchId)
  ? configuredMatchId
  : schedule[0].id;
const params = new URLSearchParams(location.search);
const displayOnly = params.get("view") === "display";
const rawRoomId = (params.get("match") || "default").trim();
const roomId = rawRoomId.replace(/[.#$\/\[\]]/g, "-").slice(0, 60) || "default";
const storageKey = `badminton-scoreboard:generic:${roomId}`;

let state = loadLocalState();
let dbApi = null;
let roomRef = null;
let toastTimer = null;
let queuedWrite = false;
let writePending = false;

function emptyMatchState() {
  return {
    scores: {
      A: { 1: null, 2: null },
      B: { 1: null, 2: null }
    },
    currentGame: 1,
    endsSwapped: { 1: false, 2: false }
  };
}

function defaultState() {
  return {
    version: 4,
    currentMatchId: defaultMatchId,
    matches: { [defaultMatchId]: emptyMatchState() },
    updatedAt: Date.now()
  };
}

function scoreValue(value) {
  if (value === null || value === undefined || value === "" || Number.isNaN(Number(value))) {
    return null;
  }
  return Math.min(TARGET_SCORE, Math.max(0, Math.trunc(Number(value))));
}

function normalizeMatchState(value) {
  const source = value && typeof value === "object" ? value : {};
  const scoreSource = source.scores || {};
  return {
    scores: {
      A: { 1: scoreValue(scoreSource.A?.[1]), 2: scoreValue(scoreSource.A?.[2]) },
      B: { 1: scoreValue(scoreSource.B?.[1]), 2: scoreValue(scoreSource.B?.[2]) }
    },
    endsSwapped: { 1: source.endsSwapped?.[1] === true, 2: source.endsSwapped?.[2] === true },
    currentGame: Math.min(2, Math.max(1, Number(source.currentGame ?? source.currentSet) || 1))
  };
}

function normalizeState(value) {
  const source = value && typeof value === "object" ? value : {};
  const matches = {};
  let currentMatchId = safeScheduleId(source.currentMatchId, defaultMatchId);

  if (!schedule.some((match) => match.id === currentMatchId)) {
    currentMatchId = defaultMatchId;
  }

  if (Number(source.version) >= 4 && source.matches && typeof source.matches === "object") {
    for (const match of schedule) {
      if (source.matches[match.id]) {
        matches[match.id] = normalizeMatchState(source.matches[match.id]);
      }
    }
  } else {
    const legacyMatch = source.matches?.[source.currentMatch || 1];
    matches[currentMatchId] = normalizeMatchState({
      scores: legacyMatch?.scores || source.scores,
      currentGame: source.currentGame ?? source.currentSet
    });
  }

  if (!matches[currentMatchId]) matches[currentMatchId] = emptyMatchState();

  return {
    version: 4,
    currentMatchId,
    matches,
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

function currentRoster() {
  return schedule.find((match) => match.id === state.currentMatchId) || schedule[0];
}

function currentScoreState() {
  const match = currentRoster();
  if (!state.matches[match.id]) state.matches[match.id] = emptyMatchState();
  return state.matches[match.id];
}

function displayName(value) {
  return value || "待定";
}

function gameWinner(gameNumber) {
  const scores = currentScoreState().scores;
  const a = Number(scores.A[gameNumber] ?? 0);
  const b = Number(scores.B[gameNumber] ?? 0);
  if (Math.max(a, b) < TARGET_SCORE || a === b) return null;
  return a > b ? "A" : "B";
}

function totals() {
  const scores = currentScoreState().scores;
  return {
    A: Number(scores.A[1] ?? 0) + Number(scores.A[2] ?? 0),
    B: Number(scores.B[1] ?? 0) + Number(scores.B[2] ?? 0)
  };
}

function formatScore(value) {
  return value === null ? "–" : String(value);
}

function render() {
  const roster = currentRoster();
  const matchState = currentScoreState();
  const game = matchState.currentGame;
  const endsSwapped = matchState.endsSwapped[game];
  const needsChangeEnds = !endsSwapped && !gameWinner(game) &&
    Math.max(matchState.scores.A[game] ?? 0, matchState.scores.B[game] ?? 0) >= CHANGE_ENDS_SCORE;
  const teamControls = $("teamControls");
  const firstControl = $(endsSwapped ? "blackControl" : "blueControl");
  if (teamControls.firstElementChild !== firstControl) teamControls.prepend(firstControl);
  $("swapEnds").setAttribute("aria-pressed", String(endsSwapped));
  $("changeEndsStatus").textContent = endsSwapped
    ? `第 ${game} 局已換邊`
    : needsChangeEnds ? `第 ${game} 局已達 11 分，請換邊` : "";
  const total = totals();
  const teamA = displayName(roster.teamA);
  const teamB = displayName(roster.teamB);

  $("matchNumber").textContent = `第 ${roster.number} 場`;
  $("matchType").textContent = roster.type;
  $("matchupA").textContent = teamA;
  $("matchupB").textContent = teamB;
  $("teamNameA").textContent = teamA;
  $("teamNameB").textContent = teamB;
  $("controlTeamA").textContent = teamA;
  $("controlTeamB").textContent = teamB;
  document.title = `第 ${roster.number} 場｜${teamA} vs ${teamB}`;

  for (const team of ["A", "B"]) {
    for (const game of [1, 2]) {
      const element = $(`${team}${game}`);
      const value = matchState.scores[team][game];
      element.textContent = formatScore(value);
      element.classList.toggle("empty", value === null);
      element.classList.toggle("current", game === matchState.currentGame);
      element.classList.toggle("winner", gameWinner(game) === team);
      element.setAttribute("aria-label", `${team === "A" ? teamA : teamB}第 ${game} 局分數`);
    }
  }

  $("totalA").textContent = total.A;
  $("totalB").textContent = total.B;
  $("totalA").classList.toggle("leader", total.A > total.B);
  $("totalB").classList.toggle("leader", total.B > total.A);
  $("currentA").textContent = matchState.scores.A[matchState.currentGame] ?? 0;
  $("currentB").textContent = matchState.scores.B[matchState.currentGame] ?? 0;
  $("matchSelect").value = roster.id;

  const rosterIndex = schedule.findIndex((match) => match.id === roster.id);
  $("previousMatch").disabled = rosterIndex <= 0;
  $("nextMatch").disabled = rosterIndex >= schedule.length - 1;

  document.querySelectorAll(".gameHead").forEach((element) => {
    element.classList.toggle("current", Number(element.dataset.game) === matchState.currentGame);
  });

  document.querySelectorAll(".gameButton").forEach((element) => {
    element.classList.toggle("active", Number(element.dataset.pickGame) === matchState.currentGame);
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
  const matchState = currentScoreState();
  const game = matchState.currentGame;

  if (gameWinner(game) && delta > 0) {
    showToast("本局已結束，如需修正請按 −1");
    return;
  }

  const current = Number(matchState.scores[team][game] ?? 0);
  matchState.scores[team][game] = Math.min(TARGET_SCORE, Math.max(0, current + delta));

  if (delta > 0 && gameWinner(game) && game === 1) {
    matchState.currentGame = 2;
    showToast("第 1 局結束，已切換到第 2 局");
  }

  render();
  save();
}

function swapEnds() {
  const matchState = currentScoreState();
  const game = matchState.currentGame;
  matchState.endsSwapped[game] = !matchState.endsSwapped[game];
  render();
  save();
}

function selectGame(game) {
  currentScoreState().currentGame = game;
  render();
  save();
}

function selectScheduledMatch(matchId) {
  const nextMatch = schedule.find((match) => match.id === matchId);
  if (!nextMatch || nextMatch.id === state.currentMatchId) return;

  state.currentMatchId = nextMatch.id;
  currentScoreState();
  render();
  save();
  showToast(`已切換到第 ${nextMatch.number} 場`);
}

function moveScheduledMatch(offset) {
  const index = schedule.findIndex((match) => match.id === currentRoster().id);
  const next = schedule[index + offset];
  if (next) selectScheduledMatch(next.id);
}

function clearScores() {
  const matchState = currentScoreState();
  const hasScore = ["A", "B"].some((team) =>
    [1, 2].some((game) => matchState.scores[team][game] !== null)
  ) || Object.values(matchState.endsSwapped).some(Boolean);
  if (!hasScore) return;

  const roster = currentRoster();
  const confirmed = confirm(`確定要清空第 ${roster.number} 場的全部比分嗎？`);
  if (!confirmed) return;

  state.matches[roster.id] = emptyMatchState();
  render();
  save();
  showToast(`第 ${roster.number} 場比分已清空`);
}

function populateSchedulePicker() {
  for (const match of schedule) {
    const option = document.createElement("option");
    option.value = match.id;
    option.textContent = `第 ${match.number} 場｜${match.type}｜${displayName(match.teamA)} vs ${displayName(match.teamB)}`;
    $("matchSelect").append(option);
  }
}

function bindControls() {
  $("plusA").addEventListener("click", () => changeScore("A", 1));
  $("minusA").addEventListener("click", () => changeScore("A", -1));
  $("plusB").addEventListener("click", () => changeScore("B", 1));
  $("minusB").addEventListener("click", () => changeScore("B", -1));
  $("swapEnds").addEventListener("click", swapEnds);
  $("clearButton").addEventListener("click", clearScores);
  $("matchSelect").addEventListener("change", (event) => selectScheduledMatch(event.target.value));
  $("previousMatch").addEventListener("click", () => moveScheduledMatch(-1));
  $("nextMatch").addEventListener("click", () => moveScheduledMatch(1));

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
    roomRef = database.ref(db, `matches/${roomId}`);

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

populateSchedulePicker();
if (displayOnly) document.body.classList.add("displayOnly");
if (!displayOnly) bindControls();
render();
connectFirebase();
