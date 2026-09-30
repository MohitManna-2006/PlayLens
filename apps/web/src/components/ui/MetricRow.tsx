import type { ReactNode } from "react";
import { Tooltip } from "./Tooltip";

/**
 * Label, right-aligned value with adjacent unit, and a definition affordance
 * (§13 metric rows). Missing values render as an em dash with a reason.
 */
export function MetricRow({
  label,
  value,
  unit,
  definition,
  missingReason,
  emphasis = false,
  trailing,
}: {
  label: ReactNode;
  value: string;
  unit?: string;
  definition?: string;
  missingReason?: string | null;
  emphasis?: boolean;
  trailing?: ReactNode;
}) {
  const missing = value === "—";
  const labelNode = definition ? (
    <Tooltip content={definition} placement="top">
      <span tabIndex={0} className="cursor-help underline decoration-border decoration-dotted underline-offset-4">
        {label}
      </span>
    </Tooltip>
  ) : (
    label
  );
  return (
    <div className="flex min-h-8 items-baseline gap-3 py-1">
      <dt className="min-w-0 flex-1 text-body-2 text-fg-2">{labelNode}</dt>
      <dd className="text-right">
        <span className={`num ${emphasis ? "text-metric font-medium" : "text-meta"} ${missing ? "text-muted" : "text-fg"}`}>
          {value}
          {!missing && unit ? <span className="ml-1 text-fg-2">{unit}</span> : null}
        </span>
        {missing && missingReason && <span className="block text-caption text-muted">{missingReason}</span>}
      </dd>
      {trailing}
    </div>
  );
}
