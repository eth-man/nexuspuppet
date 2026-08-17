'use client';

import { useMemo } from 'react';
import { RefreshCw } from 'lucide-react';
import type { ClassIndex, ClassParameterSuggestion, ClassSuggestion } from '@nexuspuppet/contracts';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';

/**
 * Class name and parameter entry, with suggestions from puppetserver (ADR-0024).
 *
 * NOTHING HERE MAY BLOCK A WRITE (§9). Every failure — no PUPPETSERVER_URL, a
 * missing auth.conf rule, a timeout, a manifest that will not parse — ends with
 * the operator still able to type a class name and JSON and press save. The
 * suggestions are an enhancement over that, never a gate in front of it.
 */

/**
 * Which of three things the status area should say.
 *
 * Extracted so the decision is testable without a DOM. The rendering below is
 * layout; THIS is the judgement, and it is the part that was wrong.
 */
export type SuggestionNotice = 'nothing' | 'unconfigured' | 'status';

export function suggestionNotice(index: ClassIndex | undefined): SuggestionNotice {
  // Still loading, or the request itself failed. Saying anything here would
  // flicker a message on every dialog open.
  if (index === undefined) return 'nothing';

  /*
   * NOT SILENT ANY MORE (ADR-0024 §4, amended).
   *
   * §4 made an unset PUPPETSERVER_URL render nothing at all, so an operator who
   * never wanted this feature would never be nagged about it. The cost only
   * became visible in use: an operator who DID want it saw an empty field, no
   * hint the capability existed, and no way to tell "off" from "broken". They
   * upgraded specifically for this and spent an evening on it.
   *
   * One faint line, in the dialog where the feature would appear, is not a nag.
   * It is the difference between a deliberate default and an apparent fault.
   */
  if (index.status === 'disabled') return 'unconfigured';

  return 'status';
}

/** The suggestion list, its environment, its age, and why it is degraded. */
export function ClassSuggestionStatus({
  index,
  onRefresh,
  refreshing,
}: {
  index: ClassIndex | undefined;
  onRefresh: () => void;
  refreshing: boolean;
}) {
  const notice = suggestionNotice(index);
  if (notice === 'nothing' || index === undefined) return null;

  if (notice === 'unconfigured') {
    return (
      <p className="border-t border-line-soft pt-1.5 text-2xs text-ink-faint">
        Class suggestions are not configured. Set{' '}
        <code className="font-mono">PUPPETSERVER_URL</code> to list the classes in your Puppet
        environment, with their parameters — DEPLOYMENT.md §6.
      </p>
    );
  }

  const degraded = index.status !== 'ok';

  return (
    <div className="space-y-1 border-t border-line-soft pt-1.5">
      <div className="flex items-center justify-between gap-2">
        <span className="text-2xs text-ink-faint">
          {/* The environment is NAMED. Suggestions for the wrong environment
              look entirely plausible — every name is real, just not here — and
              the failure only surfaces as a compile error later (§7). */}
          {index.classes.length} class{index.classes.length === 1 ? '' : 'es'} in{' '}
          <span className="font-mono text-ink">{index.environment}</span>
          {index.fetchedAt !== null && <> · fetched {relativeTime(index.fetchedAt)}</>}
        </span>

        {/* The r10k answer (§8). An operator who has just deployed code wants to
            classify it NOW, and a cache with no way to force the issue is worse
            than no cache. */}
        <Button variant="ghost" size="sm" onClick={onRefresh} disabled={refreshing}>
          <RefreshCw aria-hidden className={refreshing ? 'animate-spin' : undefined} />
          {refreshing ? 'Refreshing…' : 'Refresh'}
        </Button>
      </div>

      {/*
       * THE TWO-CACHE TRAP (§8). puppetserver holds its own class cache when
       * environment-class-cache-enabled is on, and keeps serving pre-deployment
       * classes until r10k flushes its environment cache. Flushing it is a
       * mutation we do not perform, so the refresh genuinely changed nothing —
       * and without saying so it reads as our bug.
       */}
      {index.unchangedAfterRefresh === true && (
        <p className="text-2xs text-state-pending">
          Refreshed — the class list is unchanged. If you have just deployed code, your Puppet
          server may still be serving its cached environment.
        </p>
      )}

      {degraded && index.message !== undefined && (
        <p className="text-2xs text-state-pending">{index.message}</p>
      )}

      {/* One broken manifest must not silently shorten the list. An operator
          hunting a missing class deserves to know a FILE is at fault. */}
      {index.fileErrors.length > 0 && (
        <p className="text-2xs text-state-pending">
          {index.fileErrors.length} manifest{index.fileErrors.length === 1 ? '' : 's'} could not be
          parsed, so this list is incomplete:{' '}
          <span className="font-mono">{index.fileErrors[0]?.path ?? 'unknown file'}</span>
          {index.fileErrors.length > 1 && ` and ${index.fileErrors.length - 1} more`}
        </p>
      )}
    </div>
  );
}

/**
 * Suggestions for the class-name field.
 *
 * A `datalist`, not a select. The operator may type a class that does not exist
 * yet — one they are about to write — and refusing it would be worse than the
 * guessing this replaces. Unknown names are marked, never blocked.
 */
export function ClassNameSuggestions({ id, index }: { id: string; index: ClassIndex | undefined }) {
  if (index === undefined || index.classes.length === 0) return null;
  return (
    <datalist id={id}>
      {index.classes.map((c) => (
        <option key={c.name} value={c.name} label={c.path ?? undefined} />
      ))}
    </datalist>
  );
}

