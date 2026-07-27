'use client';

import { useMutation, useQueryClient, type UseMutationResult } from '@tanstack/react-query';
import type {
  AssignClass,
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
