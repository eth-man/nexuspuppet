import {
  ArgumentsHost,
  Catch,
  type ExceptionFilter,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import type { Response } from 'express';
import { SettingsStoreError } from './settings.store';

/**
 * Turn a settings-store refusal into an answer the operator can act on.
 *
 * SettingsStoreError is thrown for preconditions a person can FIX — no
 * CONFIG_ENCRYPTION_KEY, a key that does not decrypt what is stored. Its
 * messages already name the command to run. Unhandled, Nest renders them as a
 * bare 500 "Internal server error", the console shows that, and the sentence
 * explaining the fix never reaches the person who needed it. Found on a real
 * deployment, saving directory settings on a host with no encryption key.
 *
 * 503 rather than 500: the deployment is not broken, it is not configured for
 * this yet, and the request will succeed once it is.
 */
@Catch(SettingsStoreError)
export class SettingsErrorFilter implements ExceptionFilter {
  private readonly logger = new Logger(SettingsErrorFilter.name);

  catch(error: SettingsStoreError, host: ArgumentsHost): void {
    this.logger.error(error.message);

    const response = host.switchToHttp().getResponse<Response>();
    const body = new ServiceUnavailableException({
      error: 'SETTINGS_NOT_CONFIGURED',
      message: error.message,
    }).getResponse();

    response.status(503).json(body);
  }
}
