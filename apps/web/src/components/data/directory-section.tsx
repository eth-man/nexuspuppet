'use client';

import type { ReactNode } from 'react';
import { AlertTriangle } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';

/** Where a directory's configuration comes from, as the API reports it. */
export type DirectorySource = 'database' | 'environment' | 'unset';

/**
 * One directory on the Directory / Auth page: a named region with a status
 * badge, holding that directory's cards (ADR-0029).
 *
 * TWO REASONS IT IS A REGION. Both directories are always on this page now —
 * there is no "not enabled" header any more, only a form — and their cards
 * share titles: each has "Role mappings", each has an "Edit settings" button.
 * Without a named boundary a screen reader user hears two identical headings
 * with nothing to tell them apart, and so does any test that looks for one.
 *
 * The badge says where the configuration in force came from, in the words an
 * operator would use. It is NOT a Puppet state, so it does not go through
 * lib/status: configuration provenance has no "failed" to keep consistent,
 * and borrowing a state colour for it would suggest one.
 */
export function DirectorySection({
  id,
  title,
  description,
  source,
  children,
}: {
  id: string;
  title: string;
  description: string;
  /** Undefined while the settings are loading. */
  source: DirectorySource | undefined;
  children: ReactNode;
}) {
  const headingId = `${id}-heading`;

  return (
    <section aria-labelledby={headingId} className="space-y-3">
      <header className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 border-b border-line-soft pb-1.5">
        <h2 id={headingId} className="text-sm font-semibold text-ink">
          {title}
        </h2>
        {source !== undefined && <SourceBadge source={source} />}
        <p className="w-full text-2xs text-ink-muted">{description}</p>
      </header>
      {children}
    </section>
  );
}

/**
 * The deployment has no CONFIG_ENCRYPTION_KEY, so no secret can be stored
 * (ADR-0016 §3). Specific and actionable, in the API's own words, and shown
 * BEFORE anybody types a password rather than as a refused save (ADR-0029 §6).
 */
export function EncryptionKeyNotice({ secret }: { secret: string }) {
  return (
    <div
      role="note"
      className="flex items-start gap-2 rounded border border-state-pending/40 bg-state-pending/10 px-2.5 py-2"
    >
      <AlertTriangle className="mt-px size-3.5 shrink-0 text-state-pending" aria-hidden />
      <p className="text-2xs text-state-pending">
        {`Saving ${secret} needs CONFIG_ENCRYPTION_KEY. Re-run `}
        <span className="font-mono">scripts/deploy.sh</span>
        {', which generates it, or set it in '}
        <span className="font-mono">.env</span>
        {' and restart.'}
      </p>
    </div>
  );
}

const SOURCE_LABELS: Record<DirectorySource, string> = {
  unset: 'Not configured',
  environment: 'From the environment',
  database: 'Saved in the console',
};

/**
 * Not configured / From the environment / Saved in the console.
 *
 * "Not configured" is quieter than the other two: it is the ordinary state of
 * a deployment that uses local accounts only, not a fault.
 */
export function SourceBadge({ source }: { source: DirectorySource }) {
  return (
    <Badge
      className={cn(source === 'unset' && 'border-line/60 text-ink-faint')}
      data-source={source}
    >
      {SOURCE_LABELS[source]}
    </Badge>
  );
}
