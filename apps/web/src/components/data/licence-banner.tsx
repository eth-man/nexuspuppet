'use client';

import { AlertTriangle } from 'lucide-react';
import { useCapabilities, useLicence } from '@/lib/queries';
import { useAuth } from '@/providers/auth-provider';
import { cn } from '@/lib/utils';

/**
 * Says when a licence is running out, and only then (ADR-0014 §3, §4).
 *
 * THE DISTINCTION THIS EXISTS TO MAKE. `licensed: false` is the CORRECT and
 * ordinary state of a core deployment — it is not a problem, and a banner
 * telling an operator their unlicensed open-source console is unlicensed would
 * be both wrong and insulting. Only an ENTERPRISE deployment can have a licence
 * problem, so `edition` decides whether this component says anything at all.
 *
 * SILENT UNTIL IT MATTERS. Nothing appears while a licence has more than 30
 * days left. A banner that is always there is furniture, and furniture is not
 * read on the day it changes.
 *
 * `settings:manage` ONLY. A viewer cannot renew a licence; telling them it
 * expires in nine days is noise, and noise is how the banner that matters gets
 * ignored. The API refuses the request for anyone else regardless — `can()`
 * here decides whether to ASK, never whether to trust the answer.
 */

/** Matches ADR-0014 §4: expiry starts a window, it is not a cutoff. */
const GRACE_DAYS = 30;

/** How early to start saying anything. */
const WARN_WITHIN_DAYS = 30;

const DAY_MS = 24 * 60 * 60 * 1000;

export function LicenceBanner() {
  const { can } = useAuth();
  const capabilities = useCapabilities();
  const mayManage = can('settings:manage');
  const licence = useLicence(mayManage && capabilities.data?.edition === 'enterprise');

  // Core is unlicensed by definition. Nothing to say.
  if (capabilities.data?.edition !== 'enterprise') return null;
  if (!mayManage || licence.data === undefined) return null;

  const { licensed, expiresAt, subject } = licence.data;

  /*
   * An enterprise build with no readable licence at all. Distinct from expiry:
   * there is no date to count down to, and the likely cause is a file that was
   * never mounted rather than a renewal anybody forgot.
   */
  if (expiresAt === undefined) {
    return (
      <Banner tone="expired">
        This deployment has <strong>no valid licence</strong>, so enterprise features are switched
        off. Classification and the ENC are unaffected. Check that the licence file is mounted at{' '}
        <code className="font-mono">/etc/nexuspuppet/licence.jwt</code>.
      </Banner>
    );
  }

  const expiry = new Date(expiresAt);
  const daysLeft = Math.ceil((expiry.getTime() - Date.now()) / DAY_MS);

  // Comfortably in date. Say nothing.
  if (licensed && daysLeft > WARN_WITHIN_DAYS) return null;

  if (!licensed) {
    return (
      <Banner tone="expired">
        The licence for <strong>{subject}</strong> expired on {expiry.toLocaleDateString()} and its{' '}
        {GRACE_DAYS}-day grace period has ended. Enterprise features are switched off;
        classification and the ENC are unaffected.
      </Banner>
    );
  }

  /*
   * Past expiry but inside grace. Everything still works, and saying so plainly
   * matters — an operator who reads "expired" and assumes an outage will make
   * one trying to fix it.
   */
  if (daysLeft <= 0) {
    const graceLeft = GRACE_DAYS + daysLeft;
    return (
      <Banner tone="grace">
        The licence for <strong>{subject}</strong> expired on {expiry.toLocaleDateString()}.{' '}
        <strong>
          Everything keeps working for another {graceLeft} day{graceLeft === 1 ? '' : 's'}
        </strong>
        , after which enterprise features switch off.
      </Banner>
    );
  }

  return (
    <Banner tone="warn">
      The licence for <strong>{subject}</strong> expires in {daysLeft} day
      {daysLeft === 1 ? '' : 's'}, on {expiry.toLocaleDateString()}.
    </Banner>
  );
}

/**
 * Amber throughout, never red.
 *
 * Red is a FAILED PUPPET RUN in this palette (lib/status.ts). A licence problem
 * is not an estate problem — the whole design of ADR-0014 §2 is that expiry
 * never touches classification, materialisation or the ENC — and colouring it
 * like a failed run would say the opposite at a glance.
 */
function Banner({
  tone,
  children,
}: {
  tone: 'warn' | 'grace' | 'expired';
  children: React.ReactNode;
}) {
  return (
    <div
      role="status"
      className={cn(
        'flex items-start gap-2 border-b px-3 py-1.5 text-xs',
        'border-state-pending/30 bg-state-pending/10 text-ink',
        tone === 'expired' && 'font-medium',
      )}
    >
      <AlertTriangle className="mt-px size-3.5 shrink-0 text-state-pending" aria-hidden />
      <span>{children}</span>
    </div>
  );
}
