import { BadRequestException, type ArgumentMetadata, type PipeTransform } from '@nestjs/common';
import type { ZodSchema } from 'zod';

type ZodValidationSource = ArgumentMetadata['type'];

/**
 * NestJS pipe that validates an incoming value against a zod schema and returns
 * the parsed (and narrowed) value. On failure it throws a `BadRequestException`,
 * which NestJS renders as HTTP 400 — satisfying the "invalid body is rejected
 * with 400 and nothing is created" contract for the REST endpoints.
 */
export class ZodValidationPipe<T> implements PipeTransform<unknown, T> {
  constructor(
    private readonly schema: ZodSchema<T>,
    private readonly source: ZodValidationSource = 'body',
  ) {}

  transform(value: unknown, metadata: ArgumentMetadata): T {
    // Method-scoped `@UsePipes` runs a pipe on EVERY argument. Match the declared
    // source so a body schema does not accidentally parse a path/query argument,
    // while parameter-scoped query/param pipes still validate their real values.
    if (metadata.type !== this.source) {
      return value as T;
    }
    return parseZodValue(this.schema, value);
  }
}

/** Parameter-scoped query validator using the same error contract as body pipes. */
export function zodQuery<T>(schema: ZodSchema<T>): ZodValidationPipe<T> {
  return new ZodValidationPipe(schema, 'query');
}

/** Parameter-scoped path validator using the same error contract as body pipes. */
export function zodParam<T>(schema: ZodSchema<T>): ZodValidationPipe<T> {
  return new ZodValidationPipe(schema, 'param');
}

/** Parse a non-decorator value, such as an extracted HTTP header, through Zod. */
export function parseZodValue<T>(schema: ZodSchema<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new BadRequestException({
      message: 'Validation failed',
      issues: result.error.issues,
    });
  }
  return result.data;
}
