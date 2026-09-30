/**
 * Analyst session state. Transcripts are kept per workspace context so closing
 * and reopening preserves history (§5). Each question snapshots its context;
 * results and actions stay pinned to that snapshot (§15).
 */
import { useSyncExternalStore } from "react";
import type { TrackingSeries } from "@/lib/tracking/series";
import type { PlayLensClient } from "@/lib/datasource";
import {
  ActionSchema,
  BlockSchema,
  SourceSchema,
  type AnalystAction,
  type AnalystBlock,
  type AnalystEvent,
  type EvidenceSource,
} from "./schema";

export type AnalystContext =
  | { kind: "explore" }
  | { kind: "evaluation"; model_version: string | null }
  | { kind: "play"; play_id: string; player_id: string | null; player_label: string | null; frame_id: number | null }
  | {
      kind: "compare";
      left_play_id: string;
      right_play_id: string | null;
      alignment: string;
      player_id: string | null;
      player_label: string | null;
    }
  | { kind: "playlab"; play_id: string; editable_frame_id: number | null; player_id: string | null; player_label: string | null };

export function contextKey(c: AnalystContext): string {
  switch (c.kind) {
    case "explore":
      return "explore";
    case "evaluation":
      return "evaluation";
    case "play":
      return `play:${c.play_id}`;
    case "compare":
      return `compare:${c.left_play_id}:${c.right_play_id ?? ""}`;
    case "playlab":
      return `playlab:${c.play_id}`;
  }
}

export function contextLine(c: AnalystContext): string {
  switch (c.kind) {
    case "explore":
      return "Explore · no play selected";
    case "evaluation":
      return c.model_version ? `Evaluation · model ${c.model_version}` : "Evaluation";
    case "play":
      return [`Play ${c.play_id}`, c.player_label ? `Player ${c.player_label}` : "No player selected", c.frame_id !== null ? `Frame ${c.frame_id}` : null]
        .filter(Boolean)
        .join(" · ");
    case "compare":
      return [`Compare ${c.left_play_id} / ${c.right_play_id ?? "—"}`, c.alignment, c.player_label ? `Player ${c.player_label}` : null]
        .filter(Boolean)
        .join(" · ");
    case "playlab":
      return [`PlayLab ${c.play_id}`, c.editable_frame_id !== null ? `Editable frame ${c.editable_frame_id}` : null, c.player_label ? `Defender ${c.player_label}` : null]
        .filter(Boolean)
        .join(" · ");
  }
}

/** Differences that make an older answer's context worth flagging. */
export function contextDiffers(a: AnalystContext, b: AnalystContext): boolean {
  if (contextKey(a) !== contextKey(b)) return true;
  if (a.kind === "play" && b.kind === "play") return a.player_id !== b.player_id || a.frame_id !== b.frame_id;
  if (a.kind === "compare" && b.kind === "compare") return a.player_id !== b.player_id || a.alignment !== b.alignment;
  if (a.kind === "playlab" && b.kind === "playlab") return a.player_id !== b.player_id;
  return false;
}

export interface ToolEnv {
  client: PlayLensClient;
  series?: TrackingSeries | null;
  compare?: { left: TrackingSeries | null; right: TrackingSeries | null } | null;
  datasetVersion?: string | null;
}

export interface ActionOutcome {
  ok: boolean;
  message: string;
  undo?: () => void;
}

export interface WorkspaceBinding {
  getContext(): AnalystContext;
  /** Applies a validated view action to the live workspace. */
  execute?(action: AnalystAction): ActionOutcome;
  tools?: ToolEnv;
}

export interface ServiceStatus {
  status: "checking" | "available" | "unavailable";
  mode: "llm" | "tools";
  note: string | null;
}

export interface AnalystRequest {
  question: string;
  context: AnalystContext;
  env: ToolEnv | null;
}

export interface AnalystTransport {
  status(): Promise<ServiceStatus>;
  run(req: AnalystRequest, emit: (e: AnalystEvent) => void, signal: AbortSignal): Promise<void>;
  /** Contextual prompts offered in the empty state, only when their tools are available. */
  suggestions(context: AnalystContext): string[];
}

export interface AnalystResponse {
  id: string;
  question: string;
  context: AnalystContext;
  status: "in_progress" | "complete" | "failed" | "stopped";
  progress: string | null;
  interpretation: string;
  blocks: AnalystBlock[];
  sources: EvidenceSource[];
  actions: AnalystAction[];
  notices: string[];
  rejected: number;
  error: { message: string; retryable: boolean } | null;
  command: { message: string; undo: (() => void) | null; undone: boolean } | null;
  acknowledgement: string | null;
}

interface State {
  open: boolean;
  transcripts: Record<string, AnalystResponse[]>;
  service: ServiceStatus;
  version: number;
}

let seq = 0;

