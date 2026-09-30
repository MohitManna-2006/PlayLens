"use client";

import { Layers } from "lucide-react";
import { MenuButton } from "@/components/ui/Menu";
import { Popover } from "@/components/ui/Popover";
import { DEFINITIONS } from "@/lib/tracking/measures";
import type { Orientation } from "@/lib/tracking/geometry";
import type { OverlayState, RelationshipLayer } from "./renderer";

export type ViewMode = "action" | "full";

export function ViewMenu({
  view,
  orientation,
  directionKnown,
  onView,
  onOrientation,
}: {
  view: ViewMode;
  orientation: Orientation;
  directionKnown: boolean;
  onView: (v: ViewMode) => void;
  onOrientation: (o: Orientation) => void;
}) {
  return (
    <MenuButton
      label="View"
      triggerClassName="btn btn-control"
      triggerContent={<span>{view === "action" ? "Action" : "Full field"}</span>}
      width={260}
      groups={[
        {
          label: "View",
          items: [
            { value: "view:action", label: "Action", hint: "Stable camera around every tracked player, 5 yd padding", checked: view === "action" },
            { value: "view:full", label: "Full field", hint: "120 × 53⅓ yd, letterboxed", checked: view === "full" },
          ],
        },
        {
          label: "Orientation",
          items: [
            {
              value: "o:normalized",
              label: "Direction normalized",
              hint: directionKnown ? "Offense attacks left to right" : "Play direction is not in the metadata",
              checked: orientation === "normalized",
              disabled: !directionKnown,
            },
            { value: "o:source", label: "Source view", hint: "Coordinates as recorded", checked: orientation === "source" },
          ],
        },
      ]}
      onSelect={(item) => {
        const [k, v] = item.value.split(":");
        if (k === "view") onView(v as ViewMode);
        else onOrientation(v as Orientation);
      }}
    />
  );
}

export interface OverlayChange {
  next: OverlayState;
  announcement: string | null;
}

/** Enforces the overlay budget and conflict rules (§12). */
export function changeOverlay(state: OverlayState, patch: Partial<OverlayState>): OverlayChange {
  const next = { ...state, ...patch };
  let announcement: string | null = null;
  if (patch.relationship && patch.relationship !== "none" && state.relationship !== "none" && state.relationship !== patch.relationship) {
    announcement = `${relLabel(patch.relationship)} replaced ${relLabel(state.relationship).toLowerCase()}.`;
  }
  return { next, announcement };
}

function relLabel(r: RelationshipLayer) {
  return r === "nearest_opponent" ? "Nearest opponent" : r === "interaction_graph" ? "Interaction graph" : "None";
}

export function overlaySummary(o: OverlayState, predicted: boolean): string[] {
  const out: string[] = [];
  if (o.trails) out.push("Trails");
  if (o.velocity !== "off") out.push(o.velocity === "all" ? "Velocity (all)" : "Velocity");
  if (o.acceleration) out.push("Acceleration");
  if (o.relationship !== "none") out.push(relLabel(o.relationship));
  if (predicted) out.push("Predicted path");
  return out;
}

function Check({
  label,
  hint,
  checked,
  onChange,
  disabled,
  indent,
}: {
  label: string;
  hint?: string;
  checked: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
  indent?: boolean;
}) {
  return (
    <label className={`flex cursor-pointer items-start gap-2 rounded-control px-2 py-1.5 hover:bg-hover ${indent ? "ml-6" : ""} ${disabled ? "cursor-not-allowed" : ""}`}>
      <input type="checkbox" className="mt-0.5" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
      <span className="min-w-0">
        <span className={`block text-body-2 ${disabled ? "text-muted" : "text-fg"}`}>{label}</span>
        {hint && <span className="block text-caption text-muted">{hint}</span>}
      </span>
    </label>
  );
}

function Radio({ name, label, hint, checked, onChange }: { name: string; label: string; hint?: string; checked: boolean; onChange: () => void }) {
  return (
    <label className="flex cursor-pointer items-start gap-2 rounded-control px-2 py-1.5 hover:bg-hover">
      <input type="radio" name={name} className="mt-0.5" checked={checked} onChange={onChange} />
      <span className="min-w-0">
        <span className="block text-body-2 text-fg">{label}</span>
        {hint && <span className="block text-caption text-muted">{hint}</span>}
      </span>
    </label>
  );
}

