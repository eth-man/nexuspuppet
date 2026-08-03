'use client';

import { useState } from 'react';
import { AlertTriangle, Lock, Plus, Trash2 } from 'lucide-react';
import type { BlockingRoleMapping, Permission, Role } from '@nexuspuppet/contracts';
import { useCapabilities, useRoles } from '@/lib/queries';
import { useCreateRole, useDeleteRole, useUpdateRole } from '@/lib/mutations';
import { ApiError } from '@/lib/client';
import { useAuth } from '@/providers/auth-provider';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { LoadingRows, QueryError } from '@/components/states';

/** Every permission the API arbitrates, in the order they are shown. */
const PERMISSIONS: Permission[] = [
  'inventory:read',
  'reports:read',
  'classification:read',
  'classification:write',
  'materialization:trigger',
  'pql:raw',
  'users:manage',
  'settings:manage',
];

/**
 * What a role grants, and who may change it (ADR-0018).
 *
 * Reading is unconditional; editing needs the `rbac.custom` capability. A
 * deployment without it still sees its three built-in roles and exactly what
 * they permit, because hiding that would hide how the product decides who can
 * do what.
 */
export function RolesPanel() {
  const { can } = useAuth();
  const manages = can('settings:manage');
  const capabilities = useCapabilities();
  const roles = useRoles(manages);

  const editable = capabilities.data?.capabilities.includes('rbac.custom') === true;

  if (!manages) return null;
  if (roles.isError) return <QueryError error={roles.error} />;
  if (roles.isPending) return <LoadingRows rows={4} columns={3} />;

  return (
    <Card>
      <CardHeader className="flex items-center justify-between">
        <CardTitle>Roles</CardTitle>
        {!editable && <Badge>read-only</Badge>}
      </CardHeader>

      <CardContent className="space-y-3">
        <p className="max-w-prose text-[11px] text-ink-faint">
          {'A role is a set of permissions. The API enforces these; the console only uses them '}
          {'to hide controls that would be refused.'}
          {!editable &&
            ' Defining your own roles is an enterprise capability — the built-in three are shown here regardless.'}
        </p>

        <RoleTable roles={roles.data} editable={editable} />

        {editable && <NewRole existing={roles.data.map((r) => r.name)} />}
      </CardContent>
    </Card>
  );
}

function RoleTable({ roles, editable }: { roles: Role[]; editable: boolean }) {
  return (
    <div className="scroll-x">
      <table className="w-full text-xs">
        <thead>
          <tr className="border-b border-line-soft text-left text-ink-faint">
            <th className="py-1 pr-3 font-medium">Role</th>
            <th className="py-1 pr-3 font-medium">Permissions</th>
            <th className="py-1 pr-3 font-medium">Users</th>
            <th className="py-1 font-medium" />
          </tr>
        </thead>
        <tbody>
          {roles.map((role) => (
            <RoleRow key={role.id} role={role} editable={editable} />
          ))}
        </tbody>
      </table>
    </div>
  );
}

function RoleRow({ role, editable }: { role: Role; editable: boolean }) {
  const update = useUpdateRole();
  const remove = useDeleteRole();
  const [error, setError] = useState<string | null>(null);
  const [blocking, setBlocking] = useState<BlockingRoleMapping[] | null>(null);

  /*
   * A built-in role's PERMISSIONS are editable; its name is not. The name
   * appears in directory mappings, in audit history, and in other people's
   * runbooks — but what ADMIN may do is a decision a deployment is allowed to
   * make.
   */
  const toggle = (permission: Permission) => {
    setError(null);
    setBlocking(null);
    const next = role.permissions.includes(permission)
      ? role.permissions.filter((p) => p !== permission)
      : [...role.permissions, permission];

    update.mutate({ id: role.id, patch: { permissions: next } }, { onError: fail });
  };

  const fail = (caught: unknown) => {
    if (caught instanceof ApiError) {
      const body = caught.body as { blockingMappings?: BlockingRoleMapping[] } | undefined;
      if (body?.blockingMappings !== undefined && body.blockingMappings.length > 0) {
        setBlocking(body.blockingMappings);
        setError(null);
        return;
      }
    }
    setError(caught instanceof ApiError ? caught.message : String(caught));
    setBlocking(null);
  };

  return (
    <>
      <tr className="border-b border-line-soft/60 align-top">
        <td className="py-2 pr-3">
          <span className="flex items-center gap-1 font-mono text-ink">
            {role.builtIn && <Lock className="size-3 text-ink-faint" aria-label="built-in" />}
            {role.name}
          </span>
          {role.description !== null && (
            <span className="text-[11px] text-ink-faint">{role.description}</span>
          )}
        </td>

        <td className="py-2 pr-3">
          <div className="flex flex-wrap gap-1">
            {PERMISSIONS.map((permission) => {
              const held = role.permissions.includes(permission);
              return (
                <button
                  key={permission}
                  type="button"
                  disabled={!editable || update.isPending}
                  onClick={() => toggle(permission)}
                  aria-pressed={held}
                  title={editable ? `Toggle ${permission}` : 'Editing roles is not available'}
                  className={
                    'rounded border px-1.5 py-0.5 font-mono text-[10px] transition-colors ' +
                    (held
                      ? 'border-accent/50 bg-accent/15 text-ink'
                      : 'border-line-soft text-ink-faint') +
                    (editable ? ' hover:border-accent disabled:opacity-50' : ' cursor-default')
                  }
                >
                  {permission}
                </button>
              );
            })}
          </div>
        </td>

        <td className="py-2 pr-3 tabular-nums text-ink-muted">{role.userCount}</td>

        <td className="py-2">
          {editable && !role.builtIn && (
            <Button
              variant="ghost"
              size="sm"
              disabled={remove.isPending}
              aria-label={`Delete ${role.name}`}
              onClick={() => {
                setError(null);
                setBlocking(null);
                remove.mutate(role.id, { onError: fail });
              }}
            >
              <Trash2 className="size-3.5 text-state-failed" aria-hidden />
            </Button>
          )}
        </td>
      </tr>

      {(error !== null || blocking !== null) && (
        <tr>
          <td colSpan={4} className="pb-2">
            {blocking !== null ? <BlockingMappings role={role.name} mappings={blocking} /> : null}
            {error !== null && (
              <p role="alert" className="text-[11px] text-state-failed">
                {error}
              </p>
            )}
          </td>
        </tr>
      )}
    </>
  );
}

