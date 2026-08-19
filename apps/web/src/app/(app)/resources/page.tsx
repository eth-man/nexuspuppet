'use client';

import { useMemo, useState, type FormEvent } from 'react';
import { AlertTriangle, Check, Eye, Search } from 'lucide-react';
import type { ResourceComparison, ResourceGroup } from '@nexuspuppet/contracts';
import {
  useEnvironments,
  useResourceParameters,
  useResourceSearch,
  type ParameterQuery,
  type ResourceQuery,
} from '@/lib/queries';
import { completeFactRows, FactFilters, type FactRow } from '@/components/data/fact-filters';
import { SavedQueries } from '@/components/data/saved-queries';
import { cn } from '@/lib/utils';
import { collapseUnchanged, diffLines, isMultiline } from '@/lib/diff-lines';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { Table, TBody, TD, TH, THead, TR } from '@/components/ui/table';
import { EmptyState, LoadingRows, QueryError, Spinner } from '@/components/states';

/**
 * Estate-wide resource search (ADR-0025).
 *
 * The console could always say what a node SHOULD get. This says what it DOES
 * get — and answers the question that is not a lookup: do these nodes AGREE.
 *
 * CONSISTENCY IS THE HEADLINE, not a detail. 190 identical rows hide the three
 * that differ, and an operator scrolling to find them is doing the work this
 * page exists to do. So results are grouped and the disagreements sort to the
 * top.
 *
 * Expanding a row names the nodes in each variant. That is deliberately HERE
 * and not in the next slice: "12 nodes, 2 variants" is a smoke alarm with no
 * room number, and a certname is not a disclosure — it is on the Nodes page
 * already, behind `inventory:read`.
 *
 * No parameter VALUES appear anywhere here. Variance is computed from the
 * resource hash server-side, so the browser is never sent a managed file's
 * contents (§4, §7). WHAT differs between two variants is the disclosure, and
 * that is what waits for its audit trail (§6).
 */

/** Common enough to be worth one click; the field stays free text regardless. */
const COMMON_TYPES = ['File', 'Package', 'Service', 'User', 'Cron', 'Exec'];

