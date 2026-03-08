/**
 * bots.mjs — 100 AI bots that continuously play ranked matches.
 *
 * Usage: node bots.mjs
 *
 * Each bot:
 *  1. Signs in (or creates account) with email/password
 *  2. Enters the matchmaking pool
 *  3. When matched, listens to the game doc and plays smart AI moves
 *  4. After game ends, waits 10–30 s then repeats
 *
 * Bots can match real users too, since they use the same matchmaking pool.
 */

import { initializeApp } from 'firebase/app';
import { getAuth, signInWithEmailAndPassword, createUserWithEmailAndPassword } from 'firebase/auth';
import {
  initializeFirestore,
  doc, collection, setDoc, getDoc, updateDoc, deleteDoc, getDocs,
  onSnapshot, query, serverTimestamp, arrayUnion,
} from 'firebase/firestore';

// ── Config ──────────────────────────────────────────────────────────────────
const firebaseConfig = {
  apiKey:            'AIzaSyA_c9lSl9hOibUgmmqDp8piAucwg7ab1sU',
  authDomain:        'connect6firebase.firebaseapp.com',
  projectId:         'connect6firebase',
  storageBucket:     'connect6firebase.firebasestorage.app',
  messagingSenderId: '545553731744',
  appId:             '1:545553731744:web:df573665a30451d0b739c5',
};
const APP_ID   = 'connect6-forest-v4';
const NUM_BOTS = 100;
const BOT_PW   = 'botpass_connect6_2024'; // shared password for all bot accounts
const BOARD_SIZE = 19;
const MATCH_TIMEOUT = 30000;
const STONES_PER_TURN_FIRST = 1; // first move: 1 stone
const STONES_PER_TURN       = 2; // all other moves: 2 stones

// ── Helpers ──────────────────────────────────────────────────────────────────
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const rand  = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;
const calcTolerance = (elapsed) => Math.min(Math.floor(elapsed / 2) * 10, 100);

// Minimal Connect-6 win check (6 in a row)
function checkWin(board, lastIdx, player) {
  const x = lastIdx % BOARD_SIZE;
  const y = Math.floor(lastIdx / BOARD_SIZE);
  const dirs = [[1,0],[0,1],[1,1],[1,-1]];
  for (const [dx, dy] of dirs) {
    let count = 1;
    for (let s = 1; s < 6; s++) {
      const nx = x + dx*s, ny = y + dy*s;
      if (nx < 0||nx>=BOARD_SIZE||ny<0||ny>=BOARD_SIZE) break;
      if (board[ny*BOARD_SIZE+nx] !== player) break;
      count++;
    }
    for (let s = 1; s < 6; s++) {
      const nx = x - dx*s, ny = y - dy*s;
      if (nx < 0||nx>=BOARD_SIZE||ny<0||ny>=BOARD_SIZE) break;
      if (board[ny*BOARD_SIZE+nx] !== player) break;
      count++;
    }
    if (count >= 6) return true;
  }
  return false;
}

// Score a candidate cell for the AI (higher = better)
function scoreCell(board, idx, player, opp) {
  const x = idx % BOARD_SIZE;
  const y = Math.floor(idx / BOARD_SIZE);
  const dirs = [[1,0],[0,1],[1,1],[1,-1]];
  let score = 0;
  for (const [dx, dy] of dirs) {
    let myLine = 0, oppLine = 0;
    for (let s = -5; s <= 5; s++) {
      const nx = x + dx*s, ny = y + dy*s;
      if (nx<0||nx>=BOARD_SIZE||ny<0||ny>=BOARD_SIZE) continue;
      const v = board[ny*BOARD_SIZE+nx];
      if (v === player) myLine++;
      if (v === opp) oppLine++;
    }
    score += myLine * 3 + oppLine * 2;
  }
  // Prefer center
  const cx = BOARD_SIZE >> 1, cy = BOARD_SIZE >> 1;
  score -= (Math.abs(x - cx) + Math.abs(y - cy)) * 0.1;
  return score;
}

