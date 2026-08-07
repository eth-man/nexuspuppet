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
