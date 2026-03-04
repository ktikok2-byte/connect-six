import React, { useState, useEffect, useCallback } from 'react';
import { initializeApp } from 'firebase/app';
import { 
  getAuth, 
  signInWithCustomToken, 
  signInAnonymously, 
  onAuthStateChanged,
  createUserWithEmailAndPassword,
  signInWithEmailAndPassword
} from 'firebase/auth';
import { 
  getFirestore, 
  doc, 
  setDoc, 
  getDoc, 
  collection, 
  deleteDoc,
  serverTimestamp
} from 'firebase/firestore';
import { Trophy, Play, Cpu, Shield, LogOut, RefreshCw, Send, TreePine, Leaf, Flower2, Clock } from 'lucide-react';

// --- Firebase Configuration ---
const firebaseConfig = JSON.parse(__firebase_config);
const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);
const appId = typeof __app_id !== 'undefined' ? __app_id : 'connect6-forest-v4';

const BOARD_SIZE = 19;
const MATCH_TIMEOUT = 10000;

const App = () => {
  const [user, setUser] = useState(null);
  const [view, setView] = useState('login'); 
  const [userData, setUserData] = useState(null);
  const [currentGame, setCurrentGame] = useState(null);
  const [matchmakingStatus, setMatchmakingStatus] = useState("");
  const [elapsedTime, setElapsedTime] = useState(0);
  const [error, setError] = useState("");
  const [winnerModal, setWinnerModal] = useState(null);

  useEffect(() => {
    const initAuth = async () => {
      try {
        if (typeof __initial_auth_token !== 'undefined' && __initial_auth_token) {
          await signInWithCustomToken(auth, __initial_auth_token);
        }
      } catch (err) { console.error(err); }
    };
    initAuth();
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
      setUserData(newData);
    }
  };

  const handleAutoRegister = async () => {
    // 보안 수정: Math.random() 대신 Web Crypto API 사용 (CSPRNG)
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
      alert(`비밀의 숲 계정이 생성되었습니다!\nID: ${id}\nPW: ${pw}`);
    } catch (err) { setError("가입 실패: " + err.message); }
  };

  const handleManualLogin = async (e) => {
    e.preventDefault();
    const email = e.target.id.value + "@forest6.com";
    const pw = e.target.pw.value;
    try { await signInWithEmailAndPassword(auth, email, pw); } 
    catch (err) { setError("로그인 실패. 아이디나 비밀번호를 확인하세요."); }
  };

  const startMatchmaking = async () => {
    setView('matchmaking');
    setMatchmakingStatus("숲 속에서 대전 상대를 찾는 중...");
    setElapsedTime(0);
    const startTime = Date.now();
    const poolRef = doc(db, 'artifacts', appId, 'public', 'data', 'matchmaking_pool', user.uid);
    await setDoc(poolRef, { uid: user.uid, timestamp: serverTimestamp() });

    const interval = setInterval(async () => {
      const now = Date.now();
      const elapsed = Math.floor((now - startTime) / 1000);
      setElapsedTime(elapsed);
      
      if ((now - startTime) > MATCH_TIMEOUT) {
        clearInterval(interval);
        await deleteDoc(poolRef);
        startComputerGame();
        return;
      }
    }, 1000);
  };

  const startComputerGame = () => {
    setCurrentGame({
      id: 'forest_ai_' + Date.now(),
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
    const [board, setBoard] = useState(game.board);
    const [turn, setTurn] = useState(game.turn);
    const [turnMoves, setTurnMoves] = useState(0);

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

    const handleCellClick = (idx) => {
      if (board[idx] !== 0 || winnerModal) return;
      const newBoard = [...board];
      newBoard[idx] = turn;
      
      if (checkWin(idx, turn, newBoard)) {
        setBoard(newBoard);
        setWinnerModal(turn === 1 ? "흑돌(Black)" : "백돌(White)");
        return;
      }

      let nextTurn = turn;
      let nextTurnMoves = turnMoves + 1;
      if (game.moveCount === 0 || nextTurnMoves === 2) {
        nextTurn = turn === 1 ? 2 : 1;
        nextTurnMoves = 0;
      }
      setBoard(newBoard);
      setTurn(nextTurn);
      setTurnMoves(nextTurnMoves);
      game.moveCount++;

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
      if (nextTurnMoves === 2) {
        nextTurn = 1;
        nextTurnMoves = 0;
      }
      setBoard(newBoard);
      setTurn(nextTurn);
      setTurnMoves(nextTurnMoves);
      game.moveCount++;
      if (nextTurn === 2) setTimeout(() => triggerAiMove(newBoard, 2, nextTurnMoves), 600);
    };

    // Constant values for perfect alignment
    const BOARD_PX = 600; 
    const CELL_SIZE = BOARD_PX / (BOARD_SIZE - 1); 

    return (
      <div className="flex flex-col items-center">
        {/* 상태 표시줄 - 밝은 테마 */}
        <div className="mb-8 flex items-center gap-6 bg-white/70 backdrop-blur-md px-10 py-4 rounded-3xl border border-emerald-100 shadow-sm">
           <div className={`w-8 h-8 rounded-full shadow-md transition-all duration-500 transform ${turn === 1 ? 'bg-gray-800 scale-110' : 'bg-white scale-110 border border-gray-200'}`}></div>
           <div className="flex flex-col">
             <span className="text-gray-800 font-bold text-sm">
               {turn === 1 ? "흑돌 차례" : "백돌 차례"}
             </span>
             <div className="flex items-center gap-2 mt-1">
               <div className="flex gap-1">
                 <div className={`w-2 h-2 rounded-full ${turnMoves < 2 ? 'bg-emerald-500' : 'bg-gray-200'}`}></div>
                 <div className={`w-2 h-2 rounded-full ${game.moveCount === 0 || turnMoves < 1 ? 'bg-emerald-500' : 'bg-gray-200'}`}></div>
               </div>
               <span className="text-[10px] text-emerald-600 font-semibold uppercase">Ready to Move</span>
             </div>
           </div>
        </div>

        {/* 바둑판 컴포넌트 */}
        <div className="relative group mt-2">
          <div className="absolute inset-0 bg-emerald-900/5 blur-2xl rounded-lg translate-y-6 scale-95 pointer-events-none"></div>
          
          <div className="relative bg-[#e6c280] rounded-sm border-b-[8px] border-r-[8px] border-[#d4ae6a] shadow-xl">
            <div 
              className="relative p-[30px]" 
              style={{ width: `${BOARD_PX + 60}px`, height: `${BOARD_PX + 60}px` }}
            >
              {/* 격자선 SVG */}
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

              {/* 돌 배치 레이어 */}
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
      
      {/* 부드러운 배경 효과 */}
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
            <form onSubmit={handleManualLogin} className="space-y-4">
              <input id="id" type="text" placeholder="아이디" required className="w-full bg-white border border-gray-200 rounded-xl py-4 px-6 focus:ring-2 focus:ring-emerald-400 outline-none text-gray-800 transition-all placeholder:text-gray-400 shadow-sm" />
              <input id="pw" type="password" placeholder="비밀번호" required className="w-full bg-white border border-gray-200 rounded-xl py-4 px-6 focus:ring-2 focus:ring-emerald-400 outline-none text-gray-800 transition-all placeholder:text-gray-400 shadow-sm" />
              <button className="w-full py-4 mt-2 bg-emerald-500 hover:bg-emerald-600 rounded-xl font-semibold text-white transition-all shadow-md transform active:scale-[0.98] text-base">입장하기</button>
            </form>
            <button onClick={handleAutoRegister} className="mt-6 text-gray-500 hover:text-emerald-600 text-sm font-medium transition-colors underline underline-offset-4">수호자 자동 등록</button>
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
                {[1, 2, 3, 4, 5, 6].map(i => (
                  <div key={i} className="flex justify-between items-center group w-full">
                    <div className="flex items-center gap-4 flex-1">
                      <span className={`text-xs w-7 h-7 flex items-center justify-center rounded-full font-bold shrink-0 ${i === 1 ? 'bg-yellow-100 text-yellow-700' : 'bg-gray-100 text-gray-500'}`}>{i}</span>
                      <span className="font-medium text-gray-600 group-hover:text-gray-900 transition-colors truncate">Ancient_One_{i+77}</span>
                    </div>
                    <span className="font-semibold text-emerald-500 text-sm ml-8 shrink-0">{(99 - i*0.8).toFixed(1)}%</span>
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
                 <RefreshCw size={50} className="animate-spin-slow" />
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
                 onClick={() => setView('lobby')} 
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
          <div className="bg-white border border-emerald-100 p-16 rounded-[4rem] shadow-2xl text-center max-w-lg w-full animate-in zoom-in duration-500 relative overflow-hidden">
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
    </div>
  );
};

export default App;