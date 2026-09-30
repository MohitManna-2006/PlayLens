"use client";

import { useLayoutEffect, useState } from "react";

export type Placement = "bottom-start" | "bottom-end" | "top-start" | "top" | "bottom" | "right-start";

export interface FloatingPosition {
  top: number;
  left: number;
  maxHeight: number;
}

/**
 * Fixed-position anchoring for menus, popovers, and tooltips. Flips vertically
 * when there is not enough room and keeps the surface inside the viewport.
 */
export function useFloating(
  anchor: HTMLElement | null,
  floating: HTMLElement | null,
  open: boolean,
  placement: Placement = "bottom-start",
  offset = 4,
): FloatingPosition | null {
  const [pos, setPos] = useState<FloatingPosition | null>(null);

  useLayoutEffect(() => {
    if (!open || !anchor || !floating) return;
    const update = () => {
      const a = anchor.getBoundingClientRect();
      const fw = floating.offsetWidth;
      const fh = floating.offsetHeight;
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      const margin = 8;
      let top: number;
      let left: number;
      if (placement === "right-start") {
        left = a.right + offset;
        top = a.top;
        if (left + fw > vw - margin) left = a.left - fw - offset;
      } else {
        const below = vh - a.bottom - margin;
        const above = a.top - margin;
        const wantTop = placement.startsWith("top");
        const useTop = wantTop ? above >= fh || above > below : below < fh && above > below;
        top = useTop ? a.top - fh - offset : a.bottom + offset;
        if (placement.endsWith("end")) left = a.right - fw;
        else if (placement === "top" || placement === "bottom") left = a.left + a.width / 2 - fw / 2;
        else left = a.left;
      }
      left = Math.max(margin, Math.min(left, vw - fw - margin));
      top = Math.max(margin, top);
      setPos({ top, left, maxHeight: Math.max(160, vh - top - margin) });
    };
    update();
    window.addEventListener("resize", update);
    window.addEventListener("scroll", update, true);
    const ro = new ResizeObserver(update);
    ro.observe(floating);
    return () => {
      window.removeEventListener("resize", update);
      window.removeEventListener("scroll", update, true);
      ro.disconnect();
      setPos(null);
    };
  }, [anchor, floating, open, placement, offset]);

  return open ? pos : null;
}
