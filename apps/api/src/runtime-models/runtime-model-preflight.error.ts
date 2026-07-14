import type { RuntimeModelError } from '@cap/contracts';

/** Transport-neutral, already-redacted model-preflight failure. */
export class RuntimeModelPreflightError extends Error {
  constructor(readonly domainError: RuntimeModelError) {
    super(domainError.message);
    this.name = new.target.name;
  }
}
