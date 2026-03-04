import React, { useState, useEffect, useRef, useCallback } from 'react';
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
  limit as firestoreLimit,
  serverTimestamp,
  runTransaction
} from 'firebase/firestore';
import { Trophy, Play, Cpu, Shield, LogOut, RefreshCw, TreePine, Clock, UserPlus, Copy, Check, XCircle, Timer } from 'lucide-react';
import { SpeedInsights } from '@vercel/speed-insights/react';

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

const App = () => {
  const [user, setUser] = useState(null);
  const [view, setView] = useState('login');
  const [userData, setUserData] = useState(null);
  const [currentGame, setCurrentGame] = useState(null);
  const [matchmakingStatus, setMatchmakingStatus] = useState("");
  const [elapsedTime, setElapsedTime] = useState(0);
  const [error, setError] = useState("");
  const [winnerModal, setWinnerModal] = useState(null);
  const [loginMode, setLoginMode] = useState('login'); // 'login' | 'register'
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [autoCredentials, setAutoCredentials] = useState(null); // { id, pw }
  const [copied, setCopied] = useState(false);
  const [leaderboard, setLeaderboard] = useState([]);
  const [gameMode, setGameMode] = useState(null); // 'ai' | 'pvp'
  const [playerNumber, setPlayerNumber] = useState(0); // 1 or 2
  const matchmakingCleanup = useRef(null);
  const gameResultHandled = useRef(false); // prevent double stats update

  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, (u) => {
      setUser(u);
      if (u) {
        fetchUserData(u.uid);
        setView('lobby');
      } else {
        setView('login');
      }
    });
    return () => unsubscribe();
  }, []);

  const fetchUserData = async (uid) => {
    const userDoc = await getDoc(doc(db, 'artifacts', appId, 'users', uid, 'profile', 'data'));
    if (userDoc.exists()) {
      setUserData(userDoc.data());
    } else {
      const newData = {
        uid,
        username: "숲의여행자_" + uid.slice(0, 4),
        wins: 0,
        losses: 0,
        totalGames: 0,
        winRate: 0,
      };
      await setDoc(doc(db, 'artifacts', appId, 'users', uid, 'profile', 'data'), newData);
      // Also write to flat leaderboard collection for ranking queries
      await setDoc(doc(db, 'artifacts', appId, 'leaderboard', uid), newData);
      setUserData(newData);
    }
    fetchLeaderboard();
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

  const updatePlayerStats = async (winnerUid, loserUid) => {
    if (gameResultHandled.current) return;
    gameResultHandled.current = true;
    try {
      // Use transaction to atomically update winner stats
      const winnerProfileRef = doc(db, 'artifacts', appId, 'users', winnerUid, 'profile', 'data');
      const winnerLeaderRef = doc(db, 'artifacts', appId, 'leaderboard', winnerUid);
      const loserProfileRef = doc(db, 'artifacts', appId, 'users', loserUid, 'profile', 'data');
      const loserLeaderRef = doc(db, 'artifacts', appId, 'leaderboard', loserUid);

      await runTransaction(db, async (transaction) => {
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
        const lRate = lTotal > 0 ? Math.round((lWins / lTotal) * 100) : 0;

        const winnerUpdate = { wins: wWins, totalGames: wTotal, winRate: wRate };
        const loserUpdate = { losses: lLosses, totalGames: lTotal, winRate: lRate };

        transaction.update(winnerProfileRef, winnerUpdate);
        transaction.update(winnerLeaderRef, winnerUpdate);
        transaction.update(loserProfileRef, loserUpdate);
        transaction.update(loserLeaderRef, loserUpdate);
      });

      // Refresh local userData if current user was involved
      if (user?.uid === winnerUid || user?.uid === loserUid) {
        fetchUserData(user.uid);
      }
    } catch (err) {
      console.error('Stats update failed:', err);
    }
  };

  const handleAutoRegister = async () => {
    if (isSubmitting) return;
    setIsSubmitting(true);
    setError("");
    const generateSecureString = (length) => {
      const array = new Uint8Array(length);
      window.crypto.getRandomValues(array);
      return Array.from(array, byte => byte.toString(16).padStart(2, '0')).join('').slice(0, length);
    };

    const id = `forest_${generateSecureString(6)}`;
    const pw = generateSecureString(12);

    try {
      const email = `${id}@forest6.com`;
      await createUserWithEmailAndPassword(auth, email, pw);
      await auth.signOut();
      setAutoCredentials({ id, pw });
      setLoginMode('credentials');
    } catch (err) {
      setError("가입 실패: " + err.message);
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleManualRegister = async (e) => {
    e.preventDefault();
    if (isSubmitting) return;
    setError("");

    const id = e.target.regId.value.trim();
    const pw = e.target.regPw.value;
    const pwConfirm = e.target.regPwConfirm.value;

    // ID validation: alphanumeric and underscores only, 3-20 chars
    if (!/^[a-zA-Z0-9_]{3,20}$/.test(id)) {
      setError("아이디는 영문, 숫자, 밑줄(_)만 사용 가능하며 3~20자여야 합니다.");
      return;
    }

    // Password strength: minimum 8 chars
    if (pw.length < 8) {
      setError("비밀번호는 최소 8자 이상이어야 합니다.");
      return;
    }

    if (pw !== pwConfirm) {
      setError("비밀번호가 일치하지 않습니다.");
      return;
    }

    setIsSubmitting(true);
    try {
      const email = `${id}@forest6.com`;
      await createUserWithEmailAndPassword(auth, email, pw);
    } catch (err) {
      if (err.code === 'auth/email-already-in-use') {
        setError("이미 사용 중인 아이디입니다.");
      } else {
        setError("가입 실패: " + err.message);
      }
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleManualLogin = async (e) => {
    e.preventDefault();
    if (isSubmitting) return;
    setIsSubmitting(true);
    setError("");
    const email = e.target.id.value.trim() + "@forest6.com";
    const pw = e.target.pw.value;
    try {
      await signInWithEmailAndPassword(auth, email, pw);
    } catch (err) {
      setError("로그인 실패. 아이디나 비밀번호를 확인하세요.");
    } finally {
      setIsSubmitting(false);
    }
  };

  const cancelMatchmaking = useCallback(() => {
    if (matchmakingCleanup.current) {
      matchmakingCleanup.current();
      matchmakingCleanup.current = null;
    }
    setView('lobby');
  }, []);

  // Calculate tolerance from elapsed seconds: +10% every 2 seconds, max 100%
  const calcTolerance = (elapsedSec) => Math.min(Math.floor(elapsedSec / 2) * 10, 100);

  // Core matching logic — shared by both onSnapshot and polling fallback
  const tryMatchOpponents = (docs, poolCollectionPath, poolRef, myWinRate, myTotalGames, startTime, stopAll) => {
    const now = Date.now();
    const myElapsed = Math.floor((now - startTime) / 1000);
    const myTolerance = calcTolerance(myElapsed);

    const allOpponents = docs.filter(d => d.id !== user.uid && !d.data().gameId);

    // Filter: match if EITHER player's tolerance covers the win-rate difference
    const winRateDiff = (oppData) => Math.abs((oppData.winRate || 0) - myWinRate);
    const matchable = allOpponents.filter(d => {
      const diff = winRateDiff(d.data());
      const oppElapsed = d.data().enteredAt ? Math.floor((now - d.data().enteredAt) / 1000) : 0;
      const oppTolerance = calcTolerance(oppElapsed);
      // Match if EITHER player's tolerance is wide enough
      return diff <= Math.max(myTolerance, oppTolerance);
    });

    if (matchable.length === 0) return false;

    // Tiered search: sort by closest totalGames count
    matchable.sort((a, b) => {
      const aDiff = Math.abs((a.data().totalGames || 0) - myTotalGames);
      const bDiff = Math.abs((b.data().totalGames || 0) - myTotalGames);
      return aDiff - bDiff;
    });

    const opponent = matchable[0];

    // Only the player with the smaller UID creates the game (avoid duplicates)
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
      setMatchmakingStatus("상대를 발견! 연결 중...");
      return false;
    }
  };

  const startMatchmaking = () => {
    setView('matchmaking');
    setMatchmakingStatus("숲 속에서 대전 상대를 찾는 중... (허용 승률차: 0%)");
    setElapsedTime(0);
    const startTime = Date.now();
    let stopped = false;

    const myWinRate = userData?.totalGames > 0
      ? (userData.wins / userData.totalGames) * 100
      : 0;
    const myTotalGames = userData?.totalGames || 0;

    const poolCollectionPath = collection(db, 'artifacts', appId, 'matchmaking_pool');
    const poolRef = doc(poolCollectionPath, user.uid);

    // 1) Start timer FIRST — completely independent of Firebase
    const timerInterval = setInterval(() => {
      if (stopped) return;
      const elapsed = Math.floor((Date.now() - startTime) / 1000);
      setElapsedTime(elapsed);
      const tolerance = calcTolerance(elapsed);
      setMatchmakingStatus(`숲 속에서 대전 상대를 찾는 중... (허용 승률차: ${tolerance}%)`);
    }, 1000);

    // 2) Timeout fallback → AI game after 30 seconds
    const timeoutId = setTimeout(() => {
      if (stopped) return;
      stopAll();
      deleteDoc(poolRef).catch(() => {});
      startComputerGame();
    }, MATCH_TIMEOUT);

    // Helper to stop everything
    let unsubPool = null;
    let pollInterval = null;
    const stopAll = () => {
      stopped = true;
      clearInterval(timerInterval);
      clearInterval(pollInterval);
      clearTimeout(timeoutId);
      if (unsubPool) unsubPool();
      matchmakingCleanup.current = null;
    };

    // 3) Try onSnapshot for real-time detection
    let snapshotWorking = false;
    unsubPool = onSnapshot(poolCollectionPath, (snapshot) => {
      if (stopped) return;
      snapshotWorking = true;

      // Check if we've been matched by someone else
      const myDoc = snapshot.docs.find(d => d.id === user.uid);
      if (myDoc && myDoc.data().gameId) {
        stopAll();
        deleteDoc(poolRef).catch(() => {});
        joinPvPGame(myDoc.data().gameId);
        return;
      }

      tryMatchOpponents(snapshot.docs, poolCollectionPath, poolRef, myWinRate, myTotalGames, startTime, stopAll);
    }, (err) => {
      console.warn('Pool onSnapshot failed, using polling fallback:', err);
    });

    // 4) Polling fallback — in case onSnapshot fails (e.g. security rules)
    pollInterval = setInterval(async () => {
      if (stopped || snapshotWorking) return;
      try {
        const snapshot = await getDocs(poolCollectionPath);
        if (stopped) return;

        // Check if we've been matched
        const myDoc = snapshot.docs.find(d => d.id === user.uid);
        if (myDoc && myDoc.data().gameId) {
          stopAll();
          deleteDoc(poolRef).catch(() => {});
          joinPvPGame(myDoc.data().gameId);
          return;
        }

        tryMatchOpponents(snapshot.docs, poolCollectionPath, poolRef, myWinRate, myTotalGames, startTime, stopAll);
      } catch (err) {
        console.warn('Matchmaking poll error:', err);
      }
    }, 2500);

    // 5) Write to pool LAST (non-blocking)
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
      setMatchmakingStatus("매칭 서버 연결 실패. AI 대전으로 전환합니다...");
      setTimeout(() => startComputerGame(), 1500);
    });

    // 6) Store cleanup for cancel button
    matchmakingCleanup.current = () => {
      stopAll();
      deleteDoc(poolRef).catch(() => {});
    };
  };

  const createPvPGame = async (opponentData) => {
    const gameRef = doc(collection(db, 'artifacts', appId, 'games'));
    await setDoc(gameRef, {
      player1: { uid: user.uid, username: userData?.username },
      player2: { uid: opponentData.uid, username: opponentData.username },
      board: Array(BOARD_SIZE * BOARD_SIZE).fill(0),
      turn: 1,
      moveCount: 0,
      turnMoves: 0,
      status: 'active',
      winner: null,
      loser: null,
      winReason: null, // 'connect6' | 'timeout'
      lastMoveAt: Date.now(),
      createdAt: serverTimestamp()
    });
    return gameRef.id;
  };

  const joinPvPGame = (gameId) => {
    gameResultHandled.current = false;
    setGameMode('pvp');
    setCurrentGame({ id: gameId, mode: 'pvp' });
    setWinnerModal(null);
    setView('game');
  };

  const startComputerGame = () => {
    setGameMode('ai');
    setCurrentGame({
      id: 'forest_ai_' + Date.now(),
      mode: 'ai',
      board: Array(BOARD_SIZE * BOARD_SIZE).fill(0),
      turn: 1,
      moveCount: 0,
      turnMoves: 0,
      status: 'active'
    });
    setWinnerModal(null);
    setView('game');
  };

  const GameBoard = ({ game }) => {
    const [board, setBoard] = useState(game.board || Array(BOARD_SIZE * BOARD_SIZE).fill(0));
    const [turn, setTurn] = useState(game.turn || 1);
    const [turnMoves, setTurnMoves] = useState(0);
    const [moveCount, setMoveCount] = useState(game.moveCount || 0);
    const [myPlayerNum, setMyPlayerNum] = useState(0);
    const [opponentName, setOpponentName] = useState('');
    const [isMyTurn, setIsMyTurn] = useState(false);
    const [turnTimeLeft, setTurnTimeLeft] = useState(TURN_TIME_LIMIT);
    const [gameFinished, setGameFinished] = useState(false);
    const moveCountRef = useRef(game.moveCount || 0);
    const lastMoveAtRef = useRef(Date.now());
    const turnTimerRef = useRef(null);
    const timeoutClaimRef = useRef(false);

    // PvP turn timer countdown
    useEffect(() => {
      if (game.mode !== 'pvp' || gameFinished) return;
      turnTimerRef.current = setInterval(() => {
        const elapsed = Math.floor((Date.now() - lastMoveAtRef.current) / 1000);
        const remaining = Math.max(0, TURN_TIME_LIMIT - elapsed);
        setTurnTimeLeft(remaining);

        // If it's our turn and time ran out, we lose via timeout
        if (remaining === 0 && isMyTurn && !timeoutClaimRef.current && !gameFinished) {
          timeoutClaimRef.current = true;
          clearInterval(turnTimerRef.current);
          const gameRef = doc(db, 'artifacts', appId, 'games', game.id);
          updateDoc(gameRef, {
            status: 'finished',
            winner: myPlayerNum === 1 ? 'player2' : 'player1',
            loser: user.uid,
            winReason: 'timeout'
          }).catch(err => console.error('Timeout update failed:', err));
        }
      }, 200);
      return () => clearInterval(turnTimerRef.current);
    }, [game.mode, game.id, isMyTurn, myPlayerNum, gameFinished]);

    // PvP: subscribe to game doc for real-time sync
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

        // Reset turn timer when lastMoveAt changes
        if (data.lastMoveAt) {
          lastMoveAtRef.current = data.lastMoveAt;
          setTurnTimeLeft(TURN_TIME_LIMIT);
          timeoutClaimRef.current = false;
        }

        const pNum = data.player1.uid === user.uid ? 1 : 2;
        setMyPlayerNum(pNum);
        setIsMyTurn(data.turn === pNum && data.status === 'active');
        setOpponentName(pNum === 1 ? data.player2.username : data.player1.username);

        if (data.status === 'finished') {
          setGameFinished(true);
          clearInterval(turnTimerRef.current);

          // Determine winner/loser UIDs
          let winnerUid, loserUid, winnerName;
          if (data.winReason === 'timeout') {
            // timeout: winner field is 'player1' or 'player2' reference
            winnerUid = data.winner === 'player1' ? data.player1.uid : data.player2.uid;
            loserUid = data.loser;
            winnerName = data.winner === 'player1' ? data.player1.username : data.player2.username;
          } else {
            // connect6 win: winner field is the UID directly
            winnerUid = data.winner;
            loserUid = winnerUid === data.player1.uid ? data.player2.uid : data.player1.uid;
            winnerName = winnerUid === data.player1.uid ? data.player1.username : data.player2.username;
          }

          const iWon = winnerUid === user.uid;
          const reasonText = data.winReason === 'timeout' ? ' (시간 초과)' : '';

          if (iWon) {
            setWinnerModal({ text: '나의 승리!' + reasonText, isWinner: true });
          } else {
            setWinnerModal({ text: `${winnerName} 승리${reasonText}`, isWinner: false });
          }

          // Only the winner updates stats (prevents double-counting)
          if (iWon && winnerUid && loserUid) {
            updatePlayerStats(winnerUid, loserUid);
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

    const handleCellClick = async (idx) => {
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
          // Reset timer on turn switch or game end
          ...(turnSwitching || won ? { lastMoveAt: Date.now() } : {}),
          ...(won ? {
            status: 'finished',
            winner: user.uid,
            winReason: 'connect6'
          } : {})
        });
        return;
      }

      // AI mode
      const newBoard = [...board];
      newBoard[idx] = turn;

      if (checkWin(idx, turn, newBoard)) {
        setBoard(newBoard);
        setWinnerModal({ text: turn === 1 ? "흑돌 승리!" : "백돌 승리!", isWinner: turn === 1 });
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

      if (nextTurn === 2) {
        setTimeout(() => triggerAiMove(newBoard, 2, nextTurnMoves), 600);
      }
    };

    const triggerAiMove = (currentBoard, aiPlayer, currentAiTurnMoves) => {
      if (winnerModal) return;
      const emptyIndices = currentBoard.map((c, i) => c === 0 ? i : -1).filter(i => i !== -1);
      if (emptyIndices.length === 0) return;
      const aiIdx = emptyIndices[Math.floor(Math.random() * emptyIndices.length)];

      const newBoard = [...currentBoard];
      newBoard[aiIdx] = aiPlayer;

      if (checkWin(aiIdx, aiPlayer, newBoard)) {
        setBoard(newBoard);
        setWinnerModal({ text: "컴퓨터(AI) 승리", isWinner: false });
        return;
      }

      let nextTurn = aiPlayer;
      let nextTurnMoves = currentAiTurnMoves + 1;
      moveCountRef.current++;
      if (nextTurnMoves === 2) {
        nextTurn = 1;
        nextTurnMoves = 0;
      }
      setBoard(newBoard);
      setTurn(nextTurn);
      setTurnMoves(nextTurnMoves);
      setMoveCount(moveCountRef.current);
      if (nextTurn === 2) setTimeout(() => triggerAiMove(newBoard, 2, nextTurnMoves), 600);
    };

    const BOARD_PX = 600;
    const CELL_SIZE = BOARD_PX / (BOARD_SIZE - 1);

    const timerPercent = (turnTimeLeft / TURN_TIME_LIMIT) * 100;
    const timerColor = turnTimeLeft <= 5 ? 'bg-red-500' : turnTimeLeft <= 10 ? 'bg-yellow-500' : 'bg-emerald-500';
    const timerTextColor = turnTimeLeft <= 5 ? 'text-red-600' : turnTimeLeft <= 10 ? 'text-yellow-600' : 'text-emerald-600';

    return (
      <div className="flex flex-col items-center">
        <div className="mb-4 flex items-center gap-6 bg-white/70 backdrop-blur-md px-10 py-4 rounded-3xl border border-emerald-100 shadow-sm">
           <div className={`w-8 h-8 rounded-full shadow-md transition-all duration-500 transform ${turn === 1 ? 'bg-gray-800 scale-110' : 'bg-white scale-110 border border-gray-200'}`}></div>
           <div className="flex flex-col">
             <span className="text-gray-800 font-bold text-sm">
               {game.mode === 'pvp'
                 ? (isMyTurn ? "내 차례" : `${opponentName}의 차례`)
                 : (turn === 1 ? "흑돌 차례" : "백돌 차례")}
             </span>
             <div className="flex items-center gap-2 mt-1">
               <div className="flex gap-1">
                 <div className={`w-2 h-2 rounded-full ${turnMoves < 2 ? 'bg-emerald-500' : 'bg-gray-200'}`}></div>
                 <div className={`w-2 h-2 rounded-full ${moveCount === 0 || turnMoves < 1 ? 'bg-emerald-500' : 'bg-gray-200'}`}></div>
               </div>
               <span className="text-[10px] text-emerald-600 font-semibold uppercase">
                 {game.mode === 'pvp'
                   ? (isMyTurn ? 'Your Turn' : 'Waiting...')
                   : 'Ready to Move'}
               </span>
             </div>
           </div>
           {game.mode === 'pvp' && (
             <>
               <div className="ml-4 flex items-center gap-2 text-xs text-gray-500">
                 <div className={`w-3 h-3 rounded-full ${myPlayerNum === 1 ? 'bg-gray-800' : 'bg-white border border-gray-300'}`}></div>
                 <span>나</span>
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
        </div>

        {/* Turn timer bar for PvP */}
        {game.mode === 'pvp' && !gameFinished && (
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

      {view === 'login' && (
        <div className="relative z-10 min-h-screen flex items-center justify-center p-6">
          <div className="bg-white/80 backdrop-blur-xl p-12 rounded-[3rem] border border-white shadow-[0_20px_60px_rgba(0,0,0,0.04)] w-full max-w-md text-center">
            <div className="mb-8 inline-flex p-6 bg-emerald-50 rounded-full text-emerald-500 border border-emerald-100 shadow-sm">
              <TreePine size={48} strokeWidth={1.5} />
            </div>
            <h1 className="text-4xl font-bold tracking-tight mb-2 text-gray-800">FOREST 6</h1>
            <p className="text-emerald-600 mb-10 font-medium text-sm">지혜의 숲에 오신 것을 환영합니다</p>
            {error && <p className="text-red-500 text-sm mb-4">{error}</p>}

            {loginMode === 'credentials' ? (
              <div className="space-y-6">
                <div className="bg-emerald-50 border border-emerald-200 rounded-2xl p-6 text-left">
                  <p className="text-emerald-700 font-semibold text-sm mb-4">계정이 생성되었습니다! 아래 정보를 반드시 저장하세요.</p>
                  <div className="space-y-3">
                    <div className="flex items-center justify-between bg-white rounded-xl px-4 py-3 border border-gray-100">
                      <div>
                        <span className="text-xs text-gray-400 block">아이디</span>
                        <span className="text-gray-800 font-mono font-bold select-all">{autoCredentials?.id}</span>
                      </div>
                      <button onClick={() => { navigator.clipboard.writeText(autoCredentials?.id); setCopied('id'); setTimeout(() => setCopied(false), 1500); }} className="p-2 text-gray-400 hover:text-emerald-500 transition-colors">
                        {copied === 'id' ? <Check size={16} className="text-emerald-500" /> : <Copy size={16} />}
                      </button>
                    </div>
                    <div className="flex items-center justify-between bg-white rounded-xl px-4 py-3 border border-gray-100">
                      <div>
                        <span className="text-xs text-gray-400 block">비밀번호</span>
                        <span className="text-gray-800 font-mono font-bold select-all">{autoCredentials?.pw}</span>
                      </div>
                      <button onClick={() => { navigator.clipboard.writeText(autoCredentials?.pw); setCopied('pw'); setTimeout(() => setCopied(false), 1500); }} className="p-2 text-gray-400 hover:text-emerald-500 transition-colors">
                        {copied === 'pw' ? <Check size={16} className="text-emerald-500" /> : <Copy size={16} />}
                      </button>
                    </div>
                  </div>
                  <p className="text-xs text-red-500 mt-4 font-medium">이 정보는 다시 확인할 수 없습니다. 스크린샷이나 메모로 저장하세요!</p>
                </div>
                <button onClick={() => { setLoginMode('login'); setAutoCredentials(null); setCopied(false); }} className="w-full py-4 bg-emerald-500 hover:bg-emerald-600 rounded-xl font-semibold text-white transition-all shadow-md transform active:scale-[0.98] text-base">
                  로그인하러 가기
                </button>
              </div>
            ) : loginMode === 'login' ? (
              <>
                <form onSubmit={handleManualLogin} className="space-y-4">
                  <input id="id" type="text" placeholder="아이디" required className="w-full bg-white border border-gray-200 rounded-xl py-4 px-6 focus:ring-2 focus:ring-emerald-400 outline-none text-gray-800 transition-all placeholder:text-gray-400 shadow-sm" />
                  <input id="pw" type="password" placeholder="비밀번호" required className="w-full bg-white border border-gray-200 rounded-xl py-4 px-6 focus:ring-2 focus:ring-emerald-400 outline-none text-gray-800 transition-all placeholder:text-gray-400 shadow-sm" />
                  <button disabled={isSubmitting} className="w-full py-4 mt-2 bg-emerald-500 hover:bg-emerald-600 disabled:bg-emerald-300 rounded-xl font-semibold text-white transition-all shadow-md transform active:scale-[0.98] text-base">
                    {isSubmitting ? "접속 중..." : "입장하기"}
                  </button>
                </form>
                <div className="mt-6 flex flex-col gap-3">
                  <button onClick={() => { setLoginMode('register'); setError(""); }} className="text-gray-500 hover:text-emerald-600 text-sm font-medium transition-colors underline underline-offset-4 flex items-center justify-center gap-2">
                    <UserPlus size={14} /> 계정 생성
                  </button>
                  <button onClick={handleAutoRegister} disabled={isSubmitting} className="text-gray-400 hover:text-emerald-500 text-xs font-medium transition-colors underline underline-offset-4 disabled:text-gray-300">
                    {isSubmitting ? "생성 중..." : "수호자 자동 등록"}
                  </button>
                </div>
              </>
            ) : (
              <>
                <form onSubmit={handleManualRegister} className="space-y-4">
                  <input name="regId" type="text" placeholder="아이디 (영문, 숫자, 3~20자)" required className="w-full bg-white border border-gray-200 rounded-xl py-4 px-6 focus:ring-2 focus:ring-emerald-400 outline-none text-gray-800 transition-all placeholder:text-gray-400 shadow-sm" autoComplete="username" />
                  <input name="regPw" type="password" placeholder="비밀번호 (8자 이상)" required minLength={8} className="w-full bg-white border border-gray-200 rounded-xl py-4 px-6 focus:ring-2 focus:ring-emerald-400 outline-none text-gray-800 transition-all placeholder:text-gray-400 shadow-sm" autoComplete="new-password" />
                  <input name="regPwConfirm" type="password" placeholder="비밀번호 확인" required minLength={8} className="w-full bg-white border border-gray-200 rounded-xl py-4 px-6 focus:ring-2 focus:ring-emerald-400 outline-none text-gray-800 transition-all placeholder:text-gray-400 shadow-sm" autoComplete="new-password" />
                  <button disabled={isSubmitting} className="w-full py-4 mt-2 bg-emerald-500 hover:bg-emerald-600 disabled:bg-emerald-300 rounded-xl font-semibold text-white transition-all shadow-md transform active:scale-[0.98] text-base">
                    {isSubmitting ? "생성 중..." : "계정 생성"}
                  </button>
                </form>
                <button onClick={() => { setLoginMode('login'); setError(""); }} className="mt-6 text-gray-500 hover:text-emerald-600 text-sm font-medium transition-colors underline underline-offset-4">
                  로그인으로 돌아가기
                </button>
              </>
            )}
          </div>
        </div>
      )}

      {view === 'lobby' && (
        <div className="relative z-10 p-8 md:p-16 max-w-7xl mx-auto">
          <header className="flex flex-col md:flex-row justify-between items-start md:items-end mb-16 gap-6">
            <div>
              <span className="text-emerald-500 font-semibold tracking-wider text-xs uppercase mb-2 block">Forest Sanctuary Lobby</span>
              <h1 className="text-5xl font-bold tracking-tight text-gray-800">숲의 로비</h1>
            </div>
            <div className="flex items-center gap-6 bg-white/70 p-4 pr-8 rounded-full border border-white backdrop-blur-md shadow-sm">
               <div className="w-14 h-14 bg-emerald-100 rounded-full flex items-center justify-center font-bold text-emerald-700 text-2xl shadow-inner border border-emerald-200">
                 {userData?.username[0]}
               </div>
               <div>
                 <div className="text-lg font-bold text-gray-800 tracking-tight">{userData?.username}</div>
                 <div className="text-[11px] text-emerald-600 font-medium mt-1 flex items-center gap-2">
                   <div className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse"></div>
                   Online Guardian
                 </div>
               </div>
               <button onClick={() => auth.signOut()} className="ml-6 p-2 text-gray-400 hover:text-red-500 hover:bg-red-50 rounded-full transition-all"><LogOut size={20} /></button>
            </div>
          </header>

          <div className="grid grid-cols-1 lg:grid-cols-3 gap-10">
            <div className="lg:col-span-2 space-y-10">
              <div onClick={startMatchmaking} className="relative group bg-white/80 p-12 rounded-[3rem] shadow-sm cursor-pointer overflow-hidden transition-all hover:shadow-md border border-white hover:border-emerald-100">
                <div className="relative z-10">
                  <div className="inline-flex items-center gap-2 bg-emerald-50 px-4 py-2 rounded-full text-xs font-semibold text-emerald-600 mb-6 border border-emerald-100">
                    매칭 가능
                  </div>
                  <h2 className="text-4xl font-bold mb-4 text-gray-800 tracking-tight">실시간 대전</h2>
                  <p className="text-gray-500 max-w-sm mb-12 text-base leading-relaxed">전 세계의 수호자들과 지혜를 겨루고 숲의 정점에 도달하세요.</p>
                  <div className="inline-flex items-center gap-3 bg-emerald-500 text-white px-8 py-4 rounded-2xl font-semibold text-sm shadow-md group-hover:bg-emerald-600 transition-colors">
                    대결 시작 <Play size={18} fill="currentColor" />
                  </div>
                </div>
                <div className="absolute -right-10 -bottom-10 opacity-[0.03] group-hover:opacity-[0.06] transition-opacity duration-500 pointer-events-none">
                  <TreePine size={400} strokeWidth={1} />
                </div>
              </div>

              <div className="grid grid-cols-2 gap-6">
                <button onClick={startComputerGame} className="p-8 bg-white/70 rounded-[2.5rem] border border-white hover:border-emerald-200 hover:bg-white shadow-sm transition-all text-left group">
                  <Cpu className="text-emerald-400 mb-6 w-10 h-10 group-hover:scale-110 transition-transform" />
                  <h3 className="text-2xl font-bold text-gray-800 tracking-tight mb-2">인공지능 대결</h3>
                  <p className="text-xs text-gray-500 font-medium">Solo Training Mode</p>
                </button>
                <button onClick={startComputerGame} className="p-8 bg-white/70 rounded-[2.5rem] border border-white hover:border-teal-200 hover:bg-white shadow-sm transition-all text-left group">
                  <Shield className="text-teal-400 mb-6 w-10 h-10 group-hover:scale-110 transition-transform" />
                  <h3 className="text-2xl font-bold text-gray-800 tracking-tight mb-2">숲의 시련</h3>
                  <p className="text-xs text-gray-500 font-medium">Hardcore Challenge</p>
                </button>
              </div>
            </div>

            <div className="bg-white/70 rounded-[3rem] border border-white shadow-sm p-10 backdrop-blur-md">
              <div className="flex items-center justify-between mb-10">
                <h3 className="text-sm font-bold text-gray-800 flex items-center gap-2">
                  <Trophy size={20} className="text-yellow-500" /> 명예의 전당
                </h3>
              </div>
              <div className="space-y-6">
                {leaderboard.length === 0 ? (
                  <p className="text-gray-400 text-sm text-center py-4">아직 기록이 없습니다</p>
                ) : leaderboard.map((player, i) => (
                  <div key={player.uid} className="flex justify-between items-center group w-full">
                    <div className="flex items-center gap-4 flex-1">
                      <span className={`text-xs w-7 h-7 flex items-center justify-center rounded-full font-bold shrink-0 ${i === 0 ? 'bg-yellow-100 text-yellow-700' : i === 1 ? 'bg-gray-200 text-gray-600' : i === 2 ? 'bg-orange-100 text-orange-600' : 'bg-gray-100 text-gray-500'}`}>{i + 1}</span>
                      <span className="font-medium text-gray-600 group-hover:text-gray-900 transition-colors truncate">{player.username}</span>
                    </div>
                    <div className="flex items-center gap-3 ml-4 shrink-0">
                      <span className="text-xs text-gray-400">{player.wins}승 {player.losses}패</span>
                      <span className="font-semibold text-emerald-500 text-sm">{player.totalGames > 0 ? ((player.wins / player.totalGames) * 100).toFixed(1) : '0.0'}%</span>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      )}

      {view === 'matchmaking' && (
        <div className="relative z-10 min-h-screen flex items-center justify-center">
          <div className="text-center bg-white/60 backdrop-blur-md p-16 rounded-[4rem] border border-white shadow-xl">
             <div className="relative mb-12 inline-block">
               <div className="absolute inset-0 border-[2px] border-emerald-200 rounded-full animate-ping scale-150 opacity-50"></div>
               <div className="bg-white p-8 rounded-full text-emerald-500 relative z-10 border border-emerald-100 shadow-md">
                 <RefreshCw size={50} className="animate-spin" />
               </div>
             </div>
             <h2 className="text-3xl font-bold text-gray-800 tracking-tight mb-4">대전 상대 탐색 중...</h2>
             <p className="text-gray-500 font-medium text-sm mb-6">{matchmakingStatus}</p>

             <div className="flex items-center justify-center gap-4 mb-10">
               <div className="inline-flex items-center gap-3 bg-white px-6 py-3 rounded-full border border-emerald-100 text-gray-700 font-medium shadow-sm">
                 <Clock size={18} className="text-emerald-500" />
                 <span>{elapsedTime}초 경과</span>
               </div>
               <div className="inline-flex items-center gap-2 bg-emerald-50 px-4 py-3 rounded-full border border-emerald-100 text-emerald-700 font-medium shadow-sm text-sm">
                 <span>허용 범위: {Math.min(Math.floor(elapsedTime / 2) * 10, 100)}%</span>
               </div>
             </div>

             <div>
               <button
                 onClick={cancelMatchmaking}
                 className="px-8 py-3 bg-gray-100 text-gray-600 hover:bg-gray-200 rounded-xl text-sm font-semibold transition-all"
               >
                 탐색 취소
               </button>
             </div>
          </div>
        </div>
      )}

      {view === 'game' && (
        <div className="relative z-10 min-h-screen flex flex-col items-center py-10">
          <header className="w-full max-w-6xl px-8 flex justify-between items-center mb-8">
             <button onClick={() => setView('lobby')} className="px-6 py-3 bg-white/80 rounded-xl text-sm font-semibold text-gray-600 hover:text-gray-900 border border-white hover:border-gray-200 transition-all shadow-sm">
               로비로 돌아가기
             </button>
             <div className="text-center">
               <div className="text-xs font-semibold text-emerald-500 mb-1">Combat Arena</div>
               <div className="text-2xl font-bold tracking-tight text-gray-800">숲의 전장</div>
             </div>
             <div className="w-[130px]"></div>
          </header>
          <div className="flex-1 flex items-center justify-center w-full">
            <GameBoard game={currentGame} />
          </div>
        </div>
      )}

      {winnerModal && (() => {
        const isWin = typeof winnerModal === 'object' ? winnerModal.isWinner : true;
        const modalText = typeof winnerModal === 'object' ? winnerModal.text : winnerModal;
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
                {isWin ? '위대한 승리' : '아쉬운 패배'}
              </h2>
              <p className={`font-medium mb-12 text-lg leading-relaxed ${isWin ? 'text-gray-600' : 'text-gray-500'}`}>
                <span className={`block text-2xl mb-2 font-bold ${isWin ? 'text-emerald-600' : 'text-red-500'}`}>
                  {modalText}
                </span>
                {isWin
                  ? '숲의 가장 깊은 곳을 정복했습니다.'
                  : '다음에는 더 강해져서 돌아오세요.'}
              </p>
              <button
                onClick={() => { setWinnerModal(null); setView('lobby'); fetchLeaderboard(); }}
                className={`w-full py-5 font-bold rounded-2xl transition-all shadow-md transform active:scale-[0.98] text-lg ${
                  isWin
                    ? 'bg-emerald-500 hover:bg-emerald-600 text-white'
                    : 'bg-gray-700 hover:bg-gray-800 text-white'
                }`}
              >
                로비로 귀환
              </button>
            </div>
          </div>
        );
      })()}
      <SpeedInsights />
    </div>
  );
};

export default App;
