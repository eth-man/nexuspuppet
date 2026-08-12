'use client';

import { use, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { ArrowLeft, Plus, Trash2 } from 'lucide-react';
import {
  puppetValueSchema,
  type ClassificationWriteResult,
  type MatchStrategy,
  type NodeRule,
  type PuppetValue,
  type RuleOperator,
  puppetClassNameSchema,
} from '@nexuspuppet/contracts';
import { z } from 'zod';
import { useClassNames, useFactPaths, useNodeGroup, useRefreshClassNames } from '@/lib/queries';
import {
  ClassNameSuggestions,
  ClassParameterForm,
  ClassSuggestionStatus,
  findClass,
  paramsToJson,
} from '@/components/data/class-picker';
import {
  useAddPins,
  useAssignClass,
  useDeleteGroup,
  useRemoveClass,
  useRemoveParameter,
  useRemovePin,
  useReplaceRules,
  useSetParameter,
  useUpdateGroup,
} from '@/lib/mutations';
import { ApiError } from '@/lib/client';
import { useAuth } from '@/providers/auth-provider';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { Badge } from '@/components/ui/badge';
import { Card, CardHeader, CardTitle } from '@/components/ui/card';
import { Dialog } from '@/components/ui/dialog';
import { PlanReviewProvider, usePlanReview } from '@/components/data/plan-review';
import { Forbidden, QueryError, Spinner } from '@/components/states';
import { WriteResult } from '@/components/data/write-result';

const OPERATORS: RuleOperator[] = [
  'EQUALS',
  'NOT_EQUALS',
  'MATCHES_REGEX',
  'NOT_MATCHES_REGEX',
  'IN',
  'NOT_IN',
  'GREATER_THAN',
  'LESS_THAN',
  'EXISTS',
  'NOT_EXISTS',
];

/** Operators that take no operand — the value field is meaningless for these. */
const NO_VALUE: ReadonlySet<RuleOperator> = new Set(['EXISTS', 'NOT_EXISTS']);

type Written = Pick<ClassificationWriteResult, 'materializationQueued' | 'warnings'>;

/**
 * Node group editor.
 *
 * Every save on this page eventually reconfigures real machines, so the result
 * of each write is reported explicitly rather than dismissed as a toast: the
 * operator sees which nodes were queued and that the change is not yet live.
 */
/**
 * Wrapped so every editor on this page shares ONE review dialog.
 *
 * Rules, classes, parameters, pins and group settings each have their own save
 * button; five dialogs would be five chances for them to disagree about what a
 * review looks like, and only one of them would get fixed when that happened.
 */
export default function NodeGroupPage({ params }: { params: Promise<{ id: string }> }) {
  return (
    <PlanReviewProvider>
      <NodeGroupDetail params={params} />
    </PlanReviewProvider>
  );
}

function NodeGroupDetail({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const router = useRouter();
  const { can } = useAuth();
  const group = useNodeGroup(id);

  const [written, setWritten] = useState<Written | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const writable = can('classification:write');
  const remove = useDeleteGroup();

  const report = (result: Written) => {
    setError(null);
    setWritten(result);
  };

  const fail = (caught: unknown) => {
    setWritten(null);
    setError(caught instanceof ApiError ? caught.message : String(caught));
  };

  if (group.isError) return <QueryError error={group.error} />;
  if (group.isPending) return <Spinner label="Loading node group…" />;

  const detail = group.data;

  return (
    <div className="p-3">
      <header className="mb-3">
        <Link
          href="/classification"
          className="mb-1 inline-flex items-center gap-1 text-xs text-ink-faint hover:text-ink"
        >
          <ArrowLeft className="size-3" aria-hidden />
          Classification
        </Link>

        <div className="flex flex-wrap items-center gap-2">
          <h1 className="text-sm font-semibold tracking-tight">{detail.name}</h1>
          <Badge>rank {detail.rank}</Badge>
          <Badge>{detail.strategy}</Badge>
          {!detail.isEnabled && (
            <Badge className="border-state-pending/40 bg-state-pending/10 text-state-pending">
              disabled
            </Badge>
          )}
        </div>
        {detail.description !== null && (
          <p className="mt-0.5 text-xs text-ink-muted">{detail.description}</p>
        )}
      </header>

      {!writable && <Forbidden permission="classification:write" />}

      {error !== null && (
        <div
          role="alert"
          className="mb-3 rounded border border-state-failed/40 bg-state-failed/10 p-2.5 text-xs"
        >
          <p className="font-medium text-state-failed">Change rejected</p>
          <p className="mt-0.5 text-state-failed/80">{error}</p>
        </div>
      )}

      {written !== null && <WriteResult result={written} className="mb-3" />}

      <div className="grid gap-3 xl:grid-cols-2">
        <DetailsSection
          id={id}
          detail={detail}
          writable={writable}
          onWrite={report}
          onError={fail}
        />
        <RulesSection id={id} detail={detail} writable={writable} onWrite={report} onError={fail} />
        <ClassesSection
          id={id}
          detail={detail}
          writable={writable}
          onWrite={report}
          onError={fail}
        />
        <ParametersSection
          id={id}
          detail={detail}
          writable={writable}
          onWrite={report}
          onError={fail}
        />
        {detail.strategy === 'PINNED' && (
          <PinsSection
            id={id}
            detail={detail}
            writable={writable}
            onWrite={report}
            onError={fail}
          />
        )}
      </div>

      {writable && (
        <div className="mt-3">
          <Button variant="danger" size="sm" onClick={() => setConfirmDelete(true)}>
            <Trash2 aria-hidden />
            Delete group
          </Button>
        </div>
      )}

      {/* Deleting a group unclassifies every node it matched. That blast radius
          is stated before the operator confirms, not after. */}
      <Dialog
        open={confirmDelete}
        onClose={() => setConfirmDelete(false)}
        title={`Delete “${detail.name}”?`}
        description="Every node this group currently classifies will be rewritten without it."
        footer={
          <>
            <Button variant="ghost" size="sm" onClick={() => setConfirmDelete(false)}>
              Cancel
            </Button>
            <Button
              variant="danger"
              size="sm"
              disabled={remove.isPending}
              onClick={() => {
                remove.mutate(id, {
                  onSuccess: () => router.push('/classification'),
                  onError: (caught) => {
                    setConfirmDelete(false);
                    fail(caught);
                  },
                });
              }}
            >
              {remove.isPending ? 'Deleting…' : 'Delete group'}
            </Button>
          </>
        }
      >
        <ul className="space-y-1 text-xs text-ink-muted">
          <li>
            • {detail.classCount} class assignment{detail.classCount === 1 ? '' : 's'} and{' '}
            {detail.pinCount} pin{detail.pinCount === 1 ? '' : 's'} will be removed.
          </li>
          <li>
            • Affected nodes are queued for rewrite immediately; Puppet applies the change on each
            node&rsquo;s next run.
          </li>
          <li>• This cannot be undone from the console.</li>
        </ul>
      </Dialog>
    </div>
  );
}

interface SectionProps {
  id: string;
  detail: ReturnType<typeof useNodeGroup>['data'] & object;
  writable: boolean;
  onWrite: (result: Written) => void;
  onError: (error: unknown) => void;
}

function DetailsSection({ id, detail, writable, onWrite, onError }: SectionProps) {
  const update = useUpdateGroup(id);
  const { review } = usePlanReview();
  const [name, setName] = useState(detail.name);
  const [rank, setRank] = useState(String(detail.rank));
  const [environment, setEnvironment] = useState(detail.environment ?? '');
  const [enabled, setEnabled] = useState(detail.isEnabled);
  const [strategy, setStrategy] = useState<MatchStrategy>(detail.strategy);

  const dirty =
    name !== detail.name ||
    Number(rank) !== detail.rank ||
    (environment === '' ? null : environment) !== detail.environment ||
    enabled !== detail.isEnabled ||
    strategy !== detail.strategy;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Details</CardTitle>
        <span className="text-2xs text-ink-faint">higher rank is applied last and wins</span>
      </CardHeader>

      <form
        className="space-y-2 p-3"
        onSubmit={(event) => {
          event.preventDefault();
          const payload = {
            name,
            rank: Number(rank),
            environment: environment === '' ? null : environment,
            isEnabled: enabled,
            strategy,
          };
          // Rank changes merge ORDER, enablement changes membership, and
          // strategy swaps which side of the group decides membership at all —
          // all three move documents an operator may not have been thinking
          // about.
          review(
            {
              operation: 'update-group',
              groupId: id,
              rank: Number(rank),
              environment: environment === '' ? null : environment,
              isEnabled: enabled,
              strategy,
            },
            'Group settings',
            () => update.mutate(payload, { onSuccess: onWrite, onError }),
          );
        }}
      >
        <div className="grid grid-cols-2 gap-2">
          <div className="space-y-1">
            <Label htmlFor="name">Name</Label>
            <Input
              id="name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              disabled={!writable}
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="rank">Rank</Label>
            <Input
              id="rank"
              type="number"
              value={rank}
              onChange={(e) => setRank(e.target.value)}
              disabled={!writable}
              className="font-mono"
            />
          </div>
        </div>

        <div className="space-y-1">
          <Label htmlFor="environment">Environment</Label>
          <Input
            id="environment"
            value={environment}
            onChange={(e) => setEnvironment(e.target.value)}
            placeholder="leave blank to inherit"
            disabled={!writable}
          />
        </div>

        {/* EDITABLE, not a badge. This was read-only until an operator removed
            every pin, added a rule, and was told by the warning to "switch the
            strategy to ALL_RULES" — an instruction the console offered no way
            to follow. The only escape was deleting the group and rebuilding it,
            losing its classes, parameters and history. */}
        <div className="space-y-1">
          <Label htmlFor="strategy">Strategy</Label>
          <Select
            id="strategy"
            value={strategy}
            onChange={(e) => setStrategy(e.target.value as MatchStrategy)}
            disabled={!writable}
          >
            <option value="ALL_RULES">ALL_RULES — every rule must match</option>
            <option value="ANY_RULE">ANY_RULE — any one rule matches</option>
            <option value="PINNED">PINNED — static list, rules ignored</option>
          </Select>
          <p className="text-2xs text-ink-faint">
            {strategy === 'PINNED'
              ? 'Membership comes from the pinned list; rules decide nothing.'
              : 'Membership comes from the rules; pinned nodes decide nothing.'}
          </p>
        </div>

        <label className="flex items-center gap-1.5 text-xs text-ink-muted">
          <input
            type="checkbox"
            checked={enabled}
            onChange={(e) => setEnabled(e.target.checked)}
            disabled={!writable}
            className="size-3.5 accent-[var(--color-accent)]"
          />
          Enabled — a disabled group classifies nothing
        </label>

        <Button
          type="submit"
          variant="primary"
          size="sm"
          disabled={!writable || !dirty || update.isPending}
        >
          {update.isPending ? 'Saving…' : 'Save details'}
        </Button>
      </form>
    </Card>
  );
}

/**
 * Rules are edited and saved as a SET.
 *
 * The API replaces them wholesale so that adding one rule and removing another
 * is a single atomic change — applying them separately would briefly
 * materialize an intermediate classification nobody asked for, configuring real
 * machines from a state that never existed in anyone's intent (ADR-0009).
 */
function RulesSection({ id, detail, writable, onWrite, onError }: SectionProps) {
  const replace = useReplaceRules(id);
  const { review } = usePlanReview();
  const factPaths = useFactPaths();
  const [rules, setRules] = useState<NodeRule[]>(detail.rules);

  const update = (index: number, patch: Partial<NodeRule>) =>
    setRules((current) => current.map((rule, i) => (i === index ? { ...rule, ...patch } : rule)));

  const known = new Map((factPaths.data?.paths ?? []).map((entry) => [entry.path, entry]));

  // Rules save as a set, so "changed" is a property of the whole list. Without
  // this the button invites a pointless write that would queue a full reconcile
  // across the estate for no change at all.
  const dirty = JSON.stringify(rules) !== JSON.stringify(detail.rules);

  return (
    <Card>
      <CardHeader>
        <CardTitle>Matching rules</CardTitle>
        <span className="text-2xs text-ink-faint">
          {detail.strategy === 'PINNED'
            ? 'ignored for pinned groups'
            : factPaths.isSuccess
              ? `${factPaths.data.paths.length} fact paths available`
              : 'saved as a set'}
        </span>
      </CardHeader>

      <div className="space-y-2 p-3">
        {rules.length === 0 && (
          <p className="text-xs text-ink-faint">
            No rules. A rule-based group with no rules matches nothing — deliberately, so an
            unfinished draft cannot classify the whole estate.
          </p>
        )}

        {rules.map((rule, index) => {
          const match = known.get(rule.factPath);
          // Unknown only once the index has loaded — otherwise every path looks
          // wrong for the first few hundred milliseconds.
          const unknown = factPaths.isSuccess && rule.factPath.trim() !== '' && match === undefined;

          return (
            <div key={index} className="space-y-1">
              <div className="flex items-start gap-1.5">
                <div className="flex-1">
                  <Input
                    value={rule.factPath}
                    onChange={(e) => update(index, { factPath: e.target.value })}
                    placeholder="os.family"
                    disabled={!writable}
                    list={`fact-paths-${id}`}
                    className="w-full font-mono text-xs"
                    aria-label="Fact path"
                    aria-invalid={unknown}
                  />
                </div>

                <Select
                  value={rule.operator}
                  onChange={(e) => update(index, { operator: e.target.value as RuleOperator })}
                  disabled={!writable}
                  className="text-xs"
                  aria-label="Operator"
                >
                  {OPERATORS.map((operator) => (
                    <option key={operator} value={operator}>
                      {operator}
                    </option>
                  ))}
                </Select>

                <div className="flex-1">
                  <Input
                    value={
                      NO_VALUE.has(rule.operator)
                        ? ''
                        : typeof rule.value === 'string'
                          ? rule.value
                          : JSON.stringify(rule.value ?? '')
                    }
                    onChange={(e) => update(index, { value: e.target.value })}
                    placeholder={NO_VALUE.has(rule.operator) ? 'not used' : 'RedHat'}
                    disabled={!writable || NO_VALUE.has(rule.operator)}
                    // Observed values for this path, when the cardinality is
                    // low enough to be useful.
                    list={match?.values === undefined ? undefined : `fact-values-${id}-${index}`}
                    className="w-full font-mono text-xs"
                    aria-label="Value"
                  />
                  {match?.values !== undefined && (
                    <datalist id={`fact-values-${id}-${index}`}>
                      {match.values.map((value) => (
                        <option key={String(value)} value={String(value)} />
                      ))}
                    </datalist>
                  )}
                </div>

                <Button
                  variant="ghost"
                  size="icon"
                  type="button"
                  disabled={!writable}
                  onClick={() => setRules((current) => current.filter((_, i) => i !== index))}
                  aria-label="Remove rule"
                >
                  <Trash2 aria-hidden />
                </Button>
              </div>

              {/* A typo silently never matches, which is the worst outcome —
                  the group simply classifies nothing and nobody is told. */}
              {unknown && (
                <p className="pl-1 text-2xs text-state-pending">
                  No projected node has “{rule.factPath}”. This rule can never match. Check the
                  spelling, or add the fact to PUPPETDB_PROJECTED_FACTS and re-run the projection.
                </p>
              )}

              {match !== undefined && (
                <p className="pl-1 text-2xs text-ink-faint">
                  on {match.nodeCount} node{match.nodeCount === 1 ? '' : 's'} · e.g.{' '}
                  <code className="font-mono">
                    {JSON.stringify(match.sampleValue).slice(0, 60)}
                  </code>
                </p>
              )}
            </div>
          );
        })}

        {/* One shared list for every rule row. Options carry the sample value
            as the label, so a path can be chosen on what it holds rather than
            on remembering its name. */}
        <datalist id={`fact-paths-${id}`}>
          {(factPaths.data?.paths ?? []).map((entry) => (
            <option key={entry.path} value={entry.path}>
              {`${JSON.stringify(entry.sampleValue).slice(0, 40)} — ${entry.nodeCount} node${entry.nodeCount === 1 ? '' : 's'}`}
            </option>
          ))}
        </datalist>

        <div className="flex gap-2">
          <Button
            variant="secondary"
            size="sm"
            type="button"
            disabled={!writable}
            onClick={() =>
              setRules((current) => [...current, { factPath: '', operator: 'EQUALS', value: '' }])
            }
          >
            <Plus aria-hidden />
            Add rule
          </Button>

          <Button
            variant="primary"
            size="sm"
            type="button"
            disabled={!writable || !dirty || replace.isPending}
            onClick={() => {
              const next = rules
                .filter((rule) => rule.factPath.trim() !== '')
                .map((rule) =>
                  NO_VALUE.has(rule.operator)
                    ? { factPath: rule.factPath, operator: rule.operator }
                    : rule,
                );
              // Rules have the widest blast radius of any change here: they
              // decide membership, so one edit can pull in or drop the whole
              // estate. Reviewed before it is written.
              review(
                { operation: 'replace-rules', groupId: id, rules: next },
                'Matching rules',
                () => replace.mutate({ rules: next }, { onSuccess: onWrite, onError }),
              );
            }}
          >
            {replace.isPending ? 'Saving…' : 'Save rules'}
          </Button>
        </div>
      </div>
    </Card>
  );
}

function ClassesSection({ id, detail, writable, onWrite, onError }: SectionProps) {
  const assign = useAssignClass(id);
  const { review } = usePlanReview();
  const remove = useRemoveClass(id);

  const [open, setOpen] = useState(false);
  const [className, setClassName] = useState('');
  const [params, setParams] = useState('{}');
  const [jsonError, setJsonError] = useState<string | null>(null);
  const [nameError, setNameError] = useState<string | null>(null);

  // Suggestions for the environment THIS GROUP will use — its own when set,
  // otherwise the deployment default, which the API resolves (ADR-0024 §7).
  const classIndex = useClassNames(detail.environment);
  const refresh = useRefreshClassNames();
  const suggestion = findClass(classIndex.data, className);

  // Form values live separately from the JSON so switching between them never
  // loses what was typed. The JSON is authoritative on save.
  const [fieldValues, setFieldValues] = useState<Record<string, string>>({});
  const [jsonMode, setJsonMode] = useState(false);

  // The form can only be offered for a class whose signature we actually have.
  // Everything else — unknown class, suggestions unavailable, operator's choice
  // — falls back to the textarea, which is never taken away (§9).
  const formAvailable = suggestion !== null && !jsonMode;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Classes</CardTitle>
        {writable && (
          <Button variant="secondary" size="sm" onClick={() => setOpen(true)}>
            <Plus aria-hidden />
            Assign
          </Button>
        )}
      </CardHeader>

      {detail.classes.length === 0 ? (
        <p className="p-3 text-xs text-ink-faint">No classes assigned.</p>
      ) : (
        <ul className="divide-y divide-line-soft">
          {detail.classes.map((entry) => (
            <li key={entry.className} className="flex items-start gap-2 px-3 py-1.5">
              <div className="min-w-0 flex-1">
                <p className="font-mono text-xs text-ink">{entry.className}</p>
                {Object.keys(entry.params).length > 0 && (
                  <pre className="mt-0.5 whitespace-pre-wrap break-all font-mono text-2xs text-ink-muted">
                    {JSON.stringify(entry.params)}
                  </pre>
                )}
              </div>
              <Button
                variant="ghost"
                size="icon"
                disabled={!writable || remove.isPending}
                onClick={() => remove.mutate(entry.className, { onSuccess: onWrite, onError })}
                aria-label={`Remove ${entry.className}`}
              >
                <Trash2 aria-hidden />
              </Button>
            </li>
          ))}
        </ul>
      )}

      <Dialog
        open={open}
        onClose={() => setOpen(false)}
        title="Assign class"
        description="Parameters are replaced wholesale on conflict, never deep-merged (ADR-0009)."
        footer={
          <>
            <Button variant="ghost" size="sm" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button
              variant="primary"
              size="sm"
              disabled={assign.isPending}
              onClick={() => {
                // The class name, with the SAME schema the API uses. The hint
                // under the field has always promised this is checked here;
                // until now it was not, so a single-colon typo reached the API,
                // failed validation there, and surfaced as "Invalid request
                // parameters" inside a preview dialog that then offered to
                // apply the change anyway.
                const name = puppetClassNameSchema.safeParse(className);
                if (!name.success) {
                  setNameError(
                    name.error.issues[0]?.message ??
                      'Not a valid Puppet class name (e.g. profile::base)',
                  );
                  return;
                }
                setNameError(null);

                let raw: unknown;
                try {
                  raw = JSON.parse(params);
                } catch (caught) {
                  setJsonError(caught instanceof Error ? caught.message : 'Invalid JSON');
                  return;
                }

                // Validated with the SAME schema the API uses, so a value
                // Puppet cannot represent is rejected here rather than after a
                // round trip.
                const validated = z.record(z.string(), puppetValueSchema).safeParse(raw);
                if (!validated.success) {
                  setJsonError(
                    validated.error.issues[0]?.message ??
                      'Parameters must be a JSON object of Puppet-representable values.',
                  );
                  return;
                }
                const parsed: Record<string, PuppetValue> = validated.data;
                setJsonError(null);
                review(
                  { operation: 'assign-class', groupId: id, className, params: parsed },
                  `Assign ${className}`,
                  () =>
                    assign.mutate(
                      { className, params: parsed },
                      {
                        onSuccess: (result) => {
                          setOpen(false);
                          setClassName('');
                          setParams('{}');
                          onWrite(result);
                        },
                        onError,
                      },
                    ),
                );
              }}
            >
              {assign.isPending ? 'Saving…' : 'Assign'}
            </Button>
          </>
        }
      >
        <div className="space-y-2">
          <div className="space-y-1">
            <Label htmlFor="className">Class name</Label>
            <Input
              id="className"
              value={className}
              onChange={(e) => {
                setClassName(e.target.value);
                setNameError(null);
                // A different class means a different signature; keeping the
                // old field values would submit one class's parameters to
                // another.
                setFieldValues({});
              }}
              placeholder="profile::base"
              className="font-mono"
              aria-invalid={nameError !== null}
              list="class-name-suggestions"
              autoComplete="off"
            />
            <ClassNameSuggestions id="class-name-suggestions" index={classIndex.data} />
            {nameError !== null ? (
              <p className="text-2xs text-state-failed">{nameError}</p>
            ) : (
              <p className="text-2xs text-ink-faint">
                Lowercase, <code className="font-mono">::</code>-separated. Validated here, so an
                invalid name is rejected before it reaches a preview or a catalog compilation.
              </p>
            )}

            {/* MARKED, NOT BLOCKED. A class the operator is about to write does
                not exist yet, and refusing it would be worse than the guessing
                this replaces (§5). */}
            {className !== '' &&
              suggestion === null &&
              classIndex.data?.status === 'ok' &&
              classIndex.data.classes.length > 0 && (
                <p className="text-2xs text-state-pending">
                  Not among the classes in{' '}
                  <span className="font-mono">{classIndex.data.environment}</span>. You can still
                  assign it — but if it does not exist when a catalog compiles, every matched node
                  fails.
                </p>
              )}

            {suggestion !== null && suggestion.path !== null && (
              <p className="truncate text-2xs text-ink-faint">
                <span className="font-mono">{suggestion.path}</span>
              </p>
            )}
          </div>

          <div className="space-y-1">
            <div className="flex items-center justify-between gap-2">
              <Label htmlFor="params">{formAvailable ? 'Parameters' : 'Parameters (JSON)'}</Label>
              {/* ALWAYS REACHABLE, even for a class we know perfectly well. A
                  parameter taking a structure the form cannot express must
                  never become unassignable (§9). */}
              {suggestion !== null && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    if (!jsonMode) setParams(paramsToJson(fieldValues).json);
                    setJsonMode(!jsonMode);
                  }}
                >
                  {jsonMode ? 'Use the form' : 'Edit as JSON'}
                </Button>
              )}
            </div>

            {formAvailable ? (
              <ClassParameterForm
                klass={suggestion}
                values={fieldValues}
                onChange={(next) => {
                  setFieldValues(next);
                  setParams(paramsToJson(next).json);
                  setJsonError(null);
                }}
              />
            ) : (
              <Textarea
                id="params"
                rows={6}
                value={params}
                onChange={(e) => setParams(e.target.value)}
                aria-invalid={jsonError !== null}
              />
            )}
            {jsonError !== null && <p className="text-2xs text-state-failed">{jsonError}</p>}
          </div>

          <ClassSuggestionStatus
            index={classIndex.data}
            refreshing={refresh.isPending}
            onRefresh={() => refresh.mutate(detail.environment)}
          />
        </div>
      </Dialog>
    </Card>
  );
}

