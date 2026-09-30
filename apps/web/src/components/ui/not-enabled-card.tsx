import { Badge } from '@/components/ui/badge';
import { Card, CardDescription, CardHeader, CardHeading, CardTitle } from '@/components/ui/card';

/**
 * An integration this deployment has not enabled, rendered as a header and a
 * sentence saying how to enable it.
 *
 * Only for integrations that need something outside the console first — a
 * directory provider is registered at boot from the environment, so until
 * LDAP_URL or OIDC_ISSUER is set there is no provider for a form to configure,
 * and a screen of inputs that cannot take effect is noise that pushes the
 * settings an operator CAN use below the fold.
 *
 * This replaced a card that named a licensed "capability" and read
 * "Enterprise" (ADR-0027). Nothing is licensed any more; what is missing is
 * configuration, and the note says which.
 *
 * NOT A SECURITY CONTROL. It decides what is worth drawing, nothing else.
 */
export function NotEnabledCard({
  title,
  description,
  note,
}: {
  title: string;
  description: string;
  /** How to enable it, and what keeps working meanwhile. */
  note: string;
}) {
  return (
    <Card>
      <CardHeader>
        <CardHeading>
          <CardTitle>{title}</CardTitle>
          <CardDescription>{description}</CardDescription>
        </CardHeading>
        <div className="flex shrink-0 items-center gap-2">
          <Badge className="border-line/60 text-ink-faint">Not enabled</Badge>
        </div>
      </CardHeader>

      <div className="border-t border-line px-3 py-2">
        <p className="text-2xs text-ink-faint">{note}</p>
      </div>
    </Card>
  );
}
