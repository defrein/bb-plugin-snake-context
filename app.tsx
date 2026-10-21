// bb-plugin-snake-context — frontend entry.
//
// A pixel snake in the thread side panel. It moves only while the thread's
// agent runs, and its length is the thread's context-window usage.
import { useCallback, useEffect, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent } from "react";
import {
  definePluginApp,
  experimental_useSidebarThreads,
  useBbNavigate,
  useSdk,
} from "@get-bb/plugin-sdk/app";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";

const PANEL_ACTION_ID = "snake";
const GRID = 24;
const CELL = 14;
const TICK_MS = 140;
const MIN_LENGTH = 3;
// Full context fills this share of the board, leaving room to steer.
const MAX_FILL = 0.75;
const MAX_LENGTH = Math.floor(GRID * GRID * MAX_FILL);
const CONTEXT_POLL_RUNNING_MS = 3_000;
const CONTEXT_POLL_IDLE_MS = 15_000;
const STATUS_POLL_MS = 2_000;

type Point = { x: number; y: number };
type Dir = "up" | "down" | "left" | "right";

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

const RUNNING_STATUSES = new Set(["starting", "active"]);

type ContextUsage = { usedTokens: number; modelContextWindow: number };

/** Whether the thread's agent is running, from the realtime sidebar list with a polling fallback. */
function useAgentRunning(threadId: string): boolean | null {
  const sdk = useSdk();
  const sidebar = experimental_useSidebarThreads();
  const fromSidebar = sidebar.threads.find((thread) => thread.id === threadId);
  const [polled, setPolled] = useState<boolean | null>(null);

  useEffect(() => {
    if (fromSidebar) return;
    const controller = new AbortController();
    const poll = () => {
      sdk.threads.get({ threadId, signal: controller.signal }).then(
        (result) => {
          setPolled(RUNNING_STATUSES.has(result.status));
        },
        () => {},
      );
    };
    poll();
    const timer = window.setInterval(poll, STATUS_POLL_MS);
    return () => {
      controller.abort();
      window.clearInterval(timer);
    };
  }, [sdk, threadId, fromSidebar]);

  if (fromSidebar) return RUNNING_STATUSES.has(fromSidebar.status);
  return polled;
}

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

function lengthForUsage(usage: ContextUsage | null): number {
  if (!usage) return MIN_LENGTH;
  const ratio = Math.min(1, Math.max(0, usage.usedTokens / usage.modelContextWindow));
  return Math.max(MIN_LENGTH, Math.round(ratio * MAX_LENGTH));
}

