import {
  Catch,
  HttpStatus,
  Logger,
  type ArgumentsHost,
  type ExceptionFilter,
} from '@nestjs/common';
import { PuppetDbUnavailableError } from '@nexuspuppet/contracts';
import type { Response } from 'express';

/**
 * Turns a PuppetDB outage into an explicit, machine-readable state (ADR-0004 §6).
 *
 * Not a generic 500, and emphatically not an empty result set. An empty
 * inventory table is indistinguishable from "your estate has no nodes", which
 * is the single most alarming thing this console could tell an operator
 * incorrectly. The response carries the last successful contact time so the UI
 * can say how stale things are, and states plainly that classification is
 * unaffected — because under ADR-0003 it genuinely is.
 */
@Catch(PuppetDbUnavailableError)
export class PuppetDbExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(PuppetDbExceptionFilter.name);

  catch(exception: PuppetDbUnavailableError, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<Response>();

    this.logger.warn(`PuppetDB unavailable: ${exception.message}`);

    response.status(HttpStatus.SERVICE_UNAVAILABLE).json({
      error: 'PUPPETDB_UNAVAILABLE',
      message: exception.message,
      lastSuccessAt: exception.lastSuccessAt,
      upstreamStatus: exception.statusCode ?? null,
      // The UI renders this verbatim: the reassurance is accurate, not spin.
      classificationUnaffected: true,
    });
  }
}
