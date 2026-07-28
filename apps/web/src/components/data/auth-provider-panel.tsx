'use client';

import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { useAuth } from '@/providers/auth-provider';
import { useAuthProvider } from '@/lib/queries';

/**
 * Who gets which role, according to the directory.
 *
 * Read-only on purpose. These mappings decide who can reclassify a thousand
 * machines, and they are currently owned by the deployment's environment —
 * versioned in whatever manages your configuration, changed by a restart, and
 * not editable from inside the application. This panel exists so an
 * administrator can SEE what is in force without reading a container's
 * environment over someone's shoulder.
 *
 * Rendered without interpretation: core does not know what LDAP is, and the
 * provider decides what is safe to show (ADR-0002).
 */
export function AuthProviderPanel() {
  const { can } = useAuth();
  const manages = can('settings:manage');
  const provider = useAuthProvider(manages);

  if (!manages) return null;

  const description = provider.data;

  // A provider with no group mappings has nothing to explain — core's local
  // password auth is the usual case. Showing an empty table would imply
  // something is misconfigured.
  if (description === undefined || description.roleMappings.length === 0) return null;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Directory role mappings</CardTitle>
      </CardHeader>
      <CardContent>
        <p className="mb-2 text-[11px] text-ink-faint">
          {'Applied at every login by the '}
          <span className="font-mono text-ink">{description.source}</span>
          {/* String expressions, not bare text: JSX drops the space between an
              element and adjacent text across a line break, and Prettier keeps
              collapsing an explicit {' '} back into one. This renders
              "ldap provider", not "ldapprovider". */}
          {' provider. A person\u2019s role is recomputed from their group membership each '}
          {'time they sign in \u2014 changing a group in the directory takes effect at their '}
          {'next sign-in, not immediately.'}
        </p>

        <table className="w-full text-xs">
          <thead>
            <tr className="border-b border-edge text-left text-ink-faint">
              <th className="py-1 pr-2 font-normal">Directory group</th>
              <th className="w-24 py-1 font-normal">Grants</th>
            </tr>
          </thead>
          <tbody>
            {description.roleMappings.map((mapping) => (
              <tr key={`${mapping.group}:${mapping.role}`} className="border-b border-edge/50">
                {/* Monospace: a DN is a structured identifier, and a
                    proportional font makes two similar ones hard to tell
                    apart — which is exactly the mistake that grants ADMIN to
                    the wrong group. */}
                <td className="truncate py-1 pr-2 font-mono text-ink" title={mapping.group}>
                  {mapping.group}
                </td>
                <td className="py-1">
                  <Badge>{mapping.role}</Badge>
                </td>
              </tr>
            ))}
          </tbody>
        </table>

        <p className="mt-2 text-[11px] text-ink-faint">
          {description.refusesUnmappedUsers
            ? 'Someone in none of these groups is refused, even with a correct password.'
            : 'Someone in none of these groups is still admitted with a default role.'}{' '}
          Where a person matches several, the highest role wins.
        </p>

        {description.details.length > 0 && (
          <dl className="mt-3 grid grid-cols-[8rem_1fr] gap-y-1 border-t border-edge pt-2 text-[11px]">
            {description.details.map((detail) => (
              <div key={detail.label} className="contents">
                <dt className="text-ink-faint">{detail.label}</dt>
                <dd className="truncate font-mono text-ink" title={detail.value}>
                  {detail.value}
                </dd>
              </div>
            ))}
          </dl>
        )}

        <p className="mt-2 text-[11px] text-ink-faint">
          Read-only. These are set in the deployment&rsquo;s configuration and change on restart.
        </p>
      </CardContent>
    </Card>
  );
}
