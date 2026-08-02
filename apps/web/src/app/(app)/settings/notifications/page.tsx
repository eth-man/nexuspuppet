'use client';

import { SettingsEmpty, SettingsGuard } from '@/components/settings-guard';

/** Reserved. Nothing in the product raises a notification yet. */
export default function NotificationsSettingsPage() {
  return (
    <SettingsGuard permission="settings:manage" section="Notifications">
      <SettingsEmpty title="Nothing to configure yet">
        This deployment does not send notifications. When it does &mdash; a run that fails
        repeatedly, a certificate close to expiry &mdash; the routing for them will be set here.
      </SettingsEmpty>
    </SettingsGuard>
  );
}
