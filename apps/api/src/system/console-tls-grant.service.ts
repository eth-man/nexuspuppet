import { Inject, Injectable, ServiceUnavailableException } from '@nestjs/common';
import { AUDIT_SINK, type IAuditSink } from '@nexuspuppet/contracts';
import { mintGrant } from '@nexuspuppet/tls-grant';
import type { AuthenticatedRequest } from '../auth/auth.guard';

/**
 * Authorise a certificate installation, without touching one.
 *
 * The API's ENTIRE role in this flow (ADR-0017): check the permission, record
 * that someone asked, and hand back a short-lived signed grant. The certificate
 * and its private key go from the browser to the cert-helper service and never
 * enter this process — not its heap, not its logs, not a crash dump.
 *
 * That is what keeps ADR-0013 §2 literally true rather than approximately: "no
 * private key is ever sent to the API". A design where the API forwarded the
 * upload would read the same in a diagram and be false in a core dump.
 */
@Injectable()
export class ConsoleTlsGrantService {
  constructor(
    @Inject(AUDIT_SINK) private readonly audit: IAuditSink,
    private readonly secret: string | undefined,
  ) {}

  /** Whether this deployment can offer certificate installation at all. */
  get available(): boolean {
    return this.secret !== undefined;
  }

  async authorize(
    request: AuthenticatedRequest,
  ): Promise<{ grant: string; expiresInSeconds: number }> {
    if (this.secret === undefined) {
      throw new ServiceUnavailableException(
        'This deployment cannot install certificates from the console: CERT_HELPER_SECRET is ' +
          'not set and the cert-helper service is not running. TLS is terminated elsewhere, or ' +
          'the tls profile is not enabled.',
      );
    }

    const actor = request.principal;
    const now = new Date();

    /*
     * Audited HERE, before anything happens.
     *
     * The intent is the auditable event: an administrator asked to replace the
     * certificate this console is served with. Whether it then succeeded, was
     * rolled back, or was never confirmed is recorded separately — but an
     * attempt that failed at the helper must still leave a trace in the place
     * an auditor looks, and this process is the only one holding the session
     * that identifies who made it.
     */
    await this.audit.record({
      actorUserId: actor?.userId ?? null,
      actorEmail: actor?.email ?? null,
      action: 'system.tls.install.authorize',
      entityType: 'ConsoleCertificate',
      entityId: 'console',
      before: null,
      after: null,
      ipAddress: request.ip ?? null,
      userAgent: headerOf(request, 'user-agent'),
    });

    return {
      grant: mintGrant(this.secret, now, actor?.email),
      expiresInSeconds: 300,
    };
  }
}

function headerOf(request: AuthenticatedRequest, name: string): string | null {
  const value = request.headers[name];
  return typeof value === 'string' ? value : null;
}
