import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { initializeApp } from 'firebase/app';
import { getAnalytics } from "firebase/analytics";
import {
  getAuth,
  onAuthStateChanged,
  createUserWithEmailAndPassword,
  signInWithEmailAndPassword
} from 'firebase/auth';
import {
  getFirestore,
  doc,
  setDoc,
  getDoc,
  getDocs,
  deleteDoc,
  updateDoc,
  onSnapshot,
  collection,
  query,
  orderBy,
  where,
  limit as firestoreLimit,
  serverTimestamp,
  runTransaction,
  arrayUnion
} from 'firebase/firestore';
import { Trophy, Play, Shield, LogOut, RefreshCw, Clock, UserPlus, Copy, Check, XCircle, Timer, History, Users, ChevronLeft, ChevronRight, Gamepad2, Eye } from 'lucide-react';
import { SpeedInsights } from '@vercel/speed-insights/react';
import { Analytics } from '@vercel/analytics/react';
import { translations } from './translations';

// --- Firebase Configuration from Environment Variables ---
const firebaseConfig = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID,
  storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID,
  appId: import.meta.env.VITE_FIREBASE_APP_ID,
  measurementId: import.meta.env.VITE_FIREBASE_MEASUREMENT_ID,
};
const app = initializeApp(firebaseConfig);
const analytics = getAnalytics(app);
const auth = getAuth(app);
const db = getFirestore(app);
const appId = import.meta.env.VITE_APP_ID || 'connect6-forest-v4';

const BOARD_SIZE = 19;
const MATCH_TIMEOUT = 30000;
const TURN_TIME_LIMIT = 30; // seconds per turn

const AI_BOT_UID = 'ai_bot_v1';
const AI_BOT_DISPLAY_NAME = 'Player_x7k2';

