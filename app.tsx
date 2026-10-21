// bb-plugin-snake-context — frontend entry.
//
// A pixel snake strip above the thread's chat input. It moves only while the
// thread's agent runs, and its length is the thread's context-window usage.
import { useCallback, useEffect, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent } from "react";
import { definePluginApp, useComposer, useSdk } from "@get-bb/plugin-sdk/app";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";

const ROWS = 9;
const CELL = 8;
const MIN_COLS = 20;
const MAX_COLS = 120;
const TICK_MS = 140;
const MIN_LENGTH = 3;
// Full context fills this share of the board, leaving room to steer.
const MAX_FILL = 0.6;
const CONTEXT_POLL_RUNNING_MS = 3_000;
const CONTEXT_POLL_IDLE_MS = 15_000;
const COLLAPSED_KEY = "bb-plugin-snake-context:collapsed";

type Point = { x: number; y: number };
type Dir = "up" | "down" | "left" | "right";
type Size = { cols: number; rows: number };

const DELTA: Record<Dir, Point> = {
  up: { x: 0, y: -1 },
  down: { x: 0, y: 1 },
  left: { x: -1, y: 0 },
  right: { x: 1, y: 0 },
};
const OPPOSITE: Record<Dir, Dir> = {
  up: "down",
  down: "up",
  left: "right",
  right: "left",
};
const KEY_DIR: Record<string, Dir> = {
  ArrowUp: "up",
  ArrowDown: "down",
  ArrowLeft: "left",
  ArrowRight: "right",
  w: "up",
  s: "down",
  a: "left",
  d: "right",
};

type ContextUsage = { usedTokens: number; modelContextWindow: number };

/** Latest recorded context-window usage; polls faster while the agent runs. */
function useContextUsage(threadId: string, running: boolean): ContextUsage | null {
  const sdk = useSdk();
  const [usage, setUsage] = useState<ContextUsage | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    const poll = () => {
      sdk.threads.context({ threadId, signal: controller.signal }).then(
        (result) => {
          const next = result.usage;
          setUsage(
            next && next.modelContextWindow > 0
              ? {
                  usedTokens: next.usedTokens,
                  modelContextWindow: next.modelContextWindow,
                }
              : null,
          );
        },
        () => {},
      );
    };
    poll();
    const timer = window.setInterval(
      poll,
      running ? CONTEXT_POLL_RUNNING_MS : CONTEXT_POLL_IDLE_MS,
    );
    return () => {
      controller.abort();
      window.clearInterval(timer);
    };
  }, [sdk, threadId, running]);

  return usage;
}

function lengthForUsage(usage: ContextUsage | null, size: Size): number {
  if (!usage) return MIN_LENGTH;
  const ratio = Math.min(1, Math.max(0, usage.usedTokens / usage.modelContextWindow));
  const max = Math.floor(size.cols * size.rows * MAX_FILL);
  return Math.max(MIN_LENGTH, Math.round(ratio * max));
}

