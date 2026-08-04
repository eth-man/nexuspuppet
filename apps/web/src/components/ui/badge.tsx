import * as React from 'react';
import { cn } from '@/lib/utils';
import { stateStyle, type DisplayState } from '@/lib/status';

/**
 * A tag: an environment, a class name, a count — something the system produced
 * rather than something a person wrote.
 *
 * MONOSPACED and uppercased. `textContent` is untouched, so `getByText` and
 * the accessible name still see the string that was passed in.
 *
 * `innerText` is NOT untouched — it reports RENDERED text, so a badge styled
 * uppercase reads back as "FAILED" there. An inventory E2E assertion comparing
 * `allInnerTexts()` against "Failed" caught this, having been written when the
 * two were interchangeable. Anything reading a badge's label for comparison
 * should use `textContent`, or compare case-insensitively.
 *
 * The tracking is not decoration: uppercase monospace at this size sets tightly
 * enough that a short identifier reads as one run of letters, and the extra
 * letter-spacing is what keeps it legible.
 */
export function Badge({ className, ...props }: React.HTMLAttributes<HTMLSpanElement>) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded border px-1.5 py-0 leading-5',
        'font-mono text-[10px] font-medium uppercase tracking-[0.08em]',
        'border-line bg-panel-raised text-ink-muted',
        className,
      )}
      {...props}
    />
  );
}

/**
 * The ONLY way to render a Puppet state.
 *
 * Colour comes from the token map in lib/status, so a state cannot be tinted
 * differently on two screens.
 */
export function StateBadge({ state, className }: { state: DisplayState; className?: string }) {
  const style = stateStyle(state);
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded border px-1.5 py-0 leading-5',
        'font-mono text-[10px] font-medium uppercase tracking-[0.08em]',
        style.badge,
        className,
      )}
    >
      <span className={cn('size-1.5 rounded-full', style.dot)} aria-hidden />
      {style.label}
    </span>
  );
}
