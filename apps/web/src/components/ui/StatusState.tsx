import { AlertTriangle, CircleAlert, Info, LoaderCircle } from "lucide-react";
import type { ReactNode } from "react";

export type StatusKind = "loading" | "empty" | "unavailable" | "partial" | "error" | "warning";

const ICONS = {
  loading: LoaderCircle,
  empty: Info,
  unavailable: Info,
  partial: AlertTriangle,
  warning: AlertTriangle,
  error: CircleAlert,
};

/**
 * Loading, empty, unavailable, partial, and error presentation (§3 common
 * states). Status color always travels with an icon and wording.
 */
export function StatusState({
  kind,
  title,
  children,
  action,
  compact = false,
  className = "",
}: {
  kind: StatusKind;
  title: string;
  children?: ReactNode;
  action?: ReactNode;
  compact?: boolean;
  className?: string;
}) {
  const Icon = ICONS[kind];
  const tone =
    kind === "error" ? "text-error" : kind === "warning" || kind === "partial" ? "text-warning" : "text-muted";
  return (
    <div
      role={kind === "error" ? "alert" : "status"}
      className={`flex items-start gap-3 ${compact ? "" : "py-4"} ${className}`}
    >
      <Icon size={16} strokeWidth={1.5} aria-hidden className={`mt-[3px] shrink-0 ${tone}`} />
      <div className="min-w-0 flex-1">
        <p className={`text-body-2 font-medium ${kind === "error" ? "text-error" : "text-fg"}`}>{title}</p>
        {children && <div className="mt-0.5 text-body-2 text-fg-2">{children}</div>}
        {action && <div className="mt-3 flex flex-wrap gap-2">{action}</div>}
      </div>
    </div>
  );
}

/** Warning line: triangle + wording, never color alone (§3). */
export function WarningLine({ children }: { children: ReactNode }) {
  return (
    <p className="flex items-start gap-2 text-body-2 text-fg-2">
      <AlertTriangle size={14} strokeWidth={1.5} aria-hidden className="mt-[3px] shrink-0 text-warning" />
      <span>{children}</span>
    </p>
  );
}
