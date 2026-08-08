'use client';

import { useAuth } from '@/providers/auth-provider';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { DeploymentCard } from '@/components/data/deployment-card';
import { ChangePasswordCard } from '@/components/data/change-password';
import { ConsoleTlsCard } from '@/components/data/console-tls-card';
import { LogLevelCard } from '@/components/data/log-level-card';

/**
 * What this deployment is, who you are on it, and the certificate serving it.
 *
 * The default tab, and the only one with no permission attached — everything
 * here is either public to a signed-in user or about their own session.
 *
 * LAYOUT: three cards stretched to a common height. They previously kept their
 * natural heights — 119px, 281px and 256px in practice — on the argument that
 * padding "Deployment" to match a password form wastes space. Measured on a
 * real deployment the ragged bottom edge cost more than the padding saved.
 */
export default function GeneralSettingsPage() {
  const { principal, permissions, can } = useAuth();

  return (
    <div className="space-y-3">
      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
        <DeploymentCard />
        <LogLevelCard />

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
          certificate is the same whoever is looking at it.

          Gated because GET /system/tls requires settings:manage. This tab is now
          reachable by everyone (it holds the change-password form), so a card
          whose only possible outcome for a viewer is 403 must not render. */}
      {can('settings:manage') && <ConsoleTlsCard />}
    </div>
  );
}
