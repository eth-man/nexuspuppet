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
      'h-8 rounded border border-line bg-surface px-2 text-sm text-ink',
      'focus-visible:border-accent focus-visible:outline-none disabled:opacity-50',
      className,
    )}
    {...props}
  >
    {children}
  </select>
));
Select.displayName = 'Select';
