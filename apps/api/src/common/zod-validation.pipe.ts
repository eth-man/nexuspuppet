import { BadRequestException, Injectable, type PipeTransform } from '@nestjs/common';
import type { ZodType } from 'zod';

/**
 * Validates and coerces request input against a Zod schema from
 * @nexuspuppet/contracts.
 *
 * Using the contracts schemas directly means the API accepts exactly what the
 * shared types promise — there is no second, drifting definition of a filter
 * shape. This is what makes "callers pass typed filters, never raw PQL"
 * enforceable rather than aspirational (ADR-0004).
 */
@Injectable()
export class ZodValidationPipe<T> implements PipeTransform<unknown, T> {
  constructor(private readonly schema: ZodType<T>) {}

  transform(value: unknown): T {
    const result = this.schema.safeParse(value);

    if (!result.success) {
      throw new BadRequestException({
        message: 'Invalid request parameters',
        issues: result.error.issues.map((issue) => ({
          path: issue.path.join('.'),
          message: issue.message,
        })),
      });
    }

    return result.data;
  }
}
