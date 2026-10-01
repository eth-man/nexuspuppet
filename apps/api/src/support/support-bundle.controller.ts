import { Controller, Get, Header, Logger, Query, Req, Res } from '@nestjs/common';
import type { Response } from 'express';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createGzip } from 'node:zlib';
import { supportBundleQuerySchema, type SupportBundleQuery } from '@nexuspuppet/contracts';
import { RequirePermission, type AuthenticatedRequest } from '../auth/auth.guard';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { tarChunks } from '../replication/ustar';
import { SupportBundleService } from './support-bundle.service';

/**
 * `GET /system/support-bundle?hours=24` — one archive to send to support
 * (ADR-0028).
 *
 * `settings:manage`, like the log level: the bundle carries this deployment's
 * configuration, its operational history and its own logs. None of it is a
 * secret — the bundle is built to exclude those — but all of it is
 * infrastructure detail that belongs to whoever administers the deployment.
 *
 * GET, and a plain link in the console, because a download is a navigation:
 * the browser owns the filename and the save dialog, and nothing holds the
 * archive in page memory. It does write an audit row, which a GET normally
 * should not — but the row records a READ, the same kind ADR-0025 audits for
 * resource parameters, and `no-store` keeps every intermediary from replaying
 * it silently.
 */
@Controller('system')
export class SupportBundleController {
  private readonly logger = new Logger(SupportBundleController.name);

  constructor(private readonly bundles: SupportBundleService) {}

  @RequirePermission('settings:manage')
  @Get('support-bundle')
  @Header('cache-control', 'no-store')
  async download(
    @Query(new ZodValidationPipe(supportBundleQuerySchema)) query: SupportBundleQuery,
    @Req() request: AuthenticatedRequest,
    @Res() response: Response,
  ): Promise<void> {
    // Assembled BEFORE the first byte is sent, so a failure here is an
    // ordinary error response rather than a truncated archive with a 200.
    const bundle = await this.bundles.build(query.hours, query.includePersonalData, request);

    /*
     * `application/gzip` as the TYPE, never `Content-Encoding: gzip`.
     *
     * The console reaches this through the web tier's relay, whose fetch
     * transparently decodes a content-encoded body and strips the header — the
     * browser would then save an uncompressed tar under a .tar.gz name.
     */
    response.setHeader('content-type', 'application/gzip');
    response.setHeader('content-disposition', `attachment; filename="${bundle.fileName}"`);

    const chunks = tarChunks(bundle.entries, {
      mtime: Math.floor(Date.parse(bundle.generatedAt) / 1000),
    });

    try {
      await pipeline(Readable.from(chunks), createGzip(), response);
    } catch (error) {
      // Almost always the browser going away mid-download. Nothing to answer.
      this.logger.debug(
        `Support bundle stream ended early: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}
