/**
 * Analyst transports.
 *
 * HttpAnalystTransport streams NDJSON AnalystEvents from the API's
 * orchestration endpoint (language model + typed PlayLens tools).
 *
 * LocalToolTransport is the deterministic fallback used when no language
 * model is connected (Masterbrain §29): it runs PlayLens tools for a small set
 * of explicit requests and returns their evidence. It never writes
 * interpretation text, so no AI INTERPRETATION block can appear from it.
 */
import { DATASET_VERSION_UNKNOWN, describeFrame } from "./tools";
import { AnalystEventSchema, type AnalystEvent } from "./schema";
import type { AnalystContext, AnalystRequest, AnalystTransport, ServiceStatus } from "./store";
import { separationEvidence, similarEvidence, compareEvidence, findEventFrame } from "./tools";

const NO_LLM_NOTE =
  "Language model not connected. The Analyst runs PlayLens tools for the requests listed below and reports their results; it cannot interpret free-form questions.";

function playSuggestions(c: AnalystContext): string[] {
  if (c.kind === "play") return [...(c.player_id ? ["Explain this player's separation"] : []), "Find similar plays"];
  if (c.kind === "compare" && c.right_play_id) return ["Compare the structure of these plays"];
  return [];
}

export class LocalToolTransport implements AnalystTransport {
  async status(): Promise<ServiceStatus> {
    return { status: "available", mode: "tools", note: NO_LLM_NOTE };
  }

  suggestions(c: AnalystContext) {
    return playSuggestions(c);
  }

  async run(req: AnalystRequest, emit: (e: AnalystEvent) => void, signal: AbortSignal) {
    const q = req.question.toLowerCase();
    const c = req.context;
    const env = req.env;
    const check = () => {
      if (signal.aborted) throw new DOMException("Aborted", "AbortError");
    };

    const jump = q.match(/\b(jump|go|seek|move|take me)\b.*\b(snap|throw|arrival|catch|handoff|tackle)\b/);
    if (jump && (c.kind === "play" || c.kind === "playlab") && env?.series) {
      emit({ type: "progress", label: "Reading play events" });
      const hit = findEventFrame(env.series, jump[2]);
      if (!hit) {
        emit({ type: "notice", text: `This play has no ${jump[2]} event in the supplied data, so there is no frame to jump to.` });
      } else {
        emit({
          type: "source",
          source: {
            id: "s1",
            tool: "get_play",
            play_ids: [c.play_id],
            player_ids: [],
            frame_range: [hit.frameId, hit.frameId],
            definition: `Supplied event "${hit.code}" at frame ${hit.frameId}.`,
            dataset_version: env.datasetVersion ?? DATASET_VERSION_UNKNOWN,
            model_version: null,
            request_id: null,
          },
        });
        emit({
          type: "command",
          action: { type: "jump_to_frame", play_id: c.play_id, frame_id: hit.frameId, label: `Jump to ${hit.label.toLowerCase()} · frame ${hit.frameId}` },
        });
        emit({ type: "notice", text: `${hit.label} is at frame ${hit.frameId} (${describeFrame(env.series, hit.index)}).` });
      }
      emit({ type: "done" });
      return;
    }

    if (c.kind === "play" && env?.series && /separat|open|nearest|space|cushion/.test(q)) {
      if (!c.player_id || c.frame_id === null) {
        emit({ type: "notice", text: "Select a player first. Separation is measured for one player at a time." });
        emit({ type: "done" });
        return;
      }
      emit({ type: "progress", label: "Reading selected frames" });
      await Promise.resolve();
      check();
      emit({ type: "progress", label: "Computing separation series" });
      const ev = separationEvidence(env.series, c.play_id, c.player_id, c.frame_id, env.datasetVersion ?? null);
      check();
      ev.sources.forEach((source) => emit({ type: "source", source }));
      ev.blocks.forEach((block) => emit({ type: "block", block }));
      emit({ type: "actions", actions: ev.actions });
      emit({ type: "done" });
      return;
    }

    if ((c.kind === "play" || c.kind === "playlab") && env && /similar|like this|resembl/.test(q)) {
      emit({ type: "progress", label: "Searching similar plays" });
      const ev = await similarEvidence(env.client, c.play_id, signal);
      check();
      if (ev.error) {
        emit({ type: "error", message: ev.error, retryable: true });
        return;
      }
      ev.sources.forEach((source) => emit({ type: "source", source }));
      ev.blocks.forEach((block) => emit({ type: "block", block }));
      emit({ type: "actions", actions: ev.actions });
      emit({ type: "done" });
      return;
    }

    if (c.kind === "compare" && c.right_play_id && env && /differ|compare|similar|structur|contrast/.test(q)) {
      emit({ type: "progress", label: "Computing structural measures" });
      const ev = await compareEvidence(env.client, c.left_play_id, c.right_play_id, signal);
      check();
      if (ev.error) {
        emit({ type: "error", message: ev.error, retryable: true });
        return;
      }
      ev.sources.forEach((source) => emit({ type: "source", source }));
      ev.blocks.forEach((block) => emit({ type: "block", block }));
      ev.notices.forEach((text) => emit({ type: "notice", text }));
      emit({ type: "actions", actions: ev.actions });
      emit({ type: "done" });
      return;
    }

    const available = playSuggestions(c);
    const extra = c.kind === "play" || c.kind === "playlab" ? ["Jump to the throw (or snap, arrival, catch)"] : [];
    const list = [...available, ...extra];
    emit({
      type: "notice",
      text: list.length
        ? `This question needs the language model, which is not connected. Requests that run without it: ${list.map((s) => `“${s}”`).join(", ")}.`
        : "This question needs the language model, which is not connected. Open a play to run player and frame tools.",
    });
    emit({ type: "done" });
  }
}

export class HttpAnalystTransport implements AnalystTransport {
  constructor(private readonly baseUrl: string) {}

  async status(): Promise<ServiceStatus> {
    try {
      const res = await fetch(`${this.baseUrl}/api/v1/analyst/status`);
      if (!res.ok) throw new Error(String(res.status));
      const body = (await res.json()) as { available?: boolean; reason?: string | null };
      return body.available
        ? { status: "available", mode: "llm", note: null }
        : { status: "unavailable", mode: "llm", note: body.reason ?? "The Analyst service is unavailable." };
    } catch {
      return { status: "unavailable", mode: "llm", note: "The Analyst service could not be reached. Replay, search, and model views still work." };
    }
  }

  suggestions(c: AnalystContext) {
    return playSuggestions(c);
  }

  async run(req: AnalystRequest, emit: (e: AnalystEvent) => void, signal: AbortSignal) {
    const res = await fetch(`${this.baseUrl}/api/v1/analyst/respond`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/x-ndjson" },
      body: JSON.stringify({ question: req.question, context: req.context }),
      signal,
    });
    if (!res.ok || !res.body) throw new Error(`The Analyst request failed (${res.status}).`);
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let nl: number;
      while ((nl = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line) continue;
        let parsed: unknown;
        try {
          parsed = JSON.parse(line);
        } catch {
          emit({ type: "block", block: null });
          continue;
        }
        const e = AnalystEventSchema.safeParse(parsed);
        emit(e.success ? e.data : { type: "block", block: null });
      }
    }
  }
}
