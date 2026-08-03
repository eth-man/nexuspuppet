'use client';

import type { ConsoleTlsStatus } from '@nexuspuppet/contracts';
import { AlertTriangle, Lock, ShieldOff } from 'lucide-react';
import { useConsoleTls } from '@/lib/queries';
import { ConsoleTlsInstall } from './console-tls-install';
import { cn } from '@/lib/utils';
import { Card, CardHeader, CardTitle } from '@/components/ui/card';

/**
 * The certificate the console is served with, and when it stops working.
 *
 * An expired console certificate is an outage, and it is the commonest way TLS
 * breaks — so the one thing this card exists to do is say "nine days" before
 * anybody finds out the hard way.
 *
 * It reports what is ON DISK at the configured path. It does not ask a proxy
 * what it loaded: operators run nginx, HAProxy or an appliance in front of this,
 * and a card coupled to the proxy we happen to ship would call a healthy
 * deployment broken (ADR-0013).
 */

/** Where "renew this soon" starts. Wide enough to survive a change freeze. */
const WARN_WITHIN_DAYS = 30;

export function ConsoleTlsCard() {
  const tls = useConsoleTls();

  if (tls.isPending || tls.data === undefined) return null;
  if (tls.isError) return null;

  return (
    <Card className={cn(borderFor(tls.data))}>
      <CardHeader className="flex items-center justify-between">
        <CardTitle>Console certificate</CardTitle>
        <Headline status={tls.data} />
      </CardHeader>
      <div className="space-y-2 p-3 text-xs">
        <Body status={tls.data} />
        {/* Only where it can work. `installable` is false when the deployment
            has no CERT_HELPER_SECRET — TLS terminates elsewhere, or the tls
            profile is off — and a button that always 503s is worse than none. */}
        {tls.data.installable && <ConsoleTlsInstall />}
      </div>
    </Card>
  );
}

function borderFor(status: ConsoleTlsStatus): string | undefined {
  if (!status.configured) return undefined;
  if (status.error !== null) return 'border-state-failed/40';
  if (status.certificate?.expired === true) return 'border-state-failed/40';
  if (status.coversExpectedHostname === false) return 'border-state-failed/40';
  if ((status.certificate?.daysRemaining ?? Infinity) <= WARN_WITHIN_DAYS) {
    return 'border-state-pending/40';
  }
  return undefined;
}

function Headline({ status }: { status: ConsoleTlsStatus }) {
  if (!status.configured) {
    return <span className="text-[11px] text-ink-faint">not reported here</span>;
  }
  if (status.error !== null || status.certificate === null) {
    return <span className="text-[11px] font-medium text-state-failed">unreadable</span>;
  }

  const { expired, daysRemaining } = status.certificate;

  if (expired) {
    return <span className="text-[11px] font-medium text-state-failed">expired</span>;
  }
  if (daysRemaining <= WARN_WITHIN_DAYS) {
    return (
      <span className="text-[11px] font-medium text-state-pending">
        {daysRemaining} day{daysRemaining === 1 ? '' : 's'} left
      </span>
    );
  }
  return <span className="text-[11px] text-ink-faint">{daysRemaining} days left</span>;
}

