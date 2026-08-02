'use client';

import { useMutation, useQueryClient, type UseMutationResult } from '@tanstack/react-query';
import type {
  AssignClass,
  ChangePassword,
  LdapSettings,
  ProviderVerification,
  SettingsView,
  CreateUserInput,
  ManagedUser,
  UpdateUser,
  ClassificationWriteResult,
  CreateNodeGroup,
  ReplaceRules,
  SetParameter,
  UpdateNodeGroup,
} from '@nexuspuppet/contracts';
import { api } from './client';

/**
 * Classification writes.
 *
 * EVERY MUTATION HERE RECONFIGURES REAL MACHINES, eventually. The API answers
 * 202, not 200: the change is durable at commit but the ENC file on disk is
 * written asynchronously (ADR-0003). Nothing in this layer may present a write
 * as "applied" — callers get the queued scope back and are expected to say so.
 *
 * There is deliberately no optimistic update. Optimism here would mean drawing
 * a classification the estate is not yet running, which is the exact confusion
 * the 202 exists to prevent.
 */

/** Invalidate everything a classification change can affect. */
function useClassificationInvalidation() {
  const client = useQueryClient();

  return async (groupId?: string) => {
    await Promise.all([
      client.invalidateQueries({ queryKey: ['node-groups'] }),
      groupId === undefined
        ? Promise.resolve()
        : client.invalidateQueries({ queryKey: ['node-group', groupId] }),
      // Any node's explanation may have changed — including nodes this group
      // no longer matches, which is why this cannot be narrowed to the
      // affected set returned by the API.
      client.invalidateQueries({ queryKey: ['node-classification'] }),
    ]);
  };
}

export function useCreateGroup(): UseMutationResult<
  ClassificationWriteResult,
  Error,
  CreateNodeGroup
> {
  const invalidate = useClassificationInvalidation();

  return useMutation({
    mutationFn: (input) => api.post<ClassificationWriteResult>('/node-groups', input),
    onSuccess: (result) => invalidate(result.group.id),
  });
}

export function useUpdateGroup(
  id: string,
): UseMutationResult<ClassificationWriteResult, Error, UpdateNodeGroup> {
  const invalidate = useClassificationInvalidation();

  return useMutation({
    mutationFn: (input) => api.patch<ClassificationWriteResult>(`/node-groups/${id}`, input),
    onSuccess: () => invalidate(id),
  });
}

export function useDeleteGroup(): UseMutationResult<
  { materializationQueued: { scope: 'nodes'; certnames: string[] } },
  Error,
  string
> {
  const invalidate = useClassificationInvalidation();

  return useMutation({
    mutationFn: (id) =>
      api.delete<{ materializationQueued: { scope: 'nodes'; certnames: string[] } }>(
        `/node-groups/${id}`,
      ),
    onSuccess: () => invalidate(),
  });
}

export function useReplaceRules(
  id: string,
): UseMutationResult<ClassificationWriteResult, Error, ReplaceRules> {
  const invalidate = useClassificationInvalidation();

  return useMutation({
    mutationFn: (input) => api.put<ClassificationWriteResult>(`/node-groups/${id}/rules`, input),
    onSuccess: () => invalidate(id),
  });
}

export function useAssignClass(
  id: string,
): UseMutationResult<ClassificationWriteResult, Error, AssignClass> {
  const invalidate = useClassificationInvalidation();

  return useMutation({
    mutationFn: (input) => api.put<ClassificationWriteResult>(`/node-groups/${id}/classes`, input),
    onSuccess: () => invalidate(id),
  });
}

export function useRemoveClass(
  id: string,
): UseMutationResult<ClassificationWriteResult, Error, string> {
  const invalidate = useClassificationInvalidation();

  return useMutation({
    mutationFn: (className) =>
      api.delete<ClassificationWriteResult>(
        `/node-groups/${id}/classes/${encodeURIComponent(className)}`,
      ),
    onSuccess: () => invalidate(id),
  });
}

export function useSetParameter(
  id: string,
): UseMutationResult<ClassificationWriteResult, Error, SetParameter> {
  const invalidate = useClassificationInvalidation();

  return useMutation({
    mutationFn: (input) =>
      api.put<ClassificationWriteResult>(`/node-groups/${id}/parameters`, input),
    onSuccess: () => invalidate(id),
  });
}

export function useRemoveParameter(
  id: string,
): UseMutationResult<ClassificationWriteResult, Error, string> {
  const invalidate = useClassificationInvalidation();

  return useMutation({
    mutationFn: (key) =>
      api.delete<ClassificationWriteResult>(
        `/node-groups/${id}/parameters/${encodeURIComponent(key)}`,
      ),
    onSuccess: () => invalidate(id),
  });
}

export function useAddPins(
  id: string,
): UseMutationResult<ClassificationWriteResult, Error, string[]> {
  const invalidate = useClassificationInvalidation();

  return useMutation({
    mutationFn: (certnames) =>
      api.post<ClassificationWriteResult>(`/node-groups/${id}/pins`, { certnames }),
    onSuccess: () => invalidate(id),
  });
}

