'use client';

import { useMemo, useState } from 'react';
import { AlertTriangle, Copy, Eye, Lock, Pencil, Plus, ShieldAlert, Trash2 } from 'lucide-react';
import type { BlockingRoleMapping, Permission, Role } from '@nexuspuppet/contracts';
import { useCapabilities, useRoles } from '@/lib/queries';
import { useCreateRole, useDeleteRole, useUpdateRole } from '@/lib/mutations';
import { ApiError } from '@/lib/client';
import { useAuth } from '@/providers/auth-provider';
import {
  PERMISSIONS,
  PERMISSION_CATALOG,
  impactLabel,
  type PermissionImpact,
} from '@/lib/permission-catalog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Dialog } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { LoadingRows, QueryError } from '@/components/states';

/**
 * What a role grants, and who may change it (ADR-0018).
 *
 * Reading is unconditional; editing needs the `rbac.custom` capability. A
 * deployment without it still sees its three built-in roles and exactly what
 * they permit, because hiding that would hide how the product decides who can
 * do what.
 *
 * The table never mutates. Every change to a role is made in a dialog and
 * committed explicitly — a stray click in a list of permissions should not be
 * able to grant `settings:manage`.
 */
export function RolesPanel() {
  const { can } = useAuth();
  const manages = can('settings:manage');
  const capabilities = useCapabilities();
  const roles = useRoles(manages);

  const editable = capabilities.data?.capabilities.includes('rbac.custom') === true;

  /**
   * `null` closed, otherwise what the dialog is doing.
   *
   * `seed` carries a starting point for a new role — used when duplicating a
   * built-in, which is the supported way to get a role that is *like* ADMIN
   * without redefining what ADMIN means.
   */
  const [editing, setEditing] = useState<
    | { mode: 'edit'; role: Role }
    | { mode: 'new'; seed?: { name: string; permissions: Permission[] } }
    | null
  >(null);

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
              {roles.data.map((role) => (
                <RoleRow
                  key={role.id}
                  role={role}
                  editable={editable}
                  onOpen={() => setEditing({ mode: 'edit', role })}
                />
              ))}
            </tbody>
          </table>
        </div>

        {editable && (
          <Button variant="ghost" size="sm" onClick={() => setEditing({ mode: 'new' })}>
            <Plus className="mr-1 size-3.5" aria-hidden />
            New role
          </Button>
        )}

        {editing !== null && (
          <RoleEditor
            /* Remounts when the target changes, so the draft is re-seeded
               rather than carried over from the role just closed. */
            key={editing.mode === 'edit' ? editing.role.id : (editing.seed?.name ?? 'new')}
            role={editing.mode === 'edit' ? editing.role : null}
            seed={editing.mode === 'new' ? editing.seed : undefined}
            editable={editable}
            existing={roles.data.map((r) => r.name)}
            onClose={() => setEditing(null)}
            onDuplicate={(from) =>
              setEditing({
                mode: 'new',
                seed: {
                  name: `${from.name.toLowerCase()}-copy`,
                  permissions: [...from.permissions],
                },
              })
            }
          />
        )}
      </CardContent>
    </Card>
  );
}

/**
 * One role, read-only.
 *
 * Shows the permissions it holds rather than every permission that exists —
 * the absent ones are a property of the role worth seeing while editing it, and
 * noise while scanning a list.
 */
function RoleRow({
  role,
  editable,
  onOpen,
}: {
  role: Role;
  editable: boolean;
  onOpen: () => void;
}) {
  const held = PERMISSIONS.filter((p) => role.permissions.includes(p));
  /*
   * A built-in role is never editable, capability or not (ADR-0018 §1). The
   * action says so up front rather than opening an editor that then refuses.
   */
  const verb = editable && !role.builtIn ? 'Edit' : 'View';

  return (
    <tr
      onClick={onOpen}
      className="cursor-pointer border-b border-line-soft/60 align-top hover:bg-panel-raised/60"
    >
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
        {held.length === 0 ? (
          <span className="text-[11px] text-state-pending">grants nothing</span>
        ) : (
          <div className="flex flex-wrap gap-1">
            {held.map((permission) => (
              <span
                key={permission}
                title={PERMISSION_CATALOG[permission].summary}
                className={
                  'rounded border px-1.5 py-0.5 font-mono text-[10px] ' +
                  (PERMISSION_CATALOG[permission].impact === 'admin'
                    ? 'border-state-failed/40 bg-state-failed/10 text-ink'
                    : 'border-line-soft bg-panel-raised text-ink-muted')
                }
              >
                {permission}
              </span>
            ))}
          </div>
        )}
      </td>

      <td className="py-2 pr-3 tabular-nums text-ink-muted">{role.userCount}</td>

      <td className="py-2 text-right">
        <Button
          variant="ghost"
          size="sm"
          aria-label={`${verb} ${role.name}`}
          onClick={(event) => {
            event.stopPropagation();
            onOpen();
          }}
        >
          {verb === 'Edit' ? (
            <Pencil className="mr-1 size-3.5" aria-hidden />
          ) : (
            <Eye className="mr-1 size-3.5" aria-hidden />
          )}
          {verb}
        </Button>
      </td>
    </tr>
  );
}

