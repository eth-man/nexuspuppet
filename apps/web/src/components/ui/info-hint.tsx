'use client';

import { useEffect, useId, useState } from 'react';
import { Info } from 'lucide-react';
import { cn } from '@/lib/utils';

/**
 * An "i" that explains a field without spending a line on it.
 *
 * The settings forms had grown a paragraph under every input. Each one was
 * worth saying — `ldaps://` versus `ldap://` is the difference between a bind
 * password on the wire and not — but together they turned a six-field form into
 * a wall of prose, and prose that is always on screen is prose nobody reads.
 *
 * NOT the `title` attribute. That appears after a delay the user cannot predict,
 * never appears on a touch device, is invisible to keyboard users, and cannot be
 * styled. This opens on hover, on focus, and on click, which covers a pointer, a
 * keyboard and a finger.
 *
 * The text is still in the accessibility tree via `aria-describedby` when open,
 * so it is announced as a description of the control rather than read as a
 * stray paragraph.
 */
export function InfoHint({
  text,
  label,
  className,
}: {
  text: string;
  /** What the icon is about, for screen readers: "About the server URL". */
  label: string;
  className?: string;
}) {
  const id = useId();
  const [open, setOpen] = useState(false);

  // Escape closes it. A tooltip pinned open by a click and dismissable only by
  // finding it again with the mouse is a trap for anyone driving by keyboard.
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open]);

  return (
    <span className={cn('relative inline-flex align-middle', className)}>
      <button
        type="button"
        aria-label={label}
        aria-expanded={open}
        aria-describedby={open ? id : undefined}
        onMouseEnter={() => setOpen(true)}
        onMouseLeave={() => setOpen(false)}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        onClick={() => setOpen((current) => !current)}
        className="rounded-full text-ink-faint transition-colors hover:text-ink focus-visible:text-ink"
      >
        <Info className="size-3.5" aria-hidden />
      </button>

      {open && (
        <span
          role="tooltip"
          id={id}
          /*
           * `left-0 top-full` rather than centred: a centred tooltip on the
           * first field of a row hangs off the left edge of the card, and the
           * text that explains the field is then the text that is clipped.
           */
          className="absolute top-full left-0 z-50 mt-1 w-64 rounded border border-line bg-panel-raised px-2 py-1.5 text-2xs leading-relaxed font-normal text-ink-muted shadow-lg"
        >
          {text}
        </span>
      )}
    </span>
  );
}
