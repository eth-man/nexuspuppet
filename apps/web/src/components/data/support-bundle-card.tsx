'use client';

import { useState } from 'react';
import { Download } from 'lucide-react';
import { SUPPORT_BUNDLE_DEFAULT_HOURS, SUPPORT_BUNDLE_WINDOWS } from '@nexuspuppet/contracts';
import { useAuth } from '@/providers/auth-provider';
import { buttonVariants } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Field } from '@/components/ui/field';
import { Select } from '@/components/ui/select';
import { cn } from '@/lib/utils';

/** The host half, which the API cannot collect and must not be able to (ADR-0013). */
const HOST_COMMAND =
  'sudo ./scripts/support-bundle.sh --since 24h \\\n  --include ~/Downloads/nexuspuppet-support-*.tar.gz';

/**
 * One archive to send to support (ADR-0028).
 *
 * On General, beside the log level, rather than on a tab of its own: the two
 * are one workflow — raise the level, reproduce, download — and a tab holding a
 * single card is navigation without content.
 *
 * Rendered only for `settings:manage`. That hides a control the viewer cannot
 * use; the API refuses independently, and that is the boundary.
 */
export function SupportBundleCard() {
  const { can } = useAuth();
  const [hours, setHours] = useState<number>(SUPPORT_BUNDLE_DEFAULT_HOURS);
  // Unticked on every visit, never remembered: the privacy-safe bundle is the
  // default, and the opt-in is a decision made per download (ADR-0028 §6).
  const [personal, setPersonal] = useState(false);

  if (!can('settings:manage')) return null;

  const href =
    `/api/system/support-bundle?hours=${String(hours)}` +
    (personal ? '&includePersonalData=true' : '');

  return (
    <Card>
      <CardHeader>
        <CardTitle>Support bundle</CardTitle>
      </CardHeader>

      <CardContent className="space-y-2">
        <p className="text-xs text-ink-muted">
          One archive (<span className="font-mono">.tar.gz</span>) of this console&rsquo;s own logs,
          status, conditions and non-secret configuration, redacted before it leaves the server. The
          download is recorded in the audit log.
        </p>

        <div className="flex items-end gap-2">
          <Field label="Window" className="w-32">
            {(id) => (
              <Select id={id} value={hours} onChange={(e) => setHours(Number(e.target.value))}>
                {SUPPORT_BUNDLE_WINDOWS.map((option) => (
                  <option key={option} value={option}>
                    Last {option} h
                  </option>
                ))}
              </Select>
            )}
          </Field>

          {/* A LINK, not a fetch: the browser owns the filename and the save
              dialog, and nothing holds the archive in page memory. Same
              pattern as the node CSV export. */}
          <a
            href={href}
            download
            className={cn(buttonVariants({ variant: 'secondary', size: 'md' }))}
          >
            <Download aria-hidden />
            Download
          </a>
        </div>

        <div className="space-y-0.5">
          <label className="flex items-center gap-1.5 text-xs text-ink">
            <input
              type="checkbox"
              checked={personal}
              onChange={(event) => setPersonal(event.target.checked)}
              className="size-3.5 accent-[var(--color-accent)]"
            />
            Include configuration and personal data
          </label>
          {/* Stated plainly, beside the control rather than behind a tooltip:
              this is the one choice here that changes who may see the file. */}
          <p className={cn('pl-5 text-2xs', personal ? 'text-state-pending' : 'text-ink-faint')}>
            Adds email addresses, IP addresses, audit before/after values and full class parameters
            &mdash; which may contain secrets. Share only with someone entitled to see them. Secrets
            from the environment, password hashes and tokens are never included.
          </p>
        </div>

        <details className="text-2xs text-ink-faint">
          <summary className="cursor-pointer text-ink-muted">
            What is in it, and what is not
          </summary>
          <ul className="mt-1 list-disc space-y-0.5 pl-4">
            <li>API logs from every replica for the window, oldest first</li>
            <li>System status, open and resolved conditions, propagation, log level</li>
            <li>Configuration: non-secret values; secrets only as set / unset</li>
            <li>Queue, migration and cache summaries; audit actions without actors</li>
          </ul>
          <p className="mt-1">
            Left out unless ticked: users and email addresses, client IPs, audit before/after
            values, the classification and its parameter values, saved queries.
          </p>
          <p className="mt-1">
            Never included: environment secrets, stored credentials, password hashes, tokens,
            private keys. <span className="font-mono">manifest.json</span> inside lists exactly what
            was redacted.
          </p>
        </details>

        <div className="space-y-1">
          <p className="text-2xs text-ink-faint">
            Container, Docker and systemd logs live on the host. Run this there to add them and
            produce one file for support:
          </p>
          <pre className="overflow-x-auto rounded border border-line-soft bg-panel-raised px-2 py-1 font-mono text-2xs text-ink">
            {HOST_COMMAND}
          </pre>
        </div>
      </CardContent>
    </Card>
  );
}
