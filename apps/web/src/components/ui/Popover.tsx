"use client";

import { useCallback, useEffect, useId, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useFloating, type Placement } from "./floating";

export interface PopoverRenderApi {
  close: (returnFocus?: boolean) => void;
}

interface PopoverProps {
  /** Renders the trigger. Spread `props` onto a button. */
  trigger: (props: {
    ref: (el: HTMLButtonElement | null) => void;
    onClick: () => void;
    "aria-expanded": boolean;
    "aria-controls": string;
    "aria-haspopup": "dialog" | "menu";
  }) => ReactNode;
  children: (api: PopoverRenderApi) => ReactNode;
  label: string;
  placement?: Placement;
  role?: "dialog" | "menu";
  className?: string;
  width?: number;
  onOpenChange?: (open: boolean) => void;
  /** Keyboard handling for menus (roving focus). */
  onPanelKeyDown?: (e: ReactKeyboardEvent<HTMLDivElement>) => void;
  initialFocus?: (panel: HTMLDivElement) => HTMLElement | null;
}

/**
 * Anchored, non-modal floating surface. Escape closes the most local layer and
 * returns focus to the trigger; clicking outside closes without stealing focus.
 */
export function Popover({
  trigger,
  children,
  label,
  placement = "bottom-start",
  role = "dialog",
  className = "",
  width,
  onOpenChange,
  onPanelKeyDown,
  initialFocus,
}: PopoverProps) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const [anchor, setAnchor] = useState<HTMLButtonElement | null>(null);
  const [panel, setPanel] = useState<HTMLDivElement | null>(null);
  const pos = useFloating(anchor, panel, open, placement);

  const setOpenState = useCallback(
    (v: boolean) => {
      setOpen(v);
      onOpenChange?.(v);
    },
    [onOpenChange],
  );

  const close = useCallback(
    (returnFocus = true) => {
      setOpenState(false);
      if (returnFocus) anchor?.focus();
    },
    [setOpenState, anchor],
  );

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node;
      if (panel?.contains(t) || anchor?.contains(t)) return;
      setOpenState(false);
    };
    document.addEventListener("pointerdown", onDown, true);
    return () => document.removeEventListener("pointerdown", onDown, true);
  }, [open, setOpenState, panel, anchor]);

  useEffect(() => {
    if (!open || !pos || !panel) return;
    if (panel.contains(document.activeElement)) return;
    const target =
      initialFocus?.(panel) ?? panel.querySelector<HTMLElement>("[data-autofocus], input, button, [tabindex='0'], a[href]");
    target?.focus();
  }, [open, pos, panel, initialFocus]);

  return (
    <>
      {trigger({
        ref: setAnchor,
        onClick: () => setOpenState(!open),
        "aria-expanded": open,
        "aria-controls": id,
        "aria-haspopup": role,
      })}
      {open &&
        createPortal(
          <div
            ref={setPanel}
            id={id}
            role={role}
            aria-label={label}
            className={`float-surface scroll-quiet fixed z-40 overflow-auto ${className}`}
            style={{
              top: pos?.top ?? -9999,
              left: pos?.left ?? -9999,
              maxHeight: pos?.maxHeight,
              width,
              opacity: pos ? 1 : 0,
              transform: pos ? "none" : "translateY(-4px)",
              transition: "opacity var(--dur-menu) var(--ease-out), transform var(--dur-menu) var(--ease-out)",
            }}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                e.stopPropagation();
                e.preventDefault();
                close(true);
                return;
              }
              if (e.key === "Tab" && role === "menu") {
                close(false);
                return;
              }
              onPanelKeyDown?.(e);
            }}
          >
            {children({ close })}
          </div>,
          document.body,
        )}
    </>
  );
}
