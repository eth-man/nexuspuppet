'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { AlertTriangle, CheckCircle2, Loader2, ShieldAlert, Upload } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import {
  type CertificateIdentity,
  InstallError,
  attemptConfirm,
  authorizeInstall,
  stageInstall,
} from '@/lib/console-tls';

/** How often confirmation is attempted while the window is open. */
const POLL_INTERVAL_MS = 2000;

type Phase =
  | { name: 'idle' }
  | { name: 'working'; label: string }
  | { name: 'confirming'; expiresAt: number; token: string; reconnecting: boolean }
  | { name: 'installed'; identity: CertificateIdentity }
  | { name: 'failed'; message: string; detail?: string; severe: boolean };

/**
 * Install a certificate, and prove it from this browser before it is kept.
 *
 * The confirmation loop is the point of the screen, not decoration. What locks
 * an operator out is a certificate their browser will not trust, and nothing
 * inside the deployment can see that — so the install is held open until THIS
 * client completes a TLS handshake against the new certificate and says so.
 *
 * A `fetch` rejection during that window is expected, not exceptional: the
 * reload drops the pooled connection, and behind a private CA the operator may
 * have to accept a browser warning before anything can complete. Those attempts
 * are "not yet", and the loop keeps going until the deadline the SERVER set.
 */
export function ConsoleTlsInstall() {
  const [certificate, setCertificate] = useState('');
  const [privateKey, setPrivateKey] = useState('');
  const [phase, setPhase] = useState<Phase>({ name: 'idle' });
  const [remaining, setRemaining] = useState(0);

  // Read by the interval callback, which would otherwise close over the phase
  // as it was when the interval was created.
  const phaseRef = useRef(phase);
  phaseRef.current = phase;

  const confirming = phase.name === 'confirming';
  const expiresAt = confirming ? phase.expiresAt : 0;

  useEffect(() => {
    if (!confirming) return;

    const tick = setInterval(() => {
      setRemaining(Math.max(0, Math.ceil((expiresAt - Date.now()) / 1000)));
    }, 250);
    setRemaining(Math.max(0, Math.ceil((expiresAt - Date.now()) / 1000)));

    return () => clearInterval(tick);
  }, [confirming, expiresAt]);

  useEffect(() => {
    if (phase.name !== 'confirming') return;
    let cancelled = false;
    const token = phase.token;
    const deadline = phase.expiresAt;

    const poll = async () => {
      while (!cancelled && Date.now() < deadline) {
        const outcome = await attemptConfirm(token);
        if (cancelled) return;

        if (outcome.kind === 'confirmed') {
          setPhase({ name: 'installed', identity: outcome.identity });
          return;
        }
        if (outcome.kind === 'failed') {
          setPhase({ name: 'failed', message: outcome.message, severe: false });
          return;
        }
        if (outcome.kind === 'expired') {
          setPhase({
            name: 'failed',
            severe: false,
            message:
              'The confirmation window closed before this browser could reach the console over ' +
              'the new certificate, so it was rolled back. The previous certificate is serving ' +
              'again. Nothing was lost — check the chain and try again.',
          });
          return;
        }

        // Unreachable: expected while the listener restarts, and for as long as
        // the operator spends accepting a certificate warning. Surface it as a
        // state, not an error, and keep the countdown running.
        setPhase((current) =>
          current.name === 'confirming' && !current.reconnecting
            ? { ...current, reconnecting: true }
            : current,
        );
        await sleep(POLL_INTERVAL_MS);
      }

      if (!cancelled && phaseRef.current.name === 'confirming') {
        // The server rolls back on its own deadline; this is only what this
        // browser can say about it.
        setPhase({
          name: 'failed',
          severe: false,
          message:
            'The confirmation window closed without this browser reaching the console over the ' +
            'new certificate. It has been rolled back and the previous certificate is serving.',
        });
      }
    };

    void poll();
    return () => {
      cancelled = true;
    };
  }, [phase.name, phase.name === 'confirming' ? phase.token : '', expiresAt]);

  const install = useCallback(async () => {
    try {
      setPhase({ name: 'working', label: 'Authorising…' });
      const grant = await authorizeInstall();

      setPhase({ name: 'working', label: 'Installing and reloading the proxy…' });
      const staged = await stageInstall(grant, certificate, privateKey);

      setPhase({
        name: 'confirming',
        token: staged.confirmationToken,
        expiresAt: new Date(staged.expiresAt).getTime(),
        reconnecting: false,
      });
    } catch (error) {
      if (error instanceof InstallError) {
        setPhase({
          name: 'failed',
          message: error.message,
          ...(error.detail === undefined ? {} : { detail: error.detail }),
          severe: error.kind === 'rollback-failed',
        });
        return;
      }
      // The upload itself failed to reach the helper. Nothing was installed.
      setPhase({
        name: 'failed',
        severe: false,
        message:
          'The certificate could not be uploaded. Nothing was changed — the console is still ' +
          'being served with its current certificate.',
      });
    }
  }, [certificate, privateKey]);

  const ready = certificate.trim() !== '' && privateKey.trim() !== '';

  return (
    <div className="space-y-3 border-t border-line-soft pt-3">
      <div>
        <p className="text-xs font-semibold text-ink">Install a new certificate</p>
        <p className="mt-1 max-w-prose text-[11px] text-ink-faint">
          {'The key is uploaded directly to the certificate installer, not to the API. '}
          {'Paste the full chain if you have one — the leaf must come first.'}
        </p>
      </div>

      {phase.name === 'confirming' ? (
        <Confirming remaining={remaining} reconnecting={phase.reconnecting} />
      ) : phase.name === 'installed' ? (
        <Installed identity={phase.identity} />
      ) : phase.name === 'failed' ? (
        <Failed
          message={phase.message}
          detail={phase.detail}
          severe={phase.severe}
          onDismiss={() => setPhase({ name: 'idle' })}
        />
      ) : (
        <>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field id="tls-cert" label="Certificate (PEM)" hint="Leaf first, then any issuers.">
              <Textarea
                id="tls-cert"
                rows={5}
                className="font-mono text-[11px]"
                placeholder="-----BEGIN CERTIFICATE-----"
                value={certificate}
                onChange={(e) => setCertificate(e.target.value)}
              />
            </Field>
            <Field
              id="tls-key"
              label="Private key (PEM)"
              hint="Must not be passphrase-protected — the proxy has nowhere to keep one."
            >
              <Textarea
                id="tls-key"
                rows={5}
                className="font-mono text-[11px]"
                // Deliberately not the literal PEM banner. CI greps the tree for one
                // to catch a committed key, and a placeholder that trips that guard is
                // a reason to change the placeholder — never the guard.
                placeholder="The PEM private key for that certificate"
                value={privateKey}
                onChange={(e) => setPrivateKey(e.target.value)}
              />
            </Field>
          </div>

          <div className="flex items-start gap-2 rounded border border-state-pending/40 bg-state-pending/10 p-2">
            <AlertTriangle className="mt-0.5 size-3.5 shrink-0 text-state-pending" aria-hidden />
            <p className="text-[11px] text-ink-muted">
              <span className="font-semibold text-ink">Keep this tab open.</span>
              {' The new certificate is installed immediately but kept only if this browser can '}
              {'reach the console over it. If it cannot — an incomplete chain, a CA your machine '}
              {'does not trust — it is rolled back automatically and nothing is lost.'}
            </p>
          </div>

          <Button
            variant="primary"
            size="sm"
            disabled={!ready || phase.name === 'working'}
            onClick={() => void install()}
          >
            {phase.name === 'working' ? (
              <>
                <Loader2 className="mr-1 size-3.5 animate-spin" aria-hidden />
                {phase.label}
              </>
            ) : (
              <>
                <Upload className="mr-1 size-3.5" aria-hidden />
                Install certificate
              </>
            )}
          </Button>
        </>
      )}
    </div>
  );
}

