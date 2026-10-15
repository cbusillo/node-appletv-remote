/**
 * Correlated request/reply waits for AirPlayConnection: each wait has a key (an RTSP CSeq,
 * an MRP identifier, a socket operation), a timeout, and is settled exactly once.
 */

/** Settlers for one pending wait. */
type Pending = { resolve(value: unknown): void; reject(error: Error): void };

/** Pending waits keyed by what will answer them. A timeout also calls `onTimeout`, which ends the connection. */
export class PendingRequests {
  private entries = new Map<string, Pending>();

  constructor(private onTimeout: (error: Error) => void, private label = 'AirPlay') {}

  /**
   * Wait for the reply to `key`. The timer and entry are removed as soon as it settles.
   * @throws (rejects) after `timeoutMs`, and then calls `onTimeout`.
   * @throws synchronously if a wait for `key` is already pending.
   */
  create<T>(key: string, timeoutMs: number): Promise<T> {
    if (this.entries.has(key)) throw new Error(`An equivalent ${this.label} request is already pending`);
    return new Promise<T>((resolve, reject) => {
      const finish = () => { clearTimeout(timer); this.entries.delete(key); };
      const timer = setTimeout(() => {
        const error = new Error(`${this.label} request timed out`);
        this.reject(key, error);
        this.onTimeout(error);
      }, timeoutMs);
      this.entries.set(key, {
        resolve: value => { finish(); resolve(value as T); },
        reject: error => { finish(); reject(error); },
      });
    });
  }

  /** True while a wait for `key` is pending. */
  has(key: string): boolean { return this.entries.has(key); }

  /** Resolve the wait for `key`, if any. */
  resolve(key: string, value: unknown): void { this.entries.get(key)?.resolve(value); }

  /** Reject the wait for `key`, if any. */
  reject(key: string, error: Error): void { this.entries.get(key)?.reject(error); }

  /** Reject every pending wait with `error`. */
  rejectAll(error: Error): void {
    for (const entry of this.entries.values()) entry.reject(error);
  }
}
