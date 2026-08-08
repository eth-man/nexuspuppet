'use client';

import { useQuery, type UseQueryResult } from '@tanstack/react-query';
import type {
  AuthSources,
  DeploymentInfo,
  AuditForwardingView,
  AuthProviderDescription,
  DeploymentCapabilities,
  FactPathIndex,
  LdapSettings,
  ManagedUser,
  OidcSettings,
  LogLevelSetting,
  NotificationEmailSettings,
  NotificationWebhookSettings,
  OperationalCondition,
  ManagedUserDetail,
  SettingsView,
  NodeClassificationExplanation,
  NodeGroupDetail,
  Page,
  PuppetNode,
  PuppetReport,
  ReportSummary,
  ResourceEvent,
  SystemStatus,
  ConsoleTlsStatus,
  Role,
  ConflictReport,
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
 * One user, fetched only while their detail view is open.
 *
 * Keyed under ['users', id] so a reset or a deletion invalidating ['users']
 * refreshes this too — the session count it displays is precisely what those
 * actions change.
 */
export function useUser(id: string | null): UseQueryResult<ManagedUserDetail> {
  return useQuery({
    queryKey: ['users', id],
    queryFn: ({ signal }) => api.get<ManagedUserDetail>(`/users/${id ?? ''}`, signal),
    enabled: id !== null,
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
export function useAuthSources(): UseQueryResult<AuthSources> {
  return useQuery({
    queryKey: ['auth-sources'],
    queryFn: ({ signal }) => api.get<AuthSources>('/auth/mode', signal),
    staleTime: Infinity,
  });
}

/**
 * The active provider's configuration, for an administrator.
 *
 * Requires settings:manage, so it is fetched only when the caller has it —
 * asking otherwise produces a 403 in the console for no benefit.
 */
/**
 * The stored LDAP configuration, without its secrets (ADR-0016).
 *
 * `staleTime: 0`, unlike most reads here. A settings screen that shows a cached
 * copy after somebody saved is worse than a slow one — an operator would be
 * editing a form that no longer describes the deployment.
 */
export function useLdapSettings(enabled: boolean): UseQueryResult<SettingsView<LdapSettings>> {
  return useQuery({
    queryKey: ['settings', 'auth.ldap'],
    queryFn: ({ signal }) => api.get<SettingsView<LdapSettings>>('/settings/auth/ldap', signal),
    enabled,
    staleTime: 0,
  });
}

/** The stored OIDC configuration, without its secret. Same freshness rule as LDAP. */
export function useOidcSettings(enabled: boolean): UseQueryResult<SettingsView<OidcSettings>> {
  return useQuery({
    queryKey: ['settings', 'auth.oidc'],
    queryFn: ({ signal }) => api.get<SettingsView<OidcSettings>>('/settings/auth/oidc', signal),
    enabled,
    staleTime: 0,
  });
}

/**
 * Both audit forwarding transports and which one is active (ADR-0016 §5).
 * Same `staleTime: 0` reasoning as the directory settings above.
 */
export function useAuditForwarding(enabled: boolean): UseQueryResult<AuditForwardingView> {
  return useQuery({
    queryKey: ['settings', 'audit.forwarding'],
    queryFn: ({ signal }) => api.get<AuditForwardingView>('/settings/audit/forwarding', signal),
    enabled,
    staleTime: 0,
  });
}

export function useAuthProvider(enabled: boolean): UseQueryResult<AuthProviderDescription> {
  return useQuery({
    queryKey: ['auth-provider'],
    queryFn: ({ signal }) => api.get<AuthProviderDescription>('/auth/provider', signal),
    enabled,
    staleTime: Infinity,
  });
}

/**
 * Operational status of the deployment.
 *
 * Polled rather than fetched once: the numbers it reports — a growing queue, a
 * stranded node — are exactly the ones an operator wants to watch change while
 * they are looking at the screen. Every query behind it rides an existing
 * index, so a 30s poll from several open consoles is cheap.
 */
export function useSystemStatus(): UseQueryResult<SystemStatus> {
  return useQuery({
    queryKey: ['system-status'],
    queryFn: ({ signal }) => api.get<SystemStatus>('/system/status', signal),
    refetchInterval: 30_000,
  });
}

/**
 * The certificate the console is served with (ADR-0013).
 *
 * Refetched far less often than system status: a certificate changes when an
 * operator replaces a file, not on a timer, and its expiry is measured in days.
 */
export function useConsoleTls(): UseQueryResult<ConsoleTlsStatus> {
  return useQuery({
    queryKey: ['console-tls'],
    queryFn: ({ signal }) => api.get<ConsoleTlsStatus>('/system/tls', signal),
    staleTime: 300_000,
  });
}

/**
 * Every conflict in the estate, grouped by which override it is (ADR-0009).
 *
 * Recomputed from stored materializations rather than from live merges, so it
 * follows the materializer rather than leading it — a change shows up here once
 * the affected nodes have been written, which is the same moment it becomes true
 * of the estate.
 */
export function useConflictReport(): UseQueryResult<ConflictReport> {
  return useQuery({
    queryKey: ['conflict-report'],
    queryFn: ({ signal }) => api.get<ConflictReport>('/classification/conflicts', signal),
    staleTime: 60_000,
  });
}

export function useCapabilities(): UseQueryResult<DeploymentCapabilities> {
  return useQuery({
    queryKey: ['capabilities'],
    queryFn: ({ signal }) => api.get<DeploymentCapabilities>('/capabilities', signal),
    staleTime: Infinity,
  });
}

/**
 * Every role this deployment defines.
 *
 * Readable by anyone who can manage settings, whether or not the deployment can
 * EDIT roles — a console that could not show its own roles would be hiding how
 * its authorization works.
 */
export function useRoles(enabled: boolean): UseQueryResult<Role[]> {
  return useQuery({
    queryKey: ['roles'],
    queryFn: ({ signal }) => api.get<Role[]>('/roles', signal),
    enabled,
    staleTime: 30_000,
  });
}

/**
 * What this deployment is, and whether its parts answer.
 *
 * Polled gently: a version does not change while somebody is looking at it,
 * and the database round trip should not be a load source of its own.
 */
/**
 * The operational conditions currently open (ADR-0021).
 *
 * Polled, because the value of this is being told when you are not looking —
 * a panel that only refreshes on navigation would report a healthy deployment
 * for as long as the tab sat open.
 */
export function useNotificationWebhook(
  enabled: boolean,
): UseQueryResult<SettingsView<NotificationWebhookSettings>> {
  return useQuery({
    queryKey: ['settings', 'notifications.webhook'],
    queryFn: ({ signal }) =>
      api.get<SettingsView<NotificationWebhookSettings>>('/settings/notifications/webhook', signal),
    enabled,
  });
}

export function useNotificationEmail(
  enabled: boolean,
): UseQueryResult<SettingsView<NotificationEmailSettings>> {
  return useQuery({
    queryKey: ['settings', 'notifications.email'],
    queryFn: ({ signal }) =>
      api.get<SettingsView<NotificationEmailSettings>>('/settings/notifications/email', signal),
    enabled,
  });
}

export function useLogLevel(enabled: boolean): UseQueryResult<LogLevelSetting> {
  return useQuery({
    queryKey: ['system', 'log-level'],
    queryFn: ({ signal }) => api.get<LogLevelSetting>('/system/log-level', signal),
    enabled,
  });
}

export function useOpenConditions(): UseQueryResult<OperationalCondition[]> {
  return useQuery({
    queryKey: ['system', 'conditions'],
    queryFn: ({ signal }) => api.get<OperationalCondition[]>('/system/conditions', signal),
    refetchInterval: 30_000,
    staleTime: 15_000,
  });
}

export function useDeployment(): UseQueryResult<DeploymentInfo> {
  return useQuery({
    queryKey: ['deployment'],
    queryFn: ({ signal }) => api.get<DeploymentInfo>('/system/deployment', signal),
    refetchInterval: 30_000,
    staleTime: 15_000,
  });
}