export class AnalystStore {
  private state: State = {
    open: false,
    transcripts: {},
    service: { status: "checking", mode: "tools", note: null },
    version: 0,
  };
  private listeners = new Set<() => void>();
  private contextListeners = new Set<() => void>();
  private workspace: WorkspaceBinding | null = null;
  private active: { id: string; key: string; controller: AbortController } | null = null;
  private pendingBlocks = new Map<string, AnalystBlock[]>();
  private trigger: HTMLElement | null = null;
  private navigate: (href: string) => void = () => {};

  constructor(private transport: AnalystTransport) {
    void transport.status().then((service) => this.set({ service }));
  }

  setTrigger = (el: HTMLElement | null) => {
    this.trigger = el;
  };

  setNavigate(fn: (href: string) => void) {
    this.navigate = fn;
  }

  getState = () => this.state;
  subscribe = (l: () => void) => {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  };
  subscribeContext = (l: () => void) => {
    this.contextListeners.add(l);
    return () => this.contextListeners.delete(l);
  };

  private set(patch: Partial<State>) {
    this.state = { ...this.state, ...patch, version: this.state.version + 1 };
    this.listeners.forEach((l) => l());
  }

  get suggestionsFor() {
    return (c: AnalystContext) => this.transport.suggestions(c);
  }

  currentContext(): AnalystContext {
    return this.workspace?.getContext() ?? { kind: "explore" };
  }

  bindWorkspace(binding: WorkspaceBinding) {
    this.workspace = binding;
    this.notifyContext();
    return () => {
      if (this.workspace === binding) {
        this.workspace = null;
        this.notifyContext();
      }
    };
  }

  notifyContext() {
    this.contextListeners.forEach((l) => l());
  }

  setOpen(open: boolean) {
    if (open === this.state.open) return;
    this.set({ open });
    if (!open) window.requestAnimationFrame(() => this.trigger?.focus());
  }

  toggle() {
    this.setOpen(!this.state.open);
  }

  private update(key: string, id: string, fn: (r: AnalystResponse) => AnalystResponse) {
    const list = this.state.transcripts[key] ?? [];
    this.set({ transcripts: { ...this.state.transcripts, [key]: list.map((r) => (r.id === id ? fn(r) : r)) } });
  }

  submit(question: string, contextOverride?: AnalystContext, replaceId?: string) {
    const q = question.trim();
    if (!q) return;
    if (this.active) this.stop();
    const context = contextOverride ?? this.currentContext();
    const key = contextKey(context);
    const id = `r${++seq}`;
    const response: AnalystResponse = {
      id,
      question: q,
      context,
      status: "in_progress",
      progress: null,
      interpretation: "",
      blocks: [],
      sources: [],
      actions: [],
      notices: [],
      rejected: 0,
      error: null,
      command: null,
      acknowledgement: null,
    };
    const list = this.state.transcripts[key] ?? [];
    const next = replaceId ? list.map((r) => (r.id === replaceId ? response : r)) : [...list, response];
    this.set({ transcripts: { ...this.state.transcripts, [key]: next } });

    const controller = new AbortController();
    this.active = { id, key, controller };
    this.pendingBlocks.set(id, []);
    const env = contextKey(this.currentContext()) === key ? (this.workspace?.tools ?? null) : null;

    const emit = (e: AnalystEvent) => {
      if (controller.signal.aborted) return;
      this.handle(key, id, e);
    };
    this.transport
      .run({ question: q, context, env }, emit, controller.signal)
      .catch((err: unknown) => {
        if (controller.signal.aborted) return;
        emit({ type: "error", message: err instanceof Error ? err.message : "The request failed.", retryable: true });
      })
      .finally(() => {
        if (this.active?.id === id) this.active = null;
      });
  }

  retry(response: AnalystResponse) {
    this.submit(response.question, response.context, response.id);
  }

  stop() {
    const a = this.active;
    if (!a) return;
    a.controller.abort();
    this.active = null;
    this.update(a.key, a.id, (r) => ({ ...r, status: "stopped", progress: null }));
  }

  get busy() {
    return this.active !== null;
  }

  private flushBlocks(key: string, id: string, final: boolean) {
    const pending = this.pendingBlocks.get(id) ?? [];
    this.update(key, id, (r) => {
      const known = new Set(r.sources.map((s) => s.id));
      const ready: AnalystBlock[] = [];
      const waiting: AnalystBlock[] = [];
      for (const b of pending) {
        const ids = "rows" in b ? b.rows.map((row) => row.source_id) : b.items.map((i) => i.source_id);
        (ids.every((s) => known.has(s)) ? ready : waiting).push(b);
      }
      this.pendingBlocks.set(id, final ? [] : waiting);
      return { ...r, blocks: [...r.blocks, ...ready], rejected: r.rejected + (final ? waiting.length : 0) };
    });
  }

