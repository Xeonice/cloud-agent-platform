export class RuntimeModelEnvironmentResolutionError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

/** Safe internal marker for expected operational catalog unavailability. */
export class RuntimeModelCatalogOperationalError extends Error {
  constructor() {
    super('Runtime model catalog operation is unavailable.');
    this.name = new.target.name;
  }
}