export function findClass(index: ClassIndex | undefined, name: string): ClassSuggestion | null {
  if (index === undefined) return null;
  return index.classes.find((c) => c.name === name) ?? null;
}

/**
 * A form for a class whose signature we know.
 *
 * DEFAULTS ARE PLACEHOLDERS, NEVER VALUES. Prefilling a default as an actual
 * value would send it to the ENC, so the group would pin the module's own
 * default as an override — noise in every document, and worse, the value would
 * stop tracking the module when its default later changes. An empty field means
 * "let the class decide", which is what the operator means when they leave it
 * alone.
 */
export function ClassParameterForm({
  klass,
  values,
  onChange,
}: {
  klass: ClassSuggestion;
  values: Record<string, string>;
  onChange: (next: Record<string, string>) => void;
}) {
  const required = useMemo(() => klass.params.filter((p) => p.kind === 'required'), [klass]);

  if (klass.params.length === 0) {
    return <p className="text-2xs text-ink-faint">This class takes no parameters.</p>;
  }

  const set = (name: string, value: string) => onChange({ ...values, [name]: value });

  return (
    <div className="space-y-2">
      {required.length > 0 && (
        <p className="text-2xs text-ink-faint">
          {required.length} required parameter{required.length === 1 ? '' : 's'}. Leave anything
          else blank to use the class default.
        </p>
      )}
      {required.length === 0 && (
        <p className="text-2xs text-ink-faint">
          Every parameter has a default. Leave them blank to use it.
        </p>
      )}

      {klass.params.map((param) => (
        <ParameterField
          key={param.name}
          param={param}
          value={values[param.name] ?? ''}
          onChange={(v) => set(param.name, v)}
        />
      ))}
    </div>
  );
}

function ParameterField({
  param,
  value,
  onChange,
}: {
  param: ClassParameterSuggestion;
  value: string;
  onChange: (value: string) => void;
}) {
  const fieldId = `param-${param.name}`;

  return (
    <div className="space-y-1">
      <Label htmlFor={fieldId}>
        <span className="font-mono">{param.name}</span>
        {param.kind === 'required' && <span className="ml-1 text-state-failed">required</span>}
        {/* `= undef` is a DEFAULT, so this parameter is optional. Calling it
            required told an operator four omissible parameters were mandatory. */}
        {param.kind === 'undef' && <span className="ml-1 text-ink-faint">optional</span>}
        {param.type !== null && (
          <span className="ml-1.5 font-mono text-3xs text-ink-faint">{param.type}</span>
        )}
      </Label>

      {/* An Enum carries its own option list, so the field cannot hold a value
          the class would reject. */}
      {param.enumValues.length > 0 ? (
        <Select id={fieldId} value={value} onChange={(e) => onChange(e.target.value)}>
          <option value="">
            {param.kind === 'required'
              ? 'choose…'
              : param.kind === 'literal'
                ? `default (${String(param.defaultValue ?? '')})`
                : 'default'}
          </option>
          {param.enumValues.map((option) => (
            <option key={option} value={JSON.stringify(option)}>
              {option}
            </option>
          ))}
        </Select>
      ) : (
        <Input
          id={fieldId}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className="font-mono"
          placeholder={placeholderFor(param)}
        />
      )}

      {param.kind === 'undef' && (
        <p className="text-2xs text-ink-faint">
          Defaults to <span className="font-mono">undef</span> — leave blank to omit it entirely.
        </p>
      )}

      {param.kind === 'expression' && (
        <p className="text-2xs text-ink-faint">
          {/* A $-prefixed default resolves at compile time. Showing it as a
              value would be a lie about what the class does. */}
          Defaults to <span className="font-mono">{param.defaultSource}</span>, evaluated when the
          catalog compiles. Leave blank to keep that.
        </p>
      )}
    </div>
  );
}

/**
 * JSON values, so a string stays quoted and a number does not.
 *
 * The API validates against the same Puppet value schema either way; this only
 * decides what the operator sees before it gets there.
 */
function placeholderFor(param: ClassParameterSuggestion): string {
  if (param.kind === 'literal') return `default: ${JSON.stringify(param.defaultValue)}`;
  if (param.kind === 'expression') return `default: ${param.defaultSource ?? ''}`;
  // Optional, and there is no value to suggest — saying "required" here is what
  // the reported bug looked like from the field itself.
  if (param.kind === 'undef') return 'optional — leave blank to omit';
  return 'required — JSON value, e.g. "text" or 42';
}

/**
 * Form fields to the JSON body the API takes.
 *
 * A blank field is OMITTED, not sent as null: blank means "let the class
 * decide", and sending null would override the default with undef.
 */
export function paramsToJson(values: Record<string, string>): {
  json: string;
  error: string | null;
} {
  const out: Record<string, unknown> = {};

  for (const [name, raw] of Object.entries(values)) {
    const text = raw.trim();
    if (text === '') continue;
    try {
      out[name] = JSON.parse(text);
    } catch {
      // Bare text is the overwhelmingly common intent — an operator typing a
      // hostname should not have to quote it — so fall back to a string rather
      // than refusing. Anything JSON can express still round-trips exactly.
      out[name] = text;
    }
  }

  return { json: JSON.stringify(out, null, 2), error: null };
}

function relativeTime(iso: string): string {
  const seconds = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000));
  if (seconds < 60) return 'just now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  return `${Math.round(minutes / 60)}h ago`;
}
