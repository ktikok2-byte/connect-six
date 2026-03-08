/**
 * Firebase Cloud Functions — Connect Six bot matchmaking
 *
 * Two functions replace bots.mjs entirely. No external server needed.
 *
 * onHumanEntersPool  — fires when a doc is created in matchmaking_pool.
 *   • Skips bot accounts.
 *   • Waits 2–15 s (looks human), then creates a game and sets gameId on
 *     the human's pool entry so the client joins automatically.
 *
 * onBotTurn  — fires on every write to a games document.
 *   • Only acts when it's a virtual-bot's turn (uid starts with "vbot_").
 *   • Plays the same AI as bots.mjs (scoreCell + pickMoves).
 *   • Records stats via transaction when bot wins.
 */

const { onDocumentCreated, onDocumentWritten } = require('firebase-functions/v2/firestore');
const { setGlobalOptions } = require('firebase-functions/v2');
const admin = require('firebase-admin');

admin.initializeApp();
const db = admin.firestore();

setGlobalOptions({ region: 'us-central1', timeoutSeconds: 60 });

// ── Constants ─────────────────────────────────────────────────────────────────
const APP_ID     = 'connect6-forest-v4';
const BOARD_SIZE = 19;

const BOT_NAMES = [
  '하늘별','달빛여행','봄바람','여름밤','가을달',
  '별똥별','새벽빛','초원바람','푸른하늘','따뜻한봄',
  '빠른번개','강한폭풍','차가운달','불꽃검사','번개전사',
  '용맹한별','지혜의검','전설검사','무적전사','영웅의별',
  '은하수','별자리','우주탐험','화성여행','목성인',
  '꿈나무','미래의별','희망의빛','행복한달','평화의검',
  '불굴전사','빠른발검','매서운눈','강철심장','철의의지',
  '검은독수리','흰달빛','붉은여우','파란늑대','초록잎사',
  '서울별빛','부산밤하','대구빛나','인천바람','광주달빛',
  '동쪽별','서쪽달','남쪽빛','북쪽풍','중앙의별',
  'StarFox','MoonBow','SkyWolf','IceBlaze','FireArc',
  'ThunderX','WindBlade','ShadowX','LightBow','DarkEdge',
  'SwiftBow','BoldSword','SharpEye','DeepSea','HighSky',
  'NightHawk','DawnRider','MorningDew','AutumnLeaf','SpringWind',
  'SummerRain','WinterSnow','RisingTide','SilverArrow','GoldenSword',
  'CrystalBow','IronShield','MysticRune','StormDancer','FireDancer',
  'IceDancer','WindDancer','EarthDancer','LoneWolf','SwiftEagle',
  'SilentTiger','FierceHawk','NobleLion','BraveHeart','FrostBite',
  'ThunderBolt','FlameJet','ArcLight','VoidWalker','StarDust',
  'MoonChild','SkyRider','CloudSurfer','StarGazer','NightOwl',
];

// ── AI helpers (identical to bots.mjs) ───────────────────────────────────────
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

function pickMoves(board, player, n) {
  const empty = [];
  for (let i = 0; i < board.length; i++) if (board[i] === 0) empty.push(i);
  if (empty.length === 0) return [];
  empty.sort((a, b) => scoreCell(board, b, player) - scoreCell(board, a, player));
  const topK = Math.min(empty.length, 20);
  const picked = new Set();
  while (picked.size < n && picked.size < topK)
    picked.add(empty[Math.floor(Math.random() * topK)]);
  for (let i = 0; i < topK && picked.size < n; i++) picked.add(empty[i]);
  return [...picked];
}

