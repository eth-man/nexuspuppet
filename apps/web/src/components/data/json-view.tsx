'use client';

import { useMemo, useState } from 'react';
import { Search } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';

/**
 * Monospace viewer for facts and other structured data.
 *
 * Facts are read as DATA, not prose: an operator is scanning for a key, or
 * comparing a nested structure against a rule they are about to write.
 * Proportional type destroys the column alignment that makes that possible, so
 * monospace is mandatory here.
 *
 * Keys are sorted and the filter matches on the flattened path, because
 * "does this node have os.family, and what is it?" is the actual question —
 * scrolling a 200-key blob to find out is not an answer.
 */

interface Row {
  path: string;
  value: unknown;
}

function flatten(value: unknown, prefix = '', out: Row[] = []): Row[] {
  if (value === null || typeof value !== 'object') {
    out.push({ path: prefix, value });
    return out;
  }

  if (Array.isArray(value)) {
    // Arrays are shown whole: their order is meaningful and exploding them into
    // numeric paths hides that.
    out.push({ path: prefix, value });
    return out;
  }

  for (const key of Object.keys(value as Record<string, unknown>).sort()) {
    flatten((value as Record<string, unknown>)[key], prefix === '' ? key : `${prefix}.${key}`, out);
  }
  return out;
}

function render(value: unknown): string {
  if (typeof value === 'string') return value;
  return JSON.stringify(value);
}

export function JsonView({
  data,
  className,
}: {
  data: Record<string, unknown>;
  className?: string;
}) {
  const [filter, setFilter] = useState('');

  const rows = useMemo(() => flatten(data), [data]);
  const visible = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    if (needle === '') return rows;
    return rows.filter(
      (row) =>
        row.path.toLowerCase().includes(needle) || render(row.value).toLowerCase().includes(needle),
    );
  }, [rows, filter]);

  return (
    <div className={cn('flex min-h-0 flex-col', className)}>
      <div className="relative border-b border-line-soft p-2">
        <Search
          className="absolute left-4 top-1/2 size-3.5 -translate-y-1/2 text-ink-faint"
          aria-hidden
        />
        <Input
          value={filter}
          onChange={(event) => setFilter(event.target.value)}
          placeholder={`Filter ${rows.length} facts…`}
          className="h-7 pl-7 font-mono text-xs"
          aria-label="Filter facts"
        />
      </div>

      <div className="scroll-x min-h-0 flex-1 overflow-y-auto">
        {visible.length === 0 ? (
          <p className="p-3 text-xs text-ink-faint">No facts match “{filter}”.</p>
        ) : (
          <table className="w-full font-mono text-xs">
            <tbody>
              {visible.map((row) => (
                <tr key={row.path} className="border-b border-line-soft/60 last:border-0 align-top">
                  <td className="w-1/3 whitespace-nowrap py-1 pl-3 pr-2 text-ink-muted">
                    {row.path}
                  </td>
                  <td className="py-1 pr-3 break-all text-ink">{render(row.value)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