export default function ResourcesPage() {
  // Held separately from the submitted query: an estate-wide grouping is real
  // work for PuppetDB, so this page submits deliberately rather than on every
  // keystroke the way the node list does.
  const [type, setType] = useState('');
  const [titleContains, setTitleContains] = useState('');
  const [environment, setEnvironment] = useState<string | null>(null);
  const [factRows, setFactRows] = useState<FactRow[]>([]);
  const [paramRows, setParamRows] = useState<FactRow[]>([]);
  const [submitted, setSubmitted] = useState<ResourceQuery | null>(null);

  const environments = useEnvironments();
  const results = useResourceSearch(submitted);

  const canSearch = type.trim() !== '';

  const search = (event: FormEvent) => {
    event.preventDefault();
    if (!canSearch) return;

    const facts = completeFactRows(factRows);
    const parameters = completeFactRows(paramRows);

    setSubmitted({
      type: type.trim(),
      ...(titleContains.trim() === '' ? {} : { titleContains: titleContains.trim() }),
      ...(environment === null ? {} : { environments: [environment] }),
      ...(facts.length === 0 ? {} : { facts }),
      ...(parameters.length === 0 ? {} : { parameters }),
    });
  };

  const groups = results.data?.groups ?? [];
  const inconsistent = useMemo(() => groups.filter((g) => g.variantCount > 1).length, [groups]);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex items-center justify-between border-b border-line-soft px-3 py-2">
        <div>
          <h1 className="text-sm font-semibold tracking-tight">Resources</h1>
          <p className="text-xs text-ink-muted">
            {results.isSuccess
              ? `${results.data.total.toLocaleString()} resource${
                  results.data.total === 1 ? '' : 's'
                } · ${groups.length} grouped · ${inconsistent} inconsistent`
              : 'What your nodes are actually managing'}
          </p>
        </div>
      </header>

      <form
        onSubmit={search}
        className="flex flex-wrap items-center gap-2 border-b border-line-soft px-3 py-2"
      >
        <div className="relative min-w-40">
          <Input
            value={type}
            onChange={(event) => setType(event.target.value)}
            placeholder="File"
            className="h-8 w-40 font-mono text-xs"
            list="resource-types"
            aria-label="Resource type (required)"
            required
          />
          <datalist id="resource-types">
            {COMMON_TYPES.map((t) => (
              <option key={t} value={t} />
            ))}
          </datalist>
        </div>

        <div className="relative min-w-56 flex-1 max-w-md">
          <Search
            className="absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-ink-faint"
            aria-hidden
          />
          <Input
            value={titleContains}
            onChange={(event) => setTitleContains(event.target.value)}
            placeholder="Title contains… e.g. sshd_config"
            className="h-8 pl-7 font-mono text-xs"
            aria-label="Title contains"
          />
        </div>

        <Select
          value={environment ?? ''}
          onChange={(event) =>
            setEnvironment(event.target.value === '' ? null : event.target.value)
          }
          className="h-8 w-40 shrink-0"
          aria-label="Environment"
        >
          <option value="">All environments</option>
          {(environments.data ?? []).map((name) => (
            <option key={name} value={name}>
              {name}
            </option>
          ))}
        </Select>

        <Button type="submit" size="sm" disabled={!canSearch}>
          Search
        </Button>
      </form>

      <div className="flex items-center gap-2 border-b border-line-soft px-3 py-1">
        <SavedQueries
          kind="resource"
          currentFilter={submitted}
          canSave={submitted !== null}
          onApply={(filter) => {
            /*
             * A resource query REPLAYS immediately, unlike the node one.
             *
             * Its controls are a search form with a mandatory type, so there is
             * no half-typed state to restore into — setting `submitted`
             * directly is the honest equivalent of pressing Search. The visible
             * fields are written too, so the form agrees with the results it is
             * showing.
             */
            const f = (filter ?? {}) as {
              type?: string;
              titleContains?: string;
              environments?: string[];
            };
            setType(f.type ?? '');
            setTitleContains(f.titleContains ?? '');
            setEnvironment(f.environments?.[0] ?? null);
            setSubmitted(filter as ResourceQuery);
          }}
        />
      </div>

      {/* Narrowing by node, and by parameter value. Both optional, and both
          deliberately below the primary row so the common case stays one line. */}
      <div className="grid gap-3 border-b border-line-soft px-3 py-2 md:grid-cols-2">
        <div>
          <p className="mb-1 text-2xs uppercase tracking-wide text-ink-faint">
            Only on nodes matching
          </p>
          <FactFilters rows={factRows} onChange={setFactRows} />
        </div>
        <div>
          <p className="mb-1 text-2xs uppercase tracking-wide text-ink-faint">
            Only where the parameter
          </p>
          <FactFilters rows={paramRows} onChange={setParamRows} />
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-auto">
        {submitted === null ? (
          <EmptyState
            title="Search the estate's catalogs"
            hint="A resource type is required — File, Package, Service. Results group by resource and show whether the nodes carrying it agree."
          />
        ) : results.isError ? (
          <QueryError error={results.error} />
        ) : results.isPending ? (
          <LoadingRows columns={5} />
        ) : results.data.tooMany ? (
          <EmptyState
            title={`${results.data.total.toLocaleString()} resources match`}
            hint={`That is more than the ${results.data.limit.toLocaleString()} this page will group. Narrow it with a title, an environment, or a fact filter.`}
          />
        ) : groups.length === 0 ? (
          <EmptyState
            title="Nothing matches"
            hint="No node in the estate declares a resource matching that search."
          />
        ) : (
          <Table>
            <THead>
              <TR>
                <TH className="w-8" />
                <TH>Resource</TH>
                <TH className="w-32">Environment</TH>
                <TH className="w-20 text-right">Nodes</TH>
                <TH className="w-24 text-right">Variants</TH>
                <TH>Declared in</TH>
              </TR>
            </THead>
            <TBody>
              {groups.map((group) => (
                <GroupRow key={`${group.title} ${group.environment}`} group={group} />
              ))}
            </TBody>
          </Table>
        )}
      </div>
    </div>
  );
}

/*
 * ATTENTION, NOT FAILURE.
 *
 * `state-pending` (amber) with an AlertTriangle is what this codebase already
 * uses for "look at this, it is not wrong yet" — the LDAP, OIDC and audit
 * forwarding panels all say it this way. `state-failed` would have been the
 * obvious choice and is the wrong one: red is the colour of a FAILED PUPPET
 * RUN in this palette, and a red row here would read as "this node's run
 * failed" when it means "these nodes disagree with each other". A second
 * meaning for red is how "failed" ends up meaning two things.
 */
