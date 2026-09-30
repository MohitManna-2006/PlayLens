"use client";

import { X } from "lucide-react";
import { useEffect, useRef, type ReactNode } from "react";

/**
 * Modal dialog on the native <dialog> element: focus is trapped by the
 * browser, Escape closes, and focus returns to the element that opened it.
 */
export function Dialog({
  open,
  onClose,
  title,
  children,
  className = "",
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
  className?: string;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const returnTo = useRef<HTMLElement | null>(null);

  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) {
      returnTo.current = document.activeElement as HTMLElement | null;
      d.showModal();
    } else if (!open && d.open) {
      d.close();
    }
  }, [open]);

  return (
    <dialog
      ref={ref}
      aria-label={title}
      onClose={() => {
        onClose();
        returnTo.current?.focus();
      }}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      className={`m-auto max-h-[calc(100dvh-32px)] w-[min(560px,calc(100vw-32px))] rounded-panel border border-border bg-elevated p-0 text-fg shadow-float ${className}`}
    >
      <div className="flex h-12 items-center justify-between border-b border-border px-4">
        <h2 className="text-panel font-semibold">{title}</h2>
        <button type="button" className="btn btn-quiet btn-icon" onClick={onClose} aria-label="Close">
          <X size={16} strokeWidth={1.5} aria-hidden />
        </button>
      </div>
      <div className="scroll-quiet overflow-auto p-4">{children}</div>
    </dialog>
  );
}
