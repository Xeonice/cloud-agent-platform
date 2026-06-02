import { BadRequestException, type PipeTransform } from '@nestjs/common';
import type { ZodSchema } from 'zod';

/**
 * NestJS pipe that validates an incoming value against a zod schema and returns
 * the parsed (and narrowed) value. On failure it throws a `BadRequestException`,
 * which NestJS renders as HTTP 400 — satisfying the "invalid body is rejected
 * with 400 and nothing is created" contract for the REST endpoints.
 */
export class ZodValidationPipe<T> implements PipeTransform<unknown, T> {
  constructor(private readonly schema: ZodSchema<T>) {}

  transform(value: unknown): T {
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