function ParametersSection({ id, detail, writable, onWrite, onError }: SectionProps) {
  const set = useSetParameter(id);
  const { review } = usePlanReview();
  const remove = useRemoveParameter(id);
  const [key, setKey] = useState('');
  const [value, setValue] = useState('');

  return (
    <Card>
      <CardHeader>
        <CardTitle>Top-scope parameters</CardTitle>
      </CardHeader>

      {detail.parameters.length === 0 ? (
        <p className="px-3 pt-3 text-xs text-ink-faint">No parameters set.</p>
      ) : (
        <ul className="divide-y divide-line-soft">
          {detail.parameters.map((parameter) => (
            <li key={parameter.key} className="flex items-center gap-2 px-3 py-1.5">
              <span className="font-mono text-xs text-ink">{parameter.key}</span>
              <span className="min-w-0 flex-1 truncate font-mono text-2xs text-ink-muted">
                {JSON.stringify(parameter.value)}
              </span>
              <Button
                variant="ghost"
                size="icon"
                disabled={!writable || remove.isPending}
                onClick={() => remove.mutate(parameter.key, { onSuccess: onWrite, onError })}
                aria-label={`Remove ${parameter.key}`}
              >
                <Trash2 aria-hidden />
              </Button>
            </li>
          ))}
        </ul>
      )}

      {writable && (
        <form
          className="flex items-end gap-1.5 p-3"
          onSubmit={(event) => {
            event.preventDefault();
            // Accept JSON if it parses, otherwise treat the input as a string —
            // `dc1` should not need quoting, but `["a","b"]` should work.
            // Accept JSON when it parses, otherwise treat the input as a
            // string — `dc1` should not need quoting, but `["a","b"]` should
            // work. Either way it must be a value Puppet can represent.
            let candidate: unknown;
            try {
              candidate = JSON.parse(value) as unknown;
            } catch {
              candidate = value;
            }

            const validated = puppetValueSchema.safeParse(candidate);
            if (!validated.success) {
              onError(new Error(`"${key}" is not a value Puppet can represent.`));
              return;
            }

            review(
              { operation: 'set-parameter', groupId: id, key, value: validated.data },
              `Set ${key}`,
              () =>
                set.mutate(
                  { key, value: validated.data },
                  {
                    onSuccess: (result) => {
                      setKey('');
                      setValue('');
                      onWrite(result);
                    },
                    onError,
                  },
                ),
            );
          }}
        >
          <div className="flex-1 space-y-1">
            <Label htmlFor="paramKey">Key</Label>
            <Input
              id="paramKey"
              value={key}
              onChange={(e) => setKey(e.target.value)}
              className="font-mono text-xs"
            />
          </div>
          <div className="flex-1 space-y-1">
            <Label htmlFor="paramValue">Value</Label>
            <Input
              id="paramValue"
              value={value}
              onChange={(e) => setValue(e.target.value)}
              placeholder='dc1 or ["a","b"]'
              className="font-mono text-xs"
            />
          </div>
          <Button
            type="submit"
            variant="secondary"
            size="sm"
            disabled={key === '' || set.isPending}
          >
            Set
          </Button>
        </form>
      )}
    </Card>
  );
}

