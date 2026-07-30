'use client';

import { useCapabilities } from '@/lib/queries';
import { useAuth } from '@/providers/auth-provider';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { QueryError, Spinner } from '@/components/states';
import { AuthProviderPanel } from '@/components/data/auth-provider-panel';
import { UsersPanel } from '@/components/data/users-panel';
import { ChangePasswordCard } from '@/components/data/change-password';
import { ConsoleTlsCard } from '@/components/data/console-tls-card';

/**
 * Deployment, session, and user administration.
 *
 * LAYOUT: three short cards as a context strip, then the users table at full
 * width. A two-column grid left the right-hand column empty below "Your
 * session", because the cards are all short and the table is the only thing
 * with real content — the page read as half-finished.
 *
 * `items-start` keeps each card at its natural height. Stretching them to match
 * the tallest would pad Deployment with empty space to align with a password
 * form, which is the opposite of dense.
 */
export default function SettingsPage() {
  const capabilities = useCapabilities();
  const { principal, permissions } = useAuth();

  return (
    <div className="space-y-3 p-3">
      <header>
        <h1 className="text-sm font-semibold tracking-tight">Settings</h1>
        <p className="text-xs text-ink-muted">Deployment, session, and users</p>
      </header>

      <div className="grid items-start gap-3 md:grid-cols-2 xl:grid-cols-3">
        <Card>
          <CardHeader>
            <CardTitle>Deployment</CardTitle>
          </CardHeader>
          <CardContent>
            {capabilities.isError ? (
              <QueryError error={capabilities.error} />
            ) : capabilities.isPending ? (
              <Spinner />
            ) : (
              <dl className="grid grid-cols-[7rem_1fr] gap-y-1 text-xs">
                <dt className="text-ink-faint">Edition</dt>
                <dd className="text-ink">{capabilities.data.edition}</dd>
                <dt className="text-ink-faint">Enterprise</dt>
                <dd className="font-mono text-ink">
                  {capabilities.data.enterpriseVersion ?? 'not installed'}
                </dd>
                <dt className="text-ink-faint">Capabilities</dt>
                <dd className="text-ink">
                  {capabilities.data.capabilities.length === 0
                    ? 'core only'
                    : capabilities.data.capabilities.join(', ')}
                </dd>
              </dl>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Your session</CardTitle>
          </CardHeader>
          <CardContent>
            <dl className="grid grid-cols-[7rem_1fr] gap-y-1 text-xs">
              <dt className="text-ink-faint">Email</dt>
              <dd className="truncate font-mono text-ink">{principal?.email}</dd>
              <dt className="text-ink-faint">Role</dt>
              <dd className="text-ink">{principal?.role}</dd>
              <dt className="text-ink-faint">Auth source</dt>
              <dd className="text-ink">{principal?.authSource}</dd>
            </dl>

            <p className="mt-2 text-[11px] text-ink-faint">
              What your role permits. The API enforces these independently — hidden controls are a
              convenience, not a boundary.
            </p>
            <div className="mt-1 flex flex-wrap gap-1">
              {permissions.map((permission) => (
                <Badge key={permission} className="font-mono">
                  {permission}
                </Badge>
              ))}
            </div>
          </CardContent>
        </Card>

        {/*
          An externally-authenticated account has no local password, so the
          change-password form can only ever fail — the API rejects it with
          "This account does not use a local password." Offering a control that
          cannot work is worse than offering none; say where the credential
          actually lives instead.
        */}
        {principal?.authSource === 'local' ? (
          <ChangePasswordCard />
        ) : (
          <Card>
            <CardHeader>
              <CardTitle>Password</CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-xs text-ink-faint">
                This account is authenticated by{' '}
                <span className="font-mono text-ink">{principal?.authSource}</span>, so its password
                is not held here. Change it in your directory; the new one takes effect at your next
                sign-in.
              </p>
            </CardContent>
          </Card>
        )}
      </div>

      {/* Deployment-wide, not account-specific — so outside the password block
          above, which is conditional on how THIS user authenticates. The
          certificate is the same whoever is looking at it. */}
      <ConsoleTlsCard />

      {/* Who the directory says may do what. Renders only when a provider
          actually maps groups to roles, so core deployments are unchanged. */}
      <AuthProviderPanel />

      {/* Full width: the only panel on this page with substantial content. */}
      <UsersPanel />
    </div>
  );
}