/**
 * The mappings standing in the way of a deletion.
 *
 * Rendered as a list of DNs an operator can copy, because the next thing they
 * do is search their directory configuration for that exact string. Telling
 * them "the role is in use" would send them looking without saying where.
 */
function BlockingMappings({ role, mappings }: { role: string; mappings: BlockingRoleMapping[] }) {
  return (
    <div role="alert" className="rounded border border-state-failed/40 bg-state-failed/10 p-2">
      <p className="text-[11px] font-semibold text-ink">
        {`"${role}" is still mapped from ${mappings.length} directory group${mappings.length === 1 ? '' : 's'}`}
      </p>
      <p className="mt-1 max-w-prose text-[11px] text-ink-muted">
        {'Remove or repoint these first. Anybody in them would otherwise sign in with no '}
        {'permissions, and the role explaining why would no longer exist.'}
      </p>
      <ul className="mt-1.5 space-y-0.5">
        {mappings.map((mapping) => (
          <li key={`${mapping.source}:${mapping.groupDn}`} className="text-[11px]">
            <span className="font-mono text-ink">{mapping.groupDn}</span>
            <span className="ml-2 text-ink-faint">
              {mapping.source === 'database'
                ? '— on the Directory / Auth screen'
                : '— in this deployment’s environment'}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function NewRole({ existing }: { existing: string[] }) {
  const create = useCreateRole();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [permissions, setPermissions] = useState<Permission[]>([]);
  const [error, setError] = useState<string | null>(null);

  const clash = existing.includes(name);
  // Matches the API's own rule, so the refusal happens before a round trip
  // rather than after one.
  const shaped = /^[A-Za-z0-9._-]+$/.test(name);

  if (!open) {
    return (
      <Button variant="ghost" size="sm" onClick={() => setOpen(true)}>
        <Plus className="mr-1 size-3.5" aria-hidden />
        New role
      </Button>
    );
  }

  return (
    <div className="space-y-2 rounded border border-line-soft p-3">
      <div className="space-y-1">
        <Label htmlFor="role-name">Name</Label>
        <Input
          id="role-name"
          value={name}
          onChange={(e) => {
            setName(e.target.value);
            setError(null);
          }}
          placeholder="auditor"
          aria-invalid={name !== '' && (!shaped || clash)}
        />
        <p className="text-[11px] text-ink-faint">
          {'Letters, digits, dot, underscore and hyphen. No spaces — the name goes into '}
          {'directory mappings, which are delimited by semicolons and equals signs.'}
        </p>
        {clash && <p className="text-[11px] text-state-failed">That name is already taken.</p>}
      </div>

      <div className="space-y-1">
        <Label>Permissions</Label>
        <div className="flex flex-wrap gap-1">
          {PERMISSIONS.map((permission) => {
            const held = permissions.includes(permission);
            return (
              <button
                key={permission}
                type="button"
                aria-pressed={held}
                onClick={() =>
                  setPermissions((current) =>
                    current.includes(permission)
                      ? current.filter((p) => p !== permission)
                      : [...current, permission],
                  )
                }
                className={
                  'rounded border px-1.5 py-0.5 font-mono text-[10px] transition-colors ' +
                  (held
                    ? 'border-accent/50 bg-accent/15 text-ink'
                    : 'border-line-soft text-ink-faint hover:border-accent')
                }
              >
                {permission}
              </button>
            );
          })}
        </div>
      </div>

      {error !== null && (
        <p role="alert" className="text-[11px] text-state-failed">
          {error}
        </p>
      )}

      <div className="flex gap-2">
        <Button
          variant="primary"
          size="sm"
          disabled={name === '' || !shaped || clash || create.isPending}
          onClick={() =>
            create.mutate(
              { name, permissions },
              {
                onSuccess: () => {
                  setOpen(false);
                  setName('');
                  setPermissions([]);
                },
                onError: (caught) =>
                  setError(caught instanceof ApiError ? caught.message : String(caught)),
              },
            )
          }
        >
          Create role
        </Button>
        <Button variant="ghost" size="sm" onClick={() => setOpen(false)}>
          Cancel
        </Button>
      </div>

      {permissions.length === 0 && (
        <p className="flex items-start gap-1 text-[11px] text-state-pending">
          <AlertTriangle className="mt-0.5 size-3 shrink-0" aria-hidden />
          {'This role would grant nothing. That is allowed — a placeholder to fill in later — '}
          {'but anybody holding it can do nothing at all.'}
        </p>
      )}
    </div>
  );
}