function GroupRow({ group }: { group: ResourceGroup }) {
  const drifted = group.variantCount > 1;
  const [open, setOpen] = useState(false);

  return (
    <>
      <TR
        onClick={() => setOpen((v) => !v)}
        className="cursor-pointer"
        aria-expanded={open}
        title={drifted ? 'Show which nodes carry which configuration' : 'Show the nodes'}
      >
        <TD>
          {drifted ? (
            <AlertTriangle className="size-3.5 text-state-pending" aria-label="Nodes disagree" />
          ) : (
            <Check className="size-3.5 text-state-unchanged" aria-label="Consistent" />
          )}
        </TD>
        <TD className="font-mono text-xs">
          {group.type}[{group.title}]
        </TD>
        <TD className="font-mono text-xs text-ink-muted">{group.environment}</TD>
        <TD className="text-right tabular-nums">{group.nodeCount.toLocaleString()}</TD>
        <TD
          className={cn('text-right tabular-nums', drifted && 'font-semibold text-state-pending')}
          // The number an operator is scanning for. A group with more than one
          // variant means nodes in the SAME environment carry different
          // parameters — variance across environments is never counted (§8).
          title={
            drifted
              ? `${String(group.variantCount)} different configurations among ${String(group.nodeCount)} nodes`
              : 'Every node carries identical parameters'
          }
        >
          {group.variantCount.toLocaleString()}
        </TD>
        <TD className="truncate font-mono text-2xs text-ink-muted">
          {group.file === null
            ? '—'
            : `${group.file}${group.line === null ? '' : `:${String(group.line)}`}`}
        </TD>
      </TR>

      {open && <VariantRows group={group} />}
    </>
  );
}

/**
 * WHICH nodes carry which configuration.
 *
 * "12 nodes, 2 variants" is a smoke alarm with no room number: it says
 * something is wrong and not where. The certnames answer that, and they were
 * already in the response — this only renders them.
 *
 * NO PARAMETER IS DISCLOSED HERE, and that is why it belongs in this slice
 * rather than the next. A certname is not a secret; it is on the Nodes page
 * already, behind `inventory:read`. WHAT differs between two variants is the
 * disclosure, and that still waits for its audit trail (ADR-0025 §6).
 *
 * The largest variant is the baseline and comes first, so the short lists
 * underneath it are the machines to go and look at.
 */
function VariantRows({ group }: { group: ResourceGroup }) {
  /*
   * TWO LEVELS, and only the second discloses anything.
   *
   * Expanding a row names the nodes, which is not a disclosure — a certname is
   * on the Nodes page already. Comparing parameters reads the configuration
   * payload, and the server writes an audit row before it does (§6). So it is
   * a separate, explicit action rather than something that happens because
   * somebody clicked a row to see who was involved.
   */
  const [comparing, setComparing] = useState<ParameterQuery | null>(null);
  const comparison = useResourceParameters(comparing);

  return (
    <>
      {group.variants.map((variant, index) => {
        // The API caps the certname list; a variant covering four hundred nodes
        // answers "which" with its count rather than four hundred names.
        const undisclosed = variant.nodeCount - variant.certnames.length;

        return (
          <TR key={variant.resourceHash} className="bg-panel-raised/40">
            <TD />
            <TD colSpan={5} className="py-1">
              <div className="flex items-baseline gap-2">
                <span
                  className={cn(
                    'shrink-0 text-2xs uppercase tracking-wide',
                    index === 0 ? 'text-ink-muted' : 'text-state-pending',
                  )}
                >
                  {group.variantCount === 1
                    ? 'All nodes'
                    : index === 0
                      ? `Baseline · ${variant.nodeCount.toLocaleString()} node${variant.nodeCount === 1 ? '' : 's'}`
                      : `Differs · ${variant.nodeCount.toLocaleString()} node${variant.nodeCount === 1 ? '' : 's'}`}
                </span>
                <span className="font-mono text-2xs text-ink-faint" title="Resource hash">
                  {variant.resourceHash.slice(0, 8)}
                </span>
                <span className="font-mono text-2xs text-ink">
                  {variant.certnames.join(', ')}
                  {undisclosed > 0 && (
                    <span className="text-ink-faint"> and {undisclosed.toLocaleString()} more</span>
                  )}
                </span>
              </div>
            </TD>
          </TR>
        );
      })}

      <TR className="bg-panel-raised/40">
        <TD />
        <TD colSpan={5} className="py-1">
          {comparing === null ? (
            <Button
              variant="ghost"
              size="sm"
              onClick={() =>
                setComparing({
                  type: group.type,
                  title: group.title,
                  environment: group.environment,
                  // One representative per variant (§9) — bounded by variant
                  // count, never by the hundreds of nodes carrying it.
                  certnames: group.variants.map((v) => v.sampleCertname),
                })
              }
            >
              <Eye aria-hidden />
              {group.variantCount > 1 ? 'Compare parameters' : 'Show parameters'}
            </Button>
          ) : comparison.isPending ? (
            <Spinner label="Reading parameters…" />
          ) : comparison.isError ? (
            <QueryError error={comparison.error} />
          ) : (
            <ParameterDiff comparison={comparison.data} />
          )}
        </TD>
      </TR>
    </>
  );
}

