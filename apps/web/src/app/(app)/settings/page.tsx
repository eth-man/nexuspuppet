'use client';

import { useCapabilities } from '@/lib/queries';
import { useAuth } from '@/providers/auth-provider';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { QueryError, Spinner } from '@/components/states';
import { UsersPanel } from '@/components/data/users-panel';
import { ChangePasswordCard } from '@/components/data/change-password';

/** Deployment facts an operator needs when filing a bug or planning an upgrade. */
export default function SettingsPage() {
  const capabilities = useCapabilities();
  const { principal, permissions } = useAuth();

  return (
    <div className="p-3">
      <header className="mb-3">
        <h1 className="text-sm font-semibold tracking-tight">Settings</h1>
        <p className="text-xs text-ink-muted">Deployment and session</p>
      </header>

      <div className="grid gap-3 lg:grid-cols-2">
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
              <dl className="grid grid-cols-[8rem_1fr] gap-y-1 text-xs">
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
            <dl className="grid grid-cols-[8rem_1fr] gap-y-1 text-xs">
              <dt className="text-ink-faint">Email</dt>
              <dd className="font-mono text-ink">{principal?.email}</dd>
              <dt className="text-ink-faint">Role</dt>
              <dd className="text-ink">{principal?.role}</dd>
              <dt className="text-ink-faint">Auth source</dt>
              <dd className="text-ink">{principal?.authSource}</dd>
            </dl>
            <div className="mt-2 flex flex-wrap gap-1">
              {permissions.map((permission) => (
                <Badge key={permission} className="font-mono">
                  {permission}
                </Badge>
              ))}
            </div>
          </CardContent>
        </Card>
        <ChangePasswordCard />
        <UsersPanel />
      </div>
    </div>
  );
}
