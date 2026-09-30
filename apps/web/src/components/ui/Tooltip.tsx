"use client";

import { cloneElement, isValidElement, useEffect, useId, useRef, useState, type ReactElement, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useFloating, type Placement } from "./floating";

/**
 * Hover and focus tooltip (§18: every hover affordance also appears on focus).
 * Text only; never the sole carrier of essential information. The wrapper uses
 * display: contents so it does not affect layout; events bubble through it.
 */
export function Tooltip({
  content,
  children,
  placement = "top",
  delay = 350,
  describe = true,
}: {
  content: ReactNode;
  children: ReactElement<{ "aria-describedby"?: string }>;
  placement?: Placement;
  delay?: number;
  /** When false the trigger already has an equivalent accessible name. */
  describe?: boolean;
}) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const [wrapper, setWrapper] = useState<HTMLSpanElement | null>(null);
  const [floating, setFloating] = useState<HTMLDivElement | null>(null);
  const timer = useRef<number | null>(null);
  const anchor = (wrapper?.firstElementChild as HTMLElement | null) ?? null;
  const pos = useFloating(anchor, floating, open, placement, 6);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  useEffect(
    () => () => {
      if (timer.current) window.clearTimeout(timer.current);
    },
    [],
  );

  if (!isValidElement(children)) return children;

  const show = (immediate = false) => {
    if (timer.current) window.clearTimeout(timer.current);
    if (immediate) setOpen(true);
    else timer.current = window.setTimeout(() => setOpen(true), delay);
  };
  const hide = () => {
    if (timer.current) window.clearTimeout(timer.current);
    setOpen(false);
  };

  const trigger = describe && open ? cloneElement(children, { "aria-describedby": id }) : children;

  return (
    <>
      <span
        ref={setWrapper}
        className="contents"
        onPointerEnter={(e) => {
          if (e.pointerType === "mouse") show();
        }}
        onPointerLeave={hide}
        onFocus={(e) => {
          if ((e.target as HTMLElement).matches(":focus-visible")) show(true);
        }}
        onBlur={hide}
        onPointerDown={hide}
      >
        {trigger}
      </span>
      {open &&
        createPortal(
          <div
            ref={setFloating}
            id={id}
            role="tooltip"
            className="float-surface pointer-events-none fixed z-50 max-w-72 px-2 py-1 text-caption text-fg-2"
            style={{
              top: pos?.top ?? -9999,
              left: pos?.left ?? -9999,
              opacity: pos ? 1 : 0,
              transition: "opacity var(--dur-menu) var(--ease-out)",
            }}
          >
            {content}
          </div>,
          document.body,
        )}
    </>
  );
}