/**
 * The parameters, with the differing ones marked.
 *
 * TWO LAYOUTS, chosen per value, and the choice is the whole point.
 *
 * A scalar — `mode` `0600` against `0666` — reads perfectly side by side.
 * A FILE BODY does not: `sshd_config` is a hundred near-identical lines, and
 * two columns of them is precisely the "two blobs to diff by eye" ADR-0025 §9
 * says not to hand anybody. It was also unreadable in a second way — a long
 * value widened its column until the next one was pushed out of the viewport,
 * so an operator saw one node's value and had no idea the other was there.
 * They found it by copying the table and discovering a value they had never
 * been shown.
 *
 * So multi-line values get a unified line diff across the FULL width, and
 * scalars keep the columns. Nothing is ever off-screen: the only thing that
 * can overflow is a single long line, and that scrolls inside its own box.
 *
 * MONOSPACE THROUGHOUT — these are file bodies and mode bits, and the column
 * alignment is what makes them legible.
 */
function ParameterDiff({ comparison }: { comparison: ResourceComparison }) {
  const keys = [...new Set(comparison.variants.flatMap((v) => Object.keys(v.parameters)))].sort(
    (a, b) => {
      // Differing keys first. Everything else is context, and an operator who
      // opened this did so to find the difference.
      const da = comparison.differingKeys.includes(a);
      const db = comparison.differingKeys.includes(b);
      if (da !== db) return da ? -1 : 1;
      return a < b ? -1 : a > b ? 1 : 0;
    },
  );

  return (
    <div className="space-y-1">
      {keys.map((key) => (
        <ParameterRow
          key={key}
          name={key}
          variants={comparison.variants}
          differs={comparison.differingKeys.includes(key)}
        />
      ))}
    </div>
  );
}

function ParameterRow({
  name,
  variants,
  differs,
}: {
  name: string;
  variants: ResourceComparison['variants'];
  differs: boolean;
}) {
  const values = variants.map((v) => v.parameters[name]);

  /*
   * A line diff needs exactly two sides to be a diff. With three variants
   * there is no single "before", so those fall back to columns — rarer, and
   * inventing a baseline would be a lie about which one is correct.
   */
  const lineDiff =
    differs && variants.length === 2 && values.some(isMultiline)
      ? diffLines(String(values[0] ?? ''), String(values[1] ?? ''))
      : null;

  return (
    <div className={cn('rounded border px-2 py-1', differs ? 'border-line' : 'border-transparent')}>
      <div
        className={cn(
          'font-mono text-2xs',
          differs ? 'font-semibold text-state-pending' : 'text-ink-faint',
        )}
      >
        {differs && '→ '}
        {name}
      </div>

      {lineDiff === null ? (
        <div className="mt-0.5 grid gap-2 md:grid-cols-2">
          {variants.map((variant, index) => (
            <div key={variant.certname} className="min-w-0">
              <div className="truncate font-mono text-2xs text-ink-faint">{variant.certname}</div>
              {/* `min-w-0` above and `overflow-x-auto` here are what stop a long
                  value widening its column until the next one leaves the
                  screen. A single long line scrolls inside its own box; the
                  layout never does. */}
              <div className="overflow-x-auto">
                <pre className="whitespace-pre-wrap break-all font-mono text-2xs text-ink">
                  {values[index] === undefined
                    ? '—'
                    : typeof values[index] === 'string'
                      ? (values[index] as string)
                      : JSON.stringify(values[index])}
                </pre>
              </div>
            </div>
          ))}
        </div>
      ) : (
        <div className="mt-0.5 overflow-x-auto">
          <div className="mb-0.5 font-mono text-2xs text-ink-faint">
            − {variants[0]?.certname} {'  '} + {variants[1]?.certname}
          </div>
          <pre className="font-mono text-2xs leading-snug">
            {collapseUnchanged(lineDiff).map((line, index) => (
              <div
                key={index}
                className={cn(
                  'whitespace-pre-wrap break-all',
                  line.kind === 'removed' && 'bg-state-pending/10 text-ink',
                  line.kind === 'added' && 'bg-state-unchanged/10 text-ink',
                  line.kind === 'same' && 'text-ink-faint',
                )}
              >
                {line.kind === 'removed' ? '− ' : line.kind === 'added' ? '+ ' : '  '}
                {line.text}
              </div>
            ))}
          </pre>
        </div>
      )}
    </div>
  );
}
