"use client";

import { Check, ChevronDown } from "lucide-react";
import type { ReactNode } from "react";
import { Popover } from "./Popover";
import type { Placement } from "./floating";

export interface MenuItem {
  value: string;
  label: string;
  kind?: "radio" | "checkbox" | "action";
  checked?: boolean;
  disabled?: boolean;
  hint?: string;
}

export interface MenuGroup {
  label?: string;
  items: MenuItem[];
}

function focusables(panel: HTMLElement) {
  return Array.from(panel.querySelectorAll<HTMLElement>("[role^='menuitem']:not([aria-disabled='true'])"));
}

/**
 * Menu button with radio/checkbox/action items and roving keyboard focus.
 * Rectangular trigger; active values appear in the trigger label (§6).
 */
export function MenuButton({
  label,
  triggerContent,
  groups,
  onSelect,
  placement = "bottom-start",
  triggerClassName = "btn btn-control",
  active = false,
  width = 220,
  disabled = false,
  showChevron = true,
}: {
  label: string;
  triggerContent: ReactNode;
  groups: MenuGroup[];
  onSelect: (item: MenuItem) => void;
  placement?: Placement;
  triggerClassName?: string;
  active?: boolean;
  width?: number;
  disabled?: boolean;
  showChevron?: boolean;
}) {
  return (
    <Popover
      label={label}
      role="menu"
      placement={placement}
      width={width}
      className="py-1"
      initialFocus={(panel) => {
        const items = focusables(panel);
        return items.find((el) => el.getAttribute("aria-checked") === "true") ?? items[0] ?? null;
      }}
      onPanelKeyDown={(e) => {
        const panel = e.currentTarget;
        const items = focusables(panel);
        const i = items.indexOf(document.activeElement as HTMLElement);
        const move = (n: number) => {
          e.preventDefault();
          items[(n + items.length) % items.length]?.focus();
        };
        if (e.key === "ArrowDown") move(i + 1);
        else if (e.key === "ArrowUp") move(i - 1);
        else if (e.key === "Home") move(0);
        else if (e.key === "End") move(items.length - 1);
      }}
      trigger={(props) => (
        <button
          type="button"
          {...props}
          className={triggerClassName}
          data-active={active}
          disabled={disabled}
          aria-label={typeof triggerContent === "string" ? undefined : label}
        >
          {triggerContent}
          {showChevron && <ChevronDown size={14} strokeWidth={1.5} aria-hidden className="text-muted" />}
        </button>
      )}
    >
      {({ close }) =>
        groups.map((g, gi) => (
          <div key={gi} role="group" aria-label={g.label} className={gi > 0 ? "mt-1 border-t border-border pt-1" : undefined}>
            {g.label && <div className="px-3 pt-2 pb-1 text-caption text-muted">{g.label}</div>}
            {g.items.map((item) => {
              const kind = item.kind ?? "radio";
              const role = kind === "radio" ? "menuitemradio" : kind === "checkbox" ? "menuitemcheckbox" : "menuitem";
              return (
                <div
                  key={item.value}
                  role={role}
                  tabIndex={-1}
                  aria-checked={kind === "action" ? undefined : !!item.checked}
                  aria-disabled={item.disabled || undefined}
                  className={`mx-1 flex min-h-8 cursor-pointer items-start gap-2 rounded-control px-2 py-1.5 text-body-2 outline-none select-none focus-visible:bg-hover focus-visible:outline-2 focus-visible:outline-offset-[-2px] hover:bg-hover ${
                    item.disabled ? "cursor-not-allowed text-muted" : "text-fg"
                  }`}
                  onClick={() => {
                    if (item.disabled) return;
                    onSelect(item);
                    if (kind !== "checkbox") close(true);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      if (item.disabled) return;
                      onSelect(item);
                      if (kind !== "checkbox") close(true);
                    }
                  }}
                >
                  <span className="mt-0.5 inline-flex w-4 shrink-0 justify-center" aria-hidden>
                    {item.checked && <Check size={14} strokeWidth={1.5} className="text-accent" />}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block">{item.label}</span>
                    {item.hint && <span className="block text-caption text-muted">{item.hint}</span>}
                  </span>
                </div>
              );
            })}
          </div>
        ))
      }
    </Popover>
  );
}

/** Single-value select presented as a rectangular filter control. */
export function SelectMenu<T extends string | number>({
  label,
  value,
  options,
  onChange,
  anyLabel = "Any",
  allowAny = true,
  width,
  placement,
  compactLabel,
}: {
  label: string;
  value: T | undefined;
  options: Array<{ value: T; label: string; hint?: string }>;
  onChange: (v: T | undefined) => void;
  anyLabel?: string;
  allowAny?: boolean;
  width?: number;
  placement?: Placement;
  compactLabel?: boolean;
}) {
  const current = options.find((o) => o.value === value);
  const items: MenuItem[] = [
    ...(allowAny ? [{ value: "__any", label: anyLabel, checked: value === undefined }] : []),
    ...options.map((o) => ({ value: String(o.value), label: o.label, hint: o.hint, checked: o.value === value })),
  ];
  return (
    <MenuButton
      label={label}
      active={value !== undefined}
      width={width}
      placement={placement}
      triggerContent={
        <span className="max-w-48 truncate">
          {current ? (compactLabel ? current.label : `${label}: ${current.label}`) : label}
        </span>
      }
      groups={[{ items }]}
      onSelect={(item) => {
        if (item.value === "__any") onChange(undefined);
        else onChange(options.find((o) => String(o.value) === item.value)?.value);
      }}
    />
  );
}
