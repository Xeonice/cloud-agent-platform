export interface RuntimeModelCatalogCacheOptions {
  readonly ttlMs: number;
  readonly maxEntries: number;
  readonly maxInFlight: number;
  readonly maxInFlightPerOwner: number;
  readonly now?: () => number;
}

interface CacheEntry<T> {
  readonly value: T;
  readonly expiresAt: number;
}

export class RuntimeModelCatalogCacheCapacityError extends Error {
  constructor() {
    super('Runtime model catalog cache is at its in-flight capacity.');
    this.name = new.target.name;
  }
}

/** Successful-only bounded TTL/LRU cache with same-key in-flight coalescing. */
export class RuntimeModelCatalogCache<T> {
  private readonly entries = new Map<string, CacheEntry<T>>();
  private readonly inFlight = new Map<string, Promise<T>>();
  private readonly inFlightByOwner = new Map<string, number>();
  private readonly now: () => number;

  constructor(private readonly options: RuntimeModelCatalogCacheOptions) {
    if (!Number.isFinite(options.ttlMs) || options.ttlMs <= 0) {
      throw new Error('Runtime model catalog cache ttlMs must be positive.');
    }
    if (!Number.isInteger(options.maxEntries) || options.maxEntries < 1) {
      throw new Error('Runtime model catalog cache maxEntries must be positive.');
    }
    if (!Number.isInteger(options.maxInFlight) || options.maxInFlight < 1) {
      throw new Error('Runtime model catalog cache maxInFlight must be positive.');
    }
    if (
      !Number.isInteger(options.maxInFlightPerOwner) ||
      options.maxInFlightPerOwner < 1 ||
      options.maxInFlightPerOwner > options.maxInFlight ||
      (options.maxInFlight > 1 &&
        options.maxInFlightPerOwner >= options.maxInFlight)
    ) {
      throw new Error(
        'Runtime model catalog cache maxInFlightPerOwner must preserve cross-owner capacity.',
      );
    }
    this.now = options.now ?? Date.now;
  }

  async getOrLoad(
    key: string,
    ownerUserId: string,
    loader: () => Promise<T>,
  ): Promise<T> {
    const cached = this.entries.get(key);
    if (cached && cached.expiresAt > this.now()) {
      this.entries.delete(key);
      this.entries.set(key, cached);
      return cached.value;
    }
    if (cached) this.entries.delete(key);

    const pending = this.inFlight.get(key);
    if (pending) return pending;
    const ownerInFlight = this.inFlightByOwner.get(ownerUserId) ?? 0;
    if (ownerInFlight >= this.options.maxInFlightPerOwner) {
      throw new RuntimeModelCatalogCacheCapacityError();
    }
    if (this.inFlight.size >= this.options.maxInFlight) {
      throw new RuntimeModelCatalogCacheCapacityError();
    }

    const created = loader()
      .then((value) => {
        this.store(key, value);
        return value;
      })
      .finally(() => {
        this.inFlight.delete(key);
        const remaining = (this.inFlightByOwner.get(ownerUserId) ?? 1) - 1;
        if (remaining > 0) this.inFlightByOwner.set(ownerUserId, remaining);
        else this.inFlightByOwner.delete(ownerUserId);
      });
    this.inFlight.set(key, created);
    this.inFlightByOwner.set(ownerUserId, ownerInFlight + 1);
    return created;
  }

  clear(): void {
    this.entries.clear();
  }

  private store(key: string, value: T): void {
    this.removeExpired();
    this.entries.delete(key);
    while (this.entries.size >= this.options.maxEntries) {
      const oldest = this.entries.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
    this.entries.set(key, {
      value,
      expiresAt: this.now() + this.options.ttlMs,
    });
  }

  private removeExpired(): void {
    const now = this.now();
    for (const [key, entry] of this.entries) {
      if (entry.expiresAt <= now) this.entries.delete(key);
    }
  }
}
