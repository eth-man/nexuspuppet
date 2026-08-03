'use client';

import { useId, type ReactNode } from 'react';
import { cn } from '@/lib/utils';
import { Label } from '@/components/ui/label';

/**
 * A labelled control, with its hint and its error (issue #72 slice 3).
 *
 * Every settings form in the console had rebuilt this out of a <div>, a <Label>
 * and a <p>, which is fine until they disagree — and they did: some hints sat
 * above the control, some below, and a couple of labels were not associated
 * with anything, so clicking them did nothing and a screen reader announced the
 * input as unlabelled.
 *
 * `children` is a render prop taking the id, because the association has to be
 * real. Passing an element and cloning it to inject an id works until somebody
 * wraps their input in a fragment, and then silently stops working.
 */
export function Field({
  label,
  hint,
  error,
  required = false,
  className,
  children,
}: {
  label: ReactNode;
  hint?: ReactNode;
  /** Shown instead of the hint, and marks the control invalid. */
  error?: string | null;
  required?: boolean;
  className?: string;
  children: (id: string) => ReactNode;
}) {
  const id = useId();
  const invalid = error !== null && error !== undefined && error !== '';

  return (
    <div className={cn('min-w-0 space-y-1', className)}>
      <Label htmlFor={id}>
        {label}
        {required && (
          <span aria-hidden className="ml-0.5 text-state-failed">
            *
          </span>
        )}
      </Label>

      {children(id)}

      {invalid ? (
        <p role="alert" className="text-[11px] text-state-failed">
          {error}
        </p>
      ) : (
        hint !== undefined && <p className="max-w-prose text-[11px] text-ink-faint">{hint}</p>
      )}
    </div>
  );
}

/**
 * Several fields on one line — a wide select beside two narrow inputs.
 *
 * Wraps rather than scrolls, and aligns on the BOTTOM edge of each control. Top
 * alignment looks correct until one field has a two-line label and the controls
 * beside it float upwards; `items-end` keeps the row of inputs level, which is
 * the line the eye actually follows.
 *
 * Widths come from the caller — `className="flex-[2]"` on the wide one,
 * `className="w-28"` on the narrow ones. A prop-driven grid would need a column
 * vocabulary that every caller then has to learn.
 */
export function FieldRow({ className, children }: { className?: string; children: ReactNode }) {
  return <div className={cn('flex flex-wrap items-end gap-2', className)}>{children}</div>;
}
