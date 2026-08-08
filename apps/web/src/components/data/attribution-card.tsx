'use client';

import type { MergeAttribution } from '@nexuspuppet/contracts';
import { Badge } from '@/components/ui/badge';
import { Card, CardHeader, CardTitle } from '@/components/ui/card';
import { EmptyState } from '@/components/states';

/**
 * Where each line of a node's classification came from (#141).
 *
 * The Conflicts card answers "what disagreed". This answers "where is this
 * from", which is the question asked far more often — and which previously
 * meant opening every applied group in turn and re-deriving the merge by hand.
 *
 * Names are resolved HERE from the applied-groups list rather than stored, so
 * a renamed group reads correctly instead of showing whatever it was called
 * when the node was last materialized.
 */
export function AttributionCard({
  attribution,
  groups,
}: {
  /** Undefined for a node materialized before attribution was recorded. */
  attribution: MergeAttribution | undefined;
  groups: Array<{ id: string; name: string }>;
}) {
  const nameOf = (id: string) => groups.find((g) => g.id === id)?.name ?? id;

  if (attribution === undefined) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Where it came from</CardTitle>
        </CardHeader>
        {/*
          Not "nothing contributed". This node was materialized before
          attribution was recorded, and saying the two are the same would be a
          confident wrong answer to the question being asked.
        */}
        <EmptyState
          title="Not recorded for this node"
          hint="It was last materialized before provenance was captured. The next classification change records it."
        />
      </Card>
    );
  }

  const classes = Object.entries(attribution.classes);
  const classParams = Object.entries(attribution.classParameters);
  const params = Object.entries(attribution.parameters);
  const empty =
    classes.length === 0 &&
    classParams.length === 0 &&
    params.length === 0 &&
    attribution.environment === null;

  if (empty) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Where it came from</CardTitle>
        </CardHeader>
        <EmptyState
          title="No groups match this node"
          hint="It receives default.yaml, which is a valid empty classification."
        />
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Where it came from</CardTitle>
        <span className="text-[11px] text-ink-faint">group that set each value</span>
      </CardHeader>

      <div className="divide-y divide-line-soft">
        {classes.length > 0 && (
          <Section title="Classes">
            {classes.map(([className, groupIds]) => (
              <Row key={className} label={className}>
                {/* Union: every group listed contributed, none lost. */}
                {groupIds.map((id) => (
                  <Badge key={id}>{nameOf(id)}</Badge>
                ))}
              </Row>
            ))}
          </Section>
        )}

        {classParams.length > 0 && (
          <Section title="Class parameters">
            {classParams.map(([key, attr]) => (
              <Row key={key} label={key}>
                <Badge>{nameOf(attr.groupId)}</Badge>
                <Overridden attr={attr} nameOf={nameOf} />
              </Row>
            ))}
          </Section>
        )}

        {params.length > 0 && (
          <Section title="Top-scope parameters">
            {params.map(([key, attr]) => (
              <Row key={key} label={key}>
                <Badge>{nameOf(attr.groupId)}</Badge>
                <Overridden attr={attr} nameOf={nameOf} />
              </Row>
            ))}
          </Section>
        )}

        {attribution.environment !== null && (
          <Section title="Environment">
            <Row label="environment">
              <Badge>{nameOf(attribution.environment.groupId)}</Badge>
              <Overridden attr={attribution.environment} nameOf={nameOf} />
            </Row>
          </Section>
        )}
      </div>
    </Card>
  );
}

/**
 * The groups this value displaced.
 *
 * Says whether the value actually differed, because an override with the SAME
 * value is not a disagreement — it is two groups agreeing, which is worth
 * seeing and is not a conflict.
 */
function Overridden({
  attr,
  nameOf,
}: {
  attr: { groupId: string; overridden: Array<{ groupId: string; value: unknown }> };
  nameOf: (id: string) => string;
}) {
  if (attr.overridden.length === 0) return null;

  return (
    <span className="text-[11px] text-ink-faint">
      over{' '}
      {attr.overridden.map((loser, index) => (
        <span key={`${loser.groupId}-${index}`}>
          {index > 0 && ', '}
          {nameOf(loser.groupId)} <code className="font-mono">{JSON.stringify(loser.value)}</code>
        </span>
      ))}
    </span>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="px-3 py-2">
      <p className="mb-1 text-[11px] font-medium uppercase tracking-wide text-ink-faint">{title}</p>
      <div className="space-y-1">{children}</div>
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-wrap items-baseline gap-1.5 text-xs">
      {/* Monospace: these are identifiers, and column alignment is what makes
          a long list of them readable (CLAUDE.md). */}
      <span className="font-mono text-ink">{label}</span>
      {children}
    </div>
  );
}

/**
 * Why one group matched this node (#142).
 *
 * Rendered under the group's name in the applied list, because "why is this
 * group here?" is asked while looking at the group — not on a separate screen.
 *
 * The values shown come from the ManagedNode PROJECTION, which is what rules
 * are evaluated against (ADR-0004). That can differ from what the node reports
 * now, so the timestamp the value belongs to is offered rather than implied.
 */
export function MatchReason({
  reason,
  factsAsOf,
}: {
  reason:
    | {
        strategy: string;
        rules: Array<{
          factPath: string;
          operator: string;
          expected?: unknown;
          actual?: unknown;
          factMissing: boolean;
          matched: boolean;
        }>;
      }
    | undefined;
  factsAsOf: string | null;
}) {
  // Not recorded — this node was materialized before reasons were captured.
  // Saying nothing is better than inventing one.
  if (reason === undefined) return null;

  if (reason.strategy === 'PINNED') {
    return (
      <p className="ml-6 mt-0.5 text-[11px] text-ink-faint">
        pinned — this node is named on the group, no rule was evaluated
      </p>
    );
  }

  if (reason.rules.length === 0) return null;

  return (
    <ul className="ml-6 mt-0.5 space-y-0.5">
      {reason.rules.map((rule, index) => (
        <li
          key={`${rule.factPath}-${index}`}
          className={rule.matched ? 'text-[11px] text-ink-muted' : 'text-[11px] text-ink-faint'}
        >
          <span className="font-mono">{rule.factPath}</span>{' '}
          <span className="text-ink-faint">{rule.operator.toLowerCase().replace(/_/g, ' ')}</span>
          {rule.expected !== undefined && (
            <>
              {' '}
              <code className="font-mono">{JSON.stringify(rule.expected)}</code>
            </>
          )}
          {rule.factMissing ? (
            /*
             * The fact resolved to nothing. Worth saying loudly even on a group
             * that matched: a path outside the projected allow-list looks
             * identical to a genuinely absent fact, so a rule can look
             * deliberate and be permanently unsatisfiable.
             */
            <span className="ml-1 text-state-pending">— no such fact on this node</span>
          ) : (
            <>
              {' '}
              <span className="text-ink-faint">
                {rule.matched ? '✓' : '✕'}{' '}
                <code className="font-mono">{JSON.stringify(rule.actual)}</code>
              </span>
              {factsAsOf !== null && index === 0 && (
                <span className="ml-1 text-ink-faint">as projected</span>
              )}
            </>
          )}
        </li>
      ))}
    </ul>
  );
}
