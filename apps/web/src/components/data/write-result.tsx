'use client';

import { AlertTriangle, Clock } from 'lucide-react';
import type { ClassificationWriteResult } from '@nexuspuppet/contracts';
import { cn } from '@/lib/utils';

/**
 * What actually happened after a classification write.
 *
 * The API answers 202: the change is DURABLE but not yet EFFECTIVE. The ENC
 * file is written asynchronously, so until the materializer runs, the estate is
 * still applying the previous classification (ADR-0003).
 *
 * Saying "Saved" here would be a correctness bug, not a wording preference — an
 * operator who reads "saved" reasonably concludes the machines are configured,
 * and may go on to make a decision based on that. So this reports the queue,
 * names the scope, and never claims the change is live.
 */
export function WriteResult({
  result,
  className,
}: {
  result: Pick<ClassificationWriteResult, 'materializationQueued' | 'warnings'> & {
    warnings?: string[];
  };
  className?: string;
}) {
  const { scope, certnames } = result.materializationQueued;
  const warnings = result.warnings ?? [];

  return (
    <div className={cn('space-y-2', className)}>
      <div
        role="status"
        className="rounded border border-state-pending/40 bg-state-pending/10 p-2.5"
      >
        <div className="flex items-start gap-2">
          <Clock className="mt-0.5 size-3.5 shrink-0 text-state-pending" aria-hidden />
          <div className="min-w-0 text-xs">
            <p className="font-medium text-state-pending">Change saved — materialization queued</p>
            <p className="mt-0.5 text-ink-muted">
              {scope === 'full-reconcile'
                ? 'Every node will be recomputed, because a rule change can pull in nodes that never matched this group.'
                : certnames.length === 0
                  ? 'No nodes are currently affected, so nothing needed rewriting.'
                  : `${certnames.length} node${certnames.length === 1 ? '' : 's'} queued for rewrite.`}
            </p>
            <p className="mt-1 text-ink-faint">
              Puppet applies this on each node&rsquo;s next run, once the ENC file is written. Until
              then the estate keeps its previous classification.
            </p>

            {certnames.length > 0 && certnames.length <= 12 && (
              <ul className="mt-1.5 flex flex-wrap gap-1">
                {certnames.map((certname) => (
                  <li
                    key={certname}
                    className="rounded border border-line bg-panel-raised px-1 font-mono text-3xs text-ink-muted"
                  >
                    {certname}
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      </div>

      {/* Warnings the API returns, e.g. a rule on an unprojected fact — which
          can NEVER match, and would otherwise fail silently (ADR-0004). */}
      {warnings.map((warning) => (
        <div
          key={warning}
          role="alert"
          className="flex items-start gap-2 rounded border border-state-pending/40 bg-state-pending/5 p-2.5 text-xs"
        >
          <AlertTriangle className="mt-0.5 size-3.5 shrink-0 text-state-pending" aria-hidden />
          <p className="text-ink-muted">{warning}</p>
        </div>
      ))}
    </div>
  );
}
