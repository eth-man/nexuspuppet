'use client';

import { useQuery, type UseQueryResult } from '@tanstack/react-query';
import type {
  AuthProviderDescription,
  DeploymentCapabilities,
  FactPathIndex,
  ManagedUser,
  NodeClassificationExplanation,
  NodeGroupDetail,
  Page,
  PuppetNode,
  PuppetReport,
  ReportSummary,
  ResourceEvent,
} from '@nexuspuppet/contracts';
import { api } from './client';

/**
 * Typed query hooks.
 *
 * Query keys mirror the URL shape so a mutation can invalidate exactly the
 * views it affects rather than blowing away the whole cache — on a dense
 * console that would visibly blank several panels at once.
 */

export interface NodeQuery {
  certnameContains?: string;
  environments?: string[];
  statuses?: string[];
  includeInactive?: boolean;
  limit: number;
  offset: number;
  orderBy?: string;
  order?: 'asc' | 'desc';
}

function toSearch(query: NodeQuery): string {
  const params = new URLSearchParams();
  params.set('limit', String(query.limit));
  params.set('offset', String(query.offset));

  if (query.certnameContains !== undefined && query.certnameContains !== '') {
    params.set('certnameContains', query.certnameContains);
  }
  if (query.environments !== undefined && query.environments.length > 0) {
    params.set('environments', query.environments.join(','));
  }
  if (query.statuses !== undefined && query.statuses.length > 0) {
    params.set('statuses', query.statuses.join(','));
  }
  if (query.includeInactive === true) params.set('includeInactive', 'true');
  if (query.orderBy !== undefined) params.set('orderBy', query.orderBy);
  if (query.order !== undefined) params.set('order', query.order);

  return params.toString();
}

export function useNodes(query: NodeQuery): UseQueryResult<Page<PuppetNode>> {
  return useQuery({
    queryKey: ['nodes', query],
    queryFn: ({ signal }) => api.get<Page<PuppetNode>>(`/nodes?${toSearch(query)}`, signal),
    // Keeping the previous page visible while the next loads stops a dense
    // table from collapsing to a spinner on every keystroke or page change.
    placeholderData: (previous) => previous,
  });
}

/**
 * A count for one status, used by the dashboard tiles.
 *
 * The API returns a total alongside every page, so a limit of 1 is the cheapest
 * possible count — there is no dedicated counts endpoint and inventing one for
 * four tiles would not earn its keep.
 */
export function useNodeCount(statuses: string[] | undefined, label: string) {
  return useQuery({
    queryKey: ['node-count', label],
    queryFn: async ({ signal }) => {
      const page = await api.get<Page<PuppetNode>>(
        `/nodes?${toSearch({ limit: 1, offset: 0, ...(statuses === undefined ? {} : { statuses }) })}`,
        signal,
      );
      return page.total;
    },
  });
}

export function useNode(certname: string): UseQueryResult<PuppetNode> {
  return useQuery({
    queryKey: ['node', certname],
    queryFn: ({ signal }) => api.get<PuppetNode>(`/nodes/${encodeURIComponent(certname)}`, signal),
  });
}

export function useNodeFacts(certname: string): UseQueryResult<Record<string, unknown>> {
  return useQuery({
    queryKey: ['node-facts', certname],
    queryFn: ({ signal }) =>
      api.get<Record<string, unknown>>(`/nodes/${encodeURIComponent(certname)}/facts`, signal),
  });
}

export function useNodeClassification(
  certname: string,
): UseQueryResult<NodeClassificationExplanation> {
  return useQuery({
    queryKey: ['node-classification', certname],
    queryFn: ({ signal }) =>
      api.get<NodeClassificationExplanation>(
        `/nodes/${encodeURIComponent(certname)}/classification`,
        signal,
      ),
    // Classification is served from local state and keeps working during a
    // PuppetDB outage, so it must not be cached against the inventory's
    // freshness assumptions.
    staleTime: 5_000,
  });
}

export function useNodeReports(certname: string, limit = 20): UseQueryResult<Page<PuppetReport>> {
  return useQuery({
    queryKey: ['node-reports', certname, limit],
    queryFn: ({ signal }) =>
      api.get<Page<PuppetReport>>(
        `/nodes/${encodeURIComponent(certname)}/reports?limit=${limit}&offset=0`,
        signal,
      ),
  });
}

export interface ReportDetail {
  report: PuppetReport;
  summary: ReportSummary | null;
  events: ResourceEvent[];
}

export function useReport(hash: string): UseQueryResult<ReportDetail> {
  return useQuery({
    queryKey: ['report', hash],
    queryFn: ({ signal }) => api.get<ReportDetail>(`/reports/${encodeURIComponent(hash)}`, signal),
    // A report is immutable once written.
    staleTime: Infinity,
  });
}

export function useEnvironments(): UseQueryResult<string[]> {
  return useQuery({
    queryKey: ['environments'],
    queryFn: ({ signal }) => api.get<string[]>('/environments', signal),
    staleTime: 300_000,
  });
}

export function useNodeGroups(): UseQueryResult<NodeGroupDetail[]> {
  return useQuery({
    queryKey: ['node-groups'],
    queryFn: ({ signal }) => api.get<NodeGroupDetail[]>('/node-groups', signal),
  });
}

export function useNodeGroup(id: string): UseQueryResult<NodeGroupDetail> {
  return useQuery({
    queryKey: ['node-group', id],
    queryFn: ({ signal }) => api.get<NodeGroupDetail>(`/node-groups/${id}`, signal),
  });
}

/**
 * Fact paths a rule can match on.
 *
 * Cached hard: it changes only when the projection refreshes, and a type-ahead
 * must not refetch on every keystroke.
 */
export function useFactPaths(): UseQueryResult<FactPathIndex> {
  return useQuery({
    queryKey: ['fact-paths'],
    queryFn: ({ signal }) => api.get<FactPathIndex>('/fact-paths', signal),
    staleTime: 120_000,
  });
}

export function useUsers(enabled: boolean): UseQueryResult<ManagedUser[]> {
  return useQuery({
    queryKey: ['users'],
    queryFn: ({ signal }) => api.get<ManagedUser[]>('/users', signal),
    // Only ADMIN may list users; asking as a VIEWER would 403 on every render.
    enabled,
  });
}

/**
 * Which authority this DEPLOYMENT authenticates against.
 *
 * Not the same question as "how is the current user authenticated". An
 * administrator holding a local account on an LDAP deployment still needs to be
 * able to provision directory accounts, so the current principal's authSource
 * is the wrong signal — this is the right one.
 */
export function useAuthMode(): UseQueryResult<{ mode: string; source: string }> {
  return useQuery({
    queryKey: ['auth-mode'],
    queryFn: ({ signal }) => api.get<{ mode: string; source: string }>('/auth/mode', signal),
    staleTime: Infinity,
  });
}

/**
 * The active provider's configuration, for an administrator.
 *
 * Requires settings:manage, so it is fetched only when the caller has it —
 * asking otherwise produces a 403 in the console for no benefit.
 */
export function useAuthProvider(enabled: boolean): UseQueryResult<AuthProviderDescription> {
  return useQuery({
    queryKey: ['auth-provider'],
    queryFn: ({ signal }) => api.get<AuthProviderDescription>('/auth/provider', signal),
    enabled,
    staleTime: Infinity,
  });
}

export function useCapabilities(): UseQueryResult<DeploymentCapabilities> {
  return useQuery({
    queryKey: ['capabilities'],
    queryFn: ({ signal }) => api.get<DeploymentCapabilities>('/capabilities', signal),
    staleTime: Infinity,
  });
}
