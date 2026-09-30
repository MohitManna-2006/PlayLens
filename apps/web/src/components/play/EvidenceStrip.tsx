"use client";

import { Tooltip } from "@/components/ui/Tooltip";
import { fixed, playerLabel } from "@/lib/format";

export interface StripItem {
  key: string;
  label: string;
  value: number | null;
  unit: string;
  definition: string;
  source: string;
}

/**
 * Aligned evidence at the current frame (§7 below the dock). Items appear only
 * when their measure is defined; each exposes its definition and source.
 */
export function EvidenceStrip({
  frameId,
  player,
  items,
}: {
  frameId: number;
  player: { jersey: string | null; name: string | null; position: string | null } | null;
  items: StripItem[];
}) {
  return (
    <section aria-label="Evidence at the current frame" className="border-b border-border py-4">
      <h2 className="text-caption text-muted">
        Evidence at <span className="num text-fg-2">frame {frameId}</span>
        {player ? (
          <>
            {" "}
            · <span className="text-fg-2">{playerLabel(player)} {player.position}</span>
          </>
        ) : null}{" "}
        · hover or focus a label for its definition and source
      </h2>
      {!player ? (
        <p className="mt-2 text-body-2 text-fg-2">Select a player to see separation and relative speed at this frame.</p>
      ) : items.length === 0 ? (
        <p className="mt-2 text-body-2 text-fg-2">No measures are defined for this player at this frame (not tracked).</p>
      ) : (
        <dl className="mt-2 flex flex-wrap gap-x-12 gap-y-3">
          {items.map((i) => (
            <div key={i.key} className="min-w-40">
              <dt className="text-body-2 text-fg-2">
                <Tooltip content={`${i.definition} Source: ${i.source}.`}>
                  <span tabIndex={0} className="cursor-help underline decoration-border decoration-dotted underline-offset-4">
                    {i.label}
                  </span>
                </Tooltip>
              </dt>
              <dd className="num text-metric font-medium text-fg">
                {fixed(i.value, 1)}
                <span className="ml-1 text-meta font-normal text-fg-2">{i.unit}</span>
              </dd>
            </div>
          ))}
        </dl>
      )}
    </section>
  );
}
