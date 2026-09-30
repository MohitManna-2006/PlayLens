import type { KeyboardEvent } from "react";
import type { Clock } from "./clock";

function isTyping(el: HTMLElement): boolean {
  return !!el.closest("input, textarea, select, [contenteditable='true'], [role='menu'], [role='dialog'], [role='listbox'], dialog");
}

/**
 * Replay shortcuts (§18). Apply only while focus is inside the replay
 * workspace and no text input or menu consumes the key.
 */
export function handleReplayKey(
  e: KeyboardEvent<HTMLElement>,
  clock: Clock,
  opts: { canPlay: boolean; onEscape?: () => boolean; onSeek?: () => void },
): boolean {
  if (e.defaultPrevented || e.altKey || e.metaKey || e.ctrlKey) return false;
  const target = e.target as HTMLElement;
  if (isTyping(target)) return false;
  const interactive = !!target.closest("button, a[href], [role='checkbox'], [role='radio'], summary");
  const done = () => {
    e.preventDefault();
    e.stopPropagation();
    return true;
  };
  switch (e.key) {
    case " ":
      if (interactive || !opts.canPlay) return false;
      clock.toggle();
      return done();
    case "ArrowLeft":
    case "ArrowRight": {
      const dir = e.key === "ArrowLeft" ? -1 : 1;
      if (!opts.canPlay) return false;
      if (e.shiftKey) clock.stepSeconds(dir);
      else clock.step(dir);
      opts.onSeek?.();
      return done();
    }
    case "Home":
      if (!opts.canPlay) return false;
      clock.toStart();
      opts.onSeek?.();
      return done();
    case "End":
      if (!opts.canPlay) return false;
      clock.toEnd();
      opts.onSeek?.();
      return done();
    case "Escape":
      if (opts.onEscape?.()) return done();
      return false;
  }
  return false;
}
