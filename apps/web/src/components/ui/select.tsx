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
      // Matches Input, and must keep matching it. `flex` is the load-bearing
      // part: without it a select is inline-block and flows alongside its
      // Label instead of dropping below it, so a select and an input side by
      // side in a form grid land 24px apart. That reads as "the dropdown font
      // is bigger" when both are 14px — it is a baseline offset, not a size.
      //
      // Do not bother adding a line-height here. A select keeps `line-height:
      // normal` whatever you set; the UA stylesheet wins, verified in Chromium.
      // Matching the box with h-8 is what makes the two line up.
      'flex h-8 w-full rounded border border-line bg-surface px-2 text-sm text-ink',
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
