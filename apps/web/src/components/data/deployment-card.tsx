'use client';

import { useState } from 'react';
import { CheckCircle2, RefreshCw, XCircle } from 'lucide-react';
import type { UpdateCheck } from '@nexuspuppet/contracts';
import { useCapabilities, useDeployment } from '@/lib/queries';
import { useCheckForUpdates } from '@/lib/mutations';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Spinner, QueryError } from '@/components/states';

/** "3d 4h", "4h 12m", "12m". Whole units only — a console is not a stopwatch. */
function uptime(seconds: number): string {
  const d = Math.floor(seconds / 86_400);
  const h = Math.floor((seconds % 86_400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

/**
 * What this deployment is, and whether it is well.
 *
 * The update check is the only thing in the console that reaches the internet,
 * and it happens when the button is pressed and at no other time — Puppet
 * estates are frequently air-gapped, and an appliance that phones out
 * unprompted is disqualifying there regardless of what it phones out about.
 */
export function DeploymentCard() {
  const capabilities = useCapabilities();
  const deployment = useDeployment();
  const check = useCheckForUpdates();
  const [result, setResult] = useState<UpdateCheck | null>(null);

  return (
    <Card>
      <CardHeader>
        <CardTitle>Deployment</CardTitle>
        <Health />
      </CardHeader>

      <CardContent className="space-y-3">
        {deployment.isError ? (
          <QueryError error={deployment.error} />
        ) : deployment.isPending || capabilities.isPending ? (
          <Spinner />
        ) : (
          <dl className="grid grid-cols-[7rem_1fr] gap-y-1 text-xs">
            <dt className="text-ink-faint">Version</dt>
            <dd className="font-mono text-ink">{deployment.data.version}</dd>

            <dt className="text-ink-faint">Edition</dt>
            <dd className="text-ink">{capabilities.data?.edition ?? '—'}</dd>

            <dt className="text-ink-faint">Uptime</dt>
            <dd className="text-ink">{uptime(deployment.data.uptimeSeconds)}</dd>

            <dt className="text-ink-faint">Database</dt>
            <dd className="text-ink">
              {deployment.data.database.connected ? (
                <>
                  connected
                  {deployment.data.database.latencyMs !== null && (
                    <span className="ml-1 text-ink-faint">
                      ({deployment.data.database.latencyMs} ms)
                    </span>
                  )}
                </>
              ) : (
                <span className="text-state-failed">not answering</span>
              )}
            </dd>
          </dl>
        )}

        <div className="space-y-2 border-t border-line-soft pt-3">
          <Button
            variant="outline"
            size="sm"
            disabled={check.isPending}
            onClick={() =>
              check.mutate(undefined, {
                onSuccess: setResult,
                // The endpoint answers `reachable: false` rather than failing,
                // so an error here is the API being unreachable — not the
                // internet.
                onError: () =>
                  setResult({
                    current: deployment.data?.version ?? '',
                    latest: null,
                    updateAvailable: false,
                    releaseUrl: null,
                    reachable: false,
                    message: 'The console could not complete the check.',
                  }),
              })
            }
          >
            <RefreshCw
              className={check.isPending ? 'mr-1 size-3.5 animate-spin' : 'mr-1 size-3.5'}
              aria-hidden
            />
            {check.isPending ? 'Checking…' : 'Check for updates'}
          </Button>

          {result !== null && <Result result={result} />}

          <p className="text-2xs text-ink-faint">
            {'Checks the public release list only when you press this. Nothing about this '}
            {'deployment is sent, and nothing is checked automatically.'}
          </p>
        </div>
      </CardContent>
    </Card>
  );
}

/**
 * Release tags carry a leading `v`; the running version does not.
 *
 * So `v1.3.0` and `1.3.0` are the same release and must compare equal — without
 * this, a perfectly current deployment reports itself as ahead of the release
 * it is actually running.
 */
function strip(version: string): string {
  return version.replace(/^v/, '');
}

/** The outcome, including "this host has no internet", which is not a fault. */
function Result({ result }: { result: UpdateCheck }) {
  if (!result.reachable) {
    return (
      <p role="status" className="text-2xs text-ink-muted">
        {result.message ?? 'Could not reach the release service.'}
      </p>
    );
  }

  if (!result.updateAvailable) {
    /*
     * The version shown is the one RUNNING, not the newest published.
     *
     * Those are usually the same, and when they are not, showing the published
     * one is actively wrong: a deployment on 1.3.0 whose newest published
     * release is v1.2.0 read "Up to date (v1.2.0)", which looks like a claim
     * about what is installed. An operator checking their version came away
     * with the wrong number.
     *
     * Running ahead is a normal state — a tag that was never published as a
     * release, a build from main, a private fork — so it is reported plainly
     * rather than treated as a fault.
     */
    const ahead = result.latest !== null && strip(result.latest) !== strip(result.current);

    return (
      <p role="status" className="flex flex-wrap items-center gap-1.5 text-2xs text-ink-muted">
        <CheckCircle2 className="size-3.5 shrink-0 text-state-unchanged" aria-hidden />
        Up to date ({result.current})
        {ahead && (
          <span className="text-ink-faint">
            — ahead of the newest published release ({result.latest})
          </span>
        )}
      </p>
    );
  }

  return (
    <p role="status" className="flex flex-wrap items-center gap-1.5 text-2xs text-ink">
      <Badge>{result.latest}</Badge>
      is available
      {result.releaseUrl !== null && (
        <a
          href={result.releaseUrl}
          target="_blank"
          rel="noreferrer"
          className="text-accent underline-offset-2 hover:underline"
        >
          release notes
        </a>
      )}
    </p>
  );
}

/**
 * One dot, in the header.
 *
 * Green means the API answered and the database answered with it. Anything
 * else is not green — a health light that is green while a dependency is down
 * is worse than no light, because it is consulted instead of the logs.
 */
function Health() {
  const deployment = useDeployment();
  const healthy = deployment.data?.database.connected === true;

  if (deployment.isPending) return null;

  return (
    <span className="flex shrink-0 items-center gap-1.5 text-2xs">
      {healthy ? (
        <>
          <span className="size-2 rounded-full bg-state-unchanged" aria-hidden />
          <span className="text-ink-muted">System healthy</span>
        </>
      ) : (
        <>
          <XCircle className="size-3.5 text-state-failed" aria-hidden />
          <span className="text-state-failed">Degraded</span>
        </>
      )}
    </span>
  );
}
