import * as React from 'react';
import { cn } from '@/lib/utils';

/**
 * Dense table primitives.
 *
 * Rows are 32px. At 1080p that fits roughly 25 nodes without scrolling, which
 * is the difference between seeing a pattern in an estate and paging through
 * it. Header is sticky because a long inventory is scrolled, not paged.
 */

export function Table({ className, ...props }: React.TableHTMLAttributes<HTMLTableElement>) {
  return <table className={cn('w-full border-collapse text-sm', className)} {...props} />;
}

export function THead({ className, ...props }: React.HTMLAttributes<HTMLTableSectionElement>) {
  return (
    <thead
      className={cn('sticky top-0 z-10 bg-panel-raised text-ink-muted', className)}
      {...props}
    />
  );
}

export function TBody(props: React.HTMLAttributes<HTMLTableSectionElement>) {
  return <tbody {...props} />;
}

export function TR({ className, ...props }: React.HTMLAttributes<HTMLTableRowElement>) {
  return (
    <tr
      className={cn('border-b border-line-soft last:border-0 hover:bg-panel-raised/50', className)}
      {...props}
    />
  );
}

export function TH({ className, ...props }: React.ThHTMLAttributes<HTMLTableCellElement>) {
  return (
    <th
      className={cn(
        'h-7 whitespace-nowrap px-2 text-left text-[11px] font-medium uppercase tracking-wide',
        className,
      )}
      {...props}
    />
  );
}

export function TD({ className, ...props }: React.TdHTMLAttributes<HTMLTableCellElement>) {
  return <td className={cn('h-8 whitespace-nowrap px-2 align-middle', className)} {...props} />;
}
