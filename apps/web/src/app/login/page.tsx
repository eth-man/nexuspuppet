'use client';

import { useEffect, useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { Boxes, Loader2 } from 'lucide-react';
import { ApiError, api } from '@/lib/client';
import { useAuth } from '@/providers/auth-provider';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

interface AuthMode {
  mode: 'credentials' | 'redirect';
  source: string;
  /** What to call the identifier — 'Email' locally, 'Username' for AD. */
  identifierLabel?: string;
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
  const [authMode, setAuthMode] = useState<AuthMode | null>(null);
  const identifierLabel = authMode?.identifierLabel ?? 'Email';
  const [modeError, setModeError] = useState<string | null>(null);

  useEffect(() => {
    if (status === 'authenticated') router.replace('/');
  }, [status, router]);

  useEffect(() => {
    api
      .get<AuthMode>('/auth/mode')
      .then(setAuthMode)
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
            <p className="mt-0.5 font-mono text-[11px] text-state-pending/80">{modeError}</p>
          </div>
        )}

        {authMode?.mode === 'redirect' ? (
          <div className="rounded border border-line-soft bg-panel p-3">
            <p className="mb-3 text-xs text-ink-muted">
              This deployment authenticates through {authMode.source}.
            </p>
            <Button variant="primary" size="md" className="w-full" asChild>
              <a href="/api/auth/redirect">Continue with {authMode.source}</a>
            </Button>
          </div>
        ) : (
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

        <p className="mt-3 text-center text-[11px] text-ink-faint">
          Sessions are held in HttpOnly cookies and refresh automatically.
        </p>
      </div>
    </div>
  );
}
