import { useCallback, useEffect, useRef, useState } from 'react';
import {
  CheckCircle2,
  Download,
  Heart,
  Lightbulb,
  RotateCcw,
  Volume2,
  VolumeX,
  XCircle,
} from 'lucide-react';
import { CubeEngine } from './game/CubeEngine';
import { generateSolvableLevel, GeneratedLevel } from './game/levelGenerator';
import { soundEngine } from './game/soundEngine';

const MAX_LIVES = 3;
const STORAGE_KEY = 'tap_away_3d_level';

type GameModalState = 'playing' | 'won' | 'lost';

export default function App() {
  const canvasMountRef = useRef<HTMLDivElement | null>(null);
  const engineRef = useRef<CubeEngine | null>(null);

  const [levelNum, setLevelNum] = useState<number>(() => {
    const saved = Number(localStorage.getItem(STORAGE_KEY) || '1');
    return Number.isFinite(saved) && saved >= 1 ? Math.floor(saved) : 1;
  });

  const [levelMeta, setLevelMeta] = useState<{
    title: string;
    seed: number;
    remaining: number;
    total: number;
  }>(() => {
    const saved = Number(localStorage.getItem(STORAGE_KEY) || '1');
    const initialNum = Number.isFinite(saved) && saved >= 1 ? Math.floor(saved) : 1;
    const initial = generateSolvableLevel(initialNum);
    return {
      title: initial.title,
      seed: initial.seed,
      remaining: initial.cells.length,
      total: initial.cells.length,
    };
  });

  const [lives, setLives] = useState<number>(MAX_LIVES);
  const [heartShakeKey, setHeartShakeKey] = useState<number>(0);
  const [muted, setMuted] = useState<boolean>(false);
  const [modalState, setModalState] = useState<GameModalState>('playing');
  const [stats, setStats] = useState<{
    moves: number;
    mistakes: number;
    elapsedSec: number;
  }>({ moves: 0, mistakes: 0, elapsedSec: 0 });
  const [webglError, setWebglError] = useState<string>('');

  const activeLevelRef = useRef<number>(levelNum);
  activeLevelRef.current = levelNum;

  const startLevel = useCallback((num: number) => {
    const generated: GeneratedLevel = generateSolvableLevel(num);
    setLevelNum(generated.levelNumber);
    activeLevelRef.current = generated.levelNumber;
    localStorage.setItem(STORAGE_KEY, String(generated.levelNumber));
    setLevelMeta({
      title: generated.title,
      seed: generated.seed,
      remaining: generated.cells.length,
      total: generated.cells.length,
    });
    setLives(MAX_LIVES);
    setModalState('playing');
    setStats({ moves: 0, mistakes: 0, elapsedSec: 0 });
    engineRef.current?.loadLevel(generated);
  }, []);

  useEffect(() => {
    const container = canvasMountRef.current;
    if (!container) return;

    const engine = new CubeEngine(container, {
      onBlockRemoved: (remaining, total, moves) => {
        setLevelMeta((prev) => ({ ...prev, remaining, total }));
        setStats((prev) => ({ ...prev, moves }));
      },
      onMistake: (livesLeft, mistakes) => {
        setLives(livesLeft);
        setHeartShakeKey((k) => k + 1);
        setStats((prev) => ({ ...prev, mistakes }));
      },
      onWin: (moves, mistakes, elapsedSec) => {
        // Persist completed progress immediately so reloading advances to the next level
        localStorage.setItem(STORAGE_KEY, String(activeLevelRef.current + 1));
        setStats({ moves, mistakes, elapsedSec });
        setModalState('won');
      },
      onLose: (moves, mistakes) => {
        setStats((prev) => ({ ...prev, moves, mistakes }));
        setModalState('lost');
      },
      onWebGLContextError: (msg) => {
        setWebglError(msg);
      },
    });

    engineRef.current = engine;
    const initialLevel = generateSolvableLevel(levelNum);
    setLevelMeta({
      title: initialLevel.title,
      seed: initialLevel.seed,
      remaining: initialLevel.cells.length,
      total: initialLevel.cells.length,
    });
    engine.loadLevel(initialLevel);

    return () => {
      engine.dispose();
      engineRef.current = null;
    };
    // Initialize WebGL canvas once on mount
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleRestart = () => {
    // Restart with the exact same level number & deterministic seed
    startLevel(levelNum);
  };

  const handleNextLevel = () => {
    startLevel(levelNum + 1);
  };

  const handleHint = () => {
    engineRef.current?.triggerHint();
  };

  const handleToggleSound = () => {
    const next = !muted;
    setMuted(next);
    soundEngine.setMuted(next);
  };

  return (
    <div className="relative w-full h-full overflow-hidden">
      {/* Dedicated isolated WebGL canvas container */}
      <div ref={canvasMountRef} className="fixed inset-0 z-0 w-full h-full" />

      {/* Top HUD Bar */}
      <header className="fixed top-0 left-0 right-0 z-10 flex items-center justify-between gap-4 px-4 py-4 sm:px-7 sm:py-5 pointer-events-none">
        <div className="pointer-events-auto flex flex-col gap-0.5">
          <h1 className="text-lg sm:text-xl font-extrabold tracking-tight text-slate-900 whitespace-nowrap leading-tight">
            Tap Away 3D
          </h1>
          <div className="flex items-center gap-2 text-xs sm:text-sm font-semibold text-slate-600 whitespace-nowrap">
            <span>Level {levelNum}</span>
            <span aria-hidden="true">·</span>
            <span>{levelMeta.title}</span>
            <span aria-hidden="true">·</span>
            <span className="font-mono-num text-slate-800">
              {levelMeta.remaining} / {levelMeta.total}
            </span>
          </div>
        </div>

        {/* Hearts Counter */}
        <div
          key={heartShakeKey}
          aria-label={`Осталось жизней: ${lives} из ${MAX_LIVES}`}
          className={`pointer-events-auto flex items-center gap-2 bg-white/95 border border-slate-900/10 rounded-2xl px-3.5 py-2.5 shadow-sm ${
            heartShakeKey > 0 ? 'animate-heart-shake' : ''
          }`}
        >
          {Array.from({ length: MAX_LIVES }).map((_, idx) => {
            const active = idx < lives;
            return (
              <Heart
                key={idx}
                className={`w-5 h-5 transition-all duration-200 ${
                  active
                    ? 'fill-rose-500 text-rose-500 scale-100'
                    : 'fill-slate-200 text-slate-300 scale-90 opacity-60'
                }`}
              />
            );
          })}
        </div>
      </header>

      {/* Bottom Compact Control Dock */}
      <div className="fixed bottom-5 left-1/2 -translate-x-1/2 z-10 flex flex-col items-center gap-2.5 max-w-[96vw] pointer-events-none">
        <p className="hidden sm:block text-xs font-medium text-slate-500 whitespace-nowrap">
          Тяните для вращения на 360° · Нажмите на блок для вылета
        </p>

        <div className="pointer-events-auto flex items-center gap-1.5 sm:gap-2 p-1.5 sm:p-2 bg-white/95 border border-slate-900/10 rounded-[18px] shadow-lg shadow-slate-900/10">
          <button
            type="button"
            onClick={handleRestart}
            title={`Перезапустить уровень (Seed: ${levelMeta.seed.toString(16).toUpperCase()})`}
            className="inline-flex items-center justify-center gap-1.5 sm:gap-2 min-h-[44px] px-3 sm:px-4 py-2.5 rounded-xl bg-slate-100 hover:bg-slate-200 active:scale-95 text-slate-800 text-xs sm:text-sm font-semibold whitespace-nowrap shrink-0 transition-transform cursor-pointer focus-visible:outline-2 focus-visible:outline-slate-900"
          >
            <RotateCcw className="w-4 h-4 shrink-0" />
            <span>Перезапустить уровень</span>
          </button>

          <button
            type="button"
            onClick={handleHint}
            className="inline-flex items-center justify-center gap-1.5 sm:gap-2 min-h-[44px] px-3 sm:px-4 py-2.5 rounded-xl bg-emerald-50 hover:bg-emerald-100 active:scale-95 border border-emerald-500/20 text-emerald-700 text-xs sm:text-sm font-semibold whitespace-nowrap shrink-0 transition-transform cursor-pointer focus-visible:outline-2 focus-visible:outline-emerald-700"
          >
            <Lightbulb className="w-4 h-4 shrink-0" />
            <span>Подсказка</span>
          </button>

          <button
            type="button"
            onClick={handleToggleSound}
            aria-label={muted ? 'Включить звук' : 'Выключить звук'}
            title={muted ? 'Включить звук' : 'Выключить звук'}
            className="inline-flex items-center justify-center w-[44px] min-h-[44px] rounded-xl bg-slate-100 hover:bg-slate-200 active:scale-95 text-slate-800 shrink-0 transition-transform cursor-pointer focus-visible:outline-2 focus-visible:outline-slate-900"
          >
            {muted ? <VolumeX className="w-4 h-4" /> : <Volume2 className="w-4 h-4" />}
          </button>

          <a
            href="/tap-away-3d.html"
            download="tap-away-3d.html"
            title="Скачать автономный HTML-файл"
            className="inline-flex items-center justify-center gap-1.5 min-h-[44px] px-3 sm:px-3.5 py-2.5 rounded-xl bg-slate-900 hover:bg-slate-800 active:scale-95 text-white text-xs sm:text-sm font-semibold whitespace-nowrap shrink-0 transition-transform focus-visible:outline-2 focus-visible:outline-slate-900"
          >
            <Download className="w-4 h-4 shrink-0" />
            <span className="hidden sm:inline">HTML</span>
          </a>
        </div>
      </div>

      {/* WebGL Error Fallback Banner */}
      {webglError && (
        <div className="fixed inset-0 z-40 flex items-center justify-center p-6 bg-slate-900/35">
          <div className="max-w-sm w-full bg-white rounded-2xl p-6 text-center shadow-xl border border-slate-900/10">
            <p className="text-base font-bold text-slate-900 mb-2">Ошибка 3D-рендеринга</p>
            <p className="text-sm text-slate-600 mb-4">{webglError}</p>
            <button
              type="button"
              onClick={() => window.location.reload()}
              className="w-full min-h-[44px] rounded-xl bg-slate-900 text-white text-sm font-semibold cursor-pointer"
            >
              Обновить страницу
            </button>
          </div>
        </div>
      )}

      {/* Victory Modal */}
      {modalState === 'won' && (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="win-heading"
          className="fixed inset-0 z-30 flex items-center justify-center p-5 bg-slate-900/35"
        >
          <div className="w-full max-w-sm bg-white border border-slate-900/10 rounded-3xl p-7 text-center shadow-2xl">
            <div className="w-14 h-14 mx-auto mb-4 rounded-2xl bg-emerald-50 text-emerald-600 flex items-center justify-center">
              <CheckCircle2 className="w-7 h-7" />
            </div>
            <h2 id="win-heading" className="text-2xl font-extrabold tracking-tight text-slate-900 mb-1.5">
              Level {levelNum} пройден!
            </h2>
            <p className="text-sm text-slate-600 mb-5">
              Все {levelMeta.total} блоков успешно разобраны.
            </p>

            <div className="grid grid-cols-3 gap-2 p-3 mb-6 bg-slate-50 rounded-2xl border border-slate-900/5">
              <div>
                <div className="text-[11px] font-semibold text-slate-500 mb-0.5">Ходы</div>
                <div className="text-base font-bold text-slate-900 font-mono-num">{stats.moves}</div>
              </div>
              <div>
                <div className="text-[11px] font-semibold text-slate-500 mb-0.5">Ошибки</div>
                <div className="text-base font-bold text-slate-900 font-mono-num">{stats.mistakes}</div>
              </div>
              <div>
                <div className="text-[11px] font-semibold text-slate-500 mb-0.5">Время</div>
                <div className="text-base font-bold text-slate-900 font-mono-num">{stats.elapsedSec}с</div>
              </div>
            </div>

            <button
              type="button"
              onClick={handleNextLevel}
              className="w-full min-h-[46px] px-5 py-3 rounded-xl bg-slate-900 hover:bg-slate-800 active:scale-95 text-white text-sm font-bold whitespace-nowrap transition-transform cursor-pointer"
            >
              Перейти на Level {levelNum + 1}
            </button>
          </div>
        </div>
      )}

      {/* Game Over Modal */}
      {modalState === 'lost' && (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="lose-heading"
          className="fixed inset-0 z-30 flex items-center justify-center p-5 bg-slate-900/35"
        >
          <div className="w-full max-w-sm bg-white border border-slate-900/10 rounded-3xl p-7 text-center shadow-2xl">
            <div className="w-14 h-14 mx-auto mb-4 rounded-2xl bg-rose-50 text-rose-600 flex items-center justify-center">
              <XCircle className="w-7 h-7" />
            </div>
            <h2 id="lose-heading" className="text-2xl font-extrabold tracking-tight text-slate-900 mb-1.5">
              Попытки закончились
            </h2>
            <p className="text-sm text-slate-600 mb-6 leading-relaxed">
              Несколько блоков столкнулись с препятствиями. Попробуйте ещё раз и найдите верный порядок разбора.
            </p>
            <button
              type="button"
              onClick={handleRestart}
              className="w-full min-h-[46px] px-5 py-3 rounded-xl bg-slate-900 hover:bg-slate-800 active:scale-95 text-white text-sm font-bold whitespace-nowrap transition-transform cursor-pointer"
            >
              Перезапустить уровень
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
