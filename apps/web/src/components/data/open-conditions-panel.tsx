'use client';

import { AlertTriangle, CheckCircle2 } from 'lucide-react';
import { useOpenConditions } from '@/lib/queries';
import { Card, CardHeader, CardTitle } from '@/components/ui/card';
import { ago } from '@/lib/format';

/**
 * What is wrong right now (ADR-0021).
 *
 * Conditions, not events: each entry is something that is true at this moment
 * and will disappear on its own when it stops being true. That is why there is
 * no acknowledge button and no history — a log of things that were briefly
 * wrong is what the status card and the audit trail already do better.
 *
 * RENDERS NOTHING WHEN HEALTHY, apart from one quiet line. A panel that is
 * always present becomes furniture, and this exists to be noticed.
 */
export function OpenConditionsPanel() {
  const conditions = useOpenConditions();

  // A failed query is not "healthy" — saying nothing is wrong because we could
  // not ask would be the worst possible lie for this particular surface.
  if (conditions.isError) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Conditions</CardTitle>
        </CardHeader>
        <p className="px-3 py-2 text-2xs text-state-failed">
          Could not read the deployment&rsquo;s conditions. Nothing here should be taken as healthy.
        </p>
      </Card>
    );
  }

  if (conditions.isPending) return null;

  if (conditions.data.length === 0) {
    return (
      <p className="flex items-center gap-1.5 px-1 text-2xs text-ink-faint">
        <CheckCircle2 className="size-3.5 shrink-0 text-state-unchanged" aria-hidden />
        No open conditions.
      </p>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Conditions</CardTitle>
        <span className="text-2xs text-ink-faint">{conditions.data.length} open</span>
      </CardHeader>

      <ul className="divide-y divide-line-soft" role="list">
        {conditions.data.map((condition) => (
          <li key={condition.key} className="flex items-start gap-2 px-3 py-2">
            <AlertTriangle
              className={
                condition.severity === 'critical'
                  ? 'mt-0.5 size-3.5 shrink-0 text-state-failed'
                  : 'mt-0.5 size-3.5 shrink-0 text-state-pending'
              }
              aria-hidden
            />
            <div className="min-w-0 flex-1">
              <p className="text-xs text-ink">{condition.summary}</p>
              {/* Since when, not a timestamp: "how long has this been true" is
                  the question an open condition provokes. */}
              <p className="text-2xs text-ink-faint">
                since {ago(condition.openedAt)}
                <span className="ml-1.5 font-mono">{condition.kind}</span>
              </p>
            </div>
          </li>
        ))}
      </ul>
    </Card>
  );
}
