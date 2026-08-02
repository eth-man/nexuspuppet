'use client';

import * as React from 'react';
import { cn } from '@/lib/utils';

/** Native select: keyboard behaviour and mobile pickers come free. */
export const Select = React.forwardRef<
  HTMLSelectElement,
  React.SelectHTMLAttributes<HTMLSelectElement>
>(({ className, children, ...props }, ref) => (
  <select
    ref={ref}
    className={cn(
      // Matches Input, and must keep matching it. `flex` is what puts the
      // control on its own line beneath its Label: without it a select is
      // inline-block and flows alongside the label text, so a select and an
      // input side by side in a form grid land on different baselines. That
      // reads as "the dropdown font is bigger" when it is really 24px higher.
      //
      // `leading-5` for the same reason: a select defaults to line-height
      // normal, which sits its text differently inside an identical box.
      'flex h-8 w-full rounded border border-line bg-surface px-2 text-sm leading-5 text-ink',
      'focus-visible:border-accent focus-visible:outline-none',
      'disabled:cursor-not-allowed disabled:opacity-50',
      className,
    )}
    {...props}
  >
    {children}
  </select>
));
Select.displayName = 'Select';
