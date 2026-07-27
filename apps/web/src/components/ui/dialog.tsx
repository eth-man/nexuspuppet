'use client';

import { useEffect, useRef, type ReactNode } from 'react';
import { X } from 'lucide-react';
import { cn } from '@/lib/utils';

/**
 * Modal built on the native <dialog> element.
 *
 * showModal() gives focus trapping, Escape-to-close, inertness of the
 * background, and the top layer for free — all things a hand-rolled overlay
 * gets subtly wrong. That is worth more here than the extra dependency a
 * headless library would add.
 */
export function Dialog({
  open,
  onClose,
  title,
  description,
  children,
  footer,
  className,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: string;
  children: ReactNode;
  footer?: ReactNode;
  className?: string;
}) {
  const ref = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const dialog = ref.current;
    if (dialog === null) return;

    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  return (
    <dialog
      ref={ref}
      onClose={onClose}
      // Clicking the backdrop closes; clicking the panel must not.
      onClick={(event) => {
        if (event.target === ref.current) onClose();
      }}
      className={cn(
        'w-[min(40rem,calc(100vw-2rem))] rounded border border-line bg-panel p-0 text-ink',
        'backdrop:bg-black/60',
        className,
      )}
    >
      <div className="flex items-start justify-between gap-3 border-b border-line-soft px-3 py-2">
        <div className="min-w-0">
          <h2 className="text-sm font-semibold">{title}</h2>
          {description !== undefined && (
            <p className="mt-0.5 text-xs text-ink-muted">{description}</p>
          )}
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close"
          className="rounded p-1 text-ink-faint hover:bg-panel-raised hover:text-ink"
        >
          <X className="size-4" aria-hidden />
        </button>
      </div>

      <div className="max-h-[70vh] overflow-y-auto p-3">{children}</div>

      {footer !== undefined && (
        <div className="flex justify-end gap-2 border-t border-line-soft px-3 py-2">{footer}</div>
      )}
    </dialog>
  );
}
