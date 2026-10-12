import { describe, expect, it } from 'vitest';
import { CompanionConnection } from '../connection.js';
import { CompanionSession } from '../companion-session.js';
import { FrameType } from '../framing.js';
import { opackDecode, opackEncode, type OpackDict, type OpackValue } from '../opack.js';

function fixture() {
  const key = Buffer.alloc(32, 7);
  const connection = new CompanionConnection('unused.invalid', 1, {
    clientId: 'synthetic', serverId: 'synthetic', clientLTSK: key, clientLTPK: key, serverLTPK: key,
  });
  const parser = connection as unknown as {
    session: CompanionSession;
    socket: { write(data: Buffer): void; destroy(): void };
    onData(data: Buffer): void;
  };
  parser.session = new CompanionSession(key, key);
  const peer = new CompanionSession(key, key);
  const requests: OpackDict[] = [];
  parser.socket = {
    write(data): void { requests.push(opackDecode(peer.decrypt(data.subarray(0, 4), data.subarray(4))) as OpackDict); },
    destroy(): void {},
  };
  const receive = (body: OpackDict): void => parser.onData(peer.encrypt(FrameType.E_OPACK, opackEncode(body)));
  return { connection, requests, receive };
}

describe('Companion request and event correlation', () => {
  it('keeps request IDs in 1..127 so a signed one-byte echo still matches', async () => {
    const { connection, requests, receive } = fixture();
    try {
      for (let n = 0; n < 300; n++) {
        const pending = connection.sendRequest('_ping', new Map<OpackValue, OpackValue>([['_t', 2], ['_c', new Map()]]));
        const id = requests.at(-1)!.get('_x') as number;
        expect(id).toBeGreaterThanOrEqual(1);
        expect(id).toBeLessThanOrEqual(127);
        receive(new Map<OpackValue, OpackValue>([['_x', id], ['_t', 3], ['_c', new Map()]]));
        await pending;
      }
      expect(requests.map((r) => r.get('_x')).slice(125, 129)).toEqual([126, 127, 1, 2]);
    } finally {
      connection.close();
    }
  });

  it('skips a request ID that is still awaiting its reply', async () => {
    const { connection, requests, receive } = fixture();
    try {
      const held = connection.sendRequest('_held', new Map<OpackValue, OpackValue>([['_t', 2], ['_c', new Map()]]));
      held.catch(() => {});
      expect(requests[0].get('_x')).toBe(1);
      for (let n = 0; n < 127; n++) {
        const pending = connection.sendRequest('_ping', new Map<OpackValue, OpackValue>([['_t', 2], ['_c', new Map()]]));
        receive(new Map<OpackValue, OpackValue>([['_x', requests.at(-1)!.get('_x')!], ['_t', 3], ['_c', new Map()]]));
        await pending;
      }
      expect(requests.at(-1)!.get('_x')).toBe(2);
    } finally {
      connection.close();
    }
  });

  it('delivers an event with a colliding ID without resolving the pending request', async () => {
    const { connection, requests, receive } = fixture();
    const events: unknown[] = [];
    connection.on('event', (event) => events.push(event));
    try {
      const pending = connection.sendRequest('_mcc', new Map<OpackValue, OpackValue>([['_t', 2], ['_c', new Map()]]));
      const id = requests[0].get('_x');
      receive(new Map<OpackValue, OpackValue>([['_x', id!], ['_t', 1], ['_i', '_iMC'], ['_c', new Map([['_mcF', 256]])]]));
      receive(new Map<OpackValue, OpackValue>([['_x', id!], ['_t', 3], ['_c', new Map([['_vol', 0.25]])]]));
      const reply = await pending;
      expect(reply.get('_t')).toBe(3);
      expect((reply.get('_c') as OpackDict).get('_vol')).toBe(0.25);
      expect(events).toHaveLength(1);
    } finally { connection.close(); }
  });

  it('numbers public event messages and subsequent requests independently', async () => {
    const { connection, requests, receive } = fixture();
    try {
      connection.sendMessage('_interest', new Map<OpackValue, OpackValue>([['_t', 1], ['_c', new Map()]]));
      const first = requests[0].get('_x');
      expect(first).toBeGreaterThan(0);
      const pending = connection.sendRequest('_systemInfo', new Map<OpackValue, OpackValue>([['_t', 2], ['_c', new Map()]]));
      const second = requests[1].get('_x');
      expect(second).not.toBe(first);
      receive(new Map<OpackValue, OpackValue>([['_x', second!], ['_t', 3], ['_c', new Map()]]));
      await pending;
    } finally { connection.close(); }
  });
});
