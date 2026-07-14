import { z } from 'zod';

/** Canonical lowercase SHA-256 identity used for packaged runtime artifacts. */
export const Sha256ChecksumSchema = z
  .string()
  .regex(/^sha256:[0-9a-f]{64}$/);
export type Sha256Checksum = z.infer<typeof Sha256ChecksumSchema>;
