import { describe, it, expect } from 'vitest';
import { AirPlayConnection } from '../connection.js';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { HAPSession } from '../util/hap-session.js';
import { parseDataStreamFrame } from '../util/data-stream.js';
import { Message } from '../message.js';

describe('AirPlayConnection', () => {
  it('delivers a fragmented encrypted batch without losing or reordering messages', async () => {
    const fixture = JSON.parse(readFileSync(new URL('../mrp/__tests__/metadata-fixtures.json', import.meta.url), 'utf8'));
    const incoming = Buffer.alloc(32, 1);
    const outgoing = Buffer.alloc(32, 2);
    const conn = new AirPlayConnection('127.0.0.1', 1, {
      clientId: 'synthetic', clientLTSK: Buffer.alloc(32), clientLTPK: Buffer.alloc(32),
      serverLTPK: Buffer.alloc(32), serverId: 'synthetic-server',
    });
    // Exercise the actual receive path while replacing only the socket and keys.
    const transport = conn as unknown as {
      dataSession: HAPSession;
      dataSocket: { write(data: Buffer): boolean; destroy(): void };
      onDataChannelData(data: Buffer): void;
    };
    const replies: Buffer[] = [];
    transport.dataSession = new HAPSession(outgoing, incoming);
    transport.dataSocket = { write(data) { replies.push(data); return true; }, destroy() {} };
    const peer = new HAPSession(incoming, outgoing);
    const received: number[] = [];
    conn.on('mrp-message', message => received.push(new Message(message).type));
    const batch = Buffer.from(fixture.batch, 'hex');
    const encrypted = peer.encrypt(Buffer.concat([batch, batch]));
    for (let offset = 0; offset < encrypted.length; offset += 31) {
      transport.onDataChannelData(encrypted.subarray(offset, offset + 31));
    }
    await expect.poll(() => received.length).toBe(24);
    expect(received).toEqual([15, 17, 64, 52, 46, 47, 4, 56, 54, 53, 0, 0,
      15, 17, 64, 52, 46, 47, 4, 56, 54, 53, 0, 0]);
    expect(replies).toHaveLength(2);
    for (const reply of replies) {
      expect(parseDataStreamFrame(peer.decrypt(reply))).toMatchObject({ messageType: 'rply', seqno: 0x123456789n });
    }
    conn.close();
  });

  it('constructs with host, port, and credentials', () => {
    const conn = new AirPlayConnection('192.168.1.100', 7000, {
      clientId: 'test',
      clientLTSK: randomBytes(32),
      clientLTPK: randomBytes(32),
      serverLTPK: randomBytes(32),
      serverId: 'server',
    });
    expect(conn).toBeDefined();
  });

  it('is an EventEmitter', () => {
    const conn = new AirPlayConnection('192.168.1.100', 7000, {
      clientId: 'test',
      clientLTSK: randomBytes(32),
      clientLTPK: randomBytes(32),
      serverLTPK: randomBytes(32),
      serverId: 'server',
    });
    expect(typeof conn.on).toBe('function');
    expect(typeof conn.emit).toBe('function');
  });
});
