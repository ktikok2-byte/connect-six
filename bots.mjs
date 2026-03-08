/**
 * bots.mjs — 100 AI bots playing ranked matches, indistinguishable from humans.
 *
 * Features:
 *  - Human-looking usernames (no "Bot_" prefix)
 *  - Dispatcher: when a human enters the matchmaking pool, an idle bot is sent
 *    to the pool within 1–25 s so the human gets a fast match
 *  - Rematch: bots watch for rematch requests and accept them
 *  - Emergency: if all 100 bots are busy, a new bot account is created on demand
 *
 * Usage:
 *   node bots.mjs          — run continuously
 *   node bots.mjs verify   — create/update all 100 accounts, play 1 game each, exit
 */

import { initializeApp, deleteApp } from 'firebase/app';
import {
  getAuth,
  signInWithEmailAndPassword,
  createUserWithEmailAndPassword,
} from 'firebase/auth';
import {
  initializeFirestore,
  doc, collection,
  setDoc, getDoc, updateDoc, deleteDoc, getDocs,
  onSnapshot, runTransaction, serverTimestamp, arrayUnion, writeBatch,
} from 'firebase/firestore';

// ── Firebase config ───────────────────────────────────────────────────────────
const firebaseConfig = {
  apiKey:            'AIzaSyA_c9lSl9hOibUgmmqDp8piAucwg7ab1sU',
  authDomain:        'connect6firebase.firebaseapp.com',
  projectId:         'connect6firebase',
  storageBucket:     'connect6firebase.firebasestorage.app',
  messagingSenderId: '545553731744',
  appId:             '1:545553731744:web:df573665a30451d0b739c5',
};
const APP_ID      = 'connect6-forest-v4';
const NUM_BOTS    = 100;
const BOT_PW      = 'BotPass_Connect6_2024!';
const BOARD_SIZE  = 19;
const STALE_MS    = 3 * 60 * 1000;  // ignore pool entries older than 3 min
const MATCH_TIMEOUT = 35000;         // matches App.jsx MATCH_TIMEOUT
const VERIFY_MODE = process.argv[2] === 'verify';

// ── 100 human-looking bot names ───────────────────────────────────────────────
// All 2–10 chars, Korean + English gamer-style (indistinguishable from real users)
const BOT_NAMES = [
  '하늘별',   '달빛여행', '봄바람',   '여름밤',   '가을달',
  '별똥별',   '새벽빛',   '초원바람', '푸른하늘', '따뜻한봄',
  '빠른번개', '강한폭풍', '차가운달', '불꽃검사', '번개전사',
  '용맹한별', '지혜의검', '전설검사', '무적전사', '영웅의별',
  '은하수',   '별자리',   '우주탐험', '화성여행', '목성인',
  '꿈나무',   '미래의별', '희망의빛', '행복한달', '평화의검',
  '불굴전사', '빠른발검', '매서운눈', '강철심장', '철의의지',
  '검은독수리','흰달빛',  '붉은여우', '파란늑대', '초록잎사',
  '서울별빛', '부산밤하', '대구빛나', '인천바람', '광주달빛',
  '동쪽별',   '서쪽달',   '남쪽빛',   '북쪽풍',   '중앙의별',
  'StarFox',  'MoonBow',  'SkyWolf',  'IceBlaze', 'FireArc',
  'ThunderX', 'WindBlade','ShadowX',  'LightBow', 'DarkEdge',
  'SwiftBow', 'BoldSword','SharpEye', 'DeepSea',  'HighSky',
  'NightHawk','DawnRider','MorningDew','AutumnLeaf','SpringWind',
  'SummerRain','WinterSnow','RisingTide','SilverArrow','GoldenSword',
  'CrystalBow','IronShield','MysticRune','StormDancer','FireDancer',
  'IceDancer','WindDancer','EarthDancer','LoneWolf',  'SwiftEagle',
  'SilentTiger','FierceHawk','NobleLion','BraveHeart','FrostBite',
  'ThunderBolt','FlameJet', 'ArcLight',  'VoidWalker','StarDust',
  'MoonChild', 'SkyRider', 'CloudSurfer','StarGazer', 'NightOwl',
];
// ── Helpers ───────────────────────────────────────────────────────────────────
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const rand  = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;
const calcTolerance = (elapsed) => Math.min(Math.floor(elapsed / 2) * 10, 100);

