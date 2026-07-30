import { z } from 'zod';
import { ZodValidationPipe } from './zod-validation.pipe';

/**
 * A path parameter that must be a UUID.
 *
 * Without this, a malformed id reaches Prisma, Postgres rejects it as an invalid
 * input syntax for uuid, and the operator gets **500 Internal server error** —
 * where a well-formed but absent id correctly answers 404. Found by the QA
 * fuzzer walking to `/classification/not-a-uuid`, which is also what a stale
 * bookmark or a truncated copy-paste looks like.
 *
 * A 400 naming the parameter is the honest answer: the request is malformed, and
 * the caller can see why. It is the same boundary the plan contract already
 * enforces on `groupId`, which is why `POST /classification/plan` never had this
 * problem.
 *
 * ONE SHARED INSTANCE. The pipe holds only its schema and no per-request state,
 * so every route can use the same object.
 */
export const UuidParam = new ZodValidationPipe(
  z.string().uuid('Not a valid identifier — expected a UUID'),
);
