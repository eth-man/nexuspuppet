import { ArrowUpRight, Building2, Check } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent } from '@/components/ui/card';

/**
 * Where the enterprise layer is documented. The public repository, not a
 * marketing page — there isn't one, and inventing a URL would be worse than
 * pointing at the thing that actually explains the install.
 */
const LEARN_MORE = 'https://github.com/eth-man/nexuspuppet/blob/main/DEPLOYMENT.md';

/**
 * The Directory screen, for a deployment that cannot run a directory.
 *
 * Core used to render the whole configuration form here, save what was typed
 * into it, and then explain in a warning box that nothing would take effect.
 * That is a dark pattern however honestly it is worded: an open-source user
 * fills in six fields, presses Save, gets a success, and finds nobody can sign
 * in — and the most reasonable conclusion available to them is that the product
 * is broken.
 *
 * The tab stays. Hiding the feature entirely means a core user never learns it
 * exists, and an operator evaluating the product cannot see what an upgrade
 * would buy. What goes away is the ability to configure something that will not
 * run.
 *
 * NOT a licence check. Entitlement here is "is the enterprise layer installed"
 * — the capability the API advertises. ADR-0014's signed licence is unbuilt and
 * deliberately out of scope; this screen reports what the deployment can
 * actually do, which is true either way.
 */
export function DirectoryUnavailable() {
  return (
    <Card>
      <CardContent className="space-y-4 px-6 py-8">
        <div className="flex items-start gap-3">
          <span className="rounded-full border border-line-soft bg-panel-raised p-2.5">
            <Building2 className="size-5 text-ink-faint" aria-hidden />
          </span>
          <div className="min-w-0 space-y-1">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="text-sm font-semibold text-ink">Directory integration</h2>
              <Badge>Enterprise</Badge>
            </div>
            <p className="max-w-prose text-xs text-ink-muted">
              {'Connect LDAP or Active Directory so people sign in with the accounts they '}
              {'already have, and get their role from the groups they are already in. '}
              {'Available in NexusPuppet Enterprise.'}
            </p>
          </div>
        </div>

        <ul className="space-y-1.5 pl-11">
          {[
            'Sign in with existing directory accounts — no second password to issue or reset',
            'Roles resolved from group membership at every sign-in, so leavers lose access with their directory account',
            'Test the connection before saving it, rather than finding out at somebody’s login',
          ].map((line) => (
            <li key={line} className="flex gap-2 text-[11px] text-ink-muted">
              <Check className="mt-px size-3.5 shrink-0 text-state-unchanged" aria-hidden />
              <span className="max-w-prose">{line}</span>
            </li>
          ))}
        </ul>

        <div className="flex flex-wrap items-center gap-3 pl-11">
          <a
            href={LEARN_MORE}
            target="_blank"
            rel="noreferrer"
            className="inline-flex h-7 items-center gap-1 rounded bg-accent px-2 text-xs font-medium text-white transition-colors hover:bg-accent/85"
          >
            How to enable it
            <ArrowUpRight className="size-3.5" aria-hidden />
          </a>
          <span className="text-[11px] text-ink-faint">
            Local accounts keep working, in every edition.
          </span>
        </div>
      </CardContent>
    </Card>
  );
}
