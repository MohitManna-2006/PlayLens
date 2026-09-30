"use client";

import { useAnnouncer } from "./Announcer";
import { Tooltip } from "./Tooltip";

/**
 * Long identifier: mono, truncates visually, exposes the complete value on
 * hover, focus, and copy (§3 typography).
 */
export function Identifier({
  value,
  label = "ID",
  className = "",
  maxWidth = 160,
}: {
  value: string;
  label?: string;
  className?: string;
  maxWidth?: number;
}) {
  const { toast } = useAnnouncer();
  return (
    <Tooltip content={`${value} · Click to copy`} describe={false}>
      <button
        type="button"
        aria-label={`${label} ${value}. Copy to clipboard`}
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(value);
            toast(`${label} copied`);
          } catch {
            toast(`Could not copy ${label.toLowerCase()}`);
          }
        }}
        className={`num inline-block truncate rounded-control align-bottom text-meta text-fg-2 hover:text-fg ${className}`}
        style={{ maxWidth }}
      >
        {value}
      </button>
    </Tooltip>
  );
}