const IMPACT_STYLE: Record<PermissionImpact, string> = {
  read: 'border-line-soft text-ink-faint',
  write: 'border-state-pending/50 text-state-pending',
  admin: 'border-state-failed/50 text-state-failed',
};

/**
 * The edit surface. Nothing here reaches the API until Save.
 *
 * `draft` is seeded from the role once and then owned by this component, so a
 * background refetch cannot rewrite what somebody is halfway through deciding.
 */
function RoleEditor({
  role,
  seed,
  editable,
  existing,
  onClose,
  onDuplicate,
}: {
  role: Role | null;
  seed?: { name: string; permissions: Permission[] } | undefined;
  editable: boolean;
  existing: string[];
  onClose: () => void;
  onDuplicate: (from: Role) => void;
}) {
  const create = useCreateRole();
  const update = useUpdateRole();
  const remove = useDeleteRole();

  const creating = role === null;
  /*
   * Read-only for two different reasons, deliberately collapsed into one flag
   * for rendering but explained separately to the operator below: the
   * deployment cannot define roles at all, or this particular role is built in
   * and is fixed by the product (ADR-0018 §1).
   */
  const builtIn = role?.builtIn === true;
  const readOnly = !editable || builtIn;

  const [name, setName] = useState(role?.name ?? seed?.name ?? '');
  const [description, setDescription] = useState(role?.description ?? '');
  const [draft, setDraft] = useState<Permission[]>(role?.permissions ?? seed?.permissions ?? []);
  const [error, setError] = useState<string | null>(null);
  const [blocking, setBlocking] = useState<BlockingRoleMapping[] | null>(null);
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  const busy = create.isPending || update.isPending || remove.isPending;

  const clash = creating && existing.includes(name);
  // Matches the API's own rule, so the refusal happens before a round trip
  // rather than after one.
  const shaped = /^[A-Za-z0-9._-]+$/.test(name);

  const added = draft.filter((p) => !(role?.permissions ?? []).includes(p));
  const removed = (role?.permissions ?? []).filter((p) => !draft.includes(p));
  const descriptionChanged = (role?.description ?? '') !== description;
  const dirty = creating || added.length > 0 || removed.length > 0 || descriptionChanged;

  const toggle = (permission: Permission) => {
    setError(null);
    setDraft((current) =>
      current.includes(permission)
        ? current.filter((p) => p !== permission)
        : [...current, permission],
    );
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

  const save = () => {
    setError(null);
    setBlocking(null);

    if (creating) {
      create.mutate(
        {
          name,
          permissions: draft,
          ...(description.trim() === '' ? {} : { description: description.trim() }),
        },
        { onSuccess: onClose, onError: fail },
      );
      return;
    }

    update.mutate(
      {
        id: role.id,
        patch: {
          permissions: draft,
          ...(descriptionChanged
            ? { description: description.trim() === '' ? null : description.trim() }
            : {}),
        },
      },
      { onSuccess: onClose, onError: fail },
    );
  };

  const title = creating ? 'New role' : readOnly ? `Role: ${role.name}` : `Edit role: ${role.name}`;

  return (
    <Dialog
      open
      onClose={onClose}
      title={title}
      description={
        builtIn
          ? `${role.name} is built in. Its permissions are fixed so that runbooks, directory mappings and support answers naming it stay true.`
          : readOnly
            ? 'Editing roles is not available in this deployment.'
            : 'Changes take effect for everybody holding this role as soon as you save.'
      }
      className="w-[min(46rem,calc(100vw-2rem))]"
      /*
       * The pending-changes summary lives in the FOOTER, not the body.
       *
       * The body scrolls, and a permission list is taller than the dialog — so
       * a summary rendered after it sat off-screen at exactly the moment
       * somebody was looking at Save. A statement of what a button is about to
       * do has to be visible from that button.
       */
      footer={
        readOnly ? (
          <div className="flex w-full items-center justify-between gap-2">
            {/*
             * The way OUT of a fixed role, offered at the moment somebody
             * discovers they cannot change it. A deployment that wants
             * "ADMIN but without pql:raw" gets a role of its own name that
             * says so, instead of an ADMIN that no longer means ADMIN.
             */}
            {builtIn && editable ? (
              <Button variant="ghost" size="sm" onClick={() => onDuplicate(role)}>
                <Copy className="mr-1 size-3.5" aria-hidden />
                Duplicate as custom role
              </Button>
            ) : (
              <span />
            )}
            <Button variant="ghost" size="sm" onClick={onClose}>
              Close
            </Button>
          </div>
        ) : (
          <div className="w-full space-y-2">
            <PendingChanges added={added} removed={removed} creating={creating} />
            <div className="flex justify-end gap-2">
              <Button variant="ghost" size="sm" disabled={busy} onClick={onClose}>
                Cancel
              </Button>
              <Button
                variant="primary"
                size="sm"
                disabled={busy || !dirty || (creating && (name === '' || !shaped || clash))}
                onClick={save}
              >
                {creating ? 'Create role' : 'Save changes'}
              </Button>
            </div>
          </div>
        )
      }
    >
      <div className="space-y-4">
        <div className="space-y-1">
          <Label htmlFor="role-name">Name</Label>
          {creating ? (
            <>
              <Input
                id="role-name"
                value={name}
                onChange={(event) => {
                  setName(event.target.value);
                  setError(null);
                }}
                placeholder="auditor"
                aria-invalid={name !== '' && (!shaped || clash)}
              />
              <p className="text-[11px] text-ink-faint">
                {'Letters, digits, dot, underscore and hyphen. No spaces — the name goes into '}
                {'directory mappings, which are delimited by semicolons and equals signs.'}
              </p>
              {name !== '' && !shaped && (
                <p className="text-[11px] text-state-failed">
                  Only letters, digits, dot, underscore and hyphen.
                </p>
              )}
              {clash && (
                <p className="text-[11px] text-state-failed">That name is already taken.</p>
              )}
            </>
          ) : (
            <p className="flex items-center gap-1 font-mono text-xs text-ink">
              {role.builtIn && <Lock className="size-3 text-ink-faint" aria-hidden />}
              {role.name}
              <span className="ml-2 font-sans text-[11px] text-ink-faint">
                {role.builtIn
                  ? 'built-in — fixed by the product'
                  : 'names are fixed once created; they appear in directory mappings and audit history'}
              </span>
            </p>
          )}
        </div>

        <div className="space-y-1">
          <Label htmlFor="role-description">Description</Label>
          <Input
            id="role-description"
            value={description}
            disabled={readOnly}
            maxLength={256}
            onChange={(event) => setDescription(event.target.value)}
            placeholder="What this role is for"
          />
        </div>

        <div className="space-y-1.5">
          <Label>Permissions</Label>
          <div className="divide-y divide-line-soft rounded border border-line-soft">
            {PERMISSIONS.map((permission) => {
              const info = PERMISSION_CATALOG[permission];
              const held = draft.includes(permission);
              return (
                <label
                  key={permission}
                  className={
                    'flex cursor-pointer items-start gap-2.5 p-2.5 ' +
                    (readOnly ? 'cursor-default' : 'hover:bg-panel-raised/60')
                  }
                >
                  <input
                    type="checkbox"
                    checked={held}
                    disabled={readOnly}
                    onChange={() => toggle(permission)}
                    className="mt-0.5 size-3.5 shrink-0 accent-accent"
                  />
                  <span className="min-w-0 space-y-0.5">
                    <span className="flex flex-wrap items-center gap-1.5">
                      <span className="text-xs font-medium text-ink">{info.summary}</span>
                      <span
                        className={
                          'rounded border px-1 py-px text-[10px] ' + IMPACT_STYLE[info.impact]
                        }
                      >
                        {impactLabel(info.impact)}
                      </span>
                    </span>
                    <span className="block font-mono text-[10px] text-ink-faint">{permission}</span>
                    <span className="block max-w-prose text-[11px] text-ink-muted">
                      {info.detail}
                    </span>
                    {info.caution !== undefined && (
                      <span className="mt-0.5 flex max-w-prose items-start gap-1 text-[11px] text-state-pending">
                        <AlertTriangle className="mt-0.5 size-3 shrink-0" aria-hidden />
                        {info.caution}
                      </span>
                    )}
                  </span>
                </label>
              );
            })}
          </div>
        </div>

        {draft.length === 0 && !readOnly && (
          <p className="flex items-start gap-1 text-[11px] text-state-pending">
            <AlertTriangle className="mt-0.5 size-3 shrink-0" aria-hidden />
            {'This role would grant nothing. That is allowed — a placeholder to fill in later — '}
            {'but anybody holding it can do nothing at all.'}
          </p>
        )}

        {blocking !== null && role !== null && (
          <BlockingMappings role={role.name} mappings={blocking} />
        )}

        {error !== null && (
          <p role="alert" className="text-[11px] text-state-failed">
            {error}
          </p>
        )}

        {!readOnly && !creating && !role.builtIn && (
          <div className="space-y-1.5 rounded border border-state-failed/30 p-2.5">
            <p className="text-[11px] font-semibold text-ink">Delete this role</p>
            <p className="max-w-prose text-[11px] text-ink-muted">
              {role.userCount > 0
                ? `${role.userCount} user${role.userCount === 1 ? '' : 's'} currently hold this role and will need another one.`
                : 'No users hold this role.'}
              {' Directory groups mapped to it will be refused until they are repointed.'}
            </p>
            {confirmingDelete ? (
              <div className="flex items-center gap-2">
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={busy}
                  onClick={() => {
                    setError(null);
                    setBlocking(null);
                    remove.mutate(role.id, { onSuccess: onClose, onError: fail });
                  }}
                >
                  <Trash2 className="mr-1 size-3.5 text-state-failed" aria-hidden />
                  {`Yes, delete "${role.name}"`}
                </Button>
                <Button variant="ghost" size="sm" onClick={() => setConfirmingDelete(false)}>
                  Keep it
                </Button>
              </div>
            ) : (
              <Button
                variant="ghost"
                size="sm"
                disabled={busy}
                aria-label={`Delete ${role.name}`}
                onClick={() => setConfirmingDelete(true)}
              >
                <Trash2 className="mr-1 size-3.5 text-state-failed" aria-hidden />
                Delete role
              </Button>
            )}
          </div>
        )}
      </div>
    </Dialog>
  );
}

/**
 * What Save is about to do, in words, before it does it.
 *
 * The checkbox list shows the resulting state; this shows the delta. They are
 * different questions — "what will this role be" versus "what am I changing" —
 * and the second is the one somebody is accountable for.
 */
function PendingChanges({
  added,
  removed,
  creating,
}: {
  added: Permission[];
  removed: Permission[];
  creating: boolean;
}) {
  const escalating = useMemo(
    () => added.filter((p) => PERMISSION_CATALOG[p].impact === 'admin'),
    [added],
  );

  if (creating || (added.length === 0 && removed.length === 0)) return null;

  return (
    <div className="space-y-1 rounded border border-accent/40 bg-accent/10 p-2.5">
      <p className="text-[11px] font-semibold text-ink">Pending changes</p>
      {/*
       * Marked with glyphs rather than colour. The palette's state tokens mean
       * Puppet run states (changed / unchanged / failed) and borrowing one to
       * mean "granting" would collide with them; a + and a − also survive being
       * read by somebody who cannot tell the two colours apart.
       */}
      {added.length > 0 && (
        <p className="text-[11px] text-ink-muted">
          <span aria-hidden className="font-mono text-ink">
            +
          </span>{' '}
          <span className="font-medium text-ink">Granting</span>{' '}
          <span className="font-mono text-ink">{added.join(', ')}</span>
        </p>
      )}
      {removed.length > 0 && (
        <p className="text-[11px] text-ink-muted">
          <span aria-hidden className="font-mono text-ink">
            −
          </span>{' '}
          <span className="font-medium text-ink">Revoking</span>{' '}
          <span className="font-mono text-ink">{removed.join(', ')}</span>
        </p>
      )}
      {escalating.length > 0 && (
        <p className="mt-1 flex max-w-prose items-start gap-1 text-[11px] text-state-failed">
          <ShieldAlert className="mt-0.5 size-3 shrink-0" aria-hidden />
          {'This grants administrative access. Everybody already holding this role gets it too, '}
          {'including anybody mapped in from a directory group.'}
        </p>
      )}
    </div>
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