function formatTokens(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`;
  if (tokens >= 1_000) return `${Math.round(tokens / 1_000)}k`;
  return String(tokens);
}

const wrap = (value: number) => (value + GRID) % GRID;
const same = (a: Point, b: Point) => a.x === b.x && a.y === b.y;

function spawn(length: number): Point[] {
  // Coiled on one cell; the body unfolds as the head moves.
  const centre = { x: Math.floor(GRID / 2), y: Math.floor(GRID / 2) };
  return Array.from({ length }, () => ({ ...centre }));
}

function placeFood(body: readonly Point[]): Point {
  const taken = new Set(body.map((p) => p.y * GRID + p.x));
  if (taken.size >= GRID * GRID) return { x: 0, y: 0 };
  for (;;) {
    const cell = Math.floor(Math.random() * GRID * GRID);
    if (!taken.has(cell)) return { x: cell % GRID, y: Math.floor(cell / GRID) };
  }
}

/** Greedy autopilot: step toward food, avoiding the body when it can. */
function autoSteer(body: readonly Point[], dir: Dir, food: Point): Dir {
  const head = body[0]!;
  const blocked = new Set(body.slice(0, -1).map((p) => p.y * GRID + p.x));
  const options = (Object.keys(DELTA) as Dir[]).filter((d) => d !== OPPOSITE[dir]);
  const score = (d: Dir) => {
    const next = { x: wrap(head.x + DELTA[d].x), y: wrap(head.y + DELTA[d].y) };
    if (blocked.has(next.y * GRID + next.x)) return Number.POSITIVE_INFINITY;
    const dx = Math.min(Math.abs(next.x - food.x), GRID - Math.abs(next.x - food.x));
    const dy = Math.min(Math.abs(next.y - food.y), GRID - Math.abs(next.y - food.y));
    return dx + dy;
  };
  return options.reduce((best, d) => (score(d) < score(best) ? d : best), dir);
}

type Game = {
  body: Point[];
  dir: Dir;
  queued: Dir[];
  food: Point;
  score: number;
  crashes: number;
  flashUntil: number;
};

function newGame(length: number): Game {
  const body = spawn(length);
  return {
    body,
    dir: "right",
    queued: [],
    food: placeFood(body),
    score: 0,
    crashes: 0,
    flashUntil: 0,
  };
}

function readCssColor(element: HTMLElement, variable: string, fallback: string): string {
  const value = getComputedStyle(element).getPropertyValue(variable).trim();
  if (!value) return fallback;
  return /^[\d.]+\s/.test(value) ? `hsl(${value})` : value;
}

function SnakePanel({ threadId }: { threadId: string }) {
  const running = useAgentRunning(threadId);
  const isRunning = running === true;
  const usage = useContextUsage(threadId, isRunning);
  const targetLength = lengthForUsage(usage);

  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const boardRef = useRef<HTMLDivElement | null>(null);
  const gameRef = useRef<Game | null>(null);
  gameRef.current ??= newGame(targetLength);
  const targetLengthRef = useRef(targetLength);
  const autoRef = useRef(false);
  const [auto, setAuto] = useState(false);
  const [hud, setHud] = useState({ score: 0, crashes: 0, length: targetLength });

  targetLengthRef.current = targetLength;
  autoRef.current = auto;

  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const game = gameRef.current!;
    const fg = readCssColor(canvas, "--foreground", "#e5e5e5");
    const muted = readCssColor(canvas, "--muted", "#262626");
    const accent = "#4ade80";
    const head = "#22c55e";
    const food = "#f43f5e";

    ctx.fillStyle = muted;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.globalAlpha = 0.08;
    ctx.fillStyle = fg;
    for (let y = 0; y < GRID; y++) {
      for (let x = 0; x < GRID; x++) {
        if ((x + y) % 2 === 0) ctx.fillRect(x * CELL, y * CELL, CELL, CELL);
      }
    }
    ctx.globalAlpha = 1;

    ctx.fillStyle = food;
    ctx.fillRect(game.food.x * CELL + 3, game.food.y * CELL + 3, CELL - 6, CELL - 6);

    const flashing = performance.now() < game.flashUntil;
    for (let i = game.body.length - 1; i >= 0; i--) {
      const p = game.body[i]!;
      ctx.fillStyle = flashing ? food : i === 0 ? head : accent;
      ctx.globalAlpha = i === 0 ? 1 : 0.55 + 0.45 * (1 - i / game.body.length);
      ctx.fillRect(p.x * CELL + 1, p.y * CELL + 1, CELL - 2, CELL - 2);
    }
    ctx.globalAlpha = 1;
    const h = game.body[0]!;
    ctx.fillStyle = "#052e16";
    ctx.fillRect(h.x * CELL + 4, h.y * CELL + 4, 2, 2);
    ctx.fillRect(h.x * CELL + CELL - 6, h.y * CELL + 4, 2, 2);
  }, []);

  const step = useCallback(() => {
    const game = gameRef.current!;
    const target = targetLengthRef.current;

    // Grow from the tail, or shrink after compaction.
    while (game.body.length < target) game.body.push({ ...game.body[game.body.length - 1]! });
    if (game.body.length > target) game.body.length = target;

    if (autoRef.current) {
      game.queued = [];
      game.dir = autoSteer(game.body, game.dir, game.food);
    } else {
      const next = game.queued.shift();
      if (next && next !== OPPOSITE[game.dir]) game.dir = next;
    }

    const head = game.body[0]!;
    const moved = {
      x: wrap(head.x + DELTA[game.dir].x),
      y: wrap(head.y + DELTA[game.dir].y),
    };
    const tail = game.body.slice(0, -1);
    // Segments still coiled on the spawn cell are not solid yet.
    const bit = tail.some((p, i) => i > 0 && same(p, moved) && !same(p, game.body[i - 1]!));

    if (bit) {
      game.crashes += 1;
      game.body = spawn(target);
      game.dir = "right";
      game.queued = [];
      game.flashUntil = performance.now() + 400;
    } else {
      game.body = [moved, ...tail];
      if (same(moved, game.food)) {
        game.score += 1;
        game.food = placeFood(game.body);
      }
    }
    setHud({ score: game.score, crashes: game.crashes, length: game.body.length });
  }, []);

  useEffect(() => {
    if (!isRunning) {
      draw();
      return;
    }
    const timer = window.setInterval(() => {
      step();
      draw();
    }, TICK_MS);
    return () => window.clearInterval(timer);
  }, [isRunning, step, draw]);

  // Repaint when length changes while frozen, so idle threads still show their size.
  useEffect(() => {
    if (isRunning) return;
    const game = gameRef.current!;
    while (game.body.length < targetLength) game.body.push({ ...game.body[game.body.length - 1]! });
    if (game.body.length > targetLength) game.body.length = targetLength;
    setHud((prev) => ({ ...prev, length: game.body.length }));
    draw();
  }, [isRunning, targetLength, draw]);

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
    turn(dir);
  };

  const percent = usage ? Math.min(100, (usage.usedTokens / usage.modelContextWindow) * 100) : null;
  const statusLabel =
    running === null ? "Checking agent…" : isRunning ? "Agent running" : "Agent idle — paused";

  return (
    <div className="flex h-full min-h-0 flex-col items-center gap-3 overflow-auto p-3 text-sm">
      <div className="flex w-full max-w-[336px] items-center justify-between gap-2 font-mono text-xs">
        <span className="flex items-center gap-1.5">
          <span
            className={cn(
              "inline-block size-2 rounded-full",
              isRunning ? "animate-pulse bg-green-500" : "bg-muted-foreground",
            )}
            aria-hidden
          />
          {statusLabel}
        </span>
        <span className="text-muted-foreground">
          🍎 {hud.score} · 💥 {hud.crashes}
        </span>
      </div>

      <div
        ref={boardRef}
        tabIndex={0}
        role="application"
        aria-label="Snake board. Arrow keys or WASD steer, Space toggles autopilot."
        onKeyDown={onKeyDown}
        className="relative rounded-md border border-border outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <canvas
          ref={canvasRef}
          width={GRID * CELL}
          height={GRID * CELL}
          className="block max-w-full"
          style={{ imageRendering: "pixelated" }}
          onClick={() => boardRef.current?.focus()}
        />
        {!isRunning && (
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center bg-background/40">
            <span className="rounded bg-background/80 px-2 py-1 font-mono text-xs tracking-widest">
              PAUSED
            </span>
          </div>
        )}
      </div>

      <div className="w-full max-w-[336px] space-y-1">
        <div className="flex justify-between font-mono text-xs text-muted-foreground">
          <span>Length {hud.length}</span>
          <span>
            {usage
              ? `${formatTokens(usage.usedTokens)} / ${formatTokens(usage.modelContextWindow)} (${percent!.toFixed(1)}%)`
              : "No context usage yet"}
          </span>
        </div>
        <div className="h-1.5 w-full overflow-hidden rounded bg-muted">
          <div className="h-full bg-green-500 transition-all" style={{ width: `${percent ?? 0}%` }} />
        </div>
      </div>

      <div className="grid grid-cols-3 gap-1" aria-label="Direction controls">
        <span />
        <DirButton dir="up" icon="ArrowUp" onTurn={turn} />
        <span />
        <DirButton dir="left" icon="ArrowLeft" onTurn={turn} />
        <Button
          variant={auto ? "default" : "outline"}
          size="icon"
          className="size-10 font-mono text-[10px]"
          aria-pressed={auto}
          aria-label="Toggle autopilot"
          onClick={() => setAuto((value) => !value)}
        >
          AUTO
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
      className="size-10"
      aria-label={`Turn ${dir}`}
      onPointerDown={(event) => {
        event.preventDefault();
        onTurn(dir);
      }}
    >
      <Icon name={icon} className="size-4" />
    </Button>
  );
}

/** Header button: shows live context share and opens the snake panel. */
function SnakeHeaderButton({ threadId, isCompactViewport }: { threadId: string; isCompactViewport: boolean }) {
  const navigate = useBbNavigate();
  const running = useAgentRunning(threadId) === true;
  const usage = useContextUsage(threadId, running);
  const percent = usage ? Math.round((usage.usedTokens / usage.modelContextWindow) * 100) : null;
  return (
    <Button
      variant="ghost"
      size="sm"
      className="h-7 gap-1 px-2 font-mono text-xs"
      aria-label="Open context snake"
      onClick={() => navigate.openThreadPanel({ actionId: PANEL_ACTION_ID, title: "Snake" })}
    >
      <span className={cn(running && "animate-pulse")} aria-hidden>
        🐍
      </span>
      {!isCompactViewport && percent !== null && <span>{percent}%</span>}
    </Button>
  );
}

export default definePluginApp((app) => {
  app.slots.threadPanelAction({
    id: PANEL_ACTION_ID,
    title: "Snake",
    icon: "Gamepad2",
    layout: "flush",
    component: ({ threadId }) => <SnakePanel key={threadId} threadId={threadId} />,
  });
  app.slots.experimental_threadHeaderAction({
    id: "snake-button",
    title: "Context snake",
    component: SnakeHeaderButton,
  });
});
