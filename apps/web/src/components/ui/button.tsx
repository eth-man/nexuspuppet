'use client';

import * as React from 'react';
import { Slot } from '@radix-ui/react-slot';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '@/lib/utils';

/**
 * Compact button.
 *
 * Default height is 32px rather than shadcn's 40px: this console puts controls
 * in table toolbars and row actions, where the stock size wastes a third of the
 * vertical space available for data.
 */
const buttonVariants = cva(
  'inline-flex items-center justify-center gap-1.5 whitespace-nowrap rounded font-medium transition-colors disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0',
  {
    variants: {
      variant: {
        primary: 'bg-accent text-white hover:bg-accent/85',
        secondary: 'bg-panel-raised text-ink hover:bg-line border border-line',
        ghost: 'text-ink-muted hover:bg-panel-raised hover:text-ink',
        danger:
          'bg-state-failed/15 text-state-failed border border-state-failed/40 hover:bg-state-failed/25',
        link: 'text-accent underline-offset-2 hover:underline',
      },
      size: {
        sm: 'h-7 px-2 text-xs [&_svg]:size-3.5',
        md: 'h-8 px-3 text-sm [&_svg]:size-4',
        lg: 'h-9 px-4 text-sm [&_svg]:size-4',
        icon: 'h-7 w-7 [&_svg]:size-4',
      },
    },
    defaultVariants: { variant: 'secondary', size: 'md' },
  },
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>, VariantProps<typeof buttonVariants> {
  asChild?: boolean;
}

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild = false, ...props }, ref) => {
    const Comp = asChild ? Slot : 'button';
    return (
      <Comp className={cn(buttonVariants({ variant, size }), className)} ref={ref} {...props} />
    );
  },
);
Button.displayName = 'Button';

export { buttonVariants };