export function OverlayControl({
  overlays,
  onChange,
  predicted,
  onPredicted,
  predictedDisabledReason,
  hasSelection,
}: {
  overlays: OverlayState;
  onChange: (patch: Partial<OverlayState>) => void;
  predicted?: boolean;
  onPredicted?: (v: boolean) => void;
  predictedDisabledReason?: string | null;
  hasSelection: boolean;
}) {
  const summary = overlaySummary(overlays, !!predicted);
  const selNote = hasSelection ? "selected player" : "select a player first";
  return (
    <Popover
      label="Overlays"
      width={320}
      className="p-2"
      trigger={(props) => (
        <button type="button" {...props} className="btn btn-control max-w-[min(420px,50vw)]" data-active={summary.length > 0}>
          <Layers size={14} strokeWidth={1.5} aria-hidden />
          <span className="truncate">
            Overlays
            {summary.length > 0 && <span className="text-fg-2"> · {summary.join(", ")}</span>}
          </span>
        </button>
      )}
    >
      {() => (
        <div className="space-y-2">
          <fieldset>
            <legend className="px-2 pt-1 pb-1 text-caption text-muted">Movement</legend>
            <Check label="Trails" hint={DEFINITIONS.trail + " All players."} checked={overlays.trails} onChange={(v) => onChange({ trails: v })} />
            <Check
              label="Velocity"
              hint={`Arrow length = 1 s of travel · ${selNote}`}
              checked={overlays.velocity !== "off"}
              onChange={(v) => onChange({ velocity: v ? "selected" : "off" })}
            />
            {overlays.velocity !== "off" && (
              <Check indent label="All players" hint="Advanced: arrows for every tracked player" checked={overlays.velocity === "all"} onChange={(v) => onChange({ velocity: v ? "all" : "selected" })} />
            )}
            <Check
              label="Acceleration"
              hint={`Dashed arrow in yd/s², replaces the velocity arrow · ${selNote}`}
              checked={overlays.acceleration}
              onChange={(v) => onChange({ acceleration: v })}
            />
          </fieldset>
          <fieldset className="border-t border-border pt-2">
            <legend className="px-2 pt-1 pb-1 text-caption text-muted">Relationships · one at a time</legend>
            <Radio name="rel" label="None" checked={overlays.relationship === "none"} onChange={() => onChange({ relationship: "none" })} />
            <Radio
              name="rel"
              label="Nearest opponent"
              hint={`Dotted segment with distance · ${selNote}`}
              checked={overlays.relationship === "nearest_opponent"}
              onChange={() => onChange({ relationship: "nearest_opponent" })}
            />
            <Radio
              name="rel"
              label="Interaction graph"
              hint={DEFINITIONS.interactionGraph}
              checked={overlays.relationship === "interaction_graph"}
              onChange={() => onChange({ relationship: "interaction_graph" })}
            />
            {overlays.relationship === "interaction_graph" && (
              <Check indent label="All players" hint="Advanced: show every edge at reduced opacity" checked={overlays.graphAll} onChange={(v) => onChange({ graphAll: v })} />
            )}
          </fieldset>
          {onPredicted && (
            <fieldset className="border-t border-border pt-2">
              <legend className="px-2 pt-1 pb-1 text-caption text-muted">Forecast</legend>
              <Check
                label="Predicted path"
                hint={predictedDisabledReason ?? "Pauses replay and opens model controls in the inspector"}
                checked={!!predicted}
                disabled={!!predictedDisabledReason && !predicted}
                onChange={onPredicted}
              />
            </fieldset>
          )}
        </div>
      )}
    </Popover>
  );
}

/* ---------- Legend ---------- */

