import * as React from 'react';
import { cn } from '@/lib/utils';

/** Panel surface. One elevation step above the page background, no shadow. */
export function Card({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn('rounded border border-line-soft bg-panel glass-panel', className)}
      {...props}
    />
  );
}

export function CardHeader({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn(
        // `items-start`, not `items-center`: a heading may now be two lines
        // (title + description) and centring the actions against it drops them
        // into the middle of the block rather than aligning with the title.
        'flex items-start justify-between gap-3 border-b border-line-soft px-3 py-2',
        className,
      )}
      {...props}
    />
  );
}

export function CardTitle({ className, ...props }: React.HTMLAttributes<HTMLHeadingElement>) {
  return <h2 className={cn('text-sm font-semibold text-ink', className)} {...props} />;
}

export function CardContent({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('p-3', className)} {...props} />;
}

/**
 * One line under the title saying what the card is for (issue #72 slice 3).
 *
 * Deliberately a sibling of CardTitle rather than a prop on it, so a header can
 * still put badges and actions on the right of a two-line heading — which is
 * what every settings card here already does.
 *
 * One line. A card that needs a paragraph to explain itself is a card whose
 * contents are wrong, and the description competing with the content for
 * attention is how a dense console turns into a document.
 */
export function CardDescription({
  className,
  ...props
}: React.HTMLAttributes<HTMLParagraphElement>) {
  return <p className={cn('mt-0.5 max-w-prose text-2xs text-ink-muted', className)} {...props} />;
}

/**
 * The left half of a card header: title, then description, stacked.
 *
 * Exists so the two lines stay a unit when the header is a flex row with
 * actions on the right — without it every caller wraps them in an anonymous
 * <div> and they drift apart in the ones that forget.
 */
export function CardHeading({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('min-w-0', className)} {...props} />;
}
