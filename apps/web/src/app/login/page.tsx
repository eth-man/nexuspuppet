'use client';

import { useEffect, useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { Boxes, Loader2 } from 'lucide-react';
import { ApiError, api } from '@/lib/client';
import { useAuth } from '@/providers/auth-provider';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

interface AuthSourceDescriptor {
  source: string;
  mode: 'credentials' | 'redirect';
  /** What to call the identifier — 'Email' locally, 'Username' for AD. */
  identifierLabel: string;
}

interface AuthSources {
  sources: AuthSourceDescriptor[];
}

/**
 * Sign in.
 *
 * The form asks the API how to authenticate rather than assuming a password
 * (ADR-0006). A deployment running the enterprise SSO provider answers
 * `redirect`, and this screen offers a button instead of a password field —
 * without the enterprise layer adding routes or this page importing anything
 * from it (ADR-0002).
 */
export default function LoginPage() {
  const router = useRouter();
  const { status, login } = useAuth();

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [authSources, setAuthSources] = useState<AuthSources | null>(null);

  /*
   * A deployment may offer several sources (ADR-0023 §3), so this reads a list.
   *
   * Behaviour here is unchanged for now: the label comes from the first
   * credentials source, and a redirect source still produces the single button
   * this screen has always drawn. Rendering a form AND a button per source is
   * #170 — this ticket only stops the answer being singular.
   */
  const sources = authSources?.sources ?? [];
  /*
   * One form covers every credentials source, because the account's own
   * `authSource` decides which provider is asked — the form has nothing to
   * choose between. Redirect sources each need their own button, because a
   * redirect begins before anybody has named an account to dispatch on.
   *
   * The label comes from the first credentials source. Two credentials sources
   * disagreeing about it — 'Email' locally and 'Username' for AD — is possible
   * and has no good answer in one field; the directory's label is the one that
   * matters, since a local admin already knows what to type.
   */
  const credentialSource =
    sources.find((entry) => entry.mode === 'credentials' && entry.source !== 'local') ??
    sources.find((entry) => entry.mode === 'credentials') ??
    null;
  const redirectSources = sources.filter((entry) => entry.mode === 'redirect');
  const identifierLabel = credentialSource?.identifierLabel ?? 'Email';
  const [modeError, setModeError] = useState<string | null>(null);

  useEffect(() => {
    if (status === 'authenticated') router.replace('/');
  }, [status, router]);

  useEffect(() => {
    api
      .get<AuthSources>('/auth/mode')
      .then(setAuthSources)
      .catch((caught: unknown) => {
        // Distinguish "API is down" from "wrong password" before the user has
        // typed anything. Offering a password form for an unreachable API
        // wastes their time on a problem no credential will fix.
        setModeError(
          caught instanceof ApiError ? caught.message : 'Could not reach the NexusPuppet API.',
        );
      });
  }, []);

  const onSubmit = async (event: FormEvent) => {
    event.preventDefault();
    setError(null);
    setSubmitting(true);

    try {
      await login(email, password);
      router.replace('/');
    } catch (caught) {
      setError(
        caught instanceof ApiError
          ? caught.status === 429
            ? 'Too many attempts. Wait a moment and try again.'
            : caught.message
          : 'Sign in failed.',
      );
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="flex min-h-screen items-center justify-center p-4">
      <div className="w-full max-w-xs">
        <div className="mb-6 flex items-center gap-2">
          <Boxes className="size-5 text-accent" aria-hidden />
          <div>
            <h1 className="text-sm font-semibold tracking-tight">NexusPuppet</h1>
            <p className="text-xs text-ink-faint">Puppet estate console</p>
          </div>
        </div>

        {modeError !== null && (
          <div
            role="alert"
            className="mb-4 rounded border border-state-pending/40 bg-state-pending/10 p-2.5"
          >
            <p className="text-xs font-medium text-state-pending">API unreachable</p>
            <p className="mt-0.5 font-mono text-2xs text-state-pending/80">{modeError}</p>
          </div>
        )}

        {credentialSource !== null && (
          <form
            onSubmit={onSubmit}
            className="space-y-3 rounded border border-line-soft bg-panel p-3"
          >
            <div className="space-y-1">
              <Label htmlFor="email">{identifierLabel}</Label>
              <Input
                id="email"
                name="email"
                type={identifierLabel === 'Email' ? 'email' : 'text'}
                autoComplete="username"
                required
                autoFocus
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                aria-invalid={error !== null}
              />
            </div>

            <div className="space-y-1">
              <Label htmlFor="password">Password</Label>
              <Input
                id="password"
                name="password"
                type="password"
                autoComplete="current-password"
                required
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                aria-invalid={error !== null}
              />
            </div>

            {error !== null && (
              <p role="alert" className="text-xs text-state-failed">
                {error}
              </p>
            )}

            <Button
              type="submit"
              variant="primary"
              size="md"
              className="w-full"
              disabled={submitting || status === 'loading'}
            >
              {submitting && <Loader2 className="animate-spin" aria-hidden />}
              {submitting ? 'Signing in…' : 'Sign in'}
            </Button>
          </form>
        )}

        {/*
          A button per redirect source, BESIDE the form rather than instead of
          it (ADR-0023 §3).
        */}
        {redirectSources.length > 0 && (
          <div className={credentialSource === null ? '' : 'mt-3'}>
            {credentialSource !== null && (
              // A separator, because the two are different acts: one submits a
              // credential to this deployment, the other hands the browser to
              // somebody else. Running them together as one stack of buttons
              // reads as two ways to do the same thing.
              <div className="mb-3 flex items-center gap-2" aria-hidden>
                <span className="h-px flex-1 bg-line-soft" />
                <span className="text-3xs uppercase tracking-wider text-ink-faint">or</span>
                <span className="h-px flex-1 bg-line-soft" />
              </div>
            )}

            <div className="space-y-2 rounded border border-line-soft bg-panel p-3">
              {credentialSource === null && (
                <p className="mb-3 text-xs text-ink-muted">
                  This deployment authenticates through an external identity provider.
                </p>
              )}
              {redirectSources.map((entry) => (
                <Button key={entry.source} variant="primary" size="md" className="w-full" asChild>
                  {/*
                    No `source` parameter, because only one redirect provider can
                    exist: the enterprise layer contributes a single directory
                    provider, and ADR-0023 keeps several-of-one-kind out of
                    scope. Whoever lifts that has to give this link a source and
                    teach the callback which provider is completing — the state
                    cookie carries no such thing today.
                  */}
                  <a href="/api/auth/redirect">Continue with {entry.source}</a>
                </Button>
              ))}
            </div>
          </div>
        )}

        {/*
          Nothing to offer at all. Reachable only if every provider vanished
          from a running deployment, which core makes impossible — it binds the
          local provider unconditionally — but a login page that renders an
          empty card is worse than one that says why.
        */}
        {authSources !== null && credentialSource === null && redirectSources.length === 0 && (
          <div role="alert" className="rounded border border-state-failed/40 bg-panel p-3">
            <p className="text-xs text-state-failed">
              This deployment has no way to sign in configured.
            </p>
            <p className="mt-1 text-2xs text-ink-faint">
              Nothing is registered to authenticate against. An operator has to restore a provider
              on the host.
            </p>
          </div>
        )}

        <p className="mt-3 text-center text-2xs text-ink-faint">
          Sessions are held in HttpOnly cookies and refresh automatically.
        </p>
      </div>
    </div>
  );
}