function formatTokens(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`;
  if (tokens >= 1_000) return `${Math.round(tokens / 1_000)}k`;
  return String(tokens);
}

const wrap = (value: number, max: number) => (value + max) % max;
const same = (a: Point, b: Point) => a.x === b.x && a.y === b.y;

function spawn(length: number, size: Size): Point[] {
  // Coiled on one cell; the body unfolds as the head moves.
  const centre = { x: Math.floor(size.cols / 2), y: Math.floor(size.rows / 2) };
  return Array.from({ length }, () => ({ ...centre }));
}

function placeFood(body: readonly Point[], size: Size): Point {
  const cells = size.cols * size.rows;
  const taken = new Set(body.map((p) => p.y * size.cols + p.x));
  if (taken.size >= cells) return { x: 0, y: 0 };
  for (;;) {
    const cell = Math.floor(Math.random() * cells);
    if (!taken.has(cell)) return { x: cell % size.cols, y: Math.floor(cell / size.cols) };
  }
}

/** Greedy autopilot: step toward food, avoiding the body when it can. */
function autoSteer(body: readonly Point[], dir: Dir, food: Point, size: Size): Dir {
  const head = body[0]!;
  const blocked = new Set(body.slice(0, -1).map((p) => p.y * size.cols + p.x));
  const options = (Object.keys(DELTA) as Dir[]).filter((d) => d !== OPPOSITE[dir]);
  const score = (d: Dir) => {
    const next = {
      x: wrap(head.x + DELTA[d].x, size.cols),
      y: wrap(head.y + DELTA[d].y, size.rows),
    };
    if (blocked.has(next.y * size.cols + next.x)) return Number.POSITIVE_INFINITY;
    const dx = Math.abs(next.x - food.x);
    const dy = Math.abs(next.y - food.y);
    return Math.min(dx, size.cols - dx) + Math.min(dy, size.rows - dy);
  };
  return options.reduce((best, d) => (score(d) < score(best) ? d : best), dir);
}

type Game = {
  size: Size;
  body: Point[];
  dir: Dir;
  queued: Dir[];
  food: Point;
  score: number;
  crashes: number;
  flashUntil: number;
};

function newGame(length: number, size: Size): Game {
  const body = spawn(length, size);
  return {
    size,
    body,
    dir: "right",
    queued: [],
    food: placeFood(body, size),
    score: 0,
    crashes: 0,
    flashUntil: 0,
  };
}

/** Fit an existing game to a resized board without resetting score. */
function resizeGame(game: Game, size: Size) {
  game.size = size;
  game.body = game.body.map((p) => ({ x: p.x % size.cols, y: p.y % size.rows }));
  if (game.food.x >= size.cols || game.food.y >= size.rows) {
    game.food = placeFood(game.body, size);
  }
}

function fitLength(game: Game, target: number) {
  // Grow from the tail, or shrink after compaction.
  while (game.body.length < target) game.body.push({ ...game.body[game.body.length - 1]! });
  if (game.body.length > target) game.body.length = target;
}

function readCssColor(element: HTMLElement, variable: string, fallback: string): string {
  const value = getComputedStyle(element).getPropertyValue(variable).trim();
  if (!value) return fallback;
  return /^[\d.]+\s/.test(value) ? `hsl(${value})` : value;
}

function useCollapsed(): [boolean, (value: boolean) => void] {
  const [collapsed, setCollapsed] = useState(() => {
    try {
      return window.localStorage.getItem(COLLAPSED_KEY) === "1";
    } catch {
      return false;
    }
  });
  const update = useCallback((value: boolean) => {
    setCollapsed(value);
    try {
      window.localStorage.setItem(COLLAPSED_KEY, value ? "1" : "0");
    } catch {
      // Storage can be unavailable; the toggle still works for this session.
    }
  }, []);
  return [collapsed, update];
}

/** Composer banner: only thread composers carry a thread id. */
function SnakeBanner() {
  const composer = useComposer();
  if (composer.scope.kind !== "thread") return null;
  return <SnakeStrip threadId={composer.scope.threadId} running={composer.isRunning} />;
}

function SnakeStrip({ threadId, running }: { threadId: string; running: boolean }) {
  const usage = useContextUsage(threadId, running);
  const [collapsed, setCollapsed] = useCollapsed();
  const percent = usage ? Math.min(100, (usage.usedTokens / usage.modelContextWindow) * 100) : null;

  return (
    <div className="flex w-full flex-col gap-1.5 text-xs">
      <div className="flex items-center gap-2 font-mono">
        <span
          className={cn(
            "inline-block size-2 shrink-0 rounded-full",
            running ? "animate-pulse bg-green-500" : "bg-muted-foreground",
          )}
          aria-hidden
        />
        <span className="shrink-0">🐍 {running ? "running" : "paused"}</span>
        <div className="h-1 min-w-8 flex-1 overflow-hidden rounded bg-muted">
          <div className="h-full bg-green-500 transition-all" style={{ width: `${percent ?? 0}%` }} />
        </div>
        <span className="shrink-0 text-muted-foreground">
          {usage
            ? `${formatTokens(usage.usedTokens)}/${formatTokens(usage.modelContextWindow)} · ${percent!.toFixed(1)}%`
            : "no context yet"}
        </span>
        <Button
          variant="ghost"
          size="icon"
          className="size-6 shrink-0"
          aria-label={collapsed ? "Show snake" : "Hide snake"}
          aria-expanded={!collapsed}
          onClick={() => setCollapsed(!collapsed)}
        >
          <Icon name={collapsed ? "ChevronUp" : "ChevronDown"} className="size-3.5" />
        </Button>
      </div>
      {!collapsed && <SnakeBoard running={running} usage={usage} />}
    </div>
  );
}

function SnakeBoard({ running, usage }: { running: boolean; usage: ContextUsage | null }) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const boardRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [size, setSize] = useState<Size>({ cols: 48, rows: ROWS });
  const targetLength = lengthForUsage(usage, size);

  const gameRef = useRef<Game | null>(null);
  gameRef.current ??= newGame(targetLength, size);
  const targetLengthRef = useRef(targetLength);
  targetLengthRef.current = targetLength;
  const [auto, setAuto] = useState(false);
  const autoRef = useRef(auto);
  autoRef.current = auto;
  const [hud, setHud] = useState({ score: 0, crashes: 0, length: targetLength });

  // Board width follows the composer; rows stay fixed so the strip stays short.
  useEffect(() => {
    const element = containerRef.current;
    if (!element) return;
    const measure = () => {
      const cols = Math.max(MIN_COLS, Math.min(MAX_COLS, Math.floor(element.clientWidth / CELL)));
      setSize((prev) => (prev.cols === cols ? prev : { cols, rows: ROWS }));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    const game = gameRef.current;
    if (!canvas || !game) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const { cols, rows } = game.size;
    const fg = readCssColor(canvas, "--foreground", "#e5e5e5");
    const bg = readCssColor(canvas, "--muted", "#262626");
    const body = "#4ade80";
    const head = "#22c55e";
    const food = "#f43f5e";

    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.globalAlpha = 0.06;
    ctx.fillStyle = fg;
    for (let y = 0; y < rows; y++) {
      for (let x = 0; x < cols; x++) {
        if ((x + y) % 2 === 0) ctx.fillRect(x * CELL, y * CELL, CELL, CELL);
      }
    }
    ctx.globalAlpha = 1;

    ctx.fillStyle = food;
    ctx.fillRect(game.food.x * CELL + 2, game.food.y * CELL + 2, CELL - 4, CELL - 4);

    const flashing = performance.now() < game.flashUntil;
    for (let i = game.body.length - 1; i >= 0; i--) {
      const p = game.body[i]!;
      ctx.fillStyle = flashing ? food : i === 0 ? head : body;
      ctx.globalAlpha = i === 0 ? 1 : 0.55 + 0.45 * (1 - i / game.body.length);
      ctx.fillRect(p.x * CELL + 1, p.y * CELL + 1, CELL - 2, CELL - 2);
    }
    ctx.globalAlpha = 1;
  }, []);

  const step = useCallback(() => {
    const game = gameRef.current!;
    const { size: s } = game;
    const target = targetLengthRef.current;
    fitLength(game, target);

    if (autoRef.current) {
      game.queued = [];
      game.dir = autoSteer(game.body, game.dir, game.food, s);
    } else {
      const next = game.queued.shift();
      if (next && next !== OPPOSITE[game.dir]) game.dir = next;
    }

    const head = game.body[0]!;
    const moved = {
      x: wrap(head.x + DELTA[game.dir].x, s.cols),
      y: wrap(head.y + DELTA[game.dir].y, s.rows),
    };
    const tail = game.body.slice(0, -1);
    // Segments still coiled on the spawn cell are not solid yet.
    const bit = tail.some((p, i) => i > 0 && same(p, moved) && !same(p, game.body[i - 1]!));

    if (bit) {
      game.crashes += 1;
      game.body = spawn(target, s);
      game.dir = "right";
      game.queued = [];
      game.flashUntil = performance.now() + 400;
    } else {
      game.body = [moved, ...tail];
      if (same(moved, game.food)) {
        game.score += 1;
        game.food = placeFood(game.body, s);
      }
    }
    setHud({ score: game.score, crashes: game.crashes, length: game.body.length });
  }, []);

  // Apply board resizes and context changes, then repaint (also while frozen).
  useEffect(() => {
    const game = gameRef.current!;
    if (game.size.cols !== size.cols || game.size.rows !== size.rows) resizeGame(game, size);
    fitLength(game, targetLength);
    setHud((prev) => ({ ...prev, length: game.body.length }));
    draw();
  }, [size, targetLength, draw]);

  useEffect(() => {
    if (!running) {
      draw();
      return;
    }
    const timer = window.setInterval(() => {
      step();
      draw();
    }, TICK_MS);
    return () => window.clearInterval(timer);
  }, [running, step, draw]);

  const turn = useCallback((dir: Dir) => {
    const game = gameRef.current!;
    const last = game.queued[game.queued.length - 1] ?? game.dir;
    if (dir === last || dir === OPPOSITE[last] || game.queued.length >= 3) return;
    game.queued.push(dir);
  }, []);

  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key === " ") {
      event.preventDefault();
      setAuto((value) => !value);
      return;
    }
    const dir = KEY_DIR[event.key] ?? KEY_DIR[event.key.toLowerCase()];
    if (!dir) return;
    event.preventDefault();
    event.stopPropagation();
    turn(dir);
  };

  return (
    <div className="flex items-stretch gap-2">
      <div ref={containerRef} className="min-w-0 flex-1">
        <div
          ref={boardRef}
          tabIndex={0}
          role="application"
          aria-label="Snake board. Arrow keys or WASD steer, Space toggles autopilot."
          onKeyDown={onKeyDown}
          className="relative w-fit overflow-hidden rounded border border-border outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <canvas
            ref={canvasRef}
            width={size.cols * CELL}
            height={size.rows * CELL}
            className="block"
            style={{ imageRendering: "pixelated" }}
            onClick={() => boardRef.current?.focus()}
          />
          {!running && (
            <div className="pointer-events-none absolute inset-0 flex items-center justify-center bg-background/30">
              <span className="rounded bg-background/80 px-1.5 py-0.5 font-mono text-[10px] tracking-widest">
                PAUSED · waiting for agent
              </span>
            </div>
          )}
        </div>
        <div className="mt-1 flex gap-3 font-mono text-[10px] text-muted-foreground">
          <span>len {hud.length}</span>
          <span>🍎 {hud.score}</span>
          <span>💥 {hud.crashes}</span>
          <span className="hidden sm:inline">click board · arrows/WASD · space = auto</span>
        </div>
      </div>

      <div className="grid shrink-0 grid-cols-3 gap-0.5 self-start" aria-label="Direction controls">
        <span />
        <DirButton dir="up" icon="ArrowUp" onTurn={turn} />
        <span />
        <DirButton dir="left" icon="ArrowLeft" onTurn={turn} />
        <Button
          variant={auto ? "default" : "outline"}
          size="icon"
          className="size-6 font-mono text-[8px]"
          aria-pressed={auto}
          aria-label="Toggle autopilot"
          onClick={() => setAuto((value) => !value)}
        >
          A
        </Button>
        <DirButton dir="right" icon="ArrowRight" onTurn={turn} />
        <span />
        <DirButton dir="down" icon="ArrowDown" onTurn={turn} />
        <span />
      </div>
    </div>
  );
}

function DirButton({ dir, icon, onTurn }: { dir: Dir; icon: string; onTurn: (dir: Dir) => void }) {
  return (
    <Button
      variant="outline"
      size="icon"
      className="size-6"
      aria-label={`Turn ${dir}`}
      onPointerDown={(event) => {
        // Keep focus in the composer so typing is not interrupted.
        event.preventDefault();
        onTurn(dir);
      }}
    >
      <Icon name={icon} className="size-3" />
    </Button>
  );
}

export default definePluginApp((app) => {
  app.composer.customize({
    id: "snake",
    scopes: ["thread"],
    banners: [{ id: "snake-board", chrome: "card", component: SnakeBanner }],
  });
});
