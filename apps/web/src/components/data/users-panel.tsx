'use client';

import { useState } from 'react';
import { Plus, UserX } from 'lucide-react';
import type { ManagedUser, UserRole } from '@nexuspuppet/contracts';
import { useUsers } from '@/lib/queries';
import { useCreateUser, useDeactivateUser, useUpdateUser } from '@/lib/mutations';
import { ApiError } from '@/lib/client';
import { useAuth } from '@/providers/auth-provider';
import { absolute, ago } from '@/lib/format';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardHeader, CardTitle } from '@/components/ui/card';
import { Dialog } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';
import { Table, TBody, TD, TH, THead, TR } from '@/components/ui/table';
import { LoadingRows, QueryError } from '@/components/states';

const ROLES: UserRole[] = ['VIEWER', 'OPERATOR', 'ADMIN'];

/**
 * User administration.
 *
 * The API refuses to demote or deactivate the last active administrator, and
 * refuses self-deactivation. Those rejections are surfaced verbatim rather than
 * pre-empted in the UI: the server owns the rule, and duplicating it here would
 * create a second copy to drift.
 */
export function UsersPanel() {
  const { can, principal } = useAuth();
  const manages = can('users:manage');

  const users = useUsers(manages);
  const create = useCreateUser();
  const update = useUpdateUser();
  const deactivate = useDeactivateUser();

  const [open, setOpen] = useState(false);
  const [email, setEmail] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [role, setRole] = useState<UserRole>('VIEWER');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);

  if (!manages) return null;

  const fail = (caught: unknown) =>
    setError(caught instanceof ApiError ? caught.message : String(caught));

  return (
    <Card>
      <CardHeader>
        <CardTitle>Users</CardTitle>
        <Button variant="secondary" size="sm" onClick={() => setOpen(true)}>
          <Plus aria-hidden />
          New user
        </Button>
      </CardHeader>

      {error !== null && (
        <div role="alert" className="border-b border-line-soft bg-state-failed/10 px-3 py-2">
          <p className="text-xs text-state-failed">{error}</p>
        </div>
      )}

      {users.isError ? (
        <QueryError error={users.error} />
      ) : users.isPending ? (
        <LoadingRows rows={3} columns={5} />
      ) : (
        <Table>
          <THead>
            <TR className="hover:bg-panel-raised">
              <TH>Email</TH>
              <TH>Name</TH>
              <TH>Role</TH>
              <TH>Source</TH>
              <TH>Last login</TH>
              <TH className="text-right">Actions</TH>
            </TR>
          </THead>
          <TBody>
            {users.data.map((user: ManagedUser) => {
              const self = user.id === principal?.userId;

              return (
                <TR key={user.id} className={user.isActive ? undefined : 'opacity-50'}>
                  <TD className="font-mono text-xs">
                    {user.email}
                    {self && (
                      <span className="ml-1.5 text-[10px] uppercase text-ink-faint">you</span>
                    )}
                    {!user.isActive && (
                      <span className="ml-1.5 text-[10px] uppercase text-state-pending">
                        deactivated
                      </span>
                    )}
                  </TD>
                  <TD className="text-xs text-ink-muted">{user.displayName}</TD>
                  <TD>
                    <Select
                      value={user.role}
                      // Changing your own role is refused server-side; disabling
                      // it here saves a pointless round trip.
                      disabled={self || update.isPending}
                      onChange={(event) => {
                        setError(null);
                        update.mutate(
                          { id: user.id, patch: { role: event.target.value as UserRole } },
                          { onError: fail },
                        );
                      }}
                      className="h-6 text-xs"
                      aria-label={`Role for ${user.email}`}
                    >
                      {ROLES.map((r) => (
                        <option key={r} value={r}>
                          {r}
                        </option>
                      ))}
                    </Select>
                  </TD>
                  <TD>
                    <Badge>{user.authSource}</Badge>
                  </TD>
                  <TD
                    className="text-xs tabular-nums text-ink-muted"
                    title={absolute(user.lastLoginAt)}
                  >
                    {user.lastLoginAt === null ? 'never' : `${ago(user.lastLoginAt)}`}
                  </TD>
                  <TD className="text-right">
                    {user.isActive ? (
                      <Button
                        variant="ghost"
                        size="icon"
                        disabled={self || deactivate.isPending}
                        title={self ? 'You cannot deactivate your own account' : 'Deactivate'}
                        onClick={() => {
                          setError(null);
                          deactivate.mutate(user.id, { onError: fail });
                        }}
                        aria-label={`Deactivate ${user.email}`}
                      >
                        <UserX aria-hidden />
                      </Button>
                    ) : (
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => {
                          setError(null);
                          update.mutate(
                            { id: user.id, patch: { isActive: true } },
                            { onError: fail },
                          );
                        }}
                      >
                        Reactivate
                      </Button>
                    )}
                  </TD>
                </TR>
              );
            })}
          </TBody>
        </Table>
      )}

      <Dialog
        open={open}
        onClose={() => setOpen(false)}
        title="New user"
        description="Local account. The user can change their own password after signing in."
        footer={
          <>
            <Button variant="ghost" size="sm" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button
              variant="primary"
              size="sm"
              disabled={create.isPending || password.length < 12}
              onClick={() => {
                setError(null);
                create.mutate(
                  { email, displayName, role, password },
                  {
                    onSuccess: () => {
                      setOpen(false);
                      setEmail('');
                      setDisplayName('');
                      setPassword('');
                      setRole('VIEWER');
                    },
                    onError: (caught) => {
                      setOpen(false);
                      fail(caught);
                    },
                  },
                );
              }}
            >
              {create.isPending ? 'Creating…' : 'Create user'}
            </Button>
          </>
        }
      >
        <div className="space-y-2">
          <div className="space-y-1">
            <Label htmlFor="newEmail">Email</Label>
            <Input
              id="newEmail"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              autoFocus
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="newName">Display name</Label>
            <Input
              id="newName"
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
            />
          </div>
          <div className="grid grid-cols-2 gap-2">
            <div className="space-y-1">
              <Label htmlFor="newRole">Role</Label>
              <Select
                id="newRole"
                value={role}
                onChange={(e) => setRole(e.target.value as UserRole)}
                className="w-full"
              >
                {ROLES.map((r) => (
                  <option key={r} value={r}>
                    {r}
                  </option>
                ))}
              </Select>
            </div>
            <div className="space-y-1">
              <Label htmlFor="newPassword">Password</Label>
              <Input
                id="newPassword"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                aria-invalid={password.length > 0 && password.length < 12}
              />
              {/* Length, not composition. Character-class rules mostly produce
                  `Password1!` — memorised, reused, and no stronger. */}
              <p className="text-[11px] text-ink-faint">At least 12 characters.</p>
            </div>
          </div>
        </div>
      </Dialog>
    </Card>
  );
}