function Confirming({ remaining, reconnecting }: { remaining: number; reconnecting: boolean }) {
  return (
    <div
      role="status"
      aria-live="polite"
      className="rounded border border-accent/40 bg-accent/10 p-3"
    >
      <div className="flex items-center gap-2">
        <Loader2 className="size-4 animate-spin text-accent" aria-hidden />
        <p className="text-xs font-semibold text-ink">
          {reconnecting ? 'Re-establishing secure connection…' : 'Confirming the new certificate…'}
        </p>
        <span className="ml-auto font-mono text-xs tabular-nums text-ink">
          {String(Math.floor(remaining / 60)).padStart(2, '0')}:
          {String(remaining % 60).padStart(2, '0')}
        </span>
      </div>

      <p className="mt-2 max-w-prose text-[11px] text-ink-muted">
        {reconnecting
          ? 'The connection dropped when the proxy reloaded, which is expected. If your browser ' +
            'shows a certificate warning, accept it in another tab — this will finish on its own ' +
            'once it can reach the console again.'
          : 'The certificate is in place and being checked from this browser.'}
      </p>
      <p className="mt-1 text-[11px] text-ink-faint">
        If the countdown reaches zero, the previous certificate is restored automatically.
      </p>
    </div>
  );
}

function Installed({ identity }: { identity: CertificateIdentity }) {
  return (
    <div
      role="status"
      className="rounded border border-state-unchanged/40 bg-state-unchanged/10 p-3"
    >
      <div className="flex items-center gap-2">
        <CheckCircle2 className="size-4 text-state-unchanged" aria-hidden />
        <p className="text-xs font-semibold text-ink">Certificate installed and confirmed</p>
      </div>
      <dl className="mt-2 grid grid-cols-[7rem_1fr] gap-y-1 text-[11px]">
        <dt className="text-ink-faint">Subject</dt>
        <dd className="font-mono text-ink">{identity.subject}</dd>
        <dt className="text-ink-faint">Expires</dt>
        <dd className="font-mono text-ink">{identity.validTo.slice(0, 10)}</dd>
      </dl>
    </div>
  );
}

function Failed({
  message,
  detail,
  severe,
  onDismiss,
}: {
  message: string;
  detail: string | undefined;
  severe: boolean;
  onDismiss: () => void;
}) {
  return (
    <div
      role="alert"
      className={
        severe
          ? 'rounded border border-state-failed bg-state-failed/15 p-3'
          : 'rounded border border-state-failed/40 bg-state-failed/10 p-3'
      }
    >
      <div className="flex items-center gap-2">
        <ShieldAlert className="size-4 text-state-failed" aria-hidden />
        <p className="text-xs font-semibold text-ink">
          {severe ? 'The console may be unreachable' : 'Certificate not installed'}
        </p>
      </div>
      <p className="mt-2 max-w-prose text-[11px] text-ink-muted">{message}</p>
      {detail !== undefined && detail !== '' && (
        <p className="mt-1 max-w-prose text-[11px] text-state-failed">{detail}</p>
      )}
      <Button variant="ghost" size="sm" className="mt-2" onClick={onDismiss}>
        Try again
      </Button>
    </div>
  );
}

function Field({
  id,
  label,
  hint,
  children,
}: {
  id: string;
  label: string;
  hint: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-1">
      <Label htmlFor={id}>{label}</Label>
      {children}
      <p className="text-[11px] text-ink-faint">{hint}</p>
    </div>
  );
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