  private handle(key: string, id: string, e: AnalystEvent) {
    switch (e.type) {
      case "progress":
        this.update(key, id, (r) => ({ ...r, progress: e.label }));
        break;
      case "text":
        this.update(key, id, (r) => ({ ...r, interpretation: r.interpretation + e.delta }));
        break;
      case "notice":
        this.update(key, id, (r) => ({ ...r, notices: [...r.notices, e.text] }));
        break;
      case "source": {
        const s = SourceSchema.safeParse(e.source);
        if (s.success) this.update(key, id, (r) => ({ ...r, sources: [...r.sources, s.data] }));
        else this.update(key, id, (r) => ({ ...r, rejected: r.rejected + 1 }));
        this.flushBlocks(key, id, false);
        break;
      }
      case "block": {
        const b = BlockSchema.safeParse(e.block);
        if (b.success) {
          this.pendingBlocks.get(id)?.push(b.data);
          this.flushBlocks(key, id, false);
        } else {
          this.update(key, id, (r) => ({ ...r, rejected: r.rejected + 1 }));
        }
        break;
      }
      case "actions": {
        const valid: AnalystAction[] = [];
        let bad = 0;
        for (const a of e.actions) {
          const p = ActionSchema.safeParse(a);
          if (p.success) valid.push(p.data);
          else bad++;
        }
        this.update(key, id, (r) => ({ ...r, actions: [...r.actions, ...valid], rejected: r.rejected + bad }));
        break;
      }
      case "command": {
        const p = ActionSchema.safeParse(e.action);
        if (!p.success) {
          this.update(key, id, (r) => ({ ...r, rejected: r.rejected + 1 }));
          break;
        }
        const response = this.state.transcripts[key]?.find((r) => r.id === id);
        const outcome = response ? this.runAction(p.data, response.context) : { ok: false, message: "Context unavailable." };
        this.update(key, id, (r) => ({
          ...r,
          command: { message: outcome.message, undo: outcome.ok ? (outcome.undo ?? null) : null, undone: false },
        }));
        break;
      }
      case "done":
        this.flushBlocks(key, id, true);
        this.update(key, id, (r) => ({ ...r, status: "complete", progress: null }));
        break;
      case "error":
        this.flushBlocks(key, id, true);
        this.update(key, id, (r) => ({ ...r, status: "failed", progress: null, error: { message: e.message, retryable: e.retryable } }));
        break;
    }
  }

  undoCommand(response: AnalystResponse) {
    const key = contextKey(response.context);
    response.command?.undo?.();
    this.update(key, response.id, (r) => (r.command ? { ...r, command: { ...r.command, undone: true, undo: null } } : r));
  }

  /**
   * Validates an action against the live workspace and the response's pinned
   * context. View changes apply only when the original play is still open.
   */
  runAction(action: AnalystAction, pinned: AnalystContext): ActionOutcome {
    const current = this.currentContext();
    if (action.type === "open_play") {
      this.navigate(`/play/${encodeURIComponent(action.play_id)}`);
      return { ok: true, message: `Opening play ${action.play_id}` };
    }
    if (action.type === "compare_plays") {
      this.navigate(`/compare?left=${encodeURIComponent(action.left_play_id)}&right=${encodeURIComponent(action.right_play_id)}`);
      return { ok: true, message: "Opening comparison" };
    }
    if (action.type === "apply_filters") {
      const params = new URLSearchParams(Object.entries(action.filters).map(([k, v]) => [k, String(v)]));
      this.navigate(`/explore?${params}`);
      return { ok: true, message: "Filters applied" };
    }
    const playsInView =
      current.kind === "play" || current.kind === "playlab"
        ? [current.play_id]
        : current.kind === "compare"
          ? [current.left_play_id, current.right_play_id].filter((x): x is string => !!x)
          : [];
    if (contextKey(current) !== contextKey(pinned) || !playsInView.includes(action.play_id)) {
      return { ok: false, message: `This action belongs to play ${action.play_id}, which is not open. Open that play to use it.` };
    }
    if (!this.workspace?.execute) return { ok: false, message: "This workspace cannot apply that action." };
    return this.workspace.execute(action);
  }

  acknowledge(response: AnalystResponse, message: string) {
    this.update(contextKey(response.context), response.id, (r) => ({ ...r, acknowledgement: message }));
  }
}

export function useAnalystState(store: AnalystStore) {
  return useSyncExternalStore(store.subscribe, store.getState, store.getState);
}

export function useAnalystContext(store: AnalystStore): AnalystContext {
  const snapshot = useSyncExternalStore(
    store.subscribeContext,
    () => JSON.stringify(store.currentContext()),
    () => JSON.stringify({ kind: "explore" }),
  );
  return JSON.parse(snapshot) as AnalystContext;
}
