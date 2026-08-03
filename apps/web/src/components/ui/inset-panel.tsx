import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

/**
 * A panel nested inside a card (issue #72 slice 3).
 *
 * For a sub-task that belongs to the card it sits in but is not part of saving
 * it — "test this configuration" being the case that prompted it. Those controls
 * were previously in the card's own action row, next to Save, which read as
 * though testing and saving were two halves of one decision. They are not: one
 * writes and one does not, and putting them side by side invites an operator to
 * treat a successful test as a completed save.
 *
 * Recessed rather than raised: `bg-surface` is the page behind the card, so the
 * panel reads as a hole in the card rather than another card floating on it. In
 * light that inverts — surface is the greyer of the two — and the effect is the
 * same because both themes keep surface and panel one step apart.
 */
export function InsetPanel({
  title,
  description,
  actions,
  children,
  className,
}: {
  title: string;
  description?: string;
  /** Rendered at the top right — the control the panel exists for. */
  actions?: ReactNode;
  children?: ReactNode;
  className?: string;
}) {
  return (
    <section className={cn('rounded border border-line-soft bg-surface', className)}>
      <div className="flex items-start justify-between gap-3 px-2.5 py-2">
        <div className="min-w-0">
          <h3 className="text-xs font-semibold text-ink">{title}</h3>
          {description !== undefined && (
            <p className="mt-0.5 max-w-prose text-[11px] text-ink-muted">{description}</p>
          )}
        </div>
        {actions !== undefined && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
      </div>

      {/*
        Only when there is something. An empty bordered strip under the heading
        is what a panel looks like before its first result arrives, and it reads
        as a rendering fault rather than an empty state.
      */}
      {children !== undefined && children !== null && children !== false && (
        <div className="border-t border-line-soft px-2.5 py-2">{children}</div>
      )}
    </section>
  );
}
