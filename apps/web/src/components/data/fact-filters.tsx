'use client';

import { Plus, X } from 'lucide-react';
import type { FactFilter, FactFilterOperator } from '@nexuspuppet/contracts';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { useFactPaths } from '@/lib/queries';

/**
 * Filter the estate by fact (#243).
 *
 * "Which nodes are Ubuntu 22.04" had no answer anywhere: the node list filtered
 * on certname, environment, status and staleness only, and a classification
 * group could report a COUNT but never name the nodes.
 *
 * The operator vocabulary is the SAME one classification rules use, so an
 * operator learns one grammar — and a filter that finds a set of nodes reads
 * like the rule that would classify them.
 */

/** A row being edited. Incomplete rows are held, not sent. */
export interface FactRow {
  path: string;
  operator: FactFilterOperator;
  value: string;
}

const OPERATORS: Array<{ value: FactFilterOperator; label: string; takesValue: boolean }> = [
  { value: 'EQUALS', label: 'is', takesValue: true },
  { value: 'NOT_EQUALS', label: 'is not', takesValue: true },
  { value: 'MATCHES_REGEX', label: 'matches', takesValue: true },
  { value: 'IN', label: 'is one of', takesValue: true },
  { value: 'EXISTS', label: 'is reported', takesValue: false },
  { value: 'NOT_EXISTS', label: 'is not reported', takesValue: false },
];

const takesValue = (operator: FactFilterOperator) =>
  OPERATORS.find((o) => o.value === operator)?.takesValue ?? true;

/**
 * Rows complete enough to query with.
 *
 * A half-typed row must not narrow the estate — somebody typing `os.` should
 * see the list they had, not an empty one, and certainly not a request per
 * keystroke.
 */
export function completeFactRows(rows: FactRow[]): FactFilter[] {
  return rows.flatMap((row) => {
    if (row.path.trim() === '') return [];
    if (!takesValue(row.operator)) {
      return [{ path: row.path.trim(), operator: row.operator }];
    }
    if (row.value.trim() === '') return [];
    if (row.operator === 'IN') {
      const values = row.value
        .split(',')
        .map((v) => v.trim())
        .filter((v) => v !== '');
      return values.length === 0 ? [] : [{ path: row.path.trim(), operator: 'IN', value: values }];
    }
    return [{ path: row.path.trim(), operator: row.operator, value: row.value.trim() }];
  });
}

export function FactFilters({
  rows,
  onChange,
}: {
  rows: FactRow[];
  onChange: (rows: FactRow[]) => void;
}) {
  // Coverage counts come with these, so a path nothing reports can be seen for
  // what it is before anybody filters on it and gets an empty estate.
  const factPaths = useFactPaths();

  /*
   * Distinct observed values for a path, when the estate reports few enough of
   * them to be a list rather than a wall. The API only sends them for
   * low-cardinality paths, so this is undefined for things like `networking.ip`
   * and the field stays free text.
   */
  const valuesFor = (path: string): unknown[] | undefined =>
    factPaths.data?.paths.find((p) => p.path === path.trim())?.values;

  const set = (index: number, patch: Partial<FactRow>) =>
    onChange(rows.map((row, i) => (i === index ? { ...row, ...patch } : row)));

  return (
    <div className="space-y-1">
      {rows.map((row, index) => (
        <div key={index} className="flex items-center gap-1">
          <Input
            value={row.path}
            onChange={(e) => set(index, { path: e.target.value })}
            placeholder="os.release.major"
            className="h-8 flex-1 font-mono"
            list="fact-filter-paths"
            aria-label="Fact"
          />
          <Select
            value={row.operator}
            onChange={(e) => set(index, { operator: e.target.value as FactFilterOperator })}
            className="h-8 w-32 shrink-0"
            aria-label="Operator"
          >
            {OPERATORS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </Select>
          {takesValue(row.operator) && (
            <>
              <Input
                value={row.value}
                onChange={(e) => set(index, { value: e.target.value })}
                placeholder={row.operator === 'IN' ? 'Ubuntu, Debian' : '22.04'}
                className="h-8 flex-1 font-mono"
                aria-label="Value"
                // Observed VALUES for the chosen path, which the classification
                // rule editor has always offered and this did not — knowing the
                // fact is called os.name does not tell you the estate spells it
                // "Ubuntu" rather than "ubuntu".
                list={valuesFor(row.path) === undefined ? undefined : `fact-values-${index}`}
              />
              {valuesFor(row.path) !== undefined && (
                <datalist id={`fact-values-${index}`}>
                  {valuesFor(row.path)?.map((v) => (
                    <option key={String(v)} value={typeof v === 'string' ? v : JSON.stringify(v)} />
                  ))}
                </datalist>
              )}
            </>
          )}
          <Button
            variant="ghost"
            size="sm"
            onClick={() => onChange(rows.filter((_, i) => i !== index))}
            aria-label="Remove this filter"
          >
            <X aria-hidden />
          </Button>
        </div>
      ))}

      {/* Suggestions, never a closed list: a fact this estate reports but the
          projection does not name is still a real fact, and PuppetDB can filter
          on it even though the picker has never heard of it. */}
      {factPaths.data !== undefined && (
        <datalist id="fact-filter-paths">
          {factPaths.data.paths.map((p) => (
            <option key={p.path} value={p.path} label={`${p.nodeCount} nodes`} />
          ))}
        </datalist>
      )}

      <Button
        variant="ghost"
        size="sm"
        onClick={() => onChange([...rows, { path: '', operator: 'EQUALS', value: '' }])}
      >
        <Plus aria-hidden />
        {rows.length === 0 ? 'Filter by fact' : 'Add another fact'}
      </Button>
    </div>
  );
}