// Pick best N empty cells
function pickMoves(board, player, n) {
  const opp = player === 1 ? 2 : 1;
  const empty = [];
  for (let i = 0; i < board.length; i++) {
    if (board[i] === 0) empty.push(i);
  }
  if (empty.length === 0) return [];
  // Sort by score descending with some randomness
  empty.sort((a, b) => scoreCell(board, b, player, opp) - scoreCell(board, a, player, opp));
  // Pick from top candidates with slight randomness
  const topK = Math.min(empty.length, 20);
  const picked = [];
  const used = new Set();
  for (let i = 0; i < n && picked.length < n; i++) {
    const idx = Math.floor(Math.random() * topK);
    if (!used.has(idx)) {
      used.add(idx);
      picked.push(empty[idx]);
    }
  }
  // Fill remaining if randomness left gaps
  for (let i = 0; i < topK && picked.length < n; i++) {
    if (!used.has(i)) picked.push(empty[i]);
  }
  return picked;
}

// ── Bot class ─────────────────────────────────────────────────────────────────
class Bot {
  constructor(index) {
    this.index   = index;
    this.num     = String(index + 1).padStart(3, '0');
    this.email   = `bot${this.num}@bots.connect6.local`;
    this.username = `Bot_${this.num}`;
    this.uid     = null;
    this.app     = null;
    this.auth    = null;
    this.db      = null;
    this.busy    = false;
  }

  log(msg) {
    console.log(`[Bot${this.num}] ${msg}`);
  }

  // ── Initialise Firebase app instance ──────────────────────────────────────
  async init() {
    this.app  = initializeApp(firebaseConfig, `bot-${this.index}`);
    this.auth = getAuth(this.app);
    this.db   = initializeFirestore(this.app, { experimentalAutoDetectLongPolling: true });
  }

  // ── Sign in or create account ──────────────────────────────────────────────
  async signIn() {
    try {
      const cred = await signInWithEmailAndPassword(this.auth, this.email, BOT_PW);
      this.uid = cred.user.uid;
    } catch (e) {
      if (e.code === 'auth/user-not-found' || e.code === 'auth/invalid-credential' || e.code === 'auth/invalid-email') {
        try {
          const cred = await createUserWithEmailAndPassword(this.auth, this.email, BOT_PW);
          this.uid = cred.user.uid;
          await this.ensureProfile();
          this.log('Created new account');
        } catch (ce) {
          this.log(`Account creation failed: ${ce.message}`);
          return false;
        }
      } else {
        this.log(`Sign-in failed: ${e.message}`);
        return false;
      }
    }
    await this.ensureProfile();
    return true;
  }

  async ensureProfile() {
    const profileRef = doc(this.db, 'artifacts', APP_ID, 'users', this.uid, 'profile', 'data');
    const leaderRef  = doc(this.db, 'artifacts', APP_ID, 'leaderboard', this.uid);
    const snap = await getDoc(profileRef);
    if (!snap.exists()) {
      const data = {
        uid: this.uid, username: this.username,
        wins: 0, losses: 0, totalGames: 0, winRate: 0,
        isBot: true, isHuman: false,
      };
      await Promise.all([setDoc(profileRef, data), setDoc(leaderRef, data)]);
    } else if (!snap.data().isBot) {
      // Patch existing profile that predates isBot field
      await Promise.all([
        setDoc(profileRef, { isBot: true, isHuman: false }, { merge: true }),
        setDoc(leaderRef,  { isBot: true, isHuman: false }, { merge: true }),
      ]);
    }
  }

  async getStats() {
    const profileRef = doc(this.db, 'artifacts', APP_ID, 'users', this.uid, 'profile', 'data');
    const snap = await getDoc(profileRef);
    if (!snap.exists()) return { winRate: 0, totalGames: 0 };
    const d = snap.data();
    return { winRate: d.winRate || 0, totalGames: d.totalGames || 0 };
  }

