"use client";

import { createContext, useCallback, useContext, useRef, useState, type ReactNode } from "react";

interface Ctx {
  announce: (message: string) => void;
  toast: (message: string) => void;
}

const AnnouncerContext = createContext<Ctx>({ announce: () => {}, toast: () => {} });

export const useAnnouncer = () => useContext(AnnouncerContext);

/**
 * Polite live region for user-requested changes (frame jumps, validation,
 * completed tools) and brief toasts such as "Play ID copied". Toasts are never
 * the only record of a failure.
 */
export function AnnouncerProvider({ children }: { children: ReactNode }) {
  const [message, setMessage] = useState("");
  const [toastText, setToastText] = useState<string | null>(null);
  const timer = useRef<number | null>(null);

  const announce = useCallback((m: string) => {
    setMessage("");
    window.requestAnimationFrame(() => setMessage(m));
  }, []);

  const toast = useCallback(
    (m: string) => {
      setToastText(m);
      announce(m);
      if (timer.current) window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => setToastText(null), 2400);
    },
    [announce],
  );

  return (
    <AnnouncerContext.Provider value={{ announce, toast }}>
      {children}
      <div aria-live="polite" aria-atomic="true" className="sr-only">
        {message}
      </div>
      {toastText && (
        <div
          aria-hidden
          className="float-surface fixed bottom-6 left-1/2 z-50 -translate-x-1/2 px-3 py-2 text-body-2 text-fg"
        >
          {toastText}
        </div>
      )}
    </AnnouncerContext.Provider>
  );
}
