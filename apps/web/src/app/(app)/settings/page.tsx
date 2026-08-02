import { redirect } from 'next/navigation';

/**
 * /settings has no content of its own.
 *
 * Redirect rather than render General here as well: two addresses for one
 * screen means the tab bar cannot tell which is active, and a bookmark of
 * /settings would sit on a page with no tab underlined.
 *
 * General requires no permission, so this is safe for every signed-in user.
 */
export default function SettingsIndex() {
  redirect('/settings/general');
}