export function useRemovePin(
  id: string,
): UseMutationResult<ClassificationWriteResult, Error, string> {
  const invalidate = useClassificationInvalidation();

  return useMutation({
    mutationFn: (certname) =>
      api.delete<ClassificationWriteResult>(
        `/node-groups/${id}/pins/${encodeURIComponent(certname)}`,
      ),
    onSuccess: () => invalidate(id),
  });
}

export function useForceReconcile(): UseMutationResult<{ queued: true }, Error, void> {
  const invalidate = useClassificationInvalidation();

  return useMutation({
    mutationFn: () => api.post<{ queued: true }>('/materialization/reconcile'),
    onSuccess: () => invalidate(),
  });
}

// --- Users ------------------------------------------------------------------

function useUserInvalidation() {
  const client = useQueryClient();
  return () => client.invalidateQueries({ queryKey: ['users'] });
}

export function useCreateUser(): UseMutationResult<ManagedUser, Error, CreateUserInput> {
  const invalidate = useUserInvalidation();
  return useMutation({
    mutationFn: (input) => api.post<ManagedUser>('/users', input),
    onSuccess: () => invalidate(),
  });
}

export function useUpdateUser(): UseMutationResult<
  ManagedUser,
  Error,
  { id: string; patch: UpdateUser }
> {
  const invalidate = useUserInvalidation();
  return useMutation({
    mutationFn: ({ id, patch }) => api.patch<ManagedUser>(`/users/${id}`, patch),
    onSuccess: () => invalidate(),
  });
}

/** Deactivate rather than delete, so the audit trail keeps naming a real actor. */
export function useDeactivateUser(): UseMutationResult<ManagedUser, Error, string> {
  const invalidate = useUserInvalidation();
  return useMutation({
    mutationFn: (id) => api.delete<ManagedUser>(`/users/${id}`),
    onSuccess: () => invalidate(),
  });
}

/**
 * An administrator setting somebody else's password.
 *
 * Distinct from `useChangeOwnPassword`, which requires the current password
 * because the caller is proving who they are. An admin has no such proof to
 * offer and does not need one — they already hold `users:manage`.
 *
 * The API revokes EVERY session the target has, and that is correct here: the
 * usual reason to reset somebody's password is that it may be compromised, so
 * leaving their sessions alive would defeat the point. It is the opposite of
 * the self-service path, which now spares the caller's own session.
 */
export function useResetPassword(): UseMutationResult<
  void,
  Error,
  { id: string; newPassword: string }
> {
  const invalidate = useUserInvalidation();
  return useMutation({
    mutationFn: ({ id, newPassword }) => api.post<void>(`/users/${id}/password`, { newPassword }),
    // The detail view shows a session count that this action zeroes.
    onSuccess: () => invalidate(),
  });
}

/**
 * Permanent removal.
 *
 * `/permanent` rather than the bare `DELETE /users/:id`, which deactivates.
 * Two different actions with two different paths, so neither can be reached by
 * assuming the other's convention.
 */
export function useDeleteUser(): UseMutationResult<void, Error, string> {
  const invalidate = useUserInvalidation();
  return useMutation({
    mutationFn: (id) => api.delete<void>(`/users/${id}/permanent`),
    onSuccess: () => invalidate(),
  });
}

/**
 * Save the LDAP configuration (ADR-0016).
 *
 * Omitting `bindPassword` keeps the stored one — the form never receives it, so
 * it cannot send it back, and treating absence as "clear it" would wipe the
 * credential every time somebody corrected a search base.
 */
export function useSaveLdapSettings(): UseMutationResult<
  SettingsView<LdapSettings>,
  Error,
  LdapSettings
> {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input) => api.put<SettingsView<LdapSettings>>('/settings/auth/ldap', input),
    onSuccess: () => client.invalidateQueries({ queryKey: ['settings', 'auth.ldap'] }),
  });
}

/** Discard the stored configuration and fall back to the environment. */
export function useClearLdapSettings(): UseMutationResult<void, Error, void> {
  const client = useQueryClient();
  return useMutation({
    mutationFn: () => api.delete<void>('/settings/auth/ldap'),
    onSuccess: () => client.invalidateQueries({ queryKey: ['settings', 'auth.ldap'] }),
  });
}

/**
 * Try a configuration without saving it.
 *
 * Deliberately does NOT invalidate anything: a test changes nothing, and
 * refetching after one would make it look as though it had.
 */
export function useTestLdapSettings(): UseMutationResult<
  ProviderVerification,
  Error,
  LdapSettings
> {
  return useMutation({
    mutationFn: (input) => api.post<ProviderVerification>('/settings/auth/ldap/test', input),
  });
}

export function useChangeOwnPassword(): UseMutationResult<void, Error, ChangePassword> {
  return useMutation({
    mutationFn: (input) => api.post<void>('/account/password', input),
  });
}
