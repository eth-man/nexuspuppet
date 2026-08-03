import { readFile } from 'node:fs/promises';
import { Injectable, Logger } from '@nestjs/common';
import type { ConsoleTlsStatus } from '@nexuspuppet/contracts';
import {
  CertificateParseError,
  coversHostname,
  summariseCertificate,
} from './pure/certificate-summary';

/**
 * What certificate is the console being served with, and when does it expire?
 *
 * PROXY-AGNOSTIC. This reads a file. It does not ask Caddy — or nginx, or an F5
 * — what it loaded, and it must not learn to. Operators replace the bundled
 * proxy with their own corporate one as a matter of course, and a status surface
 * that only worked against the proxy we happen to ship would report "not
 * configured" on a perfectly good deployment. A file path is the one interface
 * every one of those layouts shares.
 *
 * ONLY THE PUBLIC CERTIFICATE. The API is given a single `.pem`, never the
 * directory holding the key (ADR-0013). That is enforced by the mount rather
 * than by this code, which is the point: there is no path from here to key
 * material even if someone later adds a careless field to the response.
 */
@Injectable()
export class ConsoleTlsService {
  private readonly logger = new Logger(ConsoleTlsService.name);

  /**
   * Both injected rather than read from `process.env` here.
   *
   * The projected-facts defect is the precedent: a service that reads its own
   * configuration is a service whose tests can never observe the default, so a
   * feature that silently disables itself when a variable is unset looks correct
   * in every test and is broken in every deployment.
   */
  constructor(
    private readonly certificatePath: string | null,
    private readonly expectedHostname: string | null,
  ) {}

  async status(): Promise<ConsoleTlsStatus> {
    const base = {
      expectedHostname: this.expectedHostname,
      certificate: null,
      coversExpectedHostname: null,
    };

    // Not configured is the NORMAL state for a deployment terminating TLS at its
    // own proxy, which is most of them. It is not an error and must not be
    // rendered as one.
    if (this.certificatePath === null || this.certificatePath === '') {
      return { ...base, configured: false, error: null, errorCode: null };
    }

    let pem: string;
    try {
      pem = await readFile(this.certificatePath, 'utf8');
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      /*
       * TWO audiences, two messages.
       *
       * The log gets the path and the uid — that is what somebody with shell
       * access needs, and the only place they can act on it. The response gets
       * a code and a sentence with no server layout in it, because a filesystem
       * path in a browser tells an end user nothing they can use.
       */
      const forTheLog =
        code === 'ENOENT'
          ? `No certificate at ${this.certificatePath}.`
          : code === 'EACCES'
            ? `The certificate at ${this.certificatePath} is not readable by this process (uid ${process.getuid?.() ?? 'unknown'}).`
            : `Could not read ${this.certificatePath}: ${error instanceof Error ? error.message : String(error)}`;

      const errorCode = code === 'ENOENT' ? ('missing' as const) : ('unreadable' as const);

      this.logger.warn(`Console TLS certificate unavailable. ${forTheLog}`);
      return {
        ...base,
        configured: true,
        errorCode,
        error:
          errorCode === 'missing'
            ? 'No certificate is installed.'
            : 'The installed certificate could not be read.',
      };
    }

    try {
      const certificate = summariseCertificate(pem, new Date());

      return {
        configured: true,
        errorCode: null,
        certificate,
        expectedHostname: this.expectedHostname,
        // Null, not false, when there is nothing to compare against: "we did not
        // check" and "the browser will reject this" are different answers and an
        // operator acts differently on each.
        coversExpectedHostname:
          this.expectedHostname === null || this.expectedHostname === ''
            ? null
            : coversHostname(certificate, this.expectedHostname),
        error: null,
      };
    } catch (error) {
      const forTheLog =
        error instanceof CertificateParseError
          ? error.message
          : `Could not parse ${this.certificatePath}: ${error instanceof Error ? error.message : String(error)}`;

      this.logger.warn(`Console TLS certificate unreadable. ${forTheLog}`);
      return {
        ...base,
        configured: true,
        errorCode: 'unparsable',
        error: 'The installed file is not a readable certificate.',
      };
    }
  }
}
