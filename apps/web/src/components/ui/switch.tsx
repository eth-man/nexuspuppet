'use client';

import { useId, type ReactNode } from 'react';
import { cn } from '@/lib/utils';

/**
 * A two-state toggle (issue #72 slice 1).
 *
 * Built on a real `<input type="checkbox">` rather than a styled <div> with an
 * onClick. The checkbox brings the label association, the space-bar behaviour,
 * the disabled semantics and the announced checked state for free — all things a
 * hand-rolled switch reimplements badly, and the reason the console had only
 * checkboxes until now.
 *
 * `role="switch"` because the accessible NAME of the control should be read as
 * on/off rather than checked/unchecked; the underlying element is unchanged.
 *
 * Not a replacement for every checkbox. A switch says "this takes effect now"; a
 * checkbox in a form says "this will be included when you save". The roles
 * editor uses checkboxes for exactly that reason, and should keep them.
 */
export function Switch({
  checked,
  onCheckedChange,
  label,
  description,
  disabled = false,
  className,
}: {
  checked: boolean;
  onCheckedChange: (next: boolean) => void;
  label: ReactNode;
  description?: ReactNode;
  disabled?: boolean;
  className?: string;
}) {
  const id = useId();

  return (
    <div className={cn('flex items-start gap-2.5', className)}>
      <input
        id={id}
        type="checkbox"
        role="switch"
        checked={checked}
        disabled={disabled}
        onChange={(event) => onCheckedChange(event.target.checked)}
        className={cn(
          'peer relative mt-0.5 h-4 w-7 shrink-0 cursor-pointer appearance-none rounded-full',
          'border border-line bg-panel-raised transition-colors',
          'checked:border-accent checked:bg-accent',
          'disabled:cursor-not-allowed disabled:opacity-50',
          // The knob. A pseudo-element rather than a second node, so the whole
          // control stays one focusable, labellable element.
          'before:absolute before:top-1/2 before:left-0.5 before:size-2.5 before:-translate-y-1/2',
          'before:rounded-full before:bg-ink-muted before:transition-transform',
          'checked:before:translate-x-3 checked:before:bg-panel',
        )}
      />
      <label
        htmlFor={id}
        className={cn(
          'min-w-0 cursor-pointer select-none',
          disabled && 'cursor-not-allowed opacity-50',
        )}
      >
        <span className="block text-xs text-ink">{label}</span>
        {description !== undefined && (
          <span className="mt-0.5 block max-w-prose text-2xs text-ink-muted">{description}</span>
        )}
      </label>
    </div>
  );
}
