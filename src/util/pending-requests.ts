type Pending = { resolve(value: unknown): void; reject(error: Error): void };

/** Correlated waits with exact cleanup and a shared connection shutdown boundary. */
export class PendingRequests {
  private entries = new Map<string, Pending>();

  constructor(private onTimeout: (error: Error) => void, private label = 'AirPlay') {}

  /**
   * Wait for one correlated reply. By default a timeout also shuts the connection down;
   * pass `fatalTimeout: false` when a missing reply is expected and only this wait should fail.
   */
  create<T>(key: string, timeoutMs: number, options: { fatalTimeout?: boolean } = {}): Promise<T> {
    if (this.entries.has(key)) throw new Error(`An equivalent ${this.label} request is already pending`);
    return new Promise<T>((resolve, reject) => {
      const finish = () => { clearTimeout(timer); this.entries.delete(key); };
      const timer = setTimeout(() => {
        const error = new Error(`${this.label} request timed out`);
        this.reject(key, error);
        if (options.fatalTimeout !== false) this.onTimeout(error);
      }, timeoutMs);
      this.entries.set(key, {
        resolve: value => { finish(); resolve(value as T); },
        reject: error => { finish(); reject(error); },
      });
    });
  }

  has(key: string): boolean { return this.entries.has(key); }

  resolve(key: string, value: unknown): void { this.entries.get(key)?.resolve(value); }

  reject(key: string, error: Error): void { this.entries.get(key)?.reject(error); }

  rejectAll(error: Error): void {
    for (const entry of this.entries.values()) entry.reject(error);
  }
}
