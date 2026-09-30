"use client";

import { useSyncExternalStore } from "react";

/** Bible §4 viewport classes. */
export type Breakpoint = "xs" | "md" | "lg" | "xl" | "2xl" | "3xl";

const QUERIES: Array<[Breakpoint, string]> = [
  ["3xl", "(min-width: 1600px)"],
  ["2xl", "(min-width: 1440px)"],
  ["xl", "(min-width: 1280px)"],
  ["lg", "(min-width: 1024px)"],
  ["md", "(min-width: 768px)"],
];

function current(): Breakpoint {
  for (const [bp, q] of QUERIES) if (window.matchMedia(q).matches) return bp;
  return "xs";
}

function subscribe(cb: () => void) {
  const mqs = QUERIES.map(([, q]) => window.matchMedia(q));
  mqs.forEach((m) => m.addEventListener("change", cb));
  return () => mqs.forEach((m) => m.removeEventListener("change", cb));
}

export function useBreakpoint(): Breakpoint {
  return useSyncExternalStore(subscribe, current, () => "2xl");
}

const ORDER: Breakpoint[] = ["xs", "md", "lg", "xl", "2xl", "3xl"];
export const atLeast = (bp: Breakpoint, min: Breakpoint) => ORDER.indexOf(bp) >= ORDER.indexOf(min);

export function useReducedMotion(): boolean {
  return useSyncExternalStore(
    (cb) => {
      const m = window.matchMedia("(prefers-reduced-motion: reduce)");
      m.addEventListener("change", cb);
      return () => m.removeEventListener("change", cb);
    },
    () => window.matchMedia("(prefers-reduced-motion: reduce)").matches,
    () => false,
  );
}
