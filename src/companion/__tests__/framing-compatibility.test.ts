import { describe, expect, it } from 'vitest';
import { CompanionSession } from '../companion-session.js';
import { CompanionConnection } from '../connection.js';
import { FrameType } from '../framing.js';
import { opackDecode, opackEncode, type OpackDict, type OpackValue } from '../opack.js';

// pyatv 0.18.0 Chacha20Cipher(nonce_length=12), bytes(range(32)), counters 0 and 1.
// Public synthetic keys and payloads; no pairing or live device data.
const key = Buffer.from(Array.from({ length: 32 }, (_, i) => i));
const payload = Buffer.from('e3425f7409425f694c53797374656d537461747573425f63e14573746174650b', 'hex');
const frames = [
  '08000030fbfa1d45a4a4f9b85f322512db2623748cd0878092ef043f0dbd8f664b4110571c4015ebed81b6c162b40204067f16f7',
  '08000030777d249acda1c3433b08aa80195ab00855d984ad5ebb865e7405842d76d574c49e0fde4f7f681f246d79893979ca6ee5',
].map(hex => Buffer.from(hex, 'hex'));

function receiver() {
  const connection = new CompanionConnection('unused.invalid', 1, {
    clientId: 'test', clientLTSK: key, clientLTPK: key,
    serverLTPK: key, serverId: 'test',
  });
  // Enter the post-authentication parser without opening a socket.
  const parser = connection as unknown as {
    session: CompanionSession;
    socket: { write(data: Buffer): void; destroy(): void };
    onData(data: Buffer): void;
  };
  parser.session = new CompanionSession(key, key);
  const states: unknown[] = [];
  const errors: Error[] = [];
  connection.on('event', ({ data }: { data: OpackDict }) =>
    states.push((data.get('_c') as OpackDict).get('state')));
  connection.on('error', error => errors.push(error));
  return { connection, parser, states, errors };
}

describe('Companion encrypted framing compatibility', () => {
  it('uses nonzero transaction IDs and correlates successive public requests', async () => {
    const { connection, parser, errors } = receiver();
    const peer = new CompanionSession(key, key);
    const ids: number[] = [];
    parser.socket = {
      write(frame: Buffer): void {
        const request = opackDecode(peer.decrypt(frame.subarray(0, 4), frame.subarray(4))) as OpackDict;
        const id = request.get('_x') as number;
        // Observed TV behavior: transaction zero is never acknowledged.
        expect(id).toBeGreaterThan(0);
        expect(ids).not.toContain(id);
        ids.push(id);
        const reply = new Map<OpackValue, OpackValue>([['_x', id], ['_t', 3], ['_c', new Map()]]);
        queueMicrotask(() => parser.onData(peer.encrypt(FrameType.E_OPACK, opackEncode(reply))));
      },
      destroy(): void {},
    };
    try {
      for (const identifier of ['_systemInfo', '_sessionStart']) {
        const reply = await connection.sendRequest(identifier, new Map<OpackValue, OpackValue>([
          ['_t', 2], ['_c', new Map()],
        ]));
        expect(reply.get('_t')).toBe(3);
      }
      expect(ids).toHaveLength(2);
      expect(errors).toEqual([]);
    } finally {
      connection.close();
    }
  });

  it('matches an independently encrypted packet including the tag in its header', () => {
    const sender = new CompanionSession(key, key);
    expect(sender.encrypt(FrameType.E_OPACK, payload)).toEqual(frames[0]);
  });

  it('accepts a single complete real-format packet without waiting for extra bytes', () => {
    const { parser, states, errors } = receiver();
    parser.onData(frames[0]);
    expect(errors).toEqual([]);
    expect(states).toEqual([3]);
  });

  it('uses the Companion 96-bit little-endian nonce after the first packet', () => {
    const sender = new CompanionSession(key, key);
    sender.encrypt(FrameType.E_OPACK, payload);
    const second = Buffer.from(payload);
    second[second.length - 1] = 0x09; // State 1, rather than state 3.
    expect(sender.encrypt(FrameType.E_OPACK, second)).toEqual(frames[1]);
  });

  it('separates coalesced packets and preserves the receive counter', () => {
    const { parser, states, errors } = receiver();
    parser.onData(Buffer.concat(frames));
    expect(errors).toEqual([]);
    expect(states).toEqual([3, 1]);
  });

  it('waits for every possible split point in an encrypted packet', () => {
    for (let split = 1; split < frames[0].length; split++) {
      const { parser, states, errors } = receiver();
      parser.onData(frames[0].subarray(0, split));
      expect(states).toEqual([]);
      parser.onData(frames[0].subarray(split));
      expect(errors).toEqual([]);
      expect(states).toEqual([3]);
    }
  });
});
