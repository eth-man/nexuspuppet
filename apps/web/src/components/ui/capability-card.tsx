import { Badge } from '@/components/ui/badge';
import { Card, CardDescription, CardHeader, CardHeading, CardTitle } from '@/components/ui/card';
import { useCapabilities } from '@/lib/queries';

/**
 * A feature this deployment does not have, rendered as a header and nothing else.
 *
 * The settings screens used to render the full form in core with every input
 * disabled — the reasoning being that an open-core operator should be able to
 * see what the enterprise layer offers. In practice a screen of greyed-out
 * fields that can never be filled is mostly noise, and it pushed the settings
 * an operator CAN use below the fold.
 *
 * So the feature is still named, still explains itself, and still says which
 * capability unlocks it — the discoverability that justified showing the form
 * is carried by the header, which is the part anyone actually read. What is
 * gone is the inert form beneath it.
 *
 * NOT A SECURITY CONTROL, and nothing here should ever become one. The API
 * refuses these operations with a 501 naming the capability whether or not the
 * UI draws a field (CLAUDE.md: `can()` in the UI hides what a user cannot use,
 * and is never a security control). This decides what is worth drawing.
 */
export function CapabilityCard({
  title,
  description,
  capability,
  note,
}: {
  title: string;
  description: string;
  /**
   * The capability token, shown verbatim.
   *
   * "Enterprise" answers *why not*; the capability name answers *which line on
   * the licence* — and it is the same string the API's 501 carries, so an
   * operator reading a log and an operator reading this screen are looking at
   * the same identifier.
   */
  capability: string;
  /** What still happens without it. Absence of a feature is not absence of behaviour. */
  note?: string;
}) {
  /*
   * "Enterprise" is only an answer in CORE.
   *
   * On a deployment already running the enterprise layer, a padlock reading
   * "Enterprise" tells an operator to buy what they have bought. That is how
   * this read on staging: edition enterprise, OIDC locked — and the reason had
   * nothing to do with licensing. The layer advertises exactly one directory
   * capability, `directory.ldap` OR `sso.oidc`, because it refuses to run both
   * (ADR-0015). LDAP was configured, so OIDC could never appear.
   *
   * So this deliberately does NOT explain the absence: from here, a licence
   * that excludes a capability, a build without it, and a deployment that
   * chose the other option are indistinguishable. Guessing produced a
   * confidently wrong sentence once already. The caller knows its own domain
   * and says why in `note`; this only stops claiming it is about the edition.
   */
  const capabilities = useCapabilities();
  const onEnterprise = capabilities.data?.edition === 'enterprise';

  return (
    <Card>
      <CardHeader>
        <CardHeading>
          <CardTitle>{title}</CardTitle>
          <CardDescription>{description}</CardDescription>
        </CardHeading>
        <div className="flex shrink-0 items-center gap-2">
          <Badge className="border-line/60 text-ink-faint">
            {/*
              The padlock is decorative and only appears where the label means
              "locked to you". On enterprise it is not locked to anybody — the
              capability simply is not there — so the badge drops it and says
              so instead.
            */}
            {!onEnterprise && (
              <svg
                aria-hidden="true"
                viewBox="0 0 24 24"
                className="size-3"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.5"
              >
                <rect x="4" y="10" width="16" height="10" rx="2" />
                <path d="M8 10V7a4 4 0 0 1 8 0v3" />
              </svg>
            )}
            {onEnterprise ? 'Unavailable' : 'Enterprise'}
          </Badge>
        </div>
      </CardHeader>

      <div className="border-t border-line px-3 py-2">
        <p className="text-2xs text-ink-faint">
          Requires the <span className="font-mono">{capability}</span> capability, which this
          deployment does not advertise.
          {note !== undefined && <> {note}</>}
        </p>
      </div>
    </Card>
  );
}
