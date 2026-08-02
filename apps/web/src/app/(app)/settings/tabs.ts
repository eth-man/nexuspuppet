import type { Permission } from '@nexuspuppet/contracts';

/**
 * The Settings tabs, in display order.
 *
 * One list, used by both the tab bar and the pages themselves — the bar decides
 * what to show from it, and each page checks the same entry before rendering.
 * Two lists would eventually disagree, and the way that surfaces is a tab that
 * leads somewhere the operator is not allowed to be.
 */
export interface SettingsTab {
  /** Path segment under /settings. */
  readonly slug: string;
  readonly label: string;
  /**
   * Required to see this tab at all. Undefined means everyone signed in.
   *
   * This is an affordance, not a boundary: the API enforces independently
   * (ADR-0006). Hiding a tab keeps an operator from walking into a screen that
   * would refuse everything on it — it does not make the data safe.
   */
  readonly permission?: Permission;
}

export const SETTINGS_TABS: readonly SettingsTab[] = [
  { slug: 'general', label: 'General' },
  { slug: 'auth', label: 'Directory / Auth', permission: 'settings:manage' },
  { slug: 'integrations', label: 'Integrations', permission: 'settings:manage' },
  { slug: 'notifications', label: 'Notifications', permission: 'settings:manage' },
  { slug: 'users', label: 'Users & Roles', permission: 'users:manage' },
];

export function tabFor(slug: string): SettingsTab | undefined {
  return SETTINGS_TABS.find((tab) => tab.slug === slug);
}
