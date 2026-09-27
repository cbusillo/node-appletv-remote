import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { scan } from '../discovery.js';

const mock = vi.hoisted(() => ({ callbacks: new Map<string, (service: Record<string, unknown>) => void>(), stopped: vi.fn(), destroyed: vi.fn() }));
vi.mock('bonjour-service', () => ({
  Bonjour: class {
    find(options: { type: string }, callback: (service: Record<string, unknown>) => void) {
      mock.callbacks.set(options.type, callback);
      return { stop: mock.stopped };
    }
    destroy() { mock.destroyed(); }
  },
}));

beforeEach(() => { vi.useFakeTimers(); mock.callbacks.clear(); vi.clearAllMocks(); });
afterEach(() => vi.useRealTimers());

describe('mDNS service ordering', () => {
  it('does not start discovery when already cancelled', async () => {
    await expect(scan({ signal: AbortSignal.abort() })).rejects.toThrow();
    expect(mock.callbacks.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('cancels both browsers and the deadline without returning partial discovery', async () => {
    const controller = new AbortController();
    const pending = scan({ timeout: 5000, signal: controller.signal });
    const rejected = expect(pending).rejects.toThrow();
    controller.abort();
    await rejected;
    expect(mock.stopped).toHaveBeenCalledTimes(2);
    expect(mock.destroyed).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  for (const order of [['airplay', 'companion-link'], ['companion-link', 'airplay']]) {
    it(`finds the Companion port when ${order[0]} arrives first`, async () => {
      const services: Record<string, Record<string, unknown>> = {
        airplay: { name: 'Synthetic TV', addresses: ['192.0.2.10'], port: 7000, txt: { deviceid: 'synthetic-tv', model: 'AppleTV6,2' } },
        'companion-link': { addresses: ['192.0.2.10'], port: 49153 },
      };
      const pending = scan({ timeout: 10 });
      for (const service of order) mock.callbacks.get(service)!(services[service]);
      await vi.advanceTimersByTimeAsync(10);
      const devices = await pending;
      expect(devices).toHaveLength(1);
      expect(devices[0].companionPort).toBe(services['companion-link'].port);
      expect(mock.stopped).toHaveBeenCalledTimes(2);
      expect(mock.destroyed).toHaveBeenCalledOnce();
    });
  }
});
