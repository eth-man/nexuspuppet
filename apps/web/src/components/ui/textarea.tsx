'use client';

import * as React from 'react';
import { cn } from '@/lib/utils';

/** Monospace by default: this is used for JSON and other structured input. */
export const Textarea = React.forwardRef<
  HTMLTextAreaElement,
  React.TextareaHTMLAttributes<HTMLTextAreaElement>
>(({ className, ...props }, ref) => (
  <textarea
    ref={ref}
    className={cn(
      'w-full rounded border border-line bg-surface px-2 py-1.5 font-mono text-xs text-ink',
      'placeholder:text-ink-faint focus-visible:border-accent focus-visible:outline-none',
      'disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-state-failed',
      className,
    )}
    {...props}
  />
));
Textarea.displayName = 'Textarea';
