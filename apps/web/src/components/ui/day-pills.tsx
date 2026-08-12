'use client';

import { cn } from '@/lib/utils';

/** Day numbers as JavaScript uses them: 0 is Sunday, 6 is Saturday. */
export type DayNumber = 0 | 1 | 2 | 3 | 4 | 5 | 6;

export const DAYS: ReadonlyArray<{ value: DayNumber; short: string; full: string }> = [
  { value: 0, short: 'Sun', full: 'Sunday' },
  { value: 1, short: 'Mon', full: 'Monday' },
  { value: 2, short: 'Tue', full: 'Tuesday' },
  { value: 3, short: 'Wed', full: 'Wednesday' },
  { value: 4, short: 'Thu', full: 'Thursday' },
  { value: 5, short: 'Fri', full: 'Friday' },
  { value: 6, short: 'Sat', full: 'Saturday' },
];

/**
 * Which days a schedule runs on (issue #72 slice 3).
 *
 * Seven toggles rather than a multi-select, because the answer is read far more
 * often than it is set: "Mon Tue Wed Thu Fri" is legible at a glance in a list
 * of schedules, and a collapsed multi-select showing "5 selected" is not.
 *
 * Values are JavaScript day numbers, NOT positions in this array. A caller
 * storing an index would break the moment somebody adds a Monday-first
 * ordering, and 0-is-Sunday matches `Date.getDay()`, which is what any schedule
 * evaluating this will compare against.
 *
 * Each pill is a real button with `aria-pressed`, inside a labelled group, so
 * the selection is announced rather than inferred from colour — the whole
 * control is otherwise distinguished only by fill.
 */
export function DayPills({
  value,
  onChange,
  label = 'Days',
  disabled = false,
  className,
}: {
  value: readonly DayNumber[];
  onChange: (next: DayNumber[]) => void;
  label?: string;
  disabled?: boolean;
  className?: string;
}) {
  const toggle = (day: DayNumber) => {
    const next = value.includes(day) ? value.filter((d) => d !== day) : [...value, day];
    // Sorted so the stored value does not depend on the order they were
    // clicked in — otherwise two identical schedules compare as different.
    onChange([...next].sort((a, b) => a - b));
  };

  return (
    <div role="group" aria-label={label} className={cn('flex flex-wrap gap-1', className)}>
      {DAYS.map((day) => {
        const on = value.includes(day.value);
        return (
          <button
            key={day.value}
            type="button"
            disabled={disabled}
            aria-pressed={on}
            aria-label={day.full}
            onClick={() => toggle(day.value)}
            className={cn(
              'h-6 min-w-9 rounded border px-1.5 text-2xs transition-colors',
              'disabled:cursor-not-allowed disabled:opacity-50',
              on
                ? 'border-accent bg-accent/15 font-medium text-ink'
                : 'border-line-soft text-ink-muted hover:border-line hover:text-ink',
            )}
          >
            {day.short}
          </button>
        );
      })}
    </div>
  );
}
