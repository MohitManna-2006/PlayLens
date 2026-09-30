"use client";

import { Search, SlidersHorizontal, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { DistanceBand, Facets, OutcomeFilter, PlayQuery, PlayType } from "@/lib/contracts";
import { activeFilterCount, DISTANCE_LABELS, OUTCOME_LABELS } from "@/lib/explore/query";
import { ordinal } from "@/lib/format";
import { MenuButton, SelectMenu } from "@/components/ui/Menu";

export function SearchFilterBar({
  query,
  facets,
  onChange,
  onClear,
  compact,
}: {
  query: PlayQuery;
  facets: Facets | undefined;
  onChange: (patch: Partial<PlayQuery>) => void;
  onClear: () => void;
  compact: boolean;
}) {
  const [text, setText] = useState(query.q ?? "");
  const [filtersOpen, setFiltersOpen] = useState(false);
  const timer = useRef<number | null>(null);
  const lastSent = useRef(query.q ?? "");

  useEffect(() => {
    if ((query.q ?? "") !== lastSent.current) {
      lastSent.current = query.q ?? "";
      setText(query.q ?? "");
    }
  }, [query.q]);

  const send = (v: string) => {
    if (timer.current) window.clearTimeout(timer.current);
    lastSent.current = v.trim();
    onChange({ q: v.trim() || undefined });
  };

  const count = activeFilterCount(query);
  const anyActive = count > 0 || !!query.q;

  const downLabel = [query.down ? ordinal(query.down) : null, query.distance ? query.distance : null].filter(Boolean).join(" & ");
  const moreCount = [query.quarter, query.outcome].filter((v) => v !== undefined).length;

  const controls = (
    <>
      <SelectMenu<number>
        label="Season"
        value={query.season}
        options={(facets?.seasons ?? []).map((s) => ({ value: s, label: String(s) }))}
        onChange={(v) => onChange({ season: v })}
      />
      <SelectMenu<string>
        label="Offense"
        value={query.offense}
        options={(facets?.teams ?? []).map((t) => ({ value: t, label: t }))}
        onChange={(v) => onChange({ offense: v })}
      />
      <SelectMenu<string>
        label="Defense"
        value={query.defense}
        options={(facets?.teams ?? []).map((t) => ({ value: t, label: t }))}
        onChange={(v) => onChange({ defense: v })}
      />
      <MenuButton
        label="Down and distance"
        active={query.down !== undefined || query.distance !== undefined}
        triggerContent={<span>{downLabel ? `Down / distance: ${downLabel}` : "Down / distance"}</span>}
        groups={[
          {
            label: "Down",
            items: [
              { value: "down:any", label: "Any down", checked: query.down === undefined },
              ...[1, 2, 3, 4].map((d) => ({ value: `down:${d}`, label: `${ordinal(d)} down`, checked: query.down === d })),
            ],
          },
          {
            label: "Distance to gain",
            items: [
              { value: "dist:any", label: "Any distance", checked: query.distance === undefined },
              ...(["short", "medium", "long"] as const).map((b) => ({ value: `dist:${b}`, label: DISTANCE_LABELS[b], checked: query.distance === b })),
            ],
          },
        ]}
        onSelect={(item) => {
          const [k, v] = item.value.split(":");
          if (k === "down") onChange({ down: v === "any" ? undefined : Number(v) });
          else onChange({ distance: v === "any" ? undefined : (v as DistanceBand) });
        }}
      />
      <SelectMenu<PlayType>
        label="Play type"
        value={query.play_type}
        options={(facets?.play_types ?? ["pass", "run"]).map((t) => ({ value: t, label: t === "pass" ? "Pass" : t === "run" ? "Run" : "Other" }))}
        onChange={(v) => onChange({ play_type: v })}
      />
      <MenuButton
        label="More filters"
        active={moreCount > 0}
        triggerContent={<span>{moreCount ? `More filters (${moreCount})` : "More filters"}</span>}
        groups={[
          {
            label: "Quarter",
            items: [
              { value: "q:any", label: "Any quarter", checked: query.quarter === undefined },
              ...(facets?.quarters ?? [1, 2, 3, 4]).map((q) => ({ value: `q:${q}`, label: `Q${q}`, checked: query.quarter === q })),
            ],
          },
          {
            label: "Result",
            items: [
              { value: "o:any", label: "Any result", checked: query.outcome === undefined },
              ...(Object.keys(OUTCOME_LABELS) as OutcomeFilter[]).map((o) => ({ value: `o:${o}`, label: OUTCOME_LABELS[o], checked: query.outcome === o })),
            ],
          },
        ]}
        onSelect={(item) => {
          const [k, v] = item.value.split(":");
          if (k === "q") onChange({ quarter: v === "any" ? undefined : Number(v) });
          else onChange({ outcome: v === "any" ? undefined : (v as OutcomeFilter) });
        }}
      />
      {anyActive && (
        <button type="button" className="btn btn-quiet" onClick={onClear}>
          Clear filters
        </button>
      )}
    </>
  );

  return (
    <div>
      <form
        role="search"
        className="relative w-full max-w-[640px]"
        onSubmit={(e) => {
          e.preventDefault();
          send(text);
        }}
      >
        <label htmlFor="play-search" className="sr-only">
          Search plays
        </label>
        <Search size={16} strokeWidth={1.5} aria-hidden className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-muted" />
        <input
          id="play-search"
          type="search"
          className="input h-10 pr-9 pl-9"
          placeholder="Search teams, play descriptions, or play ID"
          value={text}
          autoComplete="off"
          onChange={(e) => {
            const v = e.target.value;
            setText(v);
            if (timer.current) window.clearTimeout(timer.current);
            timer.current = window.setTimeout(() => send(v), 250);
          }}
        />
        {text && (
          <button
            type="button"
            aria-label="Clear search"
            className="btn btn-quiet btn-icon absolute top-1/2 right-1 h-8 -translate-y-1/2"
            onClick={() => {
              setText("");
              send("");
            }}
          >
            <X size={14} strokeWidth={1.5} aria-hidden />
          </button>
        )}
      </form>

      {compact ? (
        <div className="mt-3">
          <button
            type="button"
            className="btn btn-control"
            aria-expanded={filtersOpen}
            aria-controls="explore-filters"
            onClick={() => setFiltersOpen((v) => !v)}
          >
            <SlidersHorizontal size={14} strokeWidth={1.5} aria-hidden />
            {count ? `Filters (${count})` : "Filters"}
          </button>
          {filtersOpen && (
            <div id="explore-filters" className="mt-3 flex flex-wrap gap-2">
              {controls}
            </div>
          )}
        </div>
      ) : (
        <div className="mt-4 flex min-h-9 flex-wrap items-center gap-2 [&_.btn]:h-9" aria-label="Filters" role="group">
          {controls}
        </div>
      )}
    </div>
  );
}