const App = () => {
  const [user, setUser] = useState(null);
  const [userData, setUserData] = useState(null);
  const [view, setView] = useState('login');
  const [loginMode, setLoginMode] = useState('login');
  const [autoCredentials, setAutoCredentials] = useState(null);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [currentGame, setCurrentGame] = useState(null);
  const [winnerModal, setWinnerModal] = useState(null);
  const [matchmakingStatus, setMatchmakingStatus] = useState("");
  const [elapsedTime, setElapsedTime] = useState(0);
  const [leaderboard, setLeaderboard] = useState([]);
  const [gameMode, setGameMode] = useState(null);
  const [playerNumber, setPlayerNumber] = useState(0);
  const matchmakingCleanup = useRef(null);
  const gameResultHandled = useRef(false);
  const pendingUsername = useRef(null);
  const [lang, setLang] = useState('ko');

  // Friend match state
  const [friendUsername, setFriendUsername] = useState('');
  const [pendingInvite, setPendingInvite] = useState(null);
  const [friendInviteId, setFriendInviteId] = useState(null);

  // Game history state
  const [gameHistoryList, setGameHistoryList] = useState([]);
  const [replayGame, setReplayGame] = useState(null);
  const [replayMoveIndex, setReplayMoveIndex] = useState(0);

  // Observe mode state
  const [observeUsername, setObserveUsername] = useState('');
  const [observeGameId, setObserveGameId] = useState(null);

  // Rejoin active game state
  const [rejoinGame, setRejoinGame] = useState(null);
  const [rejoinCountdown, setRejoinCountdown] = useState(TURN_TIME_LIMIT);

  // Opponent left notification
  const [opponentLeftMsg, setOpponentLeftMsg] = useState(false);
  const opponentLeftTimerRef = useRef(null);

  // Translation helper
  const t = useCallback((key) => {
    return translations[lang]?.[key] || translations['ko']?.[key] || key;
  }, [lang]);

  const handleLangChange = async (newLang) => {
    setLang(newLang);
    if (user) {
      try {
        await updateDoc(doc(db, 'artifacts', appId, 'users', user.uid, 'profile', 'data'), { lang: newLang });
      } catch (e) { /* ignore */ }
    }
  };

  useEffect(() => {
    const unsub = onAuthStateChanged(auth, async (u) => {
      setUser(u);
      if (u) {
        await fetchUserData(u.uid);
        ensureAiBotExists().catch(() => {});
        fetchLeaderboard();
        setView('lobby');
      } else {
        setUserData(null);
        setView('login');
      }
    });
    return () => unsub();
  }, []);

  const fetchUserData = async (uid) => {
    const userRef = doc(db, 'artifacts', appId, 'users', uid, 'profile', 'data');
    const userDoc = await getDoc(userRef);
    if (userDoc.exists()) {
      setUserData(userDoc.data());
      if (userDoc.data().lang) setLang(userDoc.data().lang);
    } else {
      const chosenUsername = pendingUsername.current;
      pendingUsername.current = null;
      const newData = {
        uid,
        username: chosenUsername || "Player_" + uid.slice(0, 4),
        wins: 0,
        losses: 0,
        totalGames: 0,
        winRate: 0,
        lang: lang,
      };
      await setDoc(doc(db, 'artifacts', appId, 'users', uid, 'profile', 'data'), newData);
      await setDoc(doc(db, 'artifacts', appId, 'leaderboard', uid), newData);
      setUserData(newData);
    }
  };

  const fetchLeaderboard = async () => {
    try {
      const q = query(
        collection(db, 'artifacts', appId, 'leaderboard'),
        orderBy('wins', 'desc'),
        firestoreLimit(10)
      );
      const snapshot = await getDocs(q);
      const rankings = snapshot.docs.map(d => d.data());
      setLeaderboard(rankings);
    } catch (err) {
      console.error('Leaderboard fetch failed:', err);
    }
  };

  const updatePlayerStats = async (winnerUid, loserUid, gameId) => {
    if (gameResultHandled.current) return;
    gameResultHandled.current = true;
    try {
      const winnerProfileRef = doc(db, 'artifacts', appId, 'users', winnerUid, 'profile', 'data');
      const winnerLeaderRef = doc(db, 'artifacts', appId, 'leaderboard', winnerUid);
      const loserProfileRef = doc(db, 'artifacts', appId, 'users', loserUid, 'profile', 'data');
      const loserLeaderRef = doc(db, 'artifacts', appId, 'leaderboard', loserUid);
      const gameRef = gameId ? doc(db, 'artifacts', appId, 'games', gameId) : null;

      await runTransaction(db, async (transaction) => {
        // Check statsRecorded flag to prevent double-counting from both clients
        if (gameRef) {
          const gameSnap = await transaction.get(gameRef);
          if (gameSnap.exists() && gameSnap.data().statsRecorded) return;
        }

        const winnerSnap = await transaction.get(winnerProfileRef);
        const loserSnap = await transaction.get(loserProfileRef);
        const wData = winnerSnap.exists() ? winnerSnap.data() : { wins: 0, losses: 0, totalGames: 0 };
        const lData = loserSnap.exists() ? loserSnap.data() : { wins: 0, losses: 0, totalGames: 0 };

        const wWins = (wData.wins || 0) + 1;
        const wTotal = (wData.totalGames || 0) + 1;
        const wRate = Math.round((wWins / wTotal) * 100);

        const lLosses = (lData.losses || 0) + 1;
        const lTotal = (lData.totalGames || 0) + 1;
        const lWins = lData.wins || 0;
        const lRate = Math.round((lWins / lTotal) * 100);

        const winnerUpdate = { wins: wWins, totalGames: wTotal, winRate: wRate };
        const loserUpdate = { losses: lLosses, totalGames: lTotal, winRate: lRate };

        transaction.set(winnerProfileRef, winnerUpdate, { merge: true });
        transaction.set(winnerLeaderRef, winnerUpdate, { merge: true });
        transaction.set(loserProfileRef, loserUpdate, { merge: true });
        transaction.set(loserLeaderRef, loserUpdate, { merge: true });
        // Mark stats as recorded so the other client skips this
        if (gameRef) transaction.set(gameRef, { statsRecorded: true }, { merge: true });
      });

      if (user?.uid === winnerUid || user?.uid === loserUid) {
        fetchUserData(user.uid);
      }
      fetchLeaderboard();
    } catch (err) {
      console.error('Stats update failed:', err);
    }
  };

  const handleAutoRegister = async () => {
    setIsSubmitting(true);
    setError("");
    try {
      const generateSecureString = (length) => {
        const array = new Uint8Array(length);
        window.crypto.getRandomValues(array);
        return Array.from(array, byte => byte.toString(16).padStart(2, '0')).join('').slice(0, length);
      };
      const id = `player_${generateSecureString(6)}`;
      const pw = generateSecureString(12);
      const email = `${id}@forest6.com`;
      await createUserWithEmailAndPassword(auth, email, pw);
      await auth.signOut();
      setAutoCredentials({ id, pw });
      setLoginMode('credentials');
    } catch (err) {
      setError(err.code === 'auth/email-already-in-use' ? t('idInUse') : t('regFailed') + err.message);
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleManualRegister = async (e) => {
    e.preventDefault();
    setIsSubmitting(true);
    setError("");
    try {
      const id = e.target.regId.value.trim();
      const pw = e.target.regPw.value;
      const pwConfirm = e.target.regPwConfirm.value;
      const username = e.target.regUsername.value.trim();

      if (!/^[a-zA-Z0-9_]{3,20}$/.test(id)) {
        setError(t('idValidation'));
        return;
      }
      if (pw.length < 8) {
        setError(t('pwMinLength'));
        return;
      }
      if (pw !== pwConfirm) {
        setError(t('pwMismatch'));
        return;
      }
      if (username.length < 2 || username.length > 12 || !/^[a-zA-Z0-9_\uAC00-\uD7A3]+$/.test(username)) {
        setError(t('usernameValidation'));
        return;
      }

      // Check username uniqueness
      const leaderboardSnap = await getDocs(collection(db, 'artifacts', appId, 'leaderboard'));
      const usernameTaken = leaderboardSnap.docs.some(d => d.data().username === username);
      if (usernameTaken) {
        setError(t('usernameInUse'));
        return;
      }

      pendingUsername.current = username;
      const email = `${id}@forest6.com`;
      await createUserWithEmailAndPassword(auth, email, pw);
    } catch (err) {
      setError(err.code === 'auth/email-already-in-use' ? t('idInUse') : t('regFailed') + err.message);
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleManualLogin = async (e) => {
    e.preventDefault();
    setIsSubmitting(true);
    setError("");
    try {
      const email = e.target.id.value.trim() + "@forest6.com";
      const pw = e.target.pw.value;
      await signInWithEmailAndPassword(auth, email, pw);
    } catch (err) {
      setError(t('loginFailed'));
    } finally {
      setIsSubmitting(false);
    }
  };

  // Matchmaking
  const calcTolerance = (elapsedSec) => Math.min(Math.floor(elapsedSec / 2) * 10, 100);

  const tryMatchOpponents = (docs, poolCollectionPath, poolRef, myWinRate, myTotalGames, startTime, stopAll) => {
    const now = Date.now();
    const myElapsed = Math.floor((now - startTime) / 1000);
    const myTolerance = calcTolerance(myElapsed);

    const allOpponents = docs.filter(d => d.id !== user.uid && !d.data().gameId);
    const winRateDiff = (oppData) => Math.abs((oppData.winRate || 0) - myWinRate);
    const matchable = allOpponents.filter(d => {
      const diff = winRateDiff(d.data());
      const oppElapsed = d.data().enteredAt ? Math.floor((now - d.data().enteredAt) / 1000) : 0;
      const oppTolerance = calcTolerance(oppElapsed);
      return diff <= Math.max(myTolerance, oppTolerance);
    });

    if (matchable.length === 0) return false;

    matchable.sort((a, b) => {
      const aDiff = Math.abs((a.data().totalGames || 0) - myTotalGames);
      const bDiff = Math.abs((b.data().totalGames || 0) - myTotalGames);
      return aDiff - bDiff;
    });

    const opponent = matchable[0];

    if (user.uid < opponent.id) {
      stopAll();
      createPvPGame(opponent.data()).then((gameId) => {
        Promise.all([
          updateDoc(poolRef, { gameId }).catch(() => {}),
          updateDoc(doc(poolCollectionPath, opponent.id), { gameId }).catch(() => {})
        ]).then(() => {
          deleteDoc(poolRef).catch(() => {});
          joinPvPGame(gameId);
        });
      }).catch((err) => {
        console.error('Failed to create PvP game:', err);
        deleteDoc(poolRef).catch(() => {});
        startComputerGame();
      });
      return true;
    } else {
      setMatchmakingStatus(t('opponentFound'));
      return false;
    }
  };

  const startMatchmaking = () => {
    setView('matchmaking');
    setMatchmakingStatus(`${t('searchingOpponent')} (${t('toleranceLabel')}: 0%)`);
    setElapsedTime(0);
    const startTime = Date.now();
    let stopped = false;

    const myWinRate = userData?.totalGames > 0
      ? (userData.wins / userData.totalGames) * 100
      : 0;
    const myTotalGames = userData?.totalGames || 0;

    const poolCollectionPath = collection(db, 'artifacts', appId, 'matchmaking_pool');
    const poolRef = doc(poolCollectionPath, user.uid);

    const timerInterval = setInterval(() => {
      if (stopped) return;
      const elapsed = Math.floor((Date.now() - startTime) / 1000);
      setElapsedTime(elapsed);
      const tolerance = calcTolerance(elapsed);
      setMatchmakingStatus(`${t('searchingOpponent')} (${t('toleranceLabel')}: ${tolerance}%)`);
    }, 1000);

    const timeoutId = setTimeout(() => {
      if (stopped) return;
      stopAll();
      deleteDoc(poolRef).catch(() => {});
      startComputerGame();
    }, MATCH_TIMEOUT);

    let unsubPool = null;
    let recheckInterval = null;

    const stopAll = () => {
      if (stopped) return;
      stopped = true;
      clearInterval(timerInterval);
      clearTimeout(timeoutId);
      if (unsubPool) unsubPool();
      if (recheckInterval) clearInterval(recheckInterval);
    };
    matchmakingCleanup.current = () => {
      stopAll();
      deleteDoc(poolRef).catch(() => {});
    };

    let cachedDocs = [];
    const checkForMatch = (docs) => {
      if (stopped) return;
      const myDoc = docs.find(d => d.id === user.uid);
      if (myDoc && myDoc.data().gameId) {
        stopAll();
        deleteDoc(poolRef).catch(() => {});
        joinPvPGame(myDoc.data().gameId);
        return;
      }
      tryMatchOpponents(docs, poolCollectionPath, poolRef, myWinRate, myTotalGames, startTime, stopAll);
    };

    unsubPool = onSnapshot(
      query(poolCollectionPath),
      (snapshot) => {
        if (stopped) return;
        // Sort client-side by enteredAt to avoid serverTimestamp null issues on mobile
        cachedDocs = [...snapshot.docs].sort((a, b) => (b.data().enteredAt || 0) - (a.data().enteredAt || 0));
        checkForMatch(cachedDocs);
      },
      (err) => {
        console.warn('Pool onSnapshot failed, falling back to polling:', err);
        // On mobile, onSnapshot may fail — fall back to getDocs polling
        recheckInterval = setInterval(async () => {
          if (stopped) return;
          try {
            const snap = await getDocs(poolCollectionPath);
            cachedDocs = [...snap.docs].sort((a, b) => (b.data().enteredAt || 0) - (a.data().enteredAt || 0));
            checkForMatch(cachedDocs);
          } catch (e) { /* ignore */ }
        }, 3000);
      }
    );

    recheckInterval = setInterval(() => {
      if (stopped || cachedDocs.length === 0) return;
      checkForMatch(cachedDocs);
    }, 2000);

    setDoc(poolRef, {
      uid: user.uid,
      username: userData?.username || 'Unknown',
      winRate: myWinRate,
      totalGames: myTotalGames,
      enteredAt: Date.now(),
      timestamp: serverTimestamp(),
      gameId: null
    }).catch((err) => {
      console.error('Matchmaking pool write failed:', err);
      stopAll();
      setMatchmakingStatus(t('matchServerFailed'));
      setTimeout(() => startComputerGame(), 1500);
    });
  };

  const cancelMatchmaking = () => {
    if (matchmakingCleanup.current) matchmakingCleanup.current();
    setView('lobby');
  };

  const createPvPGame = async (opponentData, forceOrder) => {
    const gameRef = doc(collection(db, 'artifacts', appId, 'games'));
    let p1, p2;
    if (forceOrder) {
      p1 = forceOrder.player1;
      p2 = forceOrder.player2;
    } else {
      const randomArray = new Uint32Array(1);
      crypto.getRandomValues(randomArray);
      const meFirst = randomArray[0] % 2 === 0;
      p1 = meFirst
        ? { uid: user.uid, username: userData?.username }
        : { uid: opponentData.uid, username: opponentData.username };
      p2 = meFirst
        ? { uid: opponentData.uid, username: opponentData.username }
        : { uid: user.uid, username: userData?.username };
    }
    const isFriendMatch = forceOrder?.friendMatch || false;
    await setDoc(gameRef, {
      player1: p1,
      player2: p2,
      playerUids: [p1.uid, p2.uid],
      board: Array(BOARD_SIZE * BOARD_SIZE).fill(0),
      turn: 1,
      moveCount: 0,
      turnMoves: 0,
      status: 'active',
      winner: null,
      loser: null,
      winReason: null,
      lastMoveAt: Date.now(),
      rematchRequests: [],
      rematchGameId: null,
      friendMatch: isFriendMatch,
      moves: [],
      statsRecorded: false,
      createdAt: serverTimestamp()
    });
    return gameRef.id;
  };

  const joinPvPGame = (gameId) => {
    gameResultHandled.current = false;
    // Store active game ID in user profile for rejoin detection
    if (user) {
      updateDoc(doc(db, 'artifacts', appId, 'users', user.uid, 'profile', 'data'), { activeGameId: gameId }).catch(() => {});
      setUserData(prev => prev ? { ...prev, activeGameId: gameId } : prev);
    }
    setRejoinGame(null);
    setGameMode('pvp');
    setCurrentGame({ id: gameId, mode: 'pvp' });
    setWinnerModal(null);
    setView('game');
  };

  const clearActiveGame = () => {
    if (user) {
      updateDoc(doc(db, 'artifacts', appId, 'users', user.uid, 'profile', 'data'), { activeGameId: null }).catch(() => {});
      setUserData(prev => prev ? { ...prev, activeGameId: null } : prev);
    }
  };

  // Called when player leaves game view (Return to Lobby button)
  const handleLeaveGame = async () => {
    if (currentGame?.mode === 'pvp' && !winnerModal) {
      // Active PvP game: mark player as left but keep game running so they can rejoin
      try {
        const gameRef = doc(db, 'artifacts', appId, 'games', currentGame.id);
        const snap = await getDoc(gameRef);
        if (snap.exists() && snap.data().status === 'active') {
          await updateDoc(gameRef, { leftDuringGame: arrayUnion(user.uid) });
          // Do NOT clear activeGameId — keep it so they can rejoin from lobby
          setWinnerModal(null);
          setView('lobby');
          return;
        }
      } catch (e) { console.error('handleLeaveGame error:', e); }
    }
    // Non-PvP or game already finished: clear activeGameId
    clearActiveGame();
    setWinnerModal(null);
    setView('lobby');
    fetchLeaderboard();
  };

  const startComputerGame = () => {
    const randomArray = new Uint32Array(1);
    crypto.getRandomValues(randomArray);
    const playerIsBlack = randomArray[0] % 2 === 0;
    const humanPlayer = playerIsBlack ? 1 : 2;
    const aiPlayer = playerIsBlack ? 2 : 1;

    ensureAiBotExists().catch(() => {});

    setGameMode('ai');
    setCurrentGame({
      id: 'ai_' + Date.now(),
      mode: 'ai',
      board: Array(BOARD_SIZE * BOARD_SIZE).fill(0),
      turn: 1,
      moveCount: 0,
      turnMoves: 0,
      status: 'active',
      humanPlayer,
      aiPlayer,
      moves: [],
    });
    setWinnerModal(null);
    setView('game');
  };

  const startLocalGame = () => {
    setGameMode('local');
    setCurrentGame({
      id: 'local_' + Date.now(),
      mode: 'local',
      board: Array(BOARD_SIZE * BOARD_SIZE).fill(0),
      turn: 1,
      moveCount: 0,
      turnMoves: 0,
      status: 'active',
    });
    setWinnerModal(null);
    setView('game');
  };

  // --- Friend Match ---
  const sendFriendInvite = async () => {
    const trimmed = friendUsername.trim().slice(0, 12);
    if (!trimmed) return;
    if (trimmed === userData?.username) { setError(t('userNotFound')); return; }
    setError('');
    try {
      const snapshot = await getDocs(collection(db, 'artifacts', appId, 'leaderboard'));
      const target = snapshot.docs.find(d => d.data().username === trimmed);
      if (!target) {
        setError(t('userNotFound'));
        return;
      }
      if (target.data().uid === user.uid) {
        setError(t('userNotFound'));
        return;
      }

      const inviteRef = doc(collection(db, 'artifacts', appId, 'invites'));
      await setDoc(inviteRef, {
        fromUid: user.uid,
        fromUsername: userData.username,
        toUsername: friendUsername.trim(),
        toUid: target.data().uid,
        status: 'pending',
        gameId: null,
        createdAt: serverTimestamp()
      });

      setFriendInviteId(inviteRef.id);
      setView('friendMatchWaiting');

      const unsub = onSnapshot(inviteRef, (snap) => {
        if (!snap.exists()) { unsub(); setView('lobby'); return; }
        const data = snap.data();
        if (data.status === 'accepted' && data.gameId) {
          unsub();
          joinPvPGame(data.gameId);
        } else if (data.status === 'declined' || data.status === 'cancelled') {
          unsub();
          setView('lobby');
        }
      });
    } catch (err) {
      console.error('Friend invite failed:', err);
      setError(t('userNotFound'));
    }
  };

  const cancelFriendInvite = async () => {
    if (friendInviteId) {
      try {
        await updateDoc(doc(db, 'artifacts', appId, 'invites', friendInviteId), { status: 'cancelled' });
      } catch (e) { /* ignore */ }
    }
    setFriendInviteId(null);
    setView('lobby');
  };

  const acceptInvite = async () => {
    if (!pendingInvite) return;
    const inviteData = pendingInvite.data();
    try {
      const randomArray = new Uint32Array(1);
      crypto.getRandomValues(randomArray);
      const inviterFirst = randomArray[0] % 2 === 0;
      const p1 = inviterFirst
        ? { uid: inviteData.fromUid, username: inviteData.fromUsername }
        : { uid: user.uid, username: userData.username };
      const p2 = inviterFirst
        ? { uid: user.uid, username: userData.username }
        : { uid: inviteData.fromUid, username: inviteData.fromUsername };

      const gameRef = doc(collection(db, 'artifacts', appId, 'games'));
      await setDoc(gameRef, {
        player1: p1,
        player2: p2,
        playerUids: [p1.uid, p2.uid],
        board: Array(BOARD_SIZE * BOARD_SIZE).fill(0),
        turn: 1,
        moveCount: 0,
        turnMoves: 0,
        status: 'active',
        winner: null,
        loser: null,
        winReason: null,
        lastMoveAt: Date.now(),
        rematchRequests: [],
        rematchGameId: null,
        friendMatch: true,
        moves: [],
        statsRecorded: false,
        createdAt: serverTimestamp()
      });

      await updateDoc(doc(db, 'artifacts', appId, 'invites', pendingInvite.id), {
        status: 'accepted',
        gameId: gameRef.id
      });

      setPendingInvite(null);
      joinPvPGame(gameRef.id);
    } catch (err) {
      console.error('Accept invite failed:', err);
    }
  };

  const declineInvite = async () => {
    if (!pendingInvite) return;
    try {
      await updateDoc(doc(db, 'artifacts', appId, 'invites', pendingInvite.id), { status: 'declined' });
    } catch (e) { /* ignore */ }
    setPendingInvite(null);
  };

  // Listen for incoming friend invites in lobby
  useEffect(() => {
    if (!user || view !== 'lobby') return;
    const q = query(
      collection(db, 'artifacts', appId, 'invites'),
      where('toUid', '==', user.uid),
      where('status', '==', 'pending')
    );
    const unsub = onSnapshot(q, (snapshot) => {
      if (snapshot.docs.length > 0) {
        setPendingInvite(snapshot.docs[0]);
      } else {
        setPendingInvite(null);
      }
    });
    return () => unsub();
  }, [user, view]);

  // --- Game History ---
  const fetchGameHistory = async () => {
    try {
      // No orderBy to avoid requiring a composite Firestore index; sort client-side
      const q = query(
        collection(db, 'artifacts', appId, 'games'),
        where('playerUids', 'array-contains', user.uid),
        firestoreLimit(50)
      );
      const snapshot = await getDocs(q);
      const games = snapshot.docs.map(d => {
        const data = d.data();
        const isPlayer1 = data.player1?.uid === user.uid;
        const winnerUid = data.winner && !data.winner.startsWith('player')
          ? data.winner
          : data.winner === 'player1' ? data.player1?.uid : data.winner === 'player2' ? data.player2?.uid : null;
        return {
          id: d.id,
          player1: data.player1,
          player2: data.player2,
          opponentName: isPlayer1 ? data.player2?.username : data.player1?.username,
          result: !winnerUid ? 'unknown' : winnerUid === user.uid ? 'win' : 'loss',
          date: data.createdAt?.toDate?.()?.toLocaleDateString() || '',
          dateMs: data.createdAt?.toMillis?.() || 0,
          mode: data.friendMatch ? 'friendly' : 'ranked',
          moves: data.moves || [],
          winReason: data.winReason,
          status: data.status,
        };
      })
        .filter(g => g.status === 'finished' && g.result !== 'unknown')
        .sort((a, b) => b.dateMs - a.dateMs);
      setGameHistoryList(games);
    } catch (err) {
      console.error('Game history fetch failed:', err);
      setGameHistoryList([]);
    }
  };

  const viewReplay = (game) => {
    setReplayGame(game);
    setReplayMoveIndex(0);
    setView('replay');
  };

  const ensureAiBotExists = async () => {
    const leaderRef = doc(db, 'artifacts', appId, 'leaderboard', AI_BOT_UID);
    const profileRef = doc(db, 'artifacts', appId, 'users', AI_BOT_UID, 'profile', 'data');
    const leaderSnap = await getDoc(leaderRef);
    if (!leaderSnap.exists()) {
      const botData = { uid: AI_BOT_UID, username: AI_BOT_DISPLAY_NAME, wins: 0, losses: 0, totalGames: 0, winRate: 0, isBot: true };
      await Promise.all([setDoc(leaderRef, botData), setDoc(profileRef, botData)]);
    }
  };

  const handleObserveSearch = async () => {
    if (!observeUsername.trim()) return;
    setError('');
    try {
      const lbSnap = await getDocs(collection(db, 'artifacts', appId, 'leaderboard'));
      const target = lbSnap.docs.find(d => d.data().username === observeUsername.trim());
      if (!target) { setError(t('userNotFound')); return; }

      const gamesQ = query(
        collection(db, 'artifacts', appId, 'games'),
        where('playerUids', 'array-contains', target.id),
        firestoreLimit(10)
      );
      const gamesSnap = await getDocs(gamesQ);
      const activeGame = gamesSnap.docs.find(d => d.data().status === 'active');
      if (!activeGame) { setError(t('noActiveGame')); return; }

      setObserveGameId(activeGame.id);
      setView('observe');
    } catch (err) {
      console.error('Observe search failed:', err);
      setError(t('userNotFound'));
    }
  };

  // User rank computation
  const userRank = useMemo(() => {
    if (!userData || !leaderboard.length) return null;
    const idx = leaderboard.findIndex(p => p.uid === userData.uid);
    return idx >= 0 ? idx + 1 : null;
  }, [leaderboard, userData]);

  // Subscribe to active game for rejoin detection (when in lobby)
  useEffect(() => {
    if (!user || view !== 'lobby' || !userData?.activeGameId) {
      setRejoinGame(null);
      return;
    }
    const gameRef = doc(db, 'artifacts', appId, 'games', userData.activeGameId);
    const unsub = onSnapshot(gameRef, (snap) => {
      if (!snap.exists() || snap.data().status !== 'active') {
        setRejoinGame(null);
        clearActiveGame();
        return;
      }
      const data = snap.data();
      const myPlayerNum = data.player1.uid === user.uid ? 1 : 2;
      setRejoinGame({
        id: userData.activeGameId,
        myPlayerNum,
        lastMoveAt: data.lastMoveAt,
        turn: data.turn,
        player1: data.player1,
        player2: data.player2,
      });
    });
    return () => unsub();
  }, [user, view, userData?.activeGameId]);

  // Countdown for rejoin (how many seconds left before I lose due to timeout)
  useEffect(() => {
    if (!rejoinGame) { setRejoinCountdown(TURN_TIME_LIMIT); return; }
    const interval = setInterval(() => {
      const isMyTurn = rejoinGame.turn === rejoinGame.myPlayerNum;
      if (isMyTurn) {
        const elapsed = (Date.now() - (rejoinGame.lastMoveAt || Date.now())) / 1000;
        setRejoinCountdown(Math.max(0, Math.ceil(TURN_TIME_LIMIT - elapsed)));
      } else {
        setRejoinCountdown(TURN_TIME_LIMIT);
      }
    }, 500);
    return () => clearInterval(interval);
  }, [rejoinGame]);

  // --- GameBoard Component ---
  const GameBoard = ({ game }) => {
    const [board, setBoard] = useState(game.board || Array(BOARD_SIZE * BOARD_SIZE).fill(0));
    const [turn, setTurn] = useState(game.turn || 1);
    const [turnMoves, setTurnMoves] = useState(0);
    const [moveCount, setMoveCount] = useState(game.moveCount || 0);
    const [myPlayerNum, setMyPlayerNum] = useState(0);
    const [opponentName, setOpponentName] = useState('');
    const [isMyTurn, setIsMyTurn] = useState(false);
    const moveCountRef = useRef(game.moveCount || 0);
    const [turnTimeLeft, setTurnTimeLeft] = useState(TURN_TIME_LIMIT);
    const [gameFinished, setGameFinished] = useState(false);
    const lastMoveAtRef = useRef(Date.now());
    const turnTimerRef = useRef(null);
    const timeoutClaimRef = useRef(false);
    const [aiMoves, setAiMoves] = useState([]);
    const [pendingMoveIdx, setPendingMoveIdx] = useState(null);
    const opponentUidRef = useRef('');

    // AI first move when AI is black
    useEffect(() => {
      if (game.mode === 'ai' && game.aiPlayer === 1 && moveCount === 0) {
        const delay = Math.floor(Math.random() * 800) + 400;
        setTimeout(() => triggerAiMove(board, 1, 0), delay);
      }
    }, []);

    // AI mode: Turn timer (human has TURN_TIME_LIMIT seconds per turn)
    useEffect(() => {
      if (game.mode !== 'ai') return;
      const humanPlayer = game.humanPlayer || 1;
      turnTimerRef.current = setInterval(() => {
        if (gameFinished) return;
        const elapsed = (Date.now() - lastMoveAtRef.current) / 1000;
        const remaining = Math.max(0, TURN_TIME_LIMIT - elapsed);
        setTurnTimeLeft(Math.ceil(remaining));
        if (remaining <= 0 && turn === humanPlayer && !timeoutClaimRef.current) {
          timeoutClaimRef.current = true;
          setGameFinished(true);
          setWinnerModal({ text: t('youLose') + t('timeout'), isWinner: false });
          if (!gameResultHandled.current) {
            gameResultHandled.current = true;
            updatePlayerStats(AI_BOT_UID, user.uid).catch(() => {});
            fetchLeaderboard();
          }
        }
      }, 200);
      return () => clearInterval(turnTimerRef.current);
    }, [game.mode, gameFinished, turn]);

    // PvP: Turn timer countdown
    useEffect(() => {
      if (game.mode !== 'pvp') return;
      turnTimerRef.current = setInterval(() => {
        if (gameFinished) return;
        const elapsed = (Date.now() - lastMoveAtRef.current) / 1000;
        const remaining = Math.max(0, TURN_TIME_LIMIT - elapsed);
        setTurnTimeLeft(Math.ceil(remaining));

        if (remaining <= 0 && !timeoutClaimRef.current) {
          timeoutClaimRef.current = true;
          const gameRef = doc(db, 'artifacts', appId, 'games', game.id);
          if (isMyTurn) {
            // My turn ran out — I lose
            updateDoc(gameRef, {
              status: 'finished',
              winner: myPlayerNum === 1 ? 'player2' : 'player1',
              loser: user.uid,
              winReason: 'timeout'
            }).catch(console.error);
          } else {
            // Opponent's turn ran out — I win (use transaction to avoid conflict)
            runTransaction(db, async (tx) => {
              const snap = await tx.get(gameRef);
              if (snap.exists() && snap.data().status === 'active') {
                tx.update(gameRef, {
                  status: 'finished',
                  winner: myPlayerNum === 1 ? 'player1' : 'player2',
                  loser: opponentUidRef.current,
                  winReason: 'timeout'
                });
              }
            }).catch(console.error);
          }
        }
      }, 200);
      return () => clearInterval(turnTimerRef.current);
    }, [game.id, game.mode, isMyTurn, gameFinished, myPlayerNum]);

    // PvP: Sync game state from Firestore
    useEffect(() => {
      if (game.mode !== 'pvp') return;
      const gameRef = doc(db, 'artifacts', appId, 'games', game.id);
      const unsubscribe = onSnapshot(gameRef, (snapshot) => {
        if (!snapshot.exists()) return;
        const data = snapshot.data();

        setBoard(data.board);
        setTurn(data.turn);
        setTurnMoves(data.turnMoves);
        setMoveCount(data.moveCount);
        moveCountRef.current = data.moveCount;

        const pNum = data.player1.uid === user.uid ? 1 : 2;
        opponentUidRef.current = pNum === 1 ? data.player2.uid : data.player1.uid;
        setMyPlayerNum(pNum);
        setIsMyTurn(data.turn === pNum && data.status === 'active');
        setOpponentName(pNum === 1 ? data.player2.username : data.player1.username);

        // Handle rematch
        if (data.rematchGameId && data.status === 'finished') {
          joinPvPGame(data.rematchGameId);
          return;
        }

        // Handle opponent left — show notification then auto-redirect
        if (data.leftPlayers && data.leftPlayers.length > 0) {
          const opponentLeft = data.leftPlayers.some(uid => uid !== user.uid);
          if (opponentLeft && !opponentLeftMsg) {
            setOpponentLeftMsg(true);
            if (opponentLeftTimerRef.current) clearTimeout(opponentLeftTimerRef.current);
            opponentLeftTimerRef.current = setTimeout(() => {
              setOpponentLeftMsg(false);
              setWinnerModal(null);
              setView('lobby');
              fetchLeaderboard();
            }, 3000);
            return;
          }
        }

        if (data.lastMoveAt) {
          lastMoveAtRef.current = data.lastMoveAt;
          timeoutClaimRef.current = false;
        }

        if (data.status === 'finished' && !gameFinished) {
          setGameFinished(true);
          clearInterval(turnTimerRef.current);

          let winnerUid, loserUid, winnerName;
          if (data.winReason === 'timeout') {
            winnerUid = data.winner === 'player1' ? data.player1.uid : data.player2.uid;
            loserUid = data.loser;
            winnerName = data.winner === 'player1' ? data.player1.username : data.player2.username;
          } else {
            winnerUid = data.winner;
            loserUid = winnerUid === data.player1.uid ? data.player2.uid : data.player1.uid;
            winnerName = winnerUid === data.player1.uid ? data.player1.username : data.player2.username;
          }

          const iWon = winnerUid === user.uid;
          const reasonText = data.winReason === 'timeout' ? t('timeout') : '';
          const rematchRequests = data.rematchRequests || [];
          const iRequestedRematch = rematchRequests.includes(user.uid);
          const opponentRequestedRematch = rematchRequests.some(uid => uid !== user.uid);

          setWinnerModal({
            text: iWon ? t('myVictory') + reasonText : `${winnerName} ${t('victory')}${reasonText}`,
            isWinner: iWon,
            gameId: game.id,
            isPvP: true,
            player1: data.player1,
            player2: data.player2,
            iRequestedRematch,
            opponentRequestedRematch,
            friendMatch: data.friendMatch || false,
          });

          // Both winner and loser clients attempt stats update; statsRecorded flag prevents double-counting
          if (winnerUid && loserUid && !data.friendMatch) {
            updatePlayerStats(winnerUid, loserUid, game.id);
          }
        }
      });
      return () => unsubscribe();
    }, [game.id, game.mode]);

    const checkWin = (idx, player, currentBoard) => {
      const x = idx % BOARD_SIZE;
      const y = Math.floor(idx / BOARD_SIZE);
      const dirs = [[1,0], [0,1], [1,1], [1,-1]];
      for (let [dx, dy] of dirs) {
        let count = 1;
        for (let i = 1; i < 6; i++) {
          const nx = x + dx * i, ny = y + dy * i;
          if (nx < 0 || nx >= BOARD_SIZE || ny < 0 || ny >= BOARD_SIZE) break;
          if (currentBoard[ny * BOARD_SIZE + nx] === player) count++; else break;
        }
        for (let i = 1; i < 6; i++) {
          const nx = x - dx * i, ny = y - dy * i;
          if (nx < 0 || nx >= BOARD_SIZE || ny < 0 || ny >= BOARD_SIZE) break;
          if (currentBoard[ny * BOARD_SIZE + nx] === player) count++; else break;
        }
        if (count >= 6) return true;
      }
      return false;
    };

    const executePlaceStone = async (idx) => {
      if (board[idx] !== 0 || winnerModal || gameFinished) return;

      if (game.mode === 'pvp') {
        if (!isMyTurn) return;

        const newBoard = [...board];
        newBoard[idx] = turn;
        const won = checkWin(idx, turn, newBoard);

        let nextTurn = turn;
        let nextTurnMoves = turnMoves + 1;
        const nextMoveCount = moveCountRef.current + 1;
        const turnSwitching = !won && (moveCountRef.current === 0 || nextTurnMoves === 2);
        if (turnSwitching) {
          nextTurn = turn === 1 ? 2 : 1;
          nextTurnMoves = 0;
        }

        const gameRef = doc(db, 'artifacts', appId, 'games', game.id);
        await updateDoc(gameRef, {
          board: newBoard,
          turn: won ? turn : nextTurn,
          turnMoves: nextTurnMoves,
          moveCount: nextMoveCount,
          ...(turnSwitching || won ? { lastMoveAt: Date.now() } : {}),
          ...(won ? {
            status: 'finished',
            winner: user.uid,
            winReason: 'connect6'
          } : {}),
          moves: arrayUnion({ idx, player: turn, moveNumber: nextMoveCount, timestamp: Date.now() })
        });
        return;
      }

      // Local 2-player mode (both players on same screen)
      if (game.mode === 'local') {
        const newBoard = [...board];
        newBoard[idx] = turn;
        if (checkWin(idx, turn, newBoard)) {
          setBoard(newBoard);
          setWinnerModal({ text: turn === 1 ? t('blackWins') : t('whiteWins'), isWinner: true });
          return;
        }
        let nextTurn = turn;
        let nextTurnMoves = turnMoves + 1;
        moveCountRef.current++;
        if (moveCountRef.current === 1 || nextTurnMoves === 2) {
          nextTurn = turn === 1 ? 2 : 1;
          nextTurnMoves = 0;
        }
        setBoard(newBoard);
        setTurn(nextTurn);
        setTurnMoves(nextTurnMoves);
        setMoveCount(moveCountRef.current);
        return;
      }

      // AI mode
      const humanPlayer = game.humanPlayer || 1;
      const aiPlayer = game.aiPlayer || 2;

      if (turn !== humanPlayer) return;

      const newBoard = [...board];
      newBoard[idx] = turn;

      const newMoves = [...aiMoves, { idx, player: turn, moveNumber: moveCountRef.current + 1 }];
      setAiMoves(newMoves);

      if (checkWin(idx, turn, newBoard)) {
        setBoard(newBoard);
        setWinnerModal({ text: t('youWin'), isWinner: true });
        if (!gameResultHandled.current) {
          gameResultHandled.current = true;
          updatePlayerStats(user.uid, AI_BOT_UID).catch(() => {});
          fetchLeaderboard();
        }
        return;
      }

      let nextTurn = turn;
      let nextTurnMoves = turnMoves + 1;
      moveCountRef.current++;
      if (moveCountRef.current === 1 || nextTurnMoves === 2) {
        nextTurn = turn === 1 ? 2 : 1;
        nextTurnMoves = 0;
      }
      lastMoveAtRef.current = Date.now();
      timeoutClaimRef.current = false;
      setBoard(newBoard);
      setTurn(nextTurn);
      setTurnMoves(nextTurnMoves);
      setMoveCount(moveCountRef.current);
      if (nextTurn === aiPlayer) {
        const delay = Math.floor(Math.random() * 800) + 400;
        setTimeout(() => triggerAiMove(newBoard, aiPlayer, nextTurnMoves), delay);
      }
    };

    // Two-click stone placement: first click selects (pending), confirm button places
    const handleCellClick = (idx) => {
      if (board[idx] !== 0 || winnerModal || gameFinished) return;
      if (game.mode === 'pvp' && !isMyTurn) return;
      if (game.mode === 'ai' && turn !== (game.humanPlayer || 1)) return;
      // Update pending position (first click or change selection)
      setPendingMoveIdx(idx);
    };

    const confirmPlacement = async () => {
      if (pendingMoveIdx === null) return;
      const idx = pendingMoveIdx;
      setPendingMoveIdx(null);
      await executePlaceStone(idx);
    };

    // Score a candidate cell for AI placement
    const scoreCell = (board, idx, aiPlayer, humanPlayer) => {
      const dirs = [[1,0],[0,1],[1,1],[1,-1]];
      const x = idx % BOARD_SIZE;
      const y = Math.floor(idx / BOARD_SIZE);

      const countDir = (dx, dy, player) => {
        let cnt = 0;
        for (let i = 1; i < 6; i++) {
          const nx = x + dx * i, ny = y + dy * i;
          if (nx < 0 || nx >= BOARD_SIZE || ny < 0 || ny >= BOARD_SIZE) break;
          if (board[ny * BOARD_SIZE + nx] === player) cnt++; else break;
        }
        return cnt;
      };

      let aiMax = 0, humanMax = 0;
      for (const [dx, dy] of dirs) {
        const aiChain = 1 + countDir(dx, dy, aiPlayer) + countDir(-dx, -dy, aiPlayer);
        const humanChain = 1 + countDir(dx, dy, humanPlayer) + countDir(-dx, -dy, humanPlayer);
        if (aiChain > aiMax) aiMax = aiChain;
        if (humanChain > humanMax) humanMax = humanChain;
      }

      // Win immediately
      if (aiMax >= 6) return 100000;
      // Block human win
      if (humanMax >= 6) return 90000;
      // Build 5-chain (one away from win)
      if (aiMax === 5) return 10000;
      // Block human 5
      if (humanMax === 5) return 9000;
      // Build 4
      if (aiMax === 4) return 1000;
      // Block human 4
      if (humanMax === 4) return 900;
      // Build 3
      if (aiMax === 3) return 100;
      // Block human 3
      if (humanMax === 3) return 90;
      // Build 2
      if (aiMax === 2) return 10;
      // Block human 2
      if (humanMax === 2) return 9;
      // Adjacent to any human stone
      const adj8 = [[1,0],[-1,0],[0,1],[0,-1],[1,1],[-1,-1],[1,-1],[-1,1]];
      for (const [adx, ady] of adj8) {
        const nx = x + adx, ny = y + ady;
        if (nx >= 0 && nx < BOARD_SIZE && ny >= 0 && ny < BOARD_SIZE) {
          if (board[ny * BOARD_SIZE + nx] === humanPlayer) return 1;
        }
      }
      return 0;
    };

    const triggerAiMove = (currentBoard, aiPlayer, currentAiTurnMoves) => {
      if (winnerModal) return;
      const humanPlayer = game.humanPlayer || (aiPlayer === 1 ? 2 : 1);
      const emptyIndices = currentBoard.map((c, i) => c === 0 ? i : -1).filter(i => i !== -1);
      if (emptyIndices.length === 0) return;

      // First move: prefer near center
      const isFirstMove = moveCountRef.current === 0;
      let aiIdx;
      if (isFirstMove) {
        const center = Math.floor(BOARD_SIZE / 2);
        const rnd = new Uint32Array(2);
        crypto.getRandomValues(rnd);
        const offX = (rnd[0] % 5) - 2; // -2..+2
        const offY = (rnd[1] % 5) - 2;
        aiIdx = Math.max(0, Math.min(BOARD_SIZE - 1, center + offY)) * BOARD_SIZE +
                Math.max(0, Math.min(BOARD_SIZE - 1, center + offX));
      } else {
        // Score all empty cells, pick the best (with small random tiebreak)
        let bestScore = -1;
        aiIdx = emptyIndices[0];
        for (const idx of emptyIndices) {
          const score = scoreCell(currentBoard, idx, aiPlayer, humanPlayer) + Math.random() * 0.5;
          if (score > bestScore) { bestScore = score; aiIdx = idx; }
        }
      }

      const newBoard = [...currentBoard];
      newBoard[aiIdx] = aiPlayer;

      setAiMoves(prev => [...prev, { idx: aiIdx, player: aiPlayer, moveNumber: moveCountRef.current + 1 }]);

      if (checkWin(aiIdx, aiPlayer, newBoard)) {
        setBoard(newBoard);
        setWinnerModal({ text: t('youLose'), isWinner: false });
        // Track AI win stats
        if (!gameResultHandled.current) {
          gameResultHandled.current = true;
          updatePlayerStats(AI_BOT_UID, user.uid).catch(() => {});
          fetchLeaderboard();
        }
        return;
      }

      let nextTurn = aiPlayer;
      let nextTurnMoves = currentAiTurnMoves + 1;
      moveCountRef.current++;
      // First overall move only gets 1 stone; otherwise 2 per turn
      if (moveCountRef.current === 1 || nextTurnMoves === 2) {
        nextTurn = aiPlayer === 1 ? 2 : 1;
        nextTurnMoves = 0;
      }
      lastMoveAtRef.current = Date.now();
      timeoutClaimRef.current = false;
      setBoard(newBoard);
      setTurn(nextTurn);
      setTurnMoves(nextTurnMoves);
      setMoveCount(moveCountRef.current);
      if (nextTurn === aiPlayer) {
        const delay = Math.floor(Math.random() * 800) + 400;
        setTimeout(() => triggerAiMove(newBoard, aiPlayer, nextTurnMoves), delay);
      }
    };

    const BOARD_PX = 600;
    const CELL_SIZE = BOARD_PX / (BOARD_SIZE - 1);

    const timerPercent = (turnTimeLeft / TURN_TIME_LIMIT) * 100;
    const timerColor = turnTimeLeft <= 5 ? 'bg-red-500' : turnTimeLeft <= 10 ? 'bg-yellow-500' : 'bg-emerald-500';
    const timerTextColor = turnTimeLeft <= 5 ? 'text-red-600' : turnTimeLeft <= 10 ? 'text-yellow-600' : 'text-emerald-600';

    const humanPlayer = game.humanPlayer || 1;
    const isHumanTurn = game.mode === 'ai' ? turn === humanPlayer : isMyTurn;

    return (
      <div className="flex flex-col items-center">
        <div className="mb-4 flex items-center gap-6 bg-white/70 backdrop-blur-md px-10 py-4 rounded-3xl border border-emerald-100 shadow-sm">
           <div className={`w-8 h-8 rounded-full shadow-md transition-all duration-500 transform ${turn === 1 ? 'bg-gray-800 scale-110' : 'bg-white scale-110 border border-gray-200'}`}></div>
           <div className="flex flex-col">
             <span className="text-gray-800 font-bold text-sm">
               {game.mode === 'pvp'
                 ? (isMyTurn ? t('myTurn') : `${opponentName}${t('opponentTurnOf')}`)
                 : (isHumanTurn ? t('myTurn') : `${AI_BOT_DISPLAY_NAME}${t('opponentTurnOf')}`)}
             </span>
             <div className="flex items-center gap-2 mt-1">
               <div className="flex gap-1">
                 <div className={`w-2 h-2 rounded-full ${turnMoves < 2 ? 'bg-emerald-500' : 'bg-gray-200'}`}></div>
                 <div className={`w-2 h-2 rounded-full ${moveCount === 0 || turnMoves < 1 ? 'bg-emerald-500' : 'bg-gray-200'}`}></div>
               </div>
               <span className="text-[10px] text-emerald-600 font-semibold uppercase">
                 {game.mode === 'pvp'
                   ? (isMyTurn ? t('yourTurn') : t('waiting'))
                   : (isHumanTurn ? t('readyToMove') : t('waiting'))}
               </span>
             </div>
           </div>
           {game.mode === 'pvp' && (
             <>
               <div className="ml-4 flex items-center gap-2 text-xs text-gray-500">
                 <div className={`w-3 h-3 rounded-full ${myPlayerNum === 1 ? 'bg-gray-800' : 'bg-white border border-gray-300'}`}></div>
                 <span>{t('me')}</span>
                 <span className="text-gray-300">vs</span>
                 <div className={`w-3 h-3 rounded-full ${myPlayerNum === 2 ? 'bg-gray-800' : 'bg-white border border-gray-300'}`}></div>
                 <span>{opponentName}</span>
               </div>
               <div className="ml-4 flex items-center gap-2">
                 <Timer size={16} className={timerTextColor} />
                 <span className={`font-bold text-lg tabular-nums ${timerTextColor} ${turnTimeLeft <= 5 ? 'animate-pulse' : ''}`}>
                   {turnTimeLeft}s
                 </span>
               </div>
             </>
           )}
           {game.mode === 'ai' && (
             <>
               <div className="ml-4 flex items-center gap-2 text-xs text-gray-500">
                 <div className={`w-3 h-3 rounded-full ${humanPlayer === 1 ? 'bg-gray-800' : 'bg-white border border-gray-300'}`}></div>
                 <span>{t('me')}</span>
                 <span className="text-gray-300">vs</span>
                 <div className={`w-3 h-3 rounded-full ${humanPlayer === 2 ? 'bg-gray-800' : 'bg-white border border-gray-300'}`}></div>
                 <span>{AI_BOT_DISPLAY_NAME}</span>
               </div>
               <div className="ml-4 flex items-center gap-2">
                 <Timer size={16} className={timerTextColor} />
                 <span className={`font-bold text-lg tabular-nums ${timerTextColor} ${turnTimeLeft <= 5 ? 'animate-pulse' : ''}`}>
                   {turnTimeLeft}s
                 </span>
               </div>
             </>
           )}
           {game.mode === 'local' && (
             <div className="ml-4 flex items-center gap-2 text-xs text-gray-500">
               <div className="w-3 h-3 rounded-full bg-gray-800"></div>
               <span>{t('blackTurn')?.split(' ')[0]}</span>
               <span className="text-gray-300">vs</span>
               <div className="w-3 h-3 rounded-full bg-white border border-gray-300"></div>
               <span>{t('whiteTurn')?.split(' ')[0]}</span>
             </div>
           )}
        </div>

        {/* Turn timer bar for PvP and AI */}
        {(game.mode === 'pvp' || game.mode === 'ai') && !gameFinished && (
          <div className="w-full max-w-[660px] mb-4 h-2 bg-gray-200 rounded-full overflow-hidden">
            <div
              className={`h-full ${timerColor} rounded-full transition-all duration-200 ease-linear`}
              style={{ width: `${timerPercent}%` }}
            />
          </div>
        )}

        <div className="relative group mt-2">
          <div className="absolute inset-0 bg-emerald-900/5 blur-2xl rounded-lg translate-y-6 scale-95 pointer-events-none"></div>

          <div className="relative bg-[#e6c280] rounded-sm border-b-[8px] border-r-[8px] border-[#d4ae6a] shadow-xl">
            <div
              className="relative p-[30px]"
              style={{ width: `${BOARD_PX + 60}px`, height: `${BOARD_PX + 60}px` }}
            >
              <svg
                className="absolute top-[30px] left-[30px] pointer-events-none"
                width={BOARD_PX}
                height={BOARD_PX}
              >
                {Array.from({ length: BOARD_SIZE }).map((_, i) => (
                  <React.Fragment key={i}>
                    <line x1={i * CELL_SIZE} y1="0" x2={i * CELL_SIZE} y2={BOARD_PX} stroke="rgba(0,0,0,0.4)" strokeWidth="1" />
                    <line x1="0" y1={i * CELL_SIZE} x2={BOARD_PX} y2={i * CELL_SIZE} stroke="rgba(0,0,0,0.4)" strokeWidth="1" />
                  </React.Fragment>
                ))}
                {[3, 9, 15].map(x => [3, 9, 15].map(y => (
                  <circle key={`${x}-${y}`} cx={x * CELL_SIZE} cy={y * CELL_SIZE} r="3" fill="rgba(0,0,0,0.6)" />
                )))}
              </svg>

              <div
                className="absolute top-[30px] left-[30px] grid"
                style={{
                  gridTemplateColumns: `repeat(${BOARD_SIZE}, 1fr)`,
                  gridTemplateRows: `repeat(${BOARD_SIZE}, 1fr)`,
                  width: `${BOARD_PX + CELL_SIZE}px`,
                  height: `${BOARD_PX + CELL_SIZE}px`,
                  transform: `translate(-${CELL_SIZE / 2}px, -${CELL_SIZE / 2}px)`,
                }}
              >
                {board.map((cell, i) => (
                  <div
                    key={i}
                    onClick={() => handleCellClick(i)}
                    className="relative flex items-center justify-center cursor-pointer group/cell"
                    style={{ width: `${CELL_SIZE}px`, height: `${CELL_SIZE}px` }}
                  >
                    {cell !== 0 ? (
                      <div className={`
                        z-20 w-[90%] h-[90%] rounded-full transition-all duration-300 transform scale-100
                        ${cell === 1
                          ? 'bg-gradient-to-br from-gray-700 via-gray-900 to-black shadow-[2px_3px_5px_rgba(0,0,0,0.4),inset_-1px_-1px_2px_rgba(255,255,255,0.1)]'
                          : 'bg-gradient-to-br from-white via-gray-50 to-gray-200 shadow-[2px_3px_5px_rgba(0,0,0,0.15),inset_-1px_-1px_2px_rgba(0,0,0,0.05)] border border-gray-200'
                        }
                      `}></div>
                    ) : pendingMoveIdx === i ? (
                      // Pending stone preview (semi-transparent)
                      <div className={`
                        z-20 w-[90%] h-[90%] rounded-full opacity-60 ring-2 ring-emerald-400 ring-offset-1 transition-all duration-150
                        ${turn === 1
                          ? 'bg-gradient-to-br from-gray-700 via-gray-900 to-black'
                          : 'bg-gradient-to-br from-white via-gray-50 to-gray-200 border border-gray-200'
                        }
                      `}></div>
                    ) : (
                      <div className={`
                        z-10 w-[35%] h-[35%] rounded-full opacity-0 group-hover/cell:opacity-30 transition-opacity
                        ${turn === 1 ? 'bg-gray-800' : 'bg-white shadow-sm'}
                      `}></div>
                    )}
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>

        {/* Confirm stone placement button */}
        {pendingMoveIdx !== null && !winnerModal && !gameFinished && (
          <div className="mt-5 flex items-center gap-3">
            <button
              onClick={confirmPlacement}
              className="px-8 py-3 bg-emerald-500 hover:bg-emerald-600 text-white font-bold rounded-2xl shadow-md transition-all transform active:scale-[0.97] text-base"
            >
              {t('confirmStone')}
            </button>
            <button
              onClick={() => setPendingMoveIdx(null)}
              className="px-6 py-3 bg-white/80 text-gray-500 hover:text-gray-700 font-semibold rounded-2xl border border-gray-200 transition-all text-sm"
            >
              {t('cancelStone')}
            </button>
          </div>
        )}
      </div>
    );
  };

  // --- Observe Board Component (read-only live view) ---
  const ObserveBoard = ({ gameId }) => {
    const [board, setBoard] = useState(Array(BOARD_SIZE * BOARD_SIZE).fill(0));
    const [turn, setTurn] = useState(1);
    const [p1Name, setP1Name] = useState('');
    const [p2Name, setP2Name] = useState('');
    const [gameStatus, setGameStatus] = useState('active');

    useEffect(() => {
      const gameRef = doc(db, 'artifacts', appId, 'games', gameId);
      const unsub = onSnapshot(gameRef, (snap) => {
        if (!snap.exists()) { setGameStatus('notfound'); return; }
        const data = snap.data();
        setBoard(data.board || Array(BOARD_SIZE * BOARD_SIZE).fill(0));
        setTurn(data.turn || 1);
        setP1Name(data.player1?.username || '');
        setP2Name(data.player2?.username || '');
        setGameStatus(data.status || 'active');
      });
      return () => unsub();
    }, [gameId]);

    const BOARD_PX = 600;
    const CELL_SIZE = BOARD_PX / (BOARD_SIZE - 1);

    return (
      <div className="flex flex-col items-center">
        <div className="mb-4 flex items-center gap-4 bg-white/70 backdrop-blur-md px-8 py-3 rounded-3xl border border-emerald-100 shadow-sm">
          <div className={`w-4 h-4 rounded-full shadow ${turn === 1 ? 'bg-gray-900 scale-125' : 'bg-gray-200 border border-gray-400'}`} />
          <span className="font-bold text-gray-700 text-sm">{p1Name}</span>
          <span className="text-gray-400">vs</span>
          <span className="font-bold text-gray-700 text-sm">{p2Name}</span>
          <div className={`w-4 h-4 rounded-full shadow ${turn === 2 ? 'bg-gray-900 scale-125' : 'bg-gray-200 border border-gray-400'}`} />
          {gameStatus === 'finished' && <span className="text-red-500 text-sm font-bold ml-2">{t('gameOver')}</span>}
          <span className="ml-2 text-xs bg-purple-100 text-purple-600 px-2 py-0.5 rounded-full font-semibold">{t('observing')}</span>
        </div>

        <div className="relative mt-2">
          <div className="relative bg-[#e6c280] rounded-sm border-b-[8px] border-r-[8px] border-[#d4ae6a] shadow-xl">
            <div className="relative p-[30px]" style={{ width: `${BOARD_PX + 60}px`, height: `${BOARD_PX + 60}px` }}>
              <svg className="absolute top-[30px] left-[30px] pointer-events-none" width={BOARD_PX} height={BOARD_PX}>
                {Array.from({ length: BOARD_SIZE }).map((_, i) => (
                  <React.Fragment key={i}>
                    <line x1={i * CELL_SIZE} y1="0" x2={i * CELL_SIZE} y2={BOARD_PX} stroke="rgba(0,0,0,0.4)" strokeWidth="1" />
                    <line x1="0" y1={i * CELL_SIZE} x2={BOARD_PX} y2={i * CELL_SIZE} stroke="rgba(0,0,0,0.4)" strokeWidth="1" />
                  </React.Fragment>
                ))}
                {[3, 9, 15].map(x => [3, 9, 15].map(y => (
                  <circle key={`${x}-${y}`} cx={x * CELL_SIZE} cy={y * CELL_SIZE} r="3" fill="rgba(0,0,0,0.6)" />
                )))}
              </svg>
              <div className="absolute top-[30px] left-[30px] grid" style={{
                gridTemplateColumns: `repeat(${BOARD_SIZE}, 1fr)`,
                gridTemplateRows: `repeat(${BOARD_SIZE}, 1fr)`,
                width: `${BOARD_PX + CELL_SIZE}px`,
                height: `${BOARD_PX + CELL_SIZE}px`,
                transform: `translate(-${CELL_SIZE / 2}px, -${CELL_SIZE / 2}px)`,
              }}>
                {board.map((cell, i) => (
                  <div key={i} className="relative flex items-center justify-center" style={{ width: `${CELL_SIZE}px`, height: `${CELL_SIZE}px` }}>
                    {cell !== 0 && (
                      <div className={`z-20 w-[90%] h-[90%] rounded-full ${cell === 1
                        ? 'bg-gradient-to-br from-gray-700 via-gray-900 to-black shadow-[2px_3px_5px_rgba(0,0,0,0.4)]'
                        : 'bg-gradient-to-br from-white via-gray-50 to-gray-200 shadow-[2px_3px_5px_rgba(0,0,0,0.15)] border border-gray-200'
                      }`} />
                    )}
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      </div>
    );
  };

  // --- Replay Board Component ---
  const ReplayBoard = ({ game: replayData }) => {
    const board = useMemo(() => {
      const b = Array(BOARD_SIZE * BOARD_SIZE).fill(0);
      const sortedMoves = [...(replayData.moves || [])].sort((a, b) => a.moveNumber - b.moveNumber);
      for (let i = 0; i < replayMoveIndex && i < sortedMoves.length; i++) {
        b[sortedMoves[i].idx] = sortedMoves[i].player;
      }
      return b;
    }, [replayData.moves, replayMoveIndex]);

    const lastMoveIdx = useMemo(() => {
      if (replayMoveIndex === 0) return -1;
      const sortedMoves = [...(replayData.moves || [])].sort((a, b) => a.moveNumber - b.moveNumber);
      return replayMoveIndex > 0 && replayMoveIndex <= sortedMoves.length ? sortedMoves[replayMoveIndex - 1].idx : -1;
    }, [replayData.moves, replayMoveIndex]);

    const BOARD_PX = 600;
    const CELL_SIZE = BOARD_PX / (BOARD_SIZE - 1);

    return (
      <div className="flex flex-col items-center">
        <div className="mb-4 flex items-center gap-4 bg-white/70 backdrop-blur-md px-8 py-3 rounded-3xl border border-emerald-100 shadow-sm">
          <span className="text-sm font-bold text-gray-700">
            {replayData.player1?.username} <span className="text-gray-400">vs</span> {replayData.player2?.username}
          </span>
          <span className="text-xs text-gray-400">|</span>
          <span className="text-sm font-medium text-emerald-600">
            {replayMoveIndex} / {replayData.moves?.length || 0} {t('moveOf')}
          </span>
        </div>

        <div className="relative group mt-2">
          <div className="relative bg-[#e6c280] rounded-sm border-b-[8px] border-r-[8px] border-[#d4ae6a] shadow-xl">
            <div
              className="relative p-[30px]"
              style={{ width: `${BOARD_PX + 60}px`, height: `${BOARD_PX + 60}px` }}
            >
              <svg
                className="absolute top-[30px] left-[30px] pointer-events-none"
                width={BOARD_PX}
                height={BOARD_PX}
              >
                {Array.from({ length: BOARD_SIZE }).map((_, i) => (
                  <React.Fragment key={i}>
                    <line x1={i * CELL_SIZE} y1="0" x2={i * CELL_SIZE} y2={BOARD_PX} stroke="rgba(0,0,0,0.4)" strokeWidth="1" />
                    <line x1="0" y1={i * CELL_SIZE} x2={BOARD_PX} y2={i * CELL_SIZE} stroke="rgba(0,0,0,0.4)" strokeWidth="1" />
                  </React.Fragment>
                ))}
                {[3, 9, 15].map(x => [3, 9, 15].map(y => (
                  <circle key={`${x}-${y}`} cx={x * CELL_SIZE} cy={y * CELL_SIZE} r="3" fill="rgba(0,0,0,0.6)" />
                )))}
              </svg>

              <div
                className="absolute top-[30px] left-[30px] grid"
                style={{
                  gridTemplateColumns: `repeat(${BOARD_SIZE}, 1fr)`,
                  gridTemplateRows: `repeat(${BOARD_SIZE}, 1fr)`,
                  width: `${BOARD_PX + CELL_SIZE}px`,
                  height: `${BOARD_PX + CELL_SIZE}px`,
                  transform: `translate(-${CELL_SIZE / 2}px, -${CELL_SIZE / 2}px)`,
                }}
              >
                {board.map((cell, i) => (
                  <div
                    key={i}
                    className="relative flex items-center justify-center"
                    style={{ width: `${CELL_SIZE}px`, height: `${CELL_SIZE}px` }}
                  >
                    {cell !== 0 && (
                      <div className={`
                        z-20 w-[90%] h-[90%] rounded-full transition-all duration-300
                        ${cell === 1
                          ? 'bg-gradient-to-br from-gray-700 via-gray-900 to-black shadow-[2px_3px_5px_rgba(0,0,0,0.4),inset_-1px_-1px_2px_rgba(255,255,255,0.1)]'
                          : 'bg-gradient-to-br from-white via-gray-50 to-gray-200 shadow-[2px_3px_5px_rgba(0,0,0,0.15),inset_-1px_-1px_2px_rgba(0,0,0,0.05)] border border-gray-200'
                        }
                        ${i === lastMoveIdx ? 'ring-2 ring-emerald-400 ring-offset-1' : ''}
                      `}></div>
                    )}
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>

        <div className="mt-6 flex items-center gap-4">
          <button
            onClick={() => setReplayMoveIndex(0)}
            className="px-4 py-2 bg-white/80 rounded-xl text-sm font-semibold text-gray-600 border border-gray-200 hover:bg-white transition-all"
          >
            &#x23EE;
          </button>
          <button
            onClick={() => setReplayMoveIndex(i => Math.max(0, i - 1))}
            disabled={replayMoveIndex === 0}
            className="px-6 py-3 bg-white/80 rounded-xl text-sm font-semibold text-gray-600 border border-gray-200 hover:bg-white transition-all disabled:opacity-40"
          >
            <ChevronLeft size={18} className="inline" /> {t('prevMove')}
          </button>
          <button
            onClick={() => setReplayMoveIndex(i => Math.min(replayData.moves?.length || 0, i + 1))}
            disabled={replayMoveIndex >= (replayData.moves?.length || 0)}
            className="px-6 py-3 bg-white/80 rounded-xl text-sm font-semibold text-gray-600 border border-gray-200 hover:bg-white transition-all disabled:opacity-40"
          >
            {t('nextMove')} <ChevronRight size={18} className="inline" />
          </button>
          <button
            onClick={() => setReplayMoveIndex(replayData.moves?.length || 0)}
            className="px-4 py-2 bg-white/80 rounded-xl text-sm font-semibold text-gray-600 border border-gray-200 hover:bg-white transition-all"
          >
            &#x23ED;
          </button>
        </div>
      </div>
    );
  };

  return (
    <div className="min-h-screen bg-[#f7fcf9] text-gray-800 selection:bg-emerald-200 selection:text-emerald-900 overflow-hidden relative" style={{ fontFamily: "'Pretendard', -apple-system, BlinkMacSystemFont, system-ui, Roboto, 'Helvetica Neue', 'Segoe UI', 'Apple SD Gothic Neo', 'Noto Sans KR', 'Malgun Gothic', sans-serif" }}>
      <style>{`
        @import url('https://cdn.jsdelivr.net/gh/orioncactus/pretendard/dist/web/static/pretendard.css');
      `}</style>

      <div className="fixed inset-0 pointer-events-none opacity-60 z-0">
        <div className="absolute top-[-10%] left-[-10%] w-[50%] h-[50%] bg-emerald-100/40 blur-[120px] rounded-full"></div>
        <div className="absolute bottom-[-10%] right-[-10%] w-[40%] h-[40%] bg-teal-50/60 blur-[100px] rounded-full"></div>
      </div>

      {/* === LOGIN === */}
      {view === 'login' && (
        <div className="relative z-10 min-h-screen flex items-center justify-center p-6">
          <div className="bg-white/80 backdrop-blur-xl p-12 rounded-[3rem] border border-white shadow-[0_20px_60px_rgba(0,0,0,0.04)] w-full max-w-md text-center relative">
            {/* Language selector */}
            <div className="absolute top-6 right-6">
              <select value={lang} onChange={(e) => setLang(e.target.value)} className="text-sm border border-gray-200 rounded-lg px-3 py-1.5 bg-white text-gray-600 focus:ring-2 focus:ring-emerald-400 outline-none">
                <option value="ko">한국어</option>
                <option value="en">English</option>
              </select>
            </div>

            <div className="mb-8 inline-flex p-6 bg-emerald-50 rounded-full text-emerald-500 border border-emerald-100 shadow-sm">
              <Shield size={48} strokeWidth={1.5} />
            </div>
            <h1 className="text-4xl font-bold tracking-tight mb-2 text-gray-800">{t('appTitle')}</h1>
            <p className="text-emerald-600 mb-10 font-medium text-sm">{t('welcome')}</p>
            {error && <p className="text-red-500 text-sm mb-4">{error}</p>}

            {loginMode === 'credentials' ? (
              <div className="space-y-6">
                <div className="bg-emerald-50 border border-emerald-200 rounded-2xl p-6 text-left">
                  <p className="text-emerald-700 font-semibold text-sm mb-4">{t('accountCreated')}</p>
                  <div className="space-y-3">
                    <div className="flex items-center justify-between bg-white rounded-xl px-4 py-3 border border-gray-100">
                      <div>
                        <span className="text-xs text-gray-400 block">{t('idLabel')}</span>
                        <span className="text-gray-800 font-mono font-bold select-all">{autoCredentials?.id}</span>
                      </div>
                      <button onClick={() => { navigator.clipboard.writeText(autoCredentials?.id); setCopied('id'); setTimeout(() => setCopied(false), 1500); }} className="p-2 text-gray-400 hover:text-emerald-500 transition-colors">
                        {copied === 'id' ? <Check size={16} className="text-emerald-500" /> : <Copy size={16} />}
                      </button>
                    </div>
                    <div className="flex items-center justify-between bg-white rounded-xl px-4 py-3 border border-gray-100">
                      <div>
                        <span className="text-xs text-gray-400 block">{t('pwLabel')}</span>
                        <span className="text-gray-800 font-mono font-bold select-all">{autoCredentials?.pw}</span>
                      </div>
                      <button onClick={() => { navigator.clipboard.writeText(autoCredentials?.pw); setCopied('pw'); setTimeout(() => setCopied(false), 1500); }} className="p-2 text-gray-400 hover:text-emerald-500 transition-colors">
                        {copied === 'pw' ? <Check size={16} className="text-emerald-500" /> : <Copy size={16} />}
                      </button>
                    </div>
                  </div>
                  <p className="text-xs text-red-500 mt-4 font-medium">{t('saveWarning')}</p>
                </div>
                <button onClick={() => { setLoginMode('login'); setAutoCredentials(null); setCopied(false); }} className="w-full py-4 bg-emerald-500 hover:bg-emerald-600 rounded-xl font-semibold text-white transition-all shadow-md transform active:scale-[0.98] text-base">
                  {t('goToLogin')}
                </button>
              </div>
            ) : loginMode === 'login' ? (
              <>
                <form onSubmit={handleManualLogin} className="space-y-4">
                  <input id="id" type="text" placeholder={t('loginId')} required className="w-full bg-white border border-gray-200 rounded-xl py-4 px-6 focus:ring-2 focus:ring-emerald-400 outline-none text-gray-800 transition-all placeholder:text-gray-400 shadow-sm" />
                  <input id="pw" type="password" placeholder={t('loginPw')} required className="w-full bg-white border border-gray-200 rounded-xl py-4 px-6 focus:ring-2 focus:ring-emerald-400 outline-none text-gray-800 transition-all placeholder:text-gray-400 shadow-sm" />
                  <button disabled={isSubmitting} className="w-full py-4 mt-2 bg-emerald-500 hover:bg-emerald-600 disabled:bg-emerald-300 rounded-xl font-semibold text-white transition-all shadow-md transform active:scale-[0.98] text-base">
                    {isSubmitting ? t('loggingIn') : t('loginButton')}
                  </button>
                </form>
                <div className="mt-6 flex flex-col gap-3">
                  <button onClick={() => { setLoginMode('register'); setError(""); }} className="text-gray-500 hover:text-emerald-600 text-sm font-medium transition-colors underline underline-offset-4 flex items-center justify-center gap-2">
                    <UserPlus size={14} /> {t('createAccount')}
                  </button>
                  <button onClick={handleAutoRegister} disabled={isSubmitting} className="text-gray-400 hover:text-emerald-500 text-xs font-medium transition-colors underline underline-offset-4 disabled:text-gray-300">
                    {isSubmitting ? t('creating') : t('autoRegister')}
                  </button>
                </div>
              </>
            ) : (
              <>
                <form onSubmit={handleManualRegister} className="space-y-4">
                  <input name="regUsername" type="text" placeholder={t('usernamePlaceholder')} required minLength={2} maxLength={12} className="w-full bg-white border border-gray-200 rounded-xl py-4 px-6 focus:ring-2 focus:ring-emerald-400 outline-none text-gray-800 transition-all placeholder:text-gray-400 shadow-sm" />
                  <input name="regId" type="text" placeholder={t('regIdPlaceholder')} required className="w-full bg-white border border-gray-200 rounded-xl py-4 px-6 focus:ring-2 focus:ring-emerald-400 outline-none text-gray-800 transition-all placeholder:text-gray-400 shadow-sm" autoComplete="username" />
                  <input name="regPw" type="password" placeholder={t('regPwPlaceholder')} required minLength={8} className="w-full bg-white border border-gray-200 rounded-xl py-4 px-6 focus:ring-2 focus:ring-emerald-400 outline-none text-gray-800 transition-all placeholder:text-gray-400 shadow-sm" autoComplete="new-password" />
                  <input name="regPwConfirm" type="password" placeholder={t('regPwConfirmPlaceholder')} required minLength={8} className="w-full bg-white border border-gray-200 rounded-xl py-4 px-6 focus:ring-2 focus:ring-emerald-400 outline-none text-gray-800 transition-all placeholder:text-gray-400 shadow-sm" autoComplete="new-password" />
                  <button disabled={isSubmitting} className="w-full py-4 mt-2 bg-emerald-500 hover:bg-emerald-600 disabled:bg-emerald-300 rounded-xl font-semibold text-white transition-all shadow-md transform active:scale-[0.98] text-base">
                    {isSubmitting ? t('creating') : t('createAccount')}
                  </button>
                </form>
                <button onClick={() => { setLoginMode('login'); setError(""); }} className="mt-6 text-gray-500 hover:text-emerald-600 text-sm font-medium transition-colors underline underline-offset-4">
                  {t('backToLogin')}
                </button>
              </>
            )}
          </div>
        </div>
      )}

      {/* === LOBBY === */}
      {view === 'lobby' && (
        <div className="relative z-10 p-8 md:p-12 max-w-7xl mx-auto">
          <header className="flex flex-col md:flex-row justify-between items-start md:items-center mb-10 gap-4">
            <div>
              <span className="text-emerald-500 font-semibold tracking-wider text-xs uppercase mb-1 block">{t('lobbySubtitle')}</span>
              <h1 className="text-4xl font-bold tracking-tight text-gray-800">{t('lobbyTitle')}</h1>
            </div>
            <div className="flex items-center gap-3">
              <select value={lang} onChange={(e) => handleLangChange(e.target.value)} className="text-xs border border-gray-200 rounded-lg px-2 py-1.5 bg-white text-gray-600 focus:ring-2 focus:ring-emerald-400 outline-none">
                <option value="ko">한국어</option>
                <option value="en">English</option>
              </select>
              <button onClick={() => auth.signOut()} className="p-2 text-gray-400 hover:text-red-500 hover:bg-red-50 rounded-full transition-all"><LogOut size={20} /></button>
            </div>
          </header>

          {/* Pending invite banner */}
          {pendingInvite && (
            <div className="mb-6 bg-amber-50 border border-amber-200 rounded-2xl p-5 flex items-center justify-between">
              <div className="flex items-center gap-3">
                <Users size={22} className="text-amber-600" />
                <span className="font-bold text-amber-800 text-sm">
                  {pendingInvite.data().fromUsername}{t('pendingInviteFrom')}
                </span>
                <span className="text-xs text-amber-600">{t('friendMatchNote')}</span>
              </div>
              <div className="flex gap-2">
                <button onClick={acceptInvite} className="px-5 py-2 bg-emerald-500 text-white rounded-xl text-sm font-semibold hover:bg-emerald-600 transition-all">{t('acceptInvite')}</button>
                <button onClick={declineInvite} className="px-5 py-2 bg-gray-200 text-gray-600 rounded-xl text-sm font-semibold hover:bg-gray-300 transition-all">{t('declineInvite')}</button>
              </div>
            </div>
          )}

          <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
            {/* LEFT: Ranked match + action buttons */}
            <div className="lg:col-span-2 space-y-6">
              {/* Ranked PvP — big card (shows rejoin if active game exists) */}
              {rejoinGame ? (
                <div className="relative bg-white/80 p-10 rounded-[3rem] shadow-sm overflow-hidden border border-amber-200">
                  <div className="relative z-10">
                    <div className="inline-flex items-center gap-2 bg-amber-50 px-4 py-2 rounded-full text-xs font-semibold text-amber-600 mb-5 border border-amber-200 animate-pulse">
                      ⚠️ {lang === 'ko' ? '진행 중인 대전이 있습니다' : 'You have an active game'}
                    </div>
                    <h2 className="text-3xl font-bold mb-2 text-gray-800 tracking-tight">
                      {rejoinGame.player1?.username} vs {rejoinGame.player2?.username}
                    </h2>
                    {rejoinGame.turn === rejoinGame.myPlayerNum && (
                      <p className="text-red-500 font-bold text-sm mb-4">
                        ⏱ {lang === 'ko' ? `내 차례 — ${rejoinCountdown}초 안에 돌아가지 않으면 패배` : `Your turn — ${rejoinCountdown}s left before timeout`}
                      </p>
                    )}
                    {rejoinGame.turn !== rejoinGame.myPlayerNum && (
                      <p className="text-gray-400 text-sm mb-4">
                        {lang === 'ko' ? '상대방 차례 진행 중' : "Opponent's turn in progress"}
                      </p>
                    )}
                    <button
                      onClick={() => joinPvPGame(rejoinGame.id)}
                      className="inline-flex items-center gap-3 bg-amber-500 text-white px-8 py-4 rounded-2xl font-semibold text-sm shadow-md hover:bg-amber-600 transition-colors"
                    >
                      {lang === 'ko' ? '게임으로 돌아가기' : 'Rejoin Game'} <Play size={18} fill="currentColor" />
                    </button>
                  </div>
                </div>
              ) : (
                <button onClick={startMatchmaking} className="relative group w-full text-left bg-white/80 p-10 rounded-[3rem] shadow-sm overflow-hidden transition-all hover:shadow-md border border-white hover:border-emerald-100 active:scale-[0.98]">
                  <div className="relative z-10">
                    <div className="inline-flex items-center gap-2 bg-emerald-50 px-4 py-2 rounded-full text-xs font-semibold text-emerald-600 mb-5 border border-emerald-100">
                      {t('matchAvailable')}
                    </div>
                    <h2 className="text-4xl font-bold mb-3 text-gray-800 tracking-tight">{t('pvpTitle')}</h2>
                    <p className="text-gray-500 max-w-sm mb-8 text-sm leading-relaxed">{t('pvpDesc')}</p>
                    <div className="inline-flex items-center gap-3 bg-emerald-500 text-white px-8 py-4 rounded-2xl font-semibold text-sm shadow-md group-hover:bg-emerald-600 transition-colors">
                      {t('startMatch')} <Play size={18} fill="currentColor" />
                    </div>
                  </div>
                </button>
              )}

              {/* Friend + Offline + History + Observe */}
              <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                <button onClick={() => { setFriendUsername(''); setError(''); setView('friendMatch'); }} className="p-5 bg-white/70 rounded-[2rem] border border-white hover:border-blue-200 hover:bg-white shadow-sm transition-all text-left group">
                  <Users className="text-blue-400 mb-3 w-7 h-7 group-hover:scale-110 transition-transform" />
                  <h3 className="text-base font-bold text-gray-800 tracking-tight mb-1">{t('friendMatch')}</h3>
                  <p className="text-xs text-gray-400">{t('friendMatchDesc')}</p>
                </button>
                <button onClick={startLocalGame} className="p-5 bg-white/70 rounded-[2rem] border border-white hover:border-purple-200 hover:bg-white shadow-sm transition-all text-left group">
                  <Gamepad2 className="text-purple-400 mb-3 w-7 h-7 group-hover:scale-110 transition-transform" />
                  <h3 className="text-base font-bold text-gray-800 tracking-tight mb-1">{t('offlineMatch')}</h3>
                  <p className="text-xs text-gray-400">{t('offlineMatchDesc')}</p>
                </button>
                <button onClick={() => { fetchGameHistory(); setView('history'); }} className="p-5 bg-white/70 rounded-[2rem] border border-white hover:border-amber-200 hover:bg-white shadow-sm transition-all text-left group">
                  <History className="text-amber-400 mb-3 w-7 h-7 group-hover:scale-110 transition-transform" />
                  <h3 className="text-base font-bold text-gray-800 tracking-tight mb-1">{t('gameHistory')}</h3>
                  <p className="text-xs text-gray-400">{t('gameHistoryDesc')}</p>
                </button>
                <button onClick={() => { setObserveUsername(''); setError(''); setView('observeSearch'); }} className="p-5 bg-white/70 rounded-[2rem] border border-white hover:border-indigo-200 hover:bg-white shadow-sm transition-all text-left group">
                  <Eye className="text-indigo-400 mb-3 w-7 h-7 group-hover:scale-110 transition-transform" />
                  <h3 className="text-base font-bold text-gray-800 tracking-tight mb-1">{t('observeMode')}</h3>
                  <p className="text-xs text-gray-400">{t('observeDesc')}</p>
                </button>
              </div>
            </div>

            {/* RIGHT: User info + Rankings */}
            <div className="space-y-4">
              {/* User info card */}
              <div className="bg-white/70 rounded-[2rem] border border-white shadow-sm p-6 backdrop-blur-md">
                <div className="flex items-center gap-4 mb-4">
                  <div className="w-12 h-12 bg-emerald-100 rounded-full flex items-center justify-center font-bold text-emerald-700 text-xl shadow-inner border border-emerald-200">
                    {userData?.username?.[0]}
                  </div>
                  <div>
                    <div className="font-bold text-gray-800 flex items-center gap-2">
                      {userData?.username}
                      {userRank && <span className="text-xs bg-yellow-100 text-yellow-700 px-2 py-0.5 rounded-full font-bold">#{userRank}</span>}
                    </div>
                    <div className="flex items-center gap-1 mt-0.5">
                      <div className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse"></div>
                      <span className="text-xs text-emerald-600">{t('online')}</span>
                    </div>
                  </div>
                </div>
                <div className="grid grid-cols-3 gap-3 text-center">
                  <div className="bg-emerald-50 rounded-xl py-2">
                    <div className="text-lg font-bold text-emerald-700">{userData?.wins || 0}</div>
                    <div className="text-[10px] text-gray-400">{t('winsLabel')}</div>
                  </div>
                  <div className="bg-red-50 rounded-xl py-2">
                    <div className="text-lg font-bold text-red-600">{userData?.losses || 0}</div>
                    <div className="text-[10px] text-gray-400">{t('lossesLabel')}</div>
                  </div>
                  <div className="bg-blue-50 rounded-xl py-2">
                    <div className="text-lg font-bold text-blue-600">
                      {userData?.totalGames > 0 ? ((userData.wins / userData.totalGames) * 100).toFixed(0) : 0}%
                    </div>
                    <div className="text-[10px] text-gray-400">Win%</div>
                  </div>
                </div>
              </div>

              {/* Rankings */}
              <div className="bg-white/70 rounded-[2rem] border border-white shadow-sm p-6 backdrop-blur-md">
                <h3 className="text-sm font-bold text-gray-800 flex items-center gap-2 mb-6">
                  <Trophy size={18} className="text-yellow-500" /> {t('hallOfFame')}
                </h3>
                <div className="space-y-4">
                  {leaderboard.length === 0 ? (
                    <p className="text-gray-400 text-xs text-center py-2">{t('noRecords')}</p>
                  ) : leaderboard.map((player, i) => (
                    <div key={player.uid} className={`flex justify-between items-center group w-full rounded-xl px-2 py-1 ${player.uid === userData?.uid ? 'bg-emerald-50' : ''}`}>
                      <div className="flex items-center gap-3 flex-1 min-w-0">
                        <span className={`text-xs w-6 h-6 flex items-center justify-center rounded-full font-bold shrink-0 ${i === 0 ? 'bg-yellow-100 text-yellow-700' : i === 1 ? 'bg-gray-200 text-gray-600' : i === 2 ? 'bg-orange-100 text-orange-600' : 'bg-gray-100 text-gray-500'}`}>{i + 1}</span>
                        <span className={`font-medium text-sm truncate ${player.uid === userData?.uid ? 'text-emerald-700 font-bold' : 'text-gray-600'}`}>{player.username}</span>
                      </div>
                      <div className="flex items-center gap-2 ml-2 shrink-0">
                        <span className="text-[10px] text-gray-400">{player.wins}{t('winsLabel')}</span>
                        <span className="font-semibold text-emerald-500 text-xs">{player.totalGames > 0 ? ((player.wins / player.totalGames) * 100).toFixed(0) : 0}%</span>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* === OBSERVE SEARCH === */}
      {view === 'observeSearch' && (
        <div className="relative z-10 min-h-screen flex items-center justify-center">
          <div className="text-center bg-white/60 backdrop-blur-md p-16 rounded-[4rem] border border-white shadow-xl max-w-md w-full">
            <div className="mb-8 inline-flex p-6 bg-indigo-50 rounded-full text-indigo-500 border border-indigo-100 shadow-sm">
              <Eye size={48} strokeWidth={1.5} />
            </div>
            <h2 className="text-3xl font-bold text-gray-800 tracking-tight mb-2">{t('observeMode')}</h2>
            <p className="text-gray-400 text-sm mb-8">{t('observeDesc')}</p>
            {error && <p className="text-red-500 text-sm mb-4">{error}</p>}
            <div className="space-y-4">
              <input
                type="text"
                value={observeUsername}
                onChange={(e) => setObserveUsername(e.target.value.slice(0, 12))}
                placeholder={t('enterUsernameToObserve')}
                className="w-full bg-white border border-gray-200 rounded-xl py-4 px-6 focus:ring-2 focus:ring-indigo-400 outline-none text-gray-800 transition-all placeholder:text-gray-400 shadow-sm"
                onKeyDown={(e) => e.key === 'Enter' && handleObserveSearch()}
              />
              <button onClick={handleObserveSearch} className="w-full py-4 bg-indigo-500 hover:bg-indigo-600 rounded-xl font-semibold text-white transition-all shadow-md transform active:scale-[0.98] text-base">
                {t('startObserve')}
              </button>
              <button onClick={() => { setError(''); setView('lobby'); }} className="w-full py-3 bg-gray-100 text-gray-600 hover:bg-gray-200 rounded-xl text-sm font-semibold transition-all">
                {t('cancelSearch')}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* === OBSERVE GAME === */}
      {view === 'observe' && observeGameId && (
        <div className="relative z-10 min-h-screen flex flex-col items-center py-10">
          <header className="w-full max-w-6xl px-8 flex justify-between items-center mb-8">
            <button onClick={() => setView('lobby')} className="px-6 py-3 bg-white/80 rounded-xl text-sm font-semibold text-gray-600 hover:text-gray-900 border border-white hover:border-gray-200 transition-all shadow-sm">
              {t('observeBack')}
            </button>
            <div className="text-center">
              <div className="text-xs font-semibold text-indigo-500 mb-1">{t('observing')}</div>
              <div className="text-2xl font-bold tracking-tight text-gray-800">{t('observeMode')}</div>
            </div>
            <div className="w-[130px]"></div>
          </header>
          <div className="flex-1 flex items-center justify-center w-full">
            <ObserveBoard gameId={observeGameId} />
          </div>
        </div>
      )}

      {/* === FRIEND MATCH === */}
      {view === 'friendMatch' && (
        <div className="relative z-10 min-h-screen flex items-center justify-center">
          <div className="text-center bg-white/60 backdrop-blur-md p-16 rounded-[4rem] border border-white shadow-xl max-w-md w-full">
            <div className="mb-8 inline-flex p-6 bg-blue-50 rounded-full text-blue-500 border border-blue-100 shadow-sm">
              <Users size={48} strokeWidth={1.5} />
            </div>
            <h2 className="text-3xl font-bold text-gray-800 tracking-tight mb-2">{t('friendMatch')}</h2>
            <p className="text-gray-400 text-sm mb-8">{t('friendMatchNote')}</p>
            {error && <p className="text-red-500 text-sm mb-4">{error}</p>}
            <div className="space-y-4">
              <input
                type="text"
                value={friendUsername}
                onChange={(e) => setFriendUsername(e.target.value)}
                placeholder={t('enterUsername')}
                className="w-full bg-white border border-gray-200 rounded-xl py-4 px-6 focus:ring-2 focus:ring-blue-400 outline-none text-gray-800 transition-all placeholder:text-gray-400 shadow-sm"
                onKeyDown={(e) => e.key === 'Enter' && sendFriendInvite()}
              />
              <button
                onClick={sendFriendInvite}
                className="w-full py-4 bg-blue-500 hover:bg-blue-600 rounded-xl font-semibold text-white transition-all shadow-md transform active:scale-[0.98] text-base"
              >
                {t('sendInvite')}
              </button>
              <button
                onClick={() => { setError(''); setView('lobby'); }}
                className="w-full py-3 bg-gray-100 text-gray-600 hover:bg-gray-200 rounded-xl text-sm font-semibold transition-all"
              >
                {t('cancelSearch')}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* === FRIEND MATCH WAITING === */}
      {view === 'friendMatchWaiting' && (
        <div className="relative z-10 min-h-screen flex items-center justify-center">
          <div className="text-center bg-white/60 backdrop-blur-md p-16 rounded-[4rem] border border-white shadow-xl">
            <div className="relative mb-12 inline-block">
              <div className="absolute inset-0 border-[2px] border-blue-200 rounded-full animate-ping scale-150 opacity-50"></div>
              <div className="bg-white p-8 rounded-full text-blue-500 relative z-10 border border-blue-100 shadow-md">
                <Users size={50} />
              </div>
            </div>
            <h2 className="text-3xl font-bold text-gray-800 tracking-tight mb-4">{t('friendMatch')}</h2>
            <p className="text-gray-500 font-medium text-sm mb-8">{t('inviteWaiting')}</p>
            <button
              onClick={cancelFriendInvite}
              className="px-8 py-3 bg-gray-100 text-gray-600 hover:bg-gray-200 rounded-xl text-sm font-semibold transition-all"
            >
              {t('cancelInvite')}
            </button>
          </div>
        </div>
      )}

      {/* === MATCHMAKING === */}
      {view === 'matchmaking' && (
        <div className="relative z-10 min-h-screen flex items-center justify-center">
          <div className="text-center bg-white/60 backdrop-blur-md p-16 rounded-[4rem] border border-white shadow-xl">
             <div className="relative mb-12 inline-block">
               <div className="absolute inset-0 border-[2px] border-emerald-200 rounded-full animate-ping scale-150 opacity-50"></div>
               <div className="bg-white p-8 rounded-full text-emerald-500 relative z-10 border border-emerald-100 shadow-md">
                 <RefreshCw size={50} className="animate-spin" />
               </div>
             </div>
             <h2 className="text-3xl font-bold text-gray-800 tracking-tight mb-4">{t('searchingOpponent')}</h2>
             <p className="text-gray-500 font-medium text-sm mb-6">{matchmakingStatus}</p>

             <div className="flex items-center justify-center gap-4 mb-10">
               <div className="inline-flex items-center gap-3 bg-white px-6 py-3 rounded-full border border-emerald-100 text-gray-700 font-medium shadow-sm">
                 <Clock size={18} className="text-emerald-500" />
                 <span>{elapsedTime}{t('elapsed')}</span>
               </div>
               <div className="inline-flex items-center gap-2 bg-emerald-50 px-4 py-3 rounded-full border border-emerald-100 text-emerald-700 font-medium shadow-sm text-sm">
                 <span>{t('toleranceRange')}: {Math.min(Math.floor(elapsedTime / 2) * 10, 100)}%</span>
               </div>
             </div>

             <div>
               <button
                 onClick={cancelMatchmaking}
                 className="px-8 py-3 bg-gray-100 text-gray-600 hover:bg-gray-200 rounded-xl text-sm font-semibold transition-all"
               >
                 {t('cancelSearch')}
               </button>
             </div>
          </div>
        </div>
      )}

      {/* === GAME === */}
      {view === 'game' && (
        <div className="relative z-10 min-h-screen flex flex-col items-center py-10">
          <header className="w-full max-w-6xl px-8 flex justify-between items-center mb-8">
             <button onClick={handleLeaveGame} className="px-6 py-3 bg-white/80 rounded-xl text-sm font-semibold text-gray-600 hover:text-gray-900 border border-white hover:border-gray-200 transition-all shadow-sm">
               {t('returnToLobby')}
             </button>
             <div className="text-center">
               <div className="text-xs font-semibold text-emerald-500 mb-1">{t('combatArena')}</div>
               <div className="text-2xl font-bold tracking-tight text-gray-800">{t('gameBoard')}</div>
             </div>
             <div className="w-[130px]"></div>
          </header>
          <div className="flex-1 flex items-center justify-center w-full">
            <GameBoard game={currentGame} />
          </div>
        </div>
      )}

      {/* === GAME HISTORY === */}
      {view === 'history' && (
        <div className="relative z-10 min-h-screen p-8 md:p-16 max-w-4xl mx-auto">
          <header className="flex justify-between items-center mb-10">
            <div>
              <h1 className="text-4xl font-bold tracking-tight text-gray-800">{t('gameHistory')}</h1>
            </div>
            <button onClick={() => setView('lobby')} className="px-6 py-3 bg-white/80 rounded-xl text-sm font-semibold text-gray-600 hover:text-gray-900 border border-white hover:border-gray-200 transition-all shadow-sm">
              {t('returnToLobby')}
            </button>
          </header>

          {/* Win rate graph (oldest→newest, left→right) */}
          {gameHistoryList.length >= 2 && (() => {
            const sorted = [...gameHistoryList].reverse(); // oldest first
            let wins = 0;
            const points = sorted.map((g, i) => {
              if (g.result === 'win') wins++;
              return { x: i, rate: Math.round((wins / (i + 1)) * 100) };
            });
            const W = 600, H = 120, PAD = 16;
            const xStep = (W - PAD * 2) / Math.max(points.length - 1, 1);
            const toX = (i) => PAD + i * xStep;
            const toY = (r) => PAD + (H - PAD * 2) * (1 - r / 100);
            const polyline = points.map(p => `${toX(p.x).toFixed(1)},${toY(p.rate).toFixed(1)}`).join(' ');
            const lastPt = points[points.length - 1];
            return (
              <div className="mb-6 bg-white/80 rounded-2xl border border-white shadow-sm p-5">
                <div className="flex justify-between items-center mb-3">
                  <span className="text-xs font-semibold text-gray-500 uppercase tracking-wider">Win Rate Trend</span>
                  <span className="text-sm font-bold text-emerald-600">{lastPt?.rate ?? 0}%</span>
                </div>
                <svg width="100%" viewBox={`0 0 ${W} ${H}`} className="overflow-visible">
                  {/* Grid lines */}
                  {[0, 25, 50, 75, 100].map(r => (
                    <g key={r}>
                      <line x1={PAD} y1={toY(r)} x2={W - PAD} y2={toY(r)} stroke="#e5e7eb" strokeWidth="1" />
                      <text x={PAD - 4} y={toY(r) + 4} textAnchor="end" fontSize="9" fill="#9ca3af">{r}%</text>
                    </g>
                  ))}
                  {/* Area fill */}
                  <polygon
                    points={`${toX(0).toFixed(1)},${H - PAD} ${polyline} ${toX(points.length - 1).toFixed(1)},${H - PAD}`}
                    fill="rgba(16,185,129,0.08)"
                  />
                  {/* Line */}
                  <polyline points={polyline} fill="none" stroke="#10b981" strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />
                  {/* Last point dot */}
                  <circle cx={toX(lastPt.x)} cy={toY(lastPt.rate)} r="4" fill="#10b981" />
                </svg>
              </div>
            );
          })()}

          <div className="space-y-4">
            {gameHistoryList.length === 0 ? (
              <div className="text-center py-20 bg-white/60 rounded-[3rem] border border-white">
                <History size={48} className="text-gray-300 mx-auto mb-4" />
                <p className="text-gray-400 text-sm">{t('noGames')}</p>
              </div>
            ) : gameHistoryList.map((game) => (
              <div
                key={game.id}
                onClick={() => game.moves.length > 0 ? viewReplay(game) : null}
                className={`flex items-center justify-between p-6 bg-white/80 rounded-2xl border border-white shadow-sm transition-all ${game.moves.length > 0 ? 'cursor-pointer hover:shadow-md hover:border-emerald-100' : ''}`}
              >
                <div className="flex items-center gap-4">
                  <div className={`w-10 h-10 rounded-full flex items-center justify-center text-sm font-bold ${
                    game.result === 'win' ? 'bg-emerald-100 text-emerald-700' : 'bg-red-100 text-red-600'
                  }`}>
                    {game.result === 'win' ? 'W' : 'L'}
                  </div>
                  <div>
                    <div className="font-bold text-gray-800">
                      vs {game.opponentName || 'AI'}
                    </div>
                    <div className="text-xs text-gray-400 flex items-center gap-2 mt-1">
                      <span className={`px-2 py-0.5 rounded-full text-[10px] font-semibold ${
                        game.mode === 'friendly' ? 'bg-blue-50 text-blue-600' : 'bg-emerald-50 text-emerald-600'
                      }`}>
                        {game.mode === 'friendly' ? t('friendly') : t('ranked')}
                      </span>
                      {game.winReason === 'timeout' && <span className="text-amber-500">{t('timeout')}</span>}
                      {game.date && <span>{game.date}</span>}
                    </div>
                  </div>
                </div>
                <div className="flex items-center gap-3">
                  {game.moves.length > 0 && (
                    <span className="text-xs text-gray-400">{game.moves.length} {t('moveOf')}</span>
                  )}
                  {game.moves.length > 0 && <ChevronRight size={18} className="text-gray-400" />}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* === REPLAY === */}
      {view === 'replay' && replayGame && (
        <div className="relative z-10 min-h-screen flex flex-col items-center py-10">
          <header className="w-full max-w-6xl px-8 flex justify-between items-center mb-8">
            <button onClick={() => setView('history')} className="px-6 py-3 bg-white/80 rounded-xl text-sm font-semibold text-gray-600 hover:text-gray-900 border border-white hover:border-gray-200 transition-all shadow-sm">
              <ChevronLeft size={16} className="inline" /> {t('backToHistory')}
            </button>
            <div className="text-center">
              <div className="text-xs font-semibold text-emerald-500 mb-1">{t('replay')}</div>
              <div className="text-2xl font-bold tracking-tight text-gray-800">
                {replayGame.result === 'win' ? t('win') : t('loss')}
              </div>
            </div>
            <div className="w-[130px]"></div>
          </header>
          <div className="flex-1 flex items-center justify-center w-full">
            <ReplayBoard game={replayGame} />
          </div>
        </div>
      )}

      {/* === OPPONENT LEFT NOTIFICATION === */}
      {opponentLeftMsg && (
        <div className="fixed inset-0 z-[200] flex items-center justify-center bg-gray-900/50 backdrop-blur-sm">
          <div className="bg-white rounded-3xl p-10 text-center shadow-2xl border border-gray-100 max-w-sm w-full mx-6">
            <div className="mb-4 text-4xl">🚪</div>
            <p className="text-xl font-bold text-gray-800 mb-2">{t('opponentLeftTitle')}</p>
            <p className="text-gray-500 text-sm">{t('opponentLeftMsg')}</p>
          </div>
        </div>
      )}

      {/* === WINNER MODAL === */}
      {winnerModal && (() => {
        const isWin = typeof winnerModal === 'object' ? winnerModal.isWinner : true;
        const modalText = typeof winnerModal === 'object' ? winnerModal.text : winnerModal;
        const isPvP = typeof winnerModal === 'object' && winnerModal.isPvP;
        const iRequestedRematch = typeof winnerModal === 'object' && winnerModal.iRequestedRematch;
        const opponentRequestedRematch = typeof winnerModal === 'object' && winnerModal.opponentRequestedRematch;

        const handleRematchRequest = async () => {
          if (!isPvP || iRequestedRematch) return;
          const gameRef = doc(db, 'artifacts', appId, 'games', winnerModal.gameId);
          try {
            const gameSnap = await getDoc(gameRef);
            if (!gameSnap.exists()) return;
            const data = gameSnap.data();
            const requests = data.rematchRequests || [];
            if (requests.includes(user.uid)) return;
            const newRequests = [...requests, user.uid];

            if (newRequests.length >= 2) {
              const oldP1 = data.player1;
              const oldP2 = data.player2;
              const newGameId = await createPvPGame(null, {
                player1: oldP2,
                player2: oldP1,
                friendMatch: data.friendMatch || false,
              });
              await updateDoc(gameRef, {
                rematchRequests: newRequests,
                rematchGameId: newGameId
              });
            } else {
              await updateDoc(gameRef, { rematchRequests: newRequests });
              setWinnerModal(prev => ({ ...prev, iRequestedRematch: true }));
            }
          } catch (err) {
            console.error('Rematch request failed:', err);
          }
        };

        return (
          <div className={`fixed inset-0 z-[100] backdrop-blur-md flex items-center justify-center p-6 ${isWin ? 'bg-white/60' : 'bg-gray-900/40'}`}>
            <div className={`p-16 rounded-[4rem] shadow-2xl text-center max-w-lg w-full relative overflow-hidden ${
              isWin
                ? 'bg-white border border-emerald-100'
                : 'bg-gray-50 border border-red-200'
            }`}>
              {isWin ? (
                <div className="mb-8 inline-flex p-8 bg-yellow-50 rounded-full text-yellow-500 shadow-sm border border-yellow-100">
                  <Trophy size={80} strokeWidth={1.5} />
                </div>
              ) : (
                <div className="mb-8 inline-flex p-8 bg-red-50 rounded-full text-red-400 shadow-sm border border-red-100">
                  <XCircle size={80} strokeWidth={1.5} />
                </div>
              )}
              <h2 className={`text-4xl font-bold mb-4 tracking-tight ${isWin ? 'text-gray-800' : 'text-gray-700'}`}>
                {isWin ? t('victory') : t('defeat')}
              </h2>
              <p className={`font-medium mb-8 text-lg leading-relaxed ${isWin ? 'text-gray-600' : 'text-gray-500'}`}>
                <span className={`block text-2xl mb-2 font-bold ${isWin ? 'text-emerald-600' : 'text-red-500'}`}>
                  {modalText}
                </span>
                {isWin ? t('victoryMessage') : t('defeatMessage')}
              </p>
              <div className="space-y-3">
                {isPvP && (
                  <button
                    onClick={handleRematchRequest}
                    disabled={iRequestedRematch}
                    className={`w-full py-5 font-bold rounded-2xl transition-all shadow-md transform active:scale-[0.98] text-lg ${
                      iRequestedRematch
                        ? 'bg-amber-100 text-amber-700 cursor-default'
                        : opponentRequestedRematch
                          ? 'bg-amber-500 hover:bg-amber-600 text-white animate-pulse'
                          : 'bg-blue-500 hover:bg-blue-600 text-white'
                    }`}
                  >
                    <div className="flex items-center justify-center gap-2">
                      <RefreshCw size={20} />
                      {iRequestedRematch
                        ? t('rematchWaiting')
                        : opponentRequestedRematch
                          ? t('rematchAccept')
                          : t('rematchRequest')}
                    </div>
                  </button>
                )}
                <button
                  onClick={() => {
                    if (isPvP && winnerModal.gameId) {
                      const gameRef = doc(db, 'artifacts', appId, 'games', winnerModal.gameId);
                      getDoc(gameRef).then(snap => {
                        if (snap.exists()) {
                          const left = snap.data().leftPlayers || [];
                          if (!left.includes(user.uid)) {
                            updateDoc(gameRef, { leftPlayers: [...left, user.uid] }).catch(() => {});
                          }
                        }
                      }).catch(() => {});
                    }
                    clearActiveGame();
                    setWinnerModal(null); setView('lobby'); fetchLeaderboard();
                  }}
                  className={`w-full py-5 font-bold rounded-2xl transition-all shadow-md transform active:scale-[0.98] text-lg ${
                    isWin
                      ? 'bg-emerald-500 hover:bg-emerald-600 text-white'
                      : 'bg-gray-700 hover:bg-gray-800 text-white'
                  }`}
                >
                  {t('returnToLobbyButton')}
                </button>
              </div>
            </div>
          </div>
        );
      })()}
      <SpeedInsights />
      <Analytics />
    </div>
  );
};

export default App;