function makeCancellableSleep(ms) {
  let cancel;
  const promise = new Promise(resolve => {
    const t = setTimeout(resolve, ms);
    cancel = () => { clearTimeout(t); resolve(); };
  });
  return { promise, cancel };
}

// Connect-6 win check
function checkWin(board, lastIdx, player) {
  const x = lastIdx % BOARD_SIZE, y = Math.floor(lastIdx / BOARD_SIZE);
  const dirs = [[1,0],[0,1],[1,1],[1,-1]];
  for (const [dx, dy] of dirs) {
    let count = 1;
    for (let s = 1; s <= 5; s++) {
      const nx = x+dx*s, ny = y+dy*s;
      if (nx<0||nx>=BOARD_SIZE||ny<0||ny>=BOARD_SIZE||board[ny*BOARD_SIZE+nx]!==player) break;
      count++;
    }
    for (let s = 1; s <= 5; s++) {
      const nx = x-dx*s, ny = y-dy*s;
      if (nx<0||nx>=BOARD_SIZE||ny<0||ny>=BOARD_SIZE||board[ny*BOARD_SIZE+nx]!==player) break;
      count++;
    }
    if (count >= 6) return true;
  }
  return false;
}

function scoreCell(board, idx, player) {
  const opp = player === 1 ? 2 : 1;
  const x = idx % BOARD_SIZE, y = Math.floor(idx / BOARD_SIZE);
  const dirs = [[1,0],[0,1],[1,1],[1,-1]];
  let score = 0;
  for (const [dx, dy] of dirs) {
    let myLine = 0, oppLine = 0;
    for (let s = -5; s <= 5; s++) {
      const nx = x+dx*s, ny = y+dy*s;
      if (nx<0||nx>=BOARD_SIZE||ny<0||ny>=BOARD_SIZE) continue;
      const v = board[ny*BOARD_SIZE+nx];
      if (v === player) myLine++;
      if (v === opp) oppLine++;
    }
    score += myLine * 3 + oppLine * 2;
  }
  const cx = BOARD_SIZE >> 1, cy = BOARD_SIZE >> 1;
  score -= (Math.abs(x-cx) + Math.abs(y-cy)) * 0.1;
  return score;
}

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
  constructor(index, nameOverride = null, emailOverride = null) {
    this.index    = index;
    this.num      = String(index + 1).padStart(3, '0');
    this.email    = emailOverride || `bot${this.num}@connect6bots.com`;
    this.username = nameOverride  || BOT_NAMES[index % BOT_NAMES.length];
    this.uid      = null;
    this.app      = null;
    this.auth     = null;
    this.db       = null;
    // State machine: 'idle' | 'matchmaking' | 'playing' | 'resting' | 'dispatched'
    this.state      = 'idle';
    this.winRate    = 0;
    this.totalGames = 0;
    this.gamesPlayed = 0;
    this._sleepCancel = null; // cancel function for current rest sleep
  }

  log(msg) { console.log(`[${this.username}] ${msg}`); }

  /** Cancel current rest period early (used by dispatcher) */
  wakeUp() {
    if (this._sleepCancel) {
      this._sleepCancel();
      this._sleepCancel = null;
    }
  }

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
      if (['auth/user-not-found','auth/invalid-credential','auth/wrong-password'].includes(e.code)) {
        try {
          const cred = await createUserWithEmailAndPassword(this.auth, this.email, BOT_PW);
          this.uid = cred.user.uid;
          return true;
        } catch (ce) {
          if (ce.code === 'auth/email-already-in-use') {
            // Retry sign-in (race between create and sign-in)
            try {
              const cred2 = await signInWithEmailAndPassword(this.auth, this.email, BOT_PW);
              this.uid = cred2.user.uid;
              return true;
            } catch (re) { this.log(`Sign-in retry failed: [${re.code}]`); return false; }
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
    if (!snap.exists()) {
      const data = {
        uid: this.uid, username: this.username,
        wins: 0, losses: 0, totalGames: 0, winRate: 0,
        isBot: true, isHuman: false,
      };
      await Promise.all([setDoc(profileRef, data), setDoc(leaderRef, data)]);
    } else {
      const d = snap.data();
      // Update name and ensure isBot flag
      const patch = { isBot: true, isHuman: false };
      if (d.username !== this.username) patch.username = this.username;
      if (Object.keys(patch).length) {
        await Promise.all([
          setDoc(profileRef, patch, { merge: true }),
          setDoc(leaderRef,  patch, { merge: true }),
        ]);
      }
      this.winRate    = d.winRate    || 0;
      this.totalGames = d.totalGames || 0;
    }
  }

  async refreshStats() {
    try {
      const snap = await getDoc(doc(this.db, 'artifacts', APP_ID, 'users', this.uid, 'profile', 'data'));
      if (snap.exists()) {
        this.winRate    = snap.data().winRate    || 0;
        this.totalGames = snap.data().totalGames || 0;
      }
    } catch { /* ignore */ }
  }

  async cleanStalePool() {
    try {
      const poolRef = doc(this.db, 'artifacts', APP_ID, 'matchmaking_pool', this.uid);
      const snap = await getDoc(poolRef);
      if (snap.exists()) {
        const age = snap.data().enteredAt ? Date.now() - snap.data().enteredAt : STALE_MS + 1;
        if (age > 30000) await deleteDoc(poolRef);
      }
    } catch { /* ignore */ }
  }

  // ── Matchmaking ─────────────────────────────────────────────────────────────
  async doMatchmaking() {
    const poolCol = collection(this.db, 'artifacts', APP_ID, 'matchmaking_pool');
    const poolRef = doc(poolCol, this.uid);
    const startTime = Date.now();

    const poolData = {
      uid: this.uid, username: this.username,
      winRate: this.winRate, totalGames: this.totalGames,
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
          .filter(d => d.id !== this.uid && !d.data().gameId &&
                       (now - (d.data().enteredAt||0)) < STALE_MS)
          .sort((a,b) => (b.data().enteredAt||0) - (a.data().enteredAt||0));

        const elapsed = Math.floor((Date.now() - startTime) / 1000);
        const myTol = calcTolerance(elapsed);
        const opponents = docs.filter(d => {
          const diff = Math.abs((d.data().winRate||0) - this.winRate);
          const oppElapsed = d.data().enteredAt ? Math.floor((now-d.data().enteredAt)/1000) : 0;
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

  // ── Play a game ─────────────────────────────────────────────────────────────
  async playGame(gameId) {
    const gameRef = doc(this.db, 'artifacts', APP_ID, 'games', gameId);

    return new Promise((resolve) => {
      const timeout = setTimeout(() => { unsub(); resolve('timeout'); }, 5 * 60 * 1000);

      const unsub = onSnapshot(gameRef, async (snap) => {
        if (!snap.exists()) { clearTimeout(timeout); unsub(); resolve('deleted'); return; }
        const data = snap.data();

        if (data.status !== 'active') {
          clearTimeout(timeout); unsub();
          if (data.winner && data.loser && !data.statsRecorded) {
            await this.recordStats(data.winner.uid, data.loser.uid, gameId);
          }
          resolve('finished');
          return;
        }

        const myPlayer = data.player1.uid === this.uid ? 1 : 2;
        if (data.turn !== myPlayer) return;

        await sleep(rand(300, 800)); // think delay

        // Re-read after delay
        const fresh = await getDoc(gameRef).catch(() => null);
        if (!fresh?.exists() || fresh.data().status !== 'active' || fresh.data().turn !== myPlayer) return;
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
          turnMoves: 0, lastMoveAt: Date.now(), turn: opp,
        };

        if (won) {
          update.status   = 'finished';
          update.winner   = { uid: this.uid, username: this.username };
          update.loser    = oppData;
          update.winReason = 'connect6';
          clearTimeout(timeout); unsub();
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

  // ── Rematch handling ─────────────────────────────────────────────────────────
  /**
   * After a game finishes, watch for 40 s for a rematch request.
   * If the opponent requests rematch, the bot accepts and plays the rematch game.
   * Returns the rematch gameId if one was played, otherwise null.
   */
  async handleRematch(originalGameId) {
    const gameRef = doc(this.db, 'artifacts', APP_ID, 'games', originalGameId);

    return new Promise((resolve) => {
      const timeout = setTimeout(() => { unsub(); resolve(null); }, 40000);
      let accepted = false;

      const unsub = onSnapshot(gameRef, async (snap) => {
        if (!snap.exists() || accepted) return;
        const data = snap.data();

        // If rematch already created by other side, join it directly
        if (data.rematchGameId) {
          accepted = true;
          clearTimeout(timeout); unsub();
          // Make sure our uid is in rematchRequests so App.jsx knows we accepted
          await updateDoc(gameRef, { rematchRequests: arrayUnion(this.uid) }).catch(() => {});
          resolve(data.rematchGameId);
          return;
        }

        // Opponent requested rematch (their uid is in array, ours is not)
        const reqs = data.rematchRequests || [];
        const opponentReq = reqs.find(uid => uid !== this.uid);
        if (!opponentReq || reqs.includes(this.uid)) return;

        accepted = true;
        // Bot accepts: add uid via transaction; if 2nd to add, create new game
        let newGameId = null;
        let p1, p2;
        let shouldCreate = false;
        try {
          await runTransaction(this.db, async (tx) => {
            const gSnap = await tx.get(gameRef);
            if (!gSnap.exists() || gSnap.data().rematchGameId) {
              newGameId = gSnap.data()?.rematchGameId || null;
              return;
            }
            const d = gSnap.data();
            const curReqs = d.rematchRequests || [];
            if (curReqs.includes(this.uid)) { newGameId = d.rematchGameId; return; }
            const newReqs = [...curReqs, this.uid];
            if (newReqs.length >= 2) {
              // Colors swap on rematch
              p1 = d.player2;
              p2 = d.player1;
              shouldCreate = true;
              tx.update(gameRef, { rematchRequests: newReqs });
            } else {
              tx.update(gameRef, { rematchRequests: newReqs });
            }
          });
        } catch (e) { this.log(`Rematch transaction error: ${e.message}`); }

        if (shouldCreate && p1 && p2) {
          const newRef = doc(collection(this.db, 'artifacts', APP_ID, 'games'));
          await setDoc(newRef, {
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
          newGameId = newRef.id;
          await updateDoc(gameRef, { rematchGameId: newGameId }).catch(() => {});
        }

        clearTimeout(timeout); unsub();
        resolve(newGameId || null);
      }, (err) => {
        clearTimeout(timeout); unsub(); resolve(null);
      });
    });
  }

  // ── Stats recording ──────────────────────────────────────────────────────────
  async recordStats(winnerUid, loserUid, gameId) {
    try {
      const gameRef     = doc(this.db, 'artifacts', APP_ID, 'games', gameId);
      const gSnap = await getDoc(gameRef);
      if (gSnap.exists() && gSnap.data().statsRecorded) return;

      const wProfileRef = doc(this.db, 'artifacts', APP_ID, 'users', winnerUid, 'profile', 'data');
      const wLeaderRef  = doc(this.db, 'artifacts', APP_ID, 'leaderboard', winnerUid);
      const lProfileRef = doc(this.db, 'artifacts', APP_ID, 'users', loserUid, 'profile', 'data');
      const lLeaderRef  = doc(this.db, 'artifacts', APP_ID, 'leaderboard', loserUid);

      const [wSnap, lSnap] = await Promise.all([getDoc(wProfileRef), getDoc(lProfileRef)]);
      const wData = wSnap.exists() ? wSnap.data() : { wins:0, losses:0, totalGames:0 };
      const lData = lSnap.exists() ? lSnap.data() : { wins:0, losses:0, totalGames:0 };

      const wWins  = (wData.wins || 0) + 1;
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

      // Update local cache
      if (winnerUid === this.uid) {
        this.winRate = wUpdate.winRate;
        this.totalGames = wTotal;
      } else if (loserUid === this.uid) {
        this.winRate = lUpdate.winRate;
        this.totalGames = lTotal;
      }
    } catch (e) {
      this.log(`Stats update failed: ${e.message}`);
    }
  }

  // ── Main run loop ─────────────────────────────────────────────────────────────
  async run(verifyMode = false) {
    if (!await this.signIn()) { this.log('Sign-in failed, skipping'); return; }
    await this.ensureProfile();
    await this.cleanStalePool();
    this.state = 'idle';
    this.log(`Ready (uid=${this.uid}, wr=${this.winRate}%)`);

    do {
      this.state = 'matchmaking';
      const gameId = await this.doMatchmaking();

      if (gameId) {
        this.state = 'playing';
        this.log(`Matched → game ${gameId}`);
        await this.playGame(gameId);
        this.gamesPlayed++;

        // Check for rematch
        const rematchId = await this.handleRematch(gameId);
        if (rematchId) {
          this.log(`Rematch → game ${rematchId}`);
          await this.playGame(rematchId);
          this.gamesPlayed++;
        }

        await this.refreshStats();
        this.log(`Game(s) done. Stats: ${this.totalGames} games, ${this.winRate}% wr`);
      } else {
        this.log('Matchmaking timed out (no opponent)');
      }

      if (!verifyMode) {
        const restMs = rand(10, 30) * 1000;
        this.state = 'resting';
        this.log(`Resting ${Math.round(restMs/1000)}s`);
        const cs = makeCancellableSleep(restMs);
        this._sleepCancel = cs.cancel;
        await cs.promise;
        this._sleepCancel = null;
        if (this.state !== 'dispatched') this.state = 'idle';
        else this.state = 'matchmaking';
      }
    } while (!verifyMode);

    this.state = 'idle';
  }
}

// ── Dispatcher ─────────────────────────────────────────────────────────────────
/**
 * Monitors the matchmaking pool.
 * When a non-bot human is detected without a bot counter-party,
 * wakes an idle bot (closest win rate) to enter the pool within 1–25 s.
 * If all bots are busy, creates an emergency bot.
 */
let emergencyBotCounter = NUM_BOTS; // index for extra bots beyond 100
const emergencyBots = [];

async function createEmergencyBot(targetWinRate) {
  const idx = emergencyBotCounter++;
  const num = String(idx + 1).padStart(3, '0');
  const name = BOT_NAMES[idx % BOT_NAMES.length] + Math.floor(Math.random() * 90 + 10);
  const email = `bot${num}@connect6bots.com`;

  const bot = new Bot(idx, name, email);
  await bot.init();
  if (!await bot.signIn()) return null;
  await bot.ensureProfile();
  emergencyBots.push(bot);
  return bot;
}

async function startDispatcher(bots) {
  console.log('[Dispatcher] Starting...');
  const app = initializeApp(firebaseConfig, 'dispatcher');
  const db  = initializeFirestore(app, { experimentalAutoDetectLongPolling: true });
  const poolCol = collection(db, 'artifacts', APP_ID, 'matchmaking_pool');

  // Set of known bot UIDs (grows as bots sign in)
  const allBots = [...bots]; // includes emergency bots added later

  const pendingDispatches = new Map(); // humanUid → { timeoutId, botUid }

  onSnapshot(poolCol, async (snap) => {
    // Refresh known UIDs
    const botUids = new Set([...bots, ...emergencyBots].filter(b => b.uid).map(b => b.uid));

    const now = Date.now();
    const poolDocs = snap.docs;

    // Find humans in pool (not our bots, not stale, no gameId)
    const humanEntries = poolDocs.filter(d => {
      const data = d.data();
      return !botUids.has(d.id)
        && !data.gameId
        && data.enteredAt
        && (now - data.enteredAt) < STALE_MS;
    });

    // Bots already active in pool
    const botsInPool = new Set(
      poolDocs.filter(d => botUids.has(d.id) && !d.data().gameId).map(d => d.id)
    );

    // Clean up dispatches for humans who left or matched
    for (const [humanUid, dispatch] of pendingDispatches) {
      const stillWaiting = humanEntries.find(e => e.id === humanUid);
      if (!stillWaiting) {
        clearTimeout(dispatch.timeoutId);
        pendingDispatches.delete(humanUid);
      }
    }

    for (const humanEntry of humanEntries) {
      const humanUid = humanEntry.id;

      // Already handling this human?
      if (pendingDispatches.has(humanUid)) continue;

      // A bot is already in the pool (will naturally match)
      if (botsInPool.size > 0) continue;

      // Any bot already dispatched will appear in pool soon
      if (pendingDispatches.size > 0) continue;

      const humanWinRate = humanEntry.data().winRate || 0;

      // Find idle/resting bot with closest win rate
      const allAvailable = [...bots, ...emergencyBots].filter(
        b => b.uid && (b.state === 'idle' || b.state === 'resting')
      );

      let selectedBot = null;
      if (allAvailable.length > 0) {
        allAvailable.sort((a, b) =>
          Math.abs(a.winRate - humanWinRate) - Math.abs(b.winRate - humanWinRate)
        );
        selectedBot = allAvailable[0];
      }

      if (!selectedBot) {
        console.log('[Dispatcher] All bots busy — creating emergency bot');
        selectedBot = await createEmergencyBot(humanWinRate).catch(() => null);
        if (!selectedBot) continue;
        // Start emergency bot's run loop in background
        selectedBot.run(false).catch(() => {});
      }

      const delay = rand(1000, 25000); // 1–25 s
      console.log(`[Dispatcher] Human in pool (wr=${humanWinRate}%) → ${selectedBot.username} in ${Math.round(delay/1000)}s`);

      const { uid: botUid } = selectedBot;
      const timeoutId = setTimeout(() => {
        pendingDispatches.delete(humanUid);
        // Wake the bot up (cancel rest) and let its run loop enter the pool
        if (selectedBot.state === 'resting') {
          selectedBot.state = 'dispatched';
          selectedBot.wakeUp();
        }
        // If bot is idle (between loops), trigger a one-off matchmaking run
        if (selectedBot.state === 'idle') {
          selectedBot.state = 'dispatched';
          // Kick off an extra game cycle without waiting for the loop
          selectedBot.doMatchmaking().then(gameId => {
            if (gameId) {
              selectedBot.state = 'playing';
              selectedBot.playGame(gameId).then(async () => {
                const rematchId = await selectedBot.handleRematch(gameId);
                if (rematchId) {
                  await selectedBot.playGame(rematchId);
                }
                await selectedBot.refreshStats();
                selectedBot.state = 'idle';
              });
            } else {
              selectedBot.state = 'idle';
            }
          });
        }
      }, delay);

      pendingDispatches.set(humanUid, { timeoutId, botUid });
    }
  }, err => {
    console.log(`[Dispatcher] Snapshot error: ${err.message} — retrying in 5s`);
    setTimeout(() => startDispatcher(bots), 5000);
  });
}

// ── Pool cleanup ───────────────────────────────────────────────────────────────
async function cleanStalePoolEntries() {
  console.log('Cleaning stale matchmaking pool entries (> 3 min old)...');
  const app = initializeApp(firebaseConfig, 'cleaner');
  const db  = initializeFirestore(app, { experimentalAutoDetectLongPolling: true });
  try {
    const poolCol = collection(db, 'artifacts', APP_ID, 'matchmaking_pool');
    const snap = await getDocs(poolCol);
    const now = Date.now();
    let cleaned = 0;
    const batch = writeBatch(db);
    for (const d of snap.docs) {
      const age = d.data().enteredAt ? now - d.data().enteredAt : STALE_MS + 1;
      if (age > STALE_MS && !d.data().gameId) {
        batch.delete(doc(poolCol, d.id));
        cleaned++;
      }
    }
    if (cleaned > 0) { await batch.commit(); console.log(`  Removed ${cleaned} stale entries.\n`); }
    else console.log('  Pool is clean.\n');
  } catch (e) { console.log(`  Pool cleanup failed: ${e.message}\n`); }
  finally { await deleteApp(app).catch(() => {}); }
}

// ── Main ───────────────────────────────────────────────────────────────────────
async function main() {
  console.log(`=== Connect Six Bot Runner — ${NUM_BOTS} bots${VERIFY_MODE ? ' [VERIFY MODE]' : ''} ===`);
  await cleanStalePoolEntries();

  const bots = Array.from({ length: NUM_BOTS }, (_, i) => new Bot(i));

  // Init all Firebase instances
  await Promise.all(bots.map(b => b.init()));
  console.log('All Firebase instances ready.\n');

  // Sign in (5 at a time to avoid rate-limiting)
  let signedIn = 0;
  const BATCH = 5;
  for (let i = 0; i < bots.length; i += BATCH) {
    await Promise.all(bots.slice(i, i + BATCH).map(async b => {
      if (await b.signIn().catch(() => false)) {
        await b.ensureProfile().catch(() => {});
        await b.cleanStalePool().catch(() => {});
        signedIn++;
      }
    }));
    await sleep(400);
  }
  console.log(`\n${signedIn}/${NUM_BOTS} bots ready.\n`);

  if (VERIFY_MODE) {
    console.log('VERIFY MODE: each bot plays 1 game then exits.\n');
    await Promise.all(
      bots.filter(b => b.uid).map((b, i) => sleep(i * 200).then(() => b.run(true)))
    );
    const played = bots.filter(b => b.gamesPlayed > 0).length;
    console.log(`\n=== VERIFY RESULT ===`);
    console.log(`Signed in: ${signedIn}/${NUM_BOTS}`);
    console.log(`Played 1+ game: ${played}/${signedIn}`);
    console.log('Check Firebase > Firestore > leaderboard for bots with their new names.\n');
    process.exit(0);
  }

  // Start dispatcher (watches pool, triggers bots for humans)
  await startDispatcher(bots);
  console.log('[Dispatcher] Active — watching for humans in matchmaking pool.\n');

  // Start all bot run loops (staggered)
  console.log('Starting bot game loops...\n');
  for (let i = 0; i < bots.length; i++) {
    if (bots[i].uid) setTimeout(() => bots[i].run(false).catch(() => {}), i * 150);
  }

  // Keep alive
  await new Promise(() => {});
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