  // ── Matchmaking ────────────────────────────────────────────────────────────
  async doMatchmaking() {
    const { winRate, totalGames } = await this.getStats();
    const poolCol = collection(this.db, 'artifacts', APP_ID, 'matchmaking_pool');
    const poolRef = doc(poolCol, this.uid);
    const startTime = Date.now();

    const poolData = {
      uid: this.uid,
      username: this.username,
      winRate,
      totalGames,
      enteredAt: Date.now(),
      timestamp: serverTimestamp(),
      gameId: null,
    };
    try {
      await setDoc(poolRef, poolData);
    } catch (e) {
      this.log(`Pool write failed: ${e.message}`);
      return null;
    }

    // Poll until matched or timeout
    const deadline = Date.now() + MATCH_TIMEOUT;
    while (Date.now() < deadline) {
      await sleep(2000);
      try {
        const mySnap = await getDoc(poolRef);
        if (!mySnap.exists()) break;
        const myData = mySnap.data();

        if (myData.gameId) {
          await deleteDoc(poolRef).catch(() => {});
          return myData.gameId;
        }

        // Try to match an opponent
        const poolSnap = await getDocs(poolCol);
        const docs = poolSnap.docs.sort((a, b) => (b.data().enteredAt||0) - (a.data().enteredAt||0));
        const elapsed = Math.floor((Date.now() - startTime) / 1000);
        const myTol = calcTolerance(elapsed);

        const opponents = docs.filter(d => {
          if (d.id === this.uid || d.data().gameId) return false;
          const diff = Math.abs((d.data().winRate||0) - winRate);
          const oppElapsed = d.data().enteredAt ? Math.floor((Date.now() - d.data().enteredAt)/1000) : 0;
          return diff <= Math.max(myTol, calcTolerance(oppElapsed));
        });

        if (opponents.length > 0) {
          const opp = opponents[0];
          // Lower uid creates the game (same as App.jsx)
          if (this.uid < opp.id) {
            const gameId = await this.createGame(opp.data());
            await Promise.all([
              updateDoc(poolRef, { gameId }).catch(() => {}),
              updateDoc(doc(poolCol, opp.id), { gameId }).catch(() => {}),
            ]);
            await deleteDoc(poolRef).catch(() => {});
            return gameId;
          }
          // else: wait for the other side to create the game
        }
      } catch (e) {
        // Ignore transient errors
      }
    }

    await deleteDoc(poolRef).catch(() => {});
    return null; // timed out
  }

  async createGame(opponentData) {
    const gameRef = doc(collection(this.db, 'artifacts', APP_ID, 'games'));
    const meFirst = Math.random() < 0.5;
    const p1 = meFirst
      ? { uid: this.uid, username: this.username }
      : { uid: opponentData.uid, username: opponentData.username };
    const p2 = meFirst
      ? { uid: opponentData.uid, username: opponentData.username }
      : { uid: this.uid, username: this.username };

    await setDoc(gameRef, {
      player1: p1, player2: p2,
      playerUids: [p1.uid, p2.uid],
      board: Array(BOARD_SIZE * BOARD_SIZE).fill(0),
      turn: 1, moveCount: 0, turnMoves: 0,
      status: 'active',
      winner: null, loser: null, winReason: null,
      lastMoveAt: Date.now(),
      rematchRequests: [], rematchGameId: null,
      friendMatch: false, moves: [],
      statsRecorded: false,
      createdAt: serverTimestamp(),
    });
    return gameRef.id;
  }

  // ── Play a game ────────────────────────────────────────────────────────────
  async playGame(gameId) {
    const gameRef = doc(this.db, 'artifacts', APP_ID, 'games', gameId);

    return new Promise((resolve) => {
      const unsub = onSnapshot(gameRef, async (snap) => {
        if (!snap.exists()) { unsub(); resolve(); return; }
        const data = snap.data();

        if (data.status !== 'active') { unsub(); resolve(); return; }

        const myPlayer = data.player1.uid === this.uid ? 1 : 2;
        if (data.turn !== myPlayer) return; // not my turn

        // Determine stones to place this turn
        const stonesNeeded = data.moveCount === 0 ? STONES_PER_TURN_FIRST : STONES_PER_TURN;
        const board = [...data.board];
        const indices = pickMoves(board, myPlayer, stonesNeeded);
        if (indices.length === 0) { unsub(); resolve(); return; }

        // Place each stone (simulate sequential placement)
        let newBoard = [...board];
        let won = false;
        for (const idx of indices) {
          if (newBoard[idx] !== 0) continue; // safety
          newBoard[idx] = myPlayer;
          if (checkWin(newBoard, idx, myPlayer)) { won = true; break; }
        }

        const opp = myPlayer === 1 ? 2 : 1;
        const update = {
          board: newBoard,
          moves: arrayUnion(...indices.map(i => ({ player: myPlayer, idx: i }))),
          moveCount: data.moveCount + 1,
          turnMoves: 0,
          lastMoveAt: Date.now(),
        };

        if (won) {
          update.status = 'finished';
          update.winner = { uid: this.uid, username: this.username };
          update.loser  = myPlayer === 1 ? data.player2 : data.player1;
          update.winReason = 'connect6';
          update.turn = opp;
          unsub();
          await updateDoc(gameRef, update).catch(() => {});
          await this.recordStats(this.uid, update.loser.uid, gameId);
          resolve();
        } else {
          update.turn = opp;
          await updateDoc(gameRef, update).catch(() => {});
        }
      }, (err) => {
        this.log(`Game snapshot error: ${err.message}`);
        unsub(); resolve();
      });

      // Safety timeout (3 min max per game)
      setTimeout(() => { unsub(); resolve(); }, 3 * 60 * 1000);
    });
  }

