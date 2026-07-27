'use client';

import * as React from 'react';
import { cn } from '@/lib/utils';

/** Compact input: 32px tall to match Button's default. */
export const Input = React.forwardRef<
  HTMLInputElement,
  React.InputHTMLAttributes<HTMLInputElement>
>(({ className, type, ...props }, ref) => (
  <input
    type={type}
    ref={ref}
    className={cn(
      'flex h-8 w-full rounded border border-line bg-surface px-2 text-sm text-ink',
      'placeholder:text-ink-faint',
      'focus-visible:border-accent focus-visible:outline-none',
      'disabled:cursor-not-allowed disabled:opacity-50',
      'aria-invalid:border-state-failed',
      className,
    )}
    {...props}
  />
));
Input.displayName = 'Input';
