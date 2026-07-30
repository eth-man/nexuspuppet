'use client';

import { useState, type ReactNode } from 'react';
import { KeyRound, Plus, RefreshCw, Trash2, UserX } from 'lucide-react';
import type { ManagedUser, UserRole } from '@nexuspuppet/contracts';
import { useAuthMode, useUser, useUsers } from '@/lib/queries';
import {
  useCreateUser,
  useDeactivateUser,
  useDeleteUser,
  useResetPassword,
  useUpdateUser,
} from '@/lib/mutations';
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
  const resetPassword = useResetPassword();
  const deleteUser = useDeleteUser();

  /**
   * One piece of state per dialog, holding the SUBJECT rather than a boolean.
   *
   * A shared `selectedUser` plus three open flags would let two dialogs disagree
   * about who they are acting on — and the two destructive ones here are exactly
   * where that must not happen.
   */
  const [detailId, setDetailId] = useState<string | null>(null);
  const [resetFor, setResetFor] = useState<ManagedUser | null>(null);
  const [deleteFor, setDeleteFor] = useState<ManagedUser | null>(null);

  const [open, setOpen] = useState(false);
  const [email, setEmail] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [role, setRole] = useState<UserRole>('VIEWER');
  const [password, setPassword] = useState('');
  /**
   * Which authority owns this account's credentials.
   *
   * Keyed off the DEPLOYMENT's active provider, not the current user's
   * authSource. An administrator with a local account on an LDAP deployment
   * must still be able to provision directory accounts — reading it off the
   * principal would hide the option from exactly the person who needs it.
   *
   * In core mode this is 'local', so nothing external is offered at all and the
   * dialog is unchanged.
   */
  const authMode = useAuthMode();
  const externalSource =
    authMode.data !== undefined && authMode.data.source !== 'local' ? authMode.data.source : null;
  const [authSource, setAuthSource] = useState('local');
  const isLocal = authSource === 'local';
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
                    {/*
                      A button, not a clickable <TR>. The row already contains a
                      role <Select> and three action buttons; making the whole
                      row a click target would swallow those, and a div with an
                      onClick is unreachable by keyboard. This is the one cell
                      with nothing else in it.
                    */}
                    <button
                      type="button"
                      onClick={() => setDetailId(user.id)}
                      className="rounded underline-offset-2 hover:underline focus-visible:outline focus-visible:outline-1"
                      aria-label={`Details for ${user.email}`}
                    >
                      {user.email}
                    </button>
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
                    <Button
                      variant="ghost"
                      size="icon"
                      title="Set a new password"
                      onClick={() => {
                        setError(null);
                        setResetFor(user);
                      }}
                      aria-label={`Set a new password for ${user.email}`}
                    >
                      <KeyRound aria-hidden />
                    </Button>

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

                    <Button
                      variant="ghost"
                      size="icon"
                      disabled={self}
                      title={self ? 'You cannot delete your own account' : 'Delete permanently'}
                      onClick={() => {
                        setError(null);
                        setDeleteFor(user);
                      }}
                      aria-label={`Delete ${user.email}`}
                      className="text-ink-faint hover:text-state-failed"
                    >
                      <Trash2 aria-hidden />
                    </Button>
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
        description={
          isLocal
            ? 'Local account. The user can change their own password after signing in.'
            : `Authenticated by ${authSource}. No password is held here — the directory decides whether they may sign in, and their group membership sets their role at each login.`
        }
        footer={
          <>
            <Button variant="ghost" size="sm" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button
              variant="primary"
              size="sm"
              disabled={create.isPending || (isLocal && password.length < 12)}
              onClick={() => {
                setError(null);
                create.mutate(
                  // An external account is created with no password at all: a
                  // stored hash would keep it usable through local auth after
                  // the directory revoked access.
                  isLocal
                    ? { email, displayName, role, authSource, password }
                    : { email, displayName, role, authSource },
                  {
                    onSuccess: () => {
                      setOpen(false);
                      setEmail('');
                      setDisplayName('');
                      setPassword('');
                      setRole('VIEWER');
                      setAuthSource('local');
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
            {externalSource !== null && (
              <div className="space-y-1">
                <Label htmlFor="newAuthSource">Authentication</Label>
                <Select
                  id="newAuthSource"
                  value={authSource}
                  onChange={(e) => setAuthSource(e.target.value)}
                  className="w-full"
                >
                  <option value="local">local (password)</option>
                  <option value={externalSource}>{externalSource}</option>
                </Select>
              </div>
            )}
          </div>

          {isLocal ? (
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
          ) : (
            <p className="text-[11px] text-ink-faint">
              No password is set here. The email above must match the directory entry, or the person
              will authenticate successfully and still be refused.
            </p>
          )}
        </div>
      </Dialog>

      <ResetPasswordDialog
        user={resetFor}
        onClose={() => setResetFor(null)}
        onSubmit={(newPassword, done) => {
          setError(null);
          resetPassword.mutate(
            { id: resetFor?.id ?? '', newPassword },
            { onSuccess: done, onError: fail },
          );
        }}
        pending={resetPassword.isPending}
      />

      <UserDetailDialog id={detailId} onClose={() => setDetailId(null)} />

      <DeleteUserDialog
        user={deleteFor}
        onClose={() => setDeleteFor(null)}
        onConfirm={() => {
          setError(null);
          deleteUser.mutate(deleteFor?.id ?? '', {
            onSuccess: () => setDeleteFor(null),
            onError: (caught) => {
              setDeleteFor(null);
              fail(caught);
            },
          });
        }}
        pending={deleteUser.isPending}
      />
    </Card>
  );
}

/**
 * A password nobody has to invent.
 *
 * `crypto.getRandomValues`, never `Math.random` — the latter is seeded
 * predictably and is not a credential source. The alphabet omits the characters
 * that get misread when a password is dictated over a phone or copied off a
 * screen: 0/O, 1/l/I. Losing four symbols costs about two bits at this length
 * and saves the support call.
 *
 * The modulo below is unbiased because 58 divides 232 evenly within a byte's
 * range only if rejected values are dropped, which is what the filter does.
 */
function generatePassword(length = 24): string {
  const alphabet = 'abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const limit = 256 - (256 % alphabet.length);
  const out: string[] = [];

  while (out.length < length) {
    const bytes = crypto.getRandomValues(new Uint8Array(length));
    for (const byte of bytes) {
      // Values in the ragged top of the byte range would over-represent the
      // first few characters. Discarding them keeps every character equally
      // likely.
      if (byte >= limit) continue;
      out.push(alphabet[byte % alphabet.length]!);
      if (out.length === length) break;
    }
  }

  return out.join('');
}

/**
 * An administrator setting somebody else's password.
 *
 * Shown in clear text, deliberately. The administrator has to transmit this
 * value to a person somehow, and a masked field they cannot read guarantees a
 * transcription error on a 24-character random string. It is on screen for as
 * long as the dialog is open and is never stored anywhere.
 *
 * The dialog states that every session ends, because that is what the API does
 * and the administrator is usually resetting for somebody who is locked out —
 * they should know the person will have to sign in again everywhere.
 */
function ResetPasswordDialog({
  user,
  onClose,
  onSubmit,
  pending,
}: {
  user: ManagedUser | null;
  onClose: () => void;
  onSubmit: (newPassword: string, done: () => void) => void;
  pending: boolean;
}) {
  const [value, setValue] = useState('');

  const close = () => {
    setValue('');
    onClose();
  };

  return (
    <Dialog
      open={user !== null}
      onClose={close}
      title={`Set a new password for ${user?.displayName ?? ''}`}
      description="Every session this user has will end, on every device. They will need the new password to sign in again."
      footer={
        <>
          <Button variant="ghost" size="sm" onClick={close}>
            Cancel
          </Button>
          <Button
            variant="primary"
            size="sm"
            disabled={pending || value.length < 12}
            onClick={() => onSubmit(value, close)}
          >
            {pending ? 'Saving…' : 'Save'}
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <div className="space-y-1">
          <Label htmlFor="resetPassword">New password</Label>
          <div className="flex gap-2">
            <Input
              id="resetPassword"
              // Not type="password": see above.
              type="text"
              value={value}
              onChange={(event) => setValue(event.target.value)}
              className="font-mono"
              autoComplete="off"
              spellCheck={false}
              aria-invalid={value.length > 0 && value.length < 12}
            />
            <Button
              variant="secondary"
              size="sm"
              onClick={() => setValue(generatePassword())}
              title="Generate a strong random password"
            >
              <RefreshCw aria-hidden />
              Generate
            </Button>
          </div>
          <p className="text-[11px] text-ink-faint">
            At least 12 characters. Copy it before saving — it is not shown again.
          </p>
        </div>

        {user !== null && user.authSource !== 'local' && (
          <p className="rounded border border-state-pending/40 bg-state-pending/10 p-2 text-[11px] text-state-pending">
            This account is authenticated by {user.authSource}. Setting a local password here will
            not change what the directory accepts, and may not let them in at all.
          </p>
        )}
      </div>
    </Dialog>
  );
}

/** One labelled fact in the detail view. */
function Detail({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-4 border-b border-line-soft py-1.5 last:border-0">
      <dt className="shrink-0 text-xs text-ink-faint">{label}</dt>
      <dd className="min-w-0 truncate text-xs text-ink">{children}</dd>
    </div>
  );
}

/**
 * Extended detail for one user.
 *
 * The fields chosen are the ones an administrator opens a user to find out, not
 * everything the row happens to hold: why can they not get in (locked, failed
 * attempts, deactivated, no local password), and are they signed in anywhere
 * right now.
 */
function UserDetailDialog({ id, onClose }: { id: string | null; onClose: () => void }) {
  const user = useUser(id);
  const locked = user.data?.lockedUntil !== null && user.data?.lockedUntil !== undefined;

  return (
    <Dialog
      open={id !== null}
      onClose={onClose}
      title={user.data?.displayName ?? 'User'}
      description={user.data?.email ?? ''}
      footer={
        <Button variant="ghost" size="sm" onClick={onClose}>
          Close
        </Button>
      }
    >
      {user.isError ? (
        <QueryError error={user.error} />
      ) : user.isPending ? (
        <LoadingRows rows={6} columns={2} />
      ) : (
        <dl className="text-xs">
          <Detail label="Role">
            <Badge>{user.data.role}</Badge>
          </Detail>
          <Detail label="Status">
            {user.data.isActive ? (
              <span className="text-state-unchanged">Active</span>
            ) : (
              <span className="text-state-pending">Deactivated</span>
            )}
          </Detail>
          <Detail label="Authenticated by">
            <Badge>{user.data.authSource}</Badge>
          </Detail>
          <Detail label="Local password">
            {user.data.hasLocalPassword ? (
              'set'
            ) : (
              // Worth stating plainly: it is the reason a password reset would
              // be pointless on this account.
              <span className="text-ink-faint">none — the directory authenticates them</span>
            )}
          </Detail>
          <Detail label="Active sessions">
            <span className="tabular-nums">{user.data.activeSessions}</span>
          </Detail>
          <Detail label="Failed sign-ins">
            <span className="tabular-nums">{user.data.failedLoginAttempts}</span>
          </Detail>
          {locked && (
            <Detail label="Locked until">
              <span className="text-state-failed">{absolute(user.data.lockedUntil)}</span>
            </Detail>
          )}
          <Detail label="Last sign-in">
            <span title={absolute(user.data.lastLoginAt)}>
              {user.data.lastLoginAt === null ? 'never' : ago(user.data.lastLoginAt)}
            </span>
          </Detail>
          <Detail label="Created">
            <span title={absolute(user.data.createdAt)}>{ago(user.data.createdAt)}</span>
          </Detail>
          <Detail label="Identifier">
            <span className="font-mono text-[11px] text-ink-muted">{user.data.id}</span>
          </Detail>
        </dl>
      )}
    </Dialog>
  );
}

/**
 * Confirmation for the one action here that cannot be undone.
 *
 * Deliberately requires typing the email rather than offering a bare "Confirm".
 * The trigger is a small icon in a row of small icons, next to Deactivate — the
 * two are one pixel-miss apart, and only one of them is reversible. Typing the
 * address also makes it impossible to delete the wrong row after the list has
 * re-sorted underneath the cursor.
 */
function DeleteUserDialog({
  user,
  onClose,
  onConfirm,
  pending,
}: {
  user: ManagedUser | null;
  onClose: () => void;
  onConfirm: () => void;
  pending: boolean;
}) {
  const [typed, setTyped] = useState('');

  const close = () => {
    setTyped('');
    onClose();
  };

  return (
    <Dialog
      open={user !== null}
      onClose={close}
      title="Delete this user permanently?"
      description="This cannot be undone. Deactivating instead keeps the account and lets you restore it later."
      footer={
        <>
          <Button variant="ghost" size="sm" onClick={close}>
            Cancel
          </Button>
          <Button
            variant="danger"
            size="sm"
            disabled={pending || typed.trim().toLowerCase() !== user?.email.toLowerCase()}
            onClick={onConfirm}
          >
            {pending ? 'Deleting…' : 'Delete permanently'}
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <p className="text-xs text-ink-muted">
          Their record and all their sessions are removed. What they did stays in the audit log —
          those entries keep the action and the timestamp, but no longer name an account.
        </p>

        <div className="space-y-1">
          <Label htmlFor="confirmEmail">
            Type <span className="font-mono text-ink">{user?.email}</span> to confirm
          </Label>
          <Input
            id="confirmEmail"
            value={typed}
            onChange={(event) => setTyped(event.target.value)}
            className="font-mono"
            autoComplete="off"
            spellCheck={false}
          />
        </div>
      </div>
    </Dialog>
  );
}