  async recordStats(winnerUid, loserUid, gameId) {
    try {
      const gameRef      = doc(this.db, 'artifacts', APP_ID, 'games', gameId);
      const wProfileRef  = doc(this.db, 'artifacts', APP_ID, 'users', winnerUid, 'profile', 'data');
      const wLeaderRef   = doc(this.db, 'artifacts', APP_ID, 'leaderboard', winnerUid);
      const lProfileRef  = doc(this.db, 'artifacts', APP_ID, 'users', loserUid, 'profile', 'data');
      const lLeaderRef   = doc(this.db, 'artifacts', APP_ID, 'leaderboard', loserUid);

      const [wSnap, lSnap, gSnap] = await Promise.all([
        getDoc(wProfileRef), getDoc(lProfileRef), getDoc(gameRef),
      ]);
      if (gSnap.exists() && gSnap.data().statsRecorded) return;

      const wData = wSnap.exists() ? wSnap.data() : { wins:0, losses:0, totalGames:0 };
      const lData = lSnap.exists() ? lSnap.data() : { wins:0, losses:0, totalGames:0 };

      const wWins  = (wData.wins  || 0) + 1;
      const wTotal = (wData.totalGames || 0) + 1;
      const lLoss  = (lData.losses || 0) + 1;
      const lTotal = (lData.totalGames || 0) + 1;

      const wUpdate = { wins: wWins, totalGames: wTotal, winRate: Math.round(wWins/wTotal*100) };
      const lUpdate = { losses: lLoss, totalGames: lTotal, winRate: Math.round((lData.wins||0)/lTotal*100) };

      await Promise.all([
        setDoc(wProfileRef, wUpdate, { merge: true }),
        setDoc(wLeaderRef,  wUpdate, { merge: true }),
        setDoc(lProfileRef, lUpdate, { merge: true }),
        setDoc(lLeaderRef,  lUpdate, { merge: true }),
        setDoc(gameRef, { statsRecorded: true }, { merge: true }),
      ]);
    } catch (e) {
      this.log(`Stats update failed: ${e.message}`);
    }
  }

  // ── Main loop ──────────────────────────────────────────────────────────────
  async run() {
    const ok = await this.signIn();
    if (!ok) { this.log('Could not sign in, skipping'); return; }
    this.log(`Signed in as ${this.username} (${this.uid})`);

    while (true) {
      if (this.busy) { await sleep(1000); continue; }
      this.busy = true;
      try {
        const gameId = await this.doMatchmaking();
        if (gameId) {
          this.log(`Matched → game ${gameId}`);
          await this.playGame(gameId);
          this.log('Game finished');
        } else {
          this.log('Matchmaking timed out (no opponent)');
        }
        const rest = rand(10, 30) * 1000;
        this.log(`Resting ${rest/1000}s`);
        await sleep(rest);
      } catch (e) {
        this.log(`Loop error: ${e.message}`);
        await sleep(5000);
      } finally {
        this.busy = false;
      }
    }
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  console.log(`=== Connect Six Bot Runner — ${NUM_BOTS} bots ===`);
  console.log('Initialising...\n');

  const bots = Array.from({ length: NUM_BOTS }, (_, i) => new Bot(i));

  // Init all Firebase app instances first
  await Promise.all(bots.map(b => b.init()));
  console.log('All Firebase instances ready.\n');

  // Stagger sign-ins (5 concurrent at a time) to avoid rate-limits
  const BATCH = 5;
  for (let i = 0; i < bots.length; i += BATCH) {
    const batch = bots.slice(i, i + BATCH);
    await Promise.all(batch.map(b => b.signIn().catch(e => console.error(b.username, e.message))));
    await sleep(300);
  }
  console.log('\nAll bots signed in. Starting game loops...\n');

  // Start all loops concurrently (staggered by 200ms each)
  for (let i = 0; i < bots.length; i++) {
    setTimeout(() => bots[i].run(), i * 200);
  }

  // Keep process alive
  await new Promise(() => {});
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
