/**
 * bots.mjs — 100 AI bots that continuously play ranked matches.
 *
 * Usage:
 *   node bots.mjs          — run all 100 bots continuously
 *   node bots.mjs verify   — create accounts for all bots, play 1 game each, then exit
 *
 * Each bot:
 *  1. Signs in (or creates account) with email/password
 *  2. Enters the matchmaking pool (same collection as human players)
 *  3. When matched, listens to the game doc and plays smart AI moves
 *  4. After game ends, waits 10–30 s then repeats
 *
 * Bots can match real users since they use the same matchmaking pool.
 */

import { initializeApp, deleteApp } from 'firebase/app';
import { getAuth, signInWithEmailAndPassword, createUserWithEmailAndPassword } from 'firebase/auth';
import {
  initializeFirestore,
  doc, collection, setDoc, getDoc, updateDoc, deleteDoc, getDocs,
  onSnapshot, serverTimestamp, arrayUnion, writeBatch,
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
const BOT_PW   = 'BotPass_Connect6_2024!'; // must be 8+ chars, satisfies Firebase policy
const BOARD_SIZE  = 19;
const MATCH_TIMEOUT = 30000; // 30s before giving up matchmaking
const STALE_MS    = 3 * 60 * 1000; // ignore pool entries older than 3 min

const VERIFY_MODE = process.argv[2] === 'verify';

// ── Helpers ──────────────────────────────────────────────────────────────────
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const rand  = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;
const calcTolerance = (elapsed) => Math.min(Math.floor(elapsed / 2) * 10, 100);

// Minimal Connect-6 win check (6 in a row in any direction)
function checkWin(board, lastIdx, player) {
  const x = lastIdx % BOARD_SIZE;
  const y = Math.floor(lastIdx / BOARD_SIZE);
  const dirs = [[1,0],[0,1],[1,1],[1,-1]];
  for (const [dx, dy] of dirs) {
    let count = 1;
    for (let s = 1; s <= 5; s++) {
      const nx = x + dx*s, ny = y + dy*s;
      if (nx < 0||nx>=BOARD_SIZE||ny<0||ny>=BOARD_SIZE||board[ny*BOARD_SIZE+nx]!==player) break;
      count++;
    }
    for (let s = 1; s <= 5; s++) {
      const nx = x - dx*s, ny = y - dy*s;
      if (nx < 0||nx>=BOARD_SIZE||ny<0||ny>=BOARD_SIZE||board[ny*BOARD_SIZE+nx]!==player) break;
      count++;
    }
    if (count >= 6) return true;
  }
  return false;
}

// Score a candidate cell for the AI (higher = better)
function scoreCell(board, idx, player) {
  const opp = player === 1 ? 2 : 1;
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

// Pick best N empty cells to place stones
function pickMoves(board, player, n) {
  const empty = [];
  for (let i = 0; i < board.length; i++) if (board[i] === 0) empty.push(i);
  if (empty.length === 0) return [];
  empty.sort((a, b) => scoreCell(board, b, player) - scoreCell(board, a, player));
  const topK = Math.min(empty.length, 20);
  const picked = new Set();
  while (picked.size < n && picked.size < topK) {
    picked.add(empty[Math.floor(Math.random() * topK)]);
  }
  for (let i = 0; i < topK && picked.size < n; i++) picked.add(empty[i]);
  return [...picked];
}

// ── Bot class ─────────────────────────────────────────────────────────────────
class Bot {
  constructor(index) {
    this.index    = index;
    this.num      = String(index + 1).padStart(3, '0');
    this.email    = `bot${this.num}@connect6bots.com`;
    this.username = `Bot_${this.num}`;
    this.uid      = null;
    this.app      = null;
    this.auth     = null;
    this.db       = null;
    this.gamesPlayed = 0;
  }

  log(msg) { console.log(`[Bot${this.num}] ${msg}`); }

  async init() {
    this.app  = initializeApp(firebaseConfig, `bot-${this.index}`);
    this.auth = getAuth(this.app);
    this.db   = initializeFirestore(this.app, { experimentalAutoDetectLongPolling: true });
  }

  async signIn() {
    try {
      const cred = await signInWithEmailAndPassword(this.auth, this.email, BOT_PW);
      this.uid = cred.user.uid;
      return true;
    } catch (e) {
      // Try to create account if not found (Firebase v9: invalid-credential = wrong pw or no user)
      if (e.code === 'auth/user-not-found' || e.code === 'auth/invalid-credential' || e.code === 'auth/wrong-password') {
        try {
          const cred = await createUserWithEmailAndPassword(this.auth, this.email, BOT_PW);
          this.uid = cred.user.uid;
          this.log(`Created new Firebase account (uid=${this.uid})`);
          await this.ensureProfile();
          return true;
        } catch (ce) {
          if (ce.code === 'auth/email-already-in-use') {
            // Race condition: account exists but sign-in failed — retry once
            try {
              const cred2 = await signInWithEmailAndPassword(this.auth, this.email, BOT_PW);
              this.uid = cred2.user.uid;
              return true;
            } catch (re) {
              this.log(`Sign-in retry failed: [${re.code}] ${re.message}`);
              return false;
            }
          }
          this.log(`Account creation failed: [${ce.code}] ${ce.message}`);
          return false;
        }
      }
      this.log(`Sign-in failed: [${e.code}] ${e.message}`);
      return false;
    }
  }

  async ensureProfile() {
    const profileRef = doc(this.db, 'artifacts', APP_ID, 'users', this.uid, 'profile', 'data');
    const leaderRef  = doc(this.db, 'artifacts', APP_ID, 'leaderboard', this.uid);
    const snap = await getDoc(profileRef);
    const data = { uid: this.uid, username: this.username, wins: 0, losses: 0, totalGames: 0, winRate: 0, isBot: true, isHuman: false };
    if (!snap.exists()) {
      await Promise.all([setDoc(profileRef, data), setDoc(leaderRef, data)]);
      this.log(`Profile created in Firestore`);
    } else {
      // Patch isBot/isHuman if missing
      if (!snap.data().isBot) {
        await Promise.all([
          setDoc(profileRef, { isBot: true, isHuman: false }, { merge: true }),
          setDoc(leaderRef,  { isBot: true, isHuman: false }, { merge: true }),
        ]);
      }
    }
  }

  async getStats() {
    try {
      const snap = await getDoc(doc(this.db, 'artifacts', APP_ID, 'users', this.uid, 'profile', 'data'));
      if (!snap.exists()) return { winRate: 0, totalGames: 0 };
      const d = snap.data();
      return { winRate: d.winRate || 0, totalGames: d.totalGames || 0 };
    } catch { return { winRate: 0, totalGames: 0 }; }
  }

  // Clean up own stale pool entry (left over from a previous crashed run)
  async cleanStalePool() {
    try {
      const poolRef = doc(this.db, 'artifacts', APP_ID, 'matchmaking_pool', this.uid);
      const snap = await getDoc(poolRef);
      if (snap.exists()) {
        const age = snap.data().enteredAt ? Date.now() - snap.data().enteredAt : STALE_MS + 1;
        if (age > 30000) await deleteDoc(poolRef); // remove if older than 30s
      }
    } catch { /* ignore */ }
  }

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

    try { await setDoc(poolRef, poolData); }
    catch (e) { this.log(`Pool write failed: ${e.message}`); return null; }

    const deadline = Date.now() + MATCH_TIMEOUT;
    while (Date.now() < deadline) {
      await sleep(2000);
      try {
        const mySnap = await getDoc(poolRef);
        if (!mySnap.exists()) break;
        if (mySnap.data().gameId) {
          await deleteDoc(poolRef).catch(() => {});
          return mySnap.data().gameId;
        }

        const poolSnap = await getDocs(poolCol);
        const now = Date.now();
        const docs = poolSnap.docs
          .filter(d => d.id !== this.uid && !d.data().gameId && (now - (d.data().enteredAt||0)) < STALE_MS)
          .sort((a, b) => (b.data().enteredAt||0) - (a.data().enteredAt||0));

        const elapsed = Math.floor((Date.now() - startTime) / 1000);
        const myTol = calcTolerance(elapsed);

        const opponents = docs.filter(d => {
          const diff = Math.abs((d.data().winRate||0) - winRate);
          const oppElapsed = d.data().enteredAt ? Math.floor((now - d.data().enteredAt)/1000) : 0;
          return diff <= Math.max(myTol, calcTolerance(oppElapsed));
        });

        if (opponents.length > 0) {
          const opp = opponents[0];
          if (this.uid < opp.id) {
            const gameId = await this.createGame(opp.data());
            await Promise.all([
              updateDoc(poolRef, { gameId }).catch(() => {}),
              updateDoc(doc(poolCol, opp.id), { gameId }).catch(() => {}),
            ]);
            await deleteDoc(poolRef).catch(() => {});
            return gameId;
          }
        }
      } catch { /* ignore transient errors */ }
    }

    await deleteDoc(poolRef).catch(() => {});
    return null;
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

  async playGame(gameId) {
    const gameRef = doc(this.db, 'artifacts', APP_ID, 'games', gameId);

    return new Promise((resolve) => {
      const timeout = setTimeout(() => { unsub(); resolve('timeout'); }, 4 * 60 * 1000);

      const unsub = onSnapshot(gameRef, async (snap) => {
        if (!snap.exists()) { clearTimeout(timeout); unsub(); resolve('deleted'); return; }
        const data = snap.data();

        if (data.status !== 'active') {
          clearTimeout(timeout); unsub();
          // If we lost (opponent won), record stats from our side too
          if (data.winner && data.loser && !data.statsRecorded) {
            await this.recordStats(data.winner.uid, data.loser.uid, gameId);
          }
          resolve('finished');
          return;
        }

        const myPlayer = data.player1.uid === this.uid ? 1 : 2;
        if (data.turn !== myPlayer) return; // wait for our turn

        // Add a small think delay (200-600ms) to avoid hammering Firestore
        await sleep(rand(200, 600));

        // Re-read to get freshest state after delay
        const fresh = await getDoc(gameRef).catch(() => null);
        if (!fresh || !fresh.exists() || fresh.data().status !== 'active' || fresh.data().turn !== myPlayer) return;
        const fData = fresh.data();

        const stonesNeeded = fData.moveCount === 0 ? 1 : 2;
        const board = [...fData.board];
        const indices = pickMoves(board, myPlayer, stonesNeeded);
        if (indices.length === 0) { clearTimeout(timeout); unsub(); resolve('no-moves'); return; }

        let newBoard = [...board];
        let won = false;
        for (const idx of indices) {
          if (newBoard[idx] !== 0) continue;
          newBoard[idx] = myPlayer;
          if (checkWin(newBoard, idx, myPlayer)) { won = true; break; }
        }

        const opp = myPlayer === 1 ? 2 : 1;
        const oppData = myPlayer === 1 ? fData.player2 : fData.player1;
        const update = {
          board: newBoard,
          moves: arrayUnion(...indices.map(i => ({ player: myPlayer, idx: i }))),
          moveCount: fData.moveCount + 1,
          turnMoves: 0,
          lastMoveAt: Date.now(),
          turn: opp,
        };

        if (won) {
          update.status   = 'finished';
          update.winner   = { uid: this.uid, username: this.username };
          update.loser    = oppData;
          update.winReason = 'connect6';
          clearTimeout(timeout);
          unsub();
          await updateDoc(gameRef, update).catch(() => {});
          await this.recordStats(this.uid, oppData.uid, gameId);
          resolve('won');
        } else {
          await updateDoc(gameRef, update).catch(() => {});
        }
      }, (err) => {
        this.log(`Game snapshot error: ${err.message}`);
        clearTimeout(timeout); unsub(); resolve('error');
      });
    });
  }

  async recordStats(winnerUid, loserUid, gameId) {
    try {
      const gameRef     = doc(this.db, 'artifacts', APP_ID, 'games', gameId);
      const gSnap = await getDoc(gameRef);
      if (gSnap.exists() && gSnap.data().statsRecorded) return; // already done

      const wProfileRef = doc(this.db, 'artifacts', APP_ID, 'users', winnerUid, 'profile', 'data');
      const wLeaderRef  = doc(this.db, 'artifacts', APP_ID, 'leaderboard', winnerUid);
      const lProfileRef = doc(this.db, 'artifacts', APP_ID, 'users', loserUid, 'profile', 'data');
      const lLeaderRef  = doc(this.db, 'artifacts', APP_ID, 'leaderboard', loserUid);

      const [wSnap, lSnap] = await Promise.all([getDoc(wProfileRef), getDoc(lProfileRef)]);
      const wData = wSnap.exists() ? wSnap.data() : { wins:0, losses:0, totalGames:0 };
      const lData = lSnap.exists() ? lSnap.data() : { wins:0, losses:0, totalGames:0 };

      const wWins  = (wData.wins  || 0) + 1;
      const wTotal = (wData.totalGames || 0) + 1;
      const lLoss  = (lData.losses || 0) + 1;
      const lTotal = (lData.totalGames || 0) + 1;
      const wRate  = Math.round(wWins / wTotal * 100);
      const lRate  = Math.round((lData.wins || 0) / lTotal * 100);

      const wUpdate = { wins: wWins, totalGames: wTotal, winRate: wRate };
      const lUpdate = { losses: lLoss, totalGames: lTotal, winRate: lRate };

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

  async run(verifyMode = false) {
    if (!await this.signIn()) {
      this.log('Could not sign in — skipping');
      return;
    }
    await this.ensureProfile();
    await this.cleanStalePool();
    this.log(`Ready (uid=${this.uid})`);

    do {
      try {
        const gameId = await this.doMatchmaking();
        if (gameId) {
          this.log(`Matched → game ${gameId}`);
          const result = await this.playGame(gameId);
          this.gamesPlayed++;
          this.log(`Game ${this.gamesPlayed} ended: ${result}`);
        } else {
          this.log('Matchmaking timed out (no opponent found)');
        }
        if (!verifyMode) {
          const rest = rand(10, 30) * 1000;
          await sleep(rest);
        }
      } catch (e) {
        this.log(`Loop error: ${e.message}`);
        await sleep(5000);
      }
    } while (!verifyMode);
  }
}

// ── Stale pool cleanup utility ────────────────────────────────────────────────
async function cleanStalePoolEntries() {
  console.log('Cleaning stale matchmaking pool entries (> 3 min old)...');
  // Use first bot's Firebase instance to clean up
  const app = initializeApp(firebaseConfig, 'cleaner');
  const db  = initializeFirestore(app, { experimentalAutoDetectLongPolling: true });
  try {
    const poolCol = collection(db, 'artifacts', APP_ID, 'matchmaking_pool');
    const snap = await getDocs(poolCol);
    const now  = Date.now();
    let cleaned = 0;
    const batch = writeBatch(db);
    for (const d of snap.docs) {
      const age = d.data().enteredAt ? now - d.data().enteredAt : STALE_MS + 1;
      if (age > STALE_MS && !d.data().gameId) {
        batch.delete(doc(poolCol, d.id));
        cleaned++;
      }
    }
    if (cleaned > 0) {
      await batch.commit();
      console.log(`  Removed ${cleaned} stale pool entries.\n`);
    } else {
      console.log('  No stale entries found.\n');
    }
  } catch (e) {
    console.log(`  Pool cleanup failed: ${e.message}\n`);
  } finally {
    await deleteApp(app);
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  console.log(`=== Connect Six Bot Runner — ${NUM_BOTS} bots${VERIFY_MODE ? ' [VERIFY MODE]' : ''} ===`);
  console.log('Initialising Firebase instances...\n');

  await cleanStalePoolEntries();

  const bots = Array.from({ length: NUM_BOTS }, (_, i) => new Bot(i));
  await Promise.all(bots.map(b => b.init()));
  console.log('All Firebase instances ready.\n');

  // Stagger sign-ins: 5 concurrent at a time to avoid rate-limiting
  let signedIn = 0;
  const BATCH = 5;
  for (let i = 0; i < bots.length; i += BATCH) {
    const batch = bots.slice(i, i + BATCH);
    await Promise.all(batch.map(async (b) => {
      if (await b.signIn().then(ok => { if (ok) signedIn++; return ok; }).catch(e => { console.error(b.username, e.message); return false; })) {
        await b.ensureProfile().catch(() => {});
      }
    }));
    await sleep(500); // 500ms between batches
  }
  console.log(`\n${signedIn}/${NUM_BOTS} bots signed in successfully.\n`);

  if (VERIFY_MODE) {
    console.log('VERIFY MODE: Each bot will play exactly 1 game then exit.\n');
    // Run all bots with verifyMode=true; stagger starts
    const promises = bots.filter(b => b.uid).map((b, i) =>
      sleep(i * 300).then(() => b.run(true))
    );
    await Promise.all(promises);
    const played = bots.filter(b => b.gamesPlayed > 0).length;
    console.log(`\n=== VERIFY RESULT ===`);
    console.log(`Bots that played at least 1 game: ${played}/${signedIn}`);
    console.log(`Check Firebase > Firestore > leaderboard for bots with wins > 0`);
    process.exit(0);
  } else {
    console.log('Starting continuous game loops (staggered 200ms each)...\n');
    for (let i = 0; i < bots.length; i++) {
      if (bots[i].uid) setTimeout(() => bots[i].run(false), i * 200);
    }
    // Keep process alive
    await new Promise(() => {});
  }
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
