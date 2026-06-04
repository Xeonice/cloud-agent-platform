import { BadRequestException, type ArgumentMetadata, type PipeTransform } from '@nestjs/common';
import type { ZodSchema } from 'zod';

/**
 * NestJS pipe that validates an incoming value against a zod schema and returns
 * the parsed (and narrowed) value. On failure it throws a `BadRequestException`,
 * which NestJS renders as HTTP 400 — satisfying the "invalid body is rejected
 * with 400 and nothing is created" contract for the REST endpoints.
 */
export class ZodValidationPipe<T> implements PipeTransform<unknown, T> {
  constructor(private readonly schema: ZodSchema<T>) {}

  transform(value: unknown, metadata: ArgumentMetadata): T {
    // Validate the request BODY only. Method-scoped `@UsePipes` runs the pipe on
    // EVERY argument (including `@Param`/`@Query`), so without this guard a body
    // schema is wrongly applied to path params like `:repoId`, failing with
    // "Expected object, received string". Non-body args pass through untouched.
    if (metadata.type !== 'body') {
      return value as T;
    }
    const result = this.schema.safeParse(value);
    if (!result.success) {
      throw new BadRequestException({
        message: 'Validation failed',
        issues: result.error.issues,
      });
    }
    return result.data;
  }
}