function Sample({ kind }: { kind: string }) {
  const common = { width: 22, height: 12, viewBox: "0 0 22 12", "aria-hidden": true } as const;
  switch (kind) {
    case "offense":
      return (
        <svg {...common}>
          <circle cx="11" cy="6" r="5" fill="#F2F4F5" stroke="#101214" />
        </svg>
      );
    case "defense":
      return (
        <svg {...common}>
          <circle cx="11" cy="6" r="4.5" fill="#101214" stroke="#F2F4F5" strokeWidth="1.5" />
        </svg>
      );
    case "ball":
      return (
        <svg {...common}>
          <path d="M11 1 L15 6 L11 11 L7 6 Z" fill="#F2F4F5" stroke="#101214" />
        </svg>
      );
    case "trail":
      return (
        <svg {...common}>
          <line x1="1" y1="6" x2="21" y2="6" stroke="rgba(242,244,245,0.45)" strokeWidth="1.5" />
        </svg>
      );
    case "velocity":
      return (
        <svg {...common}>
          <line x1="1" y1="6" x2="17" y2="6" stroke="#F2F4F5" strokeWidth="1.5" />
          <path d="M21 6 L15 3 L15 9 Z" fill="#F2F4F5" />
        </svg>
      );
    case "acceleration":
      return (
        <svg {...common}>
          <line x1="1" y1="6" x2="17" y2="6" stroke="#F2F4F5" strokeWidth="1" strokeDasharray="4 3" />
          <path d="M21 6 L15 3 L15 9 Z" fill="#F2F4F5" />
        </svg>
      );
    case "nearest":
      return (
        <svg {...common}>
          <line x1="1" y1="6" x2="21" y2="6" stroke="#B7C0C8" strokeWidth="1.5" strokeDasharray="1.5 3" strokeLinecap="round" />
        </svg>
      );
    case "graph":
      return (
        <svg {...common}>
          <line x1="1" y1="6" x2="21" y2="6" stroke="#B7C0C8" strokeWidth="1" />
        </svg>
      );
    case "predicted":
      return (
        <svg {...common}>
          <line x1="1" y1="6" x2="16" y2="6" stroke="#E7B66B" strokeWidth="2" strokeDasharray="6 4" />
          <path d="M18 2.5 L21.5 6 L18 9.5 L14.5 6 Z" fill="#E7B66B" />
        </svg>
      );
    case "original":
      return (
        <svg {...common}>
          <line x1="1" y1="6" x2="16" y2="6" stroke="rgba(183,192,200,0.9)" strokeWidth="2" strokeDasharray="6 4" />
          <path d="M18 2.5 L21.5 6 L18 9.5 L14.5 6 Z" fill="rgba(183,192,200,0.9)" />
        </svg>
      );
    case "observed":
      return (
        <svg {...common}>
          <line x1="1" y1="6" x2="16" y2="6" stroke="#F2F4F5" strokeWidth="2" />
          <rect x="15" y="2.5" width="7" height="7" fill="#F2F4F5" />
        </svg>
      );
    case "samples":
      return (
        <svg {...common}>
          <circle cx="6" cy="4" r="1.6" fill="rgba(231,182,107,0.7)" />
          <circle cx="11" cy="8" r="1.6" fill="rgba(231,182,107,0.7)" />
          <circle cx="16" cy="5" r="1.6" fill="rgba(231,182,107,0.7)" />
        </svg>
      );
    case "modified":
      return (
        <svg {...common}>
          <circle cx="11" cy="6" r="5" fill="#E7B66B" stroke="#101214" />
        </svg>
      );
    case "ghost":
      return (
        <svg {...common}>
          <circle cx="11" cy="6" r="5" fill="none" stroke="#F2F4F5" strokeDasharray="2 1.5" />
        </svg>
      );
    default:
      return null;
  }
}

export interface LegendItem {
  kind: string;
  label: string;
}

export function FieldLegend({ items, className = "" }: { items: LegendItem[]; className?: string }) {
  return (
    <ul aria-label="Legend" className={`flex flex-wrap items-center gap-x-3 gap-y-1 ${className}`}>
      {items.map((i) => (
        <li key={i.kind + i.label} className="flex items-center gap-1 text-caption whitespace-nowrap text-fg-2">
          <Sample kind={i.kind} />
          {i.label}
        </li>
      ))}
    </ul>
  );
}

export const TOKEN_LEGEND: LegendItem[] = [
  { kind: "offense", label: "Offense" },
  { kind: "defense", label: "Defense" },
  { kind: "ball", label: "Ball" },
];

/** Analytical overlay legend; shown whenever an overlay is active (§12). */
export function overlayLegend(o: OverlayState, extra: LegendItem[] = []): LegendItem[] {
  const items: LegendItem[] = [];
  if (o.trails) items.push({ kind: "trail", label: "Trail 1 s" });
  if (o.velocity !== "off") items.push({ kind: "velocity", label: "Velocity · 1 s" });
  if (o.acceleration) items.push({ kind: "acceleration", label: "Accel. yd/s²" });
  if (o.relationship === "nearest_opponent") items.push({ kind: "nearest", label: "Nearest opponent" });
  if (o.relationship === "interaction_graph") items.push({ kind: "graph", label: "3-NN graph" });
  return [...items, ...extra];
}
