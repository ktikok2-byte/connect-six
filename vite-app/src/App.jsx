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
  serverTimestamp
} from 'firebase/firestore';
import { Trophy, Play, Cpu, Shield, LogOut, RefreshCw, TreePine, Clock, UserPlus, Copy, Check } from 'lucide-react';
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

  const startMatchmaking = () => {
    setView('matchmaking');
    setMatchmakingStatus("숲 속에서 대전 상대를 찾는 중...");
    setElapsedTime(0);
    const startTime = Date.now();
    const poolRef = doc(db, 'artifacts', appId, 'public', 'data', 'matchmaking_pool', user.uid);

    setDoc(poolRef, {
      uid: user.uid,
      username: userData?.username,
      timestamp: serverTimestamp(),
      gameId: null
    }).catch((err) => console.warn('Matchmaking pool write failed:', err));

    let stopped = false;

    const interval = setInterval(async () => {
      if (stopped) return;
      const now = Date.now();
      const elapsed = Math.floor((now - startTime) / 1000);
      setElapsedTime(elapsed);

      try {
        // Check if someone else already matched us
        const myEntry = await getDoc(poolRef);
        if (stopped) return;
        if (myEntry.exists() && myEntry.data().gameId) {
          stopped = true;
          clearInterval(interval);
          matchmakingCleanup.current = null;
          const gameId = myEntry.data().gameId;
          await deleteDoc(poolRef).catch(() => {});
          joinPvPGame(gameId);
          return;
        }

        // Look for other players waiting
        const poolSnapshot = await getDocs(
          collection(db, 'artifacts', appId, 'public', 'data', 'matchmaking_pool')
        );
        if (stopped) return;

        const opponents = poolSnapshot.docs.filter(d => d.id !== user.uid && !d.data().gameId);
        if (opponents.length > 0) {
          const opponent = opponents[0];
          // Only the player with the smaller UID creates the game to avoid duplicates
          if (user.uid < opponent.id) {
            stopped = true;
            clearInterval(interval);
            matchmakingCleanup.current = null;
            const gameId = await createPvPGame(opponent.data());
            // Tag both pool entries so the opponent also joins
            await updateDoc(poolRef, { gameId }).catch(() => {});
            await updateDoc(
              doc(db, 'artifacts', appId, 'public', 'data', 'matchmaking_pool', opponent.id),
              { gameId }
            ).catch(() => {});
            await deleteDoc(poolRef).catch(() => {});
            joinPvPGame(gameId);
            return;
          }
          // If our uid is larger, wait for the other player to create the game
          setMatchmakingStatus("상대를 발견! 연결 중...");
        }

        // Timeout → fall back to AI game
        if ((now - startTime) > MATCH_TIMEOUT) {
          stopped = true;
          clearInterval(interval);
          matchmakingCleanup.current = null;
          await deleteDoc(poolRef).catch(() => {});
          startComputerGame();
        }
      } catch (err) {
        console.warn('Matchmaking poll error:', err);
      }
    }, 1500);

    // Store cleanup so cancel button and navigation can use it
    matchmakingCleanup.current = () => {
      stopped = true;
      clearInterval(interval);
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
      createdAt: serverTimestamp()
    });
    return gameRef.id;
  };

  const joinPvPGame = (gameId) => {
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
    const moveCountRef = useRef(game.moveCount || 0);

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

        const pNum = data.player1.uid === user.uid ? 1 : 2;
        setMyPlayerNum(pNum);
        setIsMyTurn(data.turn === pNum);
        setOpponentName(pNum === 1 ? data.player2.username : data.player1.username);

        if (data.status === 'finished' && data.winner) {
          setWinnerModal(data.winner === user.uid ? "나의 승리!" : `${pNum === 1 ? data.player2.username : data.player1.username} 승리`);
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
      if (board[idx] !== 0 || winnerModal) return;

      if (game.mode === 'pvp') {
        // PvP: only allow moves on our turn
        if (!isMyTurn) return;

        const newBoard = [...board];
        newBoard[idx] = turn;
        const won = checkWin(idx, turn, newBoard);

        let nextTurn = turn;
        let nextTurnMoves = turnMoves + 1;
        const nextMoveCount = moveCountRef.current + 1;
        if (!won && (moveCountRef.current === 0 || nextTurnMoves === 2)) {
          nextTurn = turn === 1 ? 2 : 1;
          nextTurnMoves = 0;
        }

        const gameRef = doc(db, 'artifacts', appId, 'games', game.id);
        await updateDoc(gameRef, {
          board: newBoard,
          turn: won ? turn : nextTurn,
          turnMoves: won ? nextTurnMoves : nextTurnMoves,
          moveCount: nextMoveCount,
          ...(won ? { status: 'finished', winner: user.uid } : {})
        });
        return;
      }

      // AI mode
      const newBoard = [...board];
      newBoard[idx] = turn;

      if (checkWin(idx, turn, newBoard)) {
        setBoard(newBoard);
        setWinnerModal(turn === 1 ? "흑돌(Black)" : "백돌(White)");
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
        setWinnerModal("컴퓨터(AI)");
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

    return (
      <div className="flex flex-col items-center">
        <div className="mb-8 flex items-center gap-6 bg-white/70 backdrop-blur-md px-10 py-4 rounded-3xl border border-emerald-100 shadow-sm">
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
             <div className="ml-4 flex items-center gap-2 text-xs text-gray-500">
               <div className={`w-3 h-3 rounded-full ${myPlayerNum === 1 ? 'bg-gray-800' : 'bg-white border border-gray-300'}`}></div>
               <span>나</span>
               <span className="text-gray-300">vs</span>
               <div className={`w-3 h-3 rounded-full ${myPlayerNum === 2 ? 'bg-gray-800' : 'bg-white border border-gray-300'}`}></div>
               <span>{opponentName}</span>
             </div>
           )}
        </div>

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
             <p className="text-gray-500 font-medium text-sm mb-10">{matchmakingStatus}</p>

             <div className="inline-flex items-center gap-3 bg-white px-6 py-3 rounded-full border border-emerald-100 text-gray-700 font-medium shadow-sm mb-12">
               <Clock size={18} className="text-emerald-500" />
               <span>{elapsedTime}초 경과</span>
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

      {winnerModal && (
        <div className="fixed inset-0 z-[100] bg-white/60 backdrop-blur-md flex items-center justify-center p-6">
          <div className="bg-white border border-emerald-100 p-16 rounded-[4rem] shadow-2xl text-center max-w-lg w-full relative overflow-hidden">
            <div className="mb-8 inline-flex p-8 bg-yellow-50 rounded-full text-yellow-500 shadow-sm border border-yellow-100">
              <Trophy size={80} strokeWidth={1.5} />
            </div>
            <h2 className="text-4xl font-bold text-gray-800 mb-4 tracking-tight">위대한 승리</h2>
            <p className="text-gray-600 font-medium mb-12 text-lg leading-relaxed">
              <span className="text-emerald-600 block text-2xl mb-2 font-bold">{winnerModal}</span>
              숲의 가장 깊은 곳을 정복했습니다.
            </p>
            <button
              onClick={() => { setWinnerModal(null); setView('lobby'); }}
              className="w-full py-5 bg-emerald-500 hover:bg-emerald-600 text-white font-bold rounded-2xl transition-all shadow-md transform active:scale-[0.98] text-lg"
            >
              로비로 귀환
            </button>
          </div>
        </div>
      )}
      <SpeedInsights />
    </div>
  );
};

export default App;