function Body({ status }: { status: ConsoleTlsStatus }) {
  // Not an error, and must not look like one. Most deployments terminate TLS at
  // their own reverse proxy, where this product cannot see the certificate and
  // has no business trying to.
  if (!status.configured) {
    return (
      <p className="flex items-start gap-1.5 text-ink-muted">
        <ShieldOff className="mt-px shrink-0 text-ink-faint" size={13} aria-hidden />
        <span>
          No certificate path is configured, so this deployment terminates TLS elsewhere — at your
          own reverse proxy, most likely. Set{' '}
          <code className="text-ink">CONSOLE_TLS_CERT_PATH</code> to the public{' '}
          <code className="text-ink">.pem</code> to have expiry reported here.
        </span>
      </p>
    );
  }

  if (status.error !== null || status.certificate === null) {
    /*
     * A STATUS, not a stack trace.
     *
     * This used to render the API's message verbatim, and that message carried
     * the filesystem path — so an end user was shown
     * `/etc/nexuspuppet/tls/console.pem`, which they cannot reach, cannot fix,
     * and did not need in order to understand that no certificate is
     * installed. The path is still logged by the API, where somebody with
     * shell access reads it.
     */
    const detail =
      status.errorCode === 'missing'
        ? 'Install one below to serve the console over HTTPS.'
        : status.errorCode === 'unparsable'
          ? 'The installed file is not a certificate this console can read. Replacing it below is the fix.'
          : 'The certificate is installed but could not be read. This is usually a file permission on the server.';

    return (
      <div className="space-y-1">
        <p className="flex items-start gap-1.5 text-state-failed">
          <AlertTriangle className="mt-px shrink-0" size={13} aria-hidden />
          <span>
            <span className="font-medium">Status:</span>{' '}
            {status.errorCode === 'missing'
              ? 'No certificate installed'
              : 'Installed certificate unusable'}
          </span>
        </p>
        <p className="pl-[18px] text-ink-muted">{detail}</p>
      </div>
    );
  }

  const cert = status.certificate;

  return (
    <>
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
        <Row label="Subject" value={cert.subject} />
        <Row label="Issuer" value={cert.issuer} />
        {cert.subjectAltNames.length > 0 && (
          <Row label="Valid for" value={cert.subjectAltNames.join(', ')} />
        )}
        <Row label="Expires" value={new Date(cert.validTo).toISOString().slice(0, 10)} />
      </dl>

      {cert.expired && (
        <Note tone="failed">
          This certificate expired. Browsers are refusing the console until it is replaced.
        </Note>
      )}

      {cert.notYetValid && (
        <Note tone="failed">
          This certificate is not valid yet. Check the clock on this host and on your CA.
        </Note>
      )}

      {/* False, not null. Null means nobody declared a hostname to check against,
          which is a missing setting rather than a broken certificate. */}
      {status.coversExpectedHostname === false && status.expectedHostname !== null && (
        <Note tone="failed">
          This certificate does not cover <strong>{status.expectedHostname}</strong>. A browser
          reaching the console by that name will refuse it, whatever else is correct.
        </Note>
      )}

      {!cert.expired && cert.daysRemaining <= WARN_WITHIN_DAYS && (
        <Note tone="pending">
          Renew before it expires. Replacing the file and reloading your proxy is enough — nothing
          in NexusPuppet needs restarting.
        </Note>
      )}

      {/*
        A placeholder we generated, versus one the operator chose.
        
        Both are self-signed and look identical in the certificate itself, so
        the API distinguishes them by the marker cert-helper writes into the
        subject (ADR-0013). Saying "replace this" about somebody's deliberate
        choice would be nagging; not saying it about our own placeholder would
        leave a deployment on it indefinitely.
      */}
      {cert.temporary ? (
        <Note tone="pending">
          <span className="font-medium">Status: temporary self-signed certificate.</span> This
          console generated one for itself at first start so the connection is encrypted from the
          beginning. Browsers will warn until you install a certificate your organisation trusts.
        </Note>
      ) : (
        cert.selfSigned && (
          <p className="flex items-start gap-1.5 text-ink-faint">
            <Lock className="mt-px shrink-0" size={13} aria-hidden />
            <span>
              Self-signed, or issued by a CA this host does not chain to. Browsers warn until your
              CA&apos;s certificate is installed on the machines that use the console.
            </span>
          </p>
        )
      )}
    </>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <>
      <dt className="text-ink-faint">{label}</dt>
      <dd className="break-all font-mono text-[11px] text-ink">{value}</dd>
    </>
  );
}

function Note({ tone, children }: { tone: 'failed' | 'pending'; children: React.ReactNode }) {
  return (
    <p
      className={cn(
        'flex items-start gap-1.5',
        tone === 'failed' ? 'text-state-failed' : 'text-state-pending',
      )}
    >
      <AlertTriangle className="mt-px shrink-0" size={13} aria-hidden />
      <span>{children}</span>
    </p>
  );
}
