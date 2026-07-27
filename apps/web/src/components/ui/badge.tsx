import * as React from 'react';
import { cn } from '@/lib/utils';
import { stateStyle, type DisplayState } from '@/lib/status';

export function Badge({ className, ...props }: React.HTMLAttributes<HTMLSpanElement>) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded border px-1.5 py-0 text-[11px] font-medium leading-5',
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
        'inline-flex items-center gap-1.5 rounded border px-1.5 py-0 text-[11px] font-medium leading-5',
        style.badge,
        className,
      )}
    >
      <span className={cn('size-1.5 rounded-full', style.dot)} aria-hidden />
      {style.label}
    </span>
  );
}