// Stable, reproducible UID from a bot name (no Firebase Auth account needed)
function botUidFromName(name) {
  let h = 5381;
  for (let i = 0; i < name.length; i++) h = ((h * 33) ^ name.charCodeAt(i)) >>> 0;
  return `vbot_${h.toString(36)}`;
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ── Stats (Admin SDK transaction) ─────────────────────────────────────────────
async function recordStats(winnerUid, loserUid, gameId) {
  const gameRef     = db.doc(`artifacts/${APP_ID}/games/${gameId}`);
  const wLeaderRef  = db.doc(`artifacts/${APP_ID}/leaderboard/${winnerUid}`);
  const lLeaderRef  = db.doc(`artifacts/${APP_ID}/leaderboard/${loserUid}`);
  const wProfileRef = db.doc(`artifacts/${APP_ID}/users/${winnerUid}/profile/data`);
  const lProfileRef = db.doc(`artifacts/${APP_ID}/users/${loserUid}/profile/data`);

  await db.runTransaction(async (tx) => {
    const [gSnap, wSnap, lSnap] = await Promise.all([
      tx.get(gameRef), tx.get(wLeaderRef), tx.get(lLeaderRef),
    ]);
    if (gSnap.exists && gSnap.data().statsRecorded) return;

    const wData = wSnap.exists ? wSnap.data() : { wins:0, losses:0, totalGames:0 };
    const lData = lSnap.exists ? lSnap.data() : { wins:0, losses:0, totalGames:0 };
    const wWins  = (wData.wins  || 0) + 1;
    const wTotal = (wData.totalGames || 0) + 1;
    const lLoss  = (lData.losses || 0) + 1;
    const lTotal = (lData.totalGames || 0) + 1;
    const wUpdate = { wins: wWins, totalGames: wTotal, winRate: Math.round(wWins/wTotal*100) };
    const lUpdate = { losses: lLoss, totalGames: lTotal, winRate: Math.round((lData.wins||0)/lTotal*100) };

    tx.set(wLeaderRef,  wUpdate, { merge: true });
    tx.set(wProfileRef, wUpdate, { merge: true });
    tx.set(lLeaderRef,  lUpdate, { merge: true });
    tx.set(lProfileRef, lUpdate, { merge: true });
    tx.set(gameRef, { statsRecorded: true }, { merge: true });
  });
}

// ── Function 1: Human enters pool ─────────────────────────────────────────────
exports.onHumanEntersPool = onDocumentCreated(
  `artifacts/${APP_ID}/matchmaking_pool/{userId}`,
  async (event) => {
    const snap     = event.data;
    const humanUid = event.params.userId;
    const humanData = snap.data();

    // Skip bots (isBot accounts from bots.mjs, if still running)
    const leaderSnap = await db.doc(`artifacts/${APP_ID}/leaderboard/${humanUid}`).get();
    if (leaderSnap.exists && leaderSnap.data().isBot === true) return null;

    // Human-like delay: 2–15 seconds
    await sleep(Math.floor(Math.random() * 13000) + 2000);

    // Check human is still waiting (not already matched or left)
    const current = await snap.ref.get();
    if (!current.exists || current.data().gameId) return null;

    // Pick a bot with close win rate
    const humanWinRate = humanData.winRate || 0;
    const botName = BOT_NAMES[Math.floor(Math.random() * BOT_NAMES.length)];
    const botUid  = botUidFromName(botName);

    // Ensure bot has a leaderboard entry (create once, reuse across games)
    const botLeaderRef = db.doc(`artifacts/${APP_ID}/leaderboard/${botUid}`);
    const botLeader = await botLeaderRef.get();
    if (!botLeader.exists) {
      const variance = (Math.random() - 0.5) * 30;
      const botWinRate = Math.max(0, Math.min(100, Math.round(humanWinRate + variance)));
      await botLeaderRef.set({
        uid: botUid, username: botName,
        wins: 0, losses: 0, totalGames: 0, winRate: botWinRate,
        isBot: true, isHuman: false,
      });
    }
    const botStats = (await botLeaderRef.get()).data();

    // Create game (random color assignment)
    const humanFirst = Math.random() < 0.5;
    const p1 = humanFirst
      ? { uid: humanUid, username: humanData.username || 'Player' }
      : { uid: botUid,   username: botName };
    const p2 = humanFirst
      ? { uid: botUid,   username: botName }
      : { uid: humanUid, username: humanData.username || 'Player' };

    const gameRef = db.collection(`artifacts/${APP_ID}/games`).doc();
    await gameRef.set({
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
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    // Notify human — client detects gameId and joins
    await snap.ref.update({ gameId: gameRef.id });

    console.log(`Matched ${humanData.username} (${humanWinRate}% wr) with bot ${botName}`);
    return null;
  }
);

// ── Function 2: Play bot move when it's the bot's turn ────────────────────────
exports.onBotTurn = onDocumentWritten(
  `artifacts/${APP_ID}/games/{gameId}`,
  async (event) => {
    const snap = event.data.after;
    if (!snap.exists) return null;
    const data = snap.data();
    if (data.status !== 'active') return null;

    // Only handle virtual bots (uid starts with 'vbot_')
    const botPlayer =
      data.player1.uid.startsWith('vbot_') ? 1 :
      data.player2.uid.startsWith('vbot_') ? 2 : null;
    if (botPlayer === null || data.turn !== botPlayer) return null;

    // Think delay (300–900 ms)
    await sleep(Math.floor(Math.random() * 600) + 300);

    // Re-read — another trigger may have already played
    const fresh = await snap.ref.get();
    if (!fresh.exists) return null;
    const fData = fresh.data();
    if (fData.status !== 'active' || fData.turn !== botPlayer) return null;

    const stonesNeeded = fData.moveCount === 0 ? 1 : 2;
    const board  = [...fData.board];
    const indices = pickMoves(board, botPlayer, stonesNeeded);
    if (indices.length === 0) return null;

    let newBoard = [...board];
    let won = false;
    for (const idx of indices) {
      if (newBoard[idx] !== 0) continue;
      newBoard[idx] = botPlayer;
      if (checkWin(newBoard, idx, botPlayer)) { won = true; break; }
    }

    const oppPlayer = botPlayer === 1 ? 2 : 1;
    const botUid    = botPlayer === 1 ? fData.player1.uid : fData.player2.uid;
    const humanUid  = botPlayer === 1 ? fData.player2.uid : fData.player1.uid;

    const update = {
      board: newBoard,
      moves: admin.firestore.FieldValue.arrayUnion(
        ...indices.map(i => ({ player: botPlayer, idx: i }))
      ),
      moveCount:   fData.moveCount + 1,
      turnMoves:   0,
      lastMoveAt:  Date.now(),
      turn:        oppPlayer,
    };

    if (won) {
      update.status    = 'finished';
      update.winner    = botUid;
      update.loser     = humanUid;
      update.winReason = 'connect6';
    }

    await snap.ref.update(update);

    if (won) {
      await recordStats(botUid, humanUid, event.params.gameId).catch(console.error);
      console.log(`Bot ${fData[`player${botPlayer}`].username} won game ${event.params.gameId}`);
    }

    return null;
  }
);