function PinsSection({ id, detail, writable, onWrite, onError }: SectionProps) {
  const add = useAddPins(id);
  const { review } = usePlanReview();
  const remove = useRemovePin(id);
  const [certnames, setCertnames] = useState('');

  return (
    <Card>
      <CardHeader>
        <CardTitle>Pinned nodes</CardTitle>
        <span className="text-2xs text-ink-faint">static membership — rules are ignored</span>
      </CardHeader>

      {detail.pinnedCertnames.length === 0 ? (
        <p className="px-3 pt-3 text-xs text-ink-faint">No nodes pinned.</p>
      ) : (
        <ul className="divide-y divide-line-soft">
          {detail.pinnedCertnames.map((certname) => (
            <li key={certname} className="flex items-center gap-2 px-3 py-1">
              <Link
                href={`/nodes/${encodeURIComponent(certname)}`}
                className="link-entity min-w-0 flex-1 truncate font-mono text-xs"
              >
                {certname}
              </Link>
              <Button
                variant="ghost"
                size="icon"
                disabled={!writable || remove.isPending}
                onClick={() => remove.mutate(certname, { onSuccess: onWrite, onError })}
                aria-label={`Unpin ${certname}`}
              >
                <Trash2 aria-hidden />
              </Button>
            </li>
          ))}
        </ul>
      )}

      {writable && (
        <form
          className="space-y-1.5 p-3"
          onSubmit={(event) => {
            event.preventDefault();
            const list = certnames
              .split(/[\s,]+/)
              .map((entry) => entry.trim())
              .filter((entry) => entry !== '');
            if (list.length === 0) return;

            review({ operation: 'pin', groupId: id, certnames: list }, 'Pin nodes', () =>
              add.mutate(list, {
                onSuccess: (result) => {
                  setCertnames('');
                  onWrite(result);
                },
                onError,
              }),
            );
          }}
        >
          <Label htmlFor="pins">Add certnames</Label>
          <Textarea
            id="pins"
            rows={2}
            value={certnames}
            onChange={(e) => setCertnames(e.target.value)}
            placeholder="web01.example.com, db02.example.com"
          />
          <p className="text-2xs text-ink-faint">
            Pinning a node PuppetDB has not seen yet is allowed — it will materialize once the node
            reports.
          </p>
          <Button type="submit" variant="secondary" size="sm" disabled={add.isPending}>
            {add.isPending ? 'Pinning…' : 'Pin nodes'}
          </Button>
        </form>
      )}
    </Card>
  );
}

export { OPERATORS, NO_VALUE, type Written, cn };
