/**
 * Tests for the AirPlay connection lifetime: RTSP replies matched by CSeq, MRP replies by
 * identifier, timeouts, one heartbeat at a time, cancellation, and cleanup on close.
 * Replies are built by hand from the wire format, not with the code under test.
 */
import { createServer, type AddressInfo, type Socket } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { describe, expect, it, vi } from 'vitest';
import { AirPlayConnection } from '../connection.js';
import { AppleTV } from '../appletv.js';
import { Credentials } from '../credentials.js';
import { HAPSession } from '../util/hap-session.js';
import { MRPMessage, MessageType } from '../mrp/messages.js';
import { buildDataStreamFrame } from '../util/data-stream.js';

const credentials = {
  clientId: 'synthetic-client', serverId: 'synthetic-server',
  clientLTSK: Buffer.alloc(32, 1), clientLTPK: Buffer.alloc(32, 2), serverLTPK: Buffer.alloc(32, 3),
};
type Reply = { headers: Record<string, string>; body: Buffer };
type Harness = {
  socket: { write(data: Buffer, callback?: (error?: Error) => void): boolean; destroy(): void };
  dataSocket: Harness['socket'];
  session: HAPSession;
  dataSession: HAPSession;
  onEncryptedData(data: Buffer): void;
  onDataChannelData(data: Buffer): void;
  sendRTSP(method: string, uri: string): Promise<Reply>;
  startFeedbackHeartbeat(): void;
};

function fixture(timeoutMs = 500) {
  const connection = new AirPlayConnection('127.0.0.1', 1, credentials, { timeoutMs, logger: () => {} });
  const transport = connection as unknown as Harness;
  const peer = new HAPSession(Buffer.alloc(32, 4), Buffer.alloc(32, 5));
  const writes: Buffer[] = [];
  let destroyed = 0;
  transport.session = new HAPSession(Buffer.alloc(32, 5), Buffer.alloc(32, 4));
  transport.dataSession = new HAPSession(Buffer.alloc(32, 5), Buffer.alloc(32, 4));
  transport.socket = { write(data, callback) { writes.push(data); callback?.(); return true; }, destroy() { destroyed++; } };
  transport.dataSocket = transport.socket;
  const errors: Error[] = [];
  connection.on('error', error => errors.push(error));
  return { connection, transport, peer, writes, errors, destroyed: () => destroyed };
}

function response(sequence: number, body = '', status = 200): Buffer {
  return Buffer.from(`RTSP/1.0 ${status} Test\r\nCSeq: ${sequence}\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
}

async function outcome<T>(promise: Promise<T>): Promise<{ value?: T; error?: Error; timeout?: true }> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise.then(value => ({ value }), error => ({ error })),
      new Promise<{ timeout: true }>(resolve => { timer = setTimeout(() => resolve({ timeout: true }), 1000); }),
    ]);
  } finally { clearTimeout(timer); }
}

describe('AirPlay response transport', () => {
  it('keeps only one heartbeat pending and clears its timers on close', async () => {
    vi.useFakeTimers();
    const f = fixture(10000);
    try {
      f.transport.startFeedbackHeartbeat();
      await vi.advanceTimersByTimeAsync(4500);
      expect(f.writes).toHaveLength(1);
      f.transport.onEncryptedData(f.peer.encrypt(response(1)));
      await vi.advanceTimersByTimeAsync(2000);
      expect(f.writes).toHaveLength(2);
      f.connection.close();
      await vi.advanceTimersByTimeAsync(0);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      f.connection.close();
      vi.useRealTimers();
    }
  });

  it('keeps decrypted partial replies separate from encrypted TCP fragments', async () => {
    const f = fixture();
    const pending = outcome(f.transport.sendRTSP('POST', '/feedback'));
    const reply = response(1, 'fragmented reply');
    f.transport.onEncryptedData(f.peer.encrypt(reply.subarray(0, 17)));
    const rest = f.peer.encrypt(reply.subarray(17));
    for (let offset = 0; offset < rest.length; offset += 7) f.transport.onEncryptedData(rest.subarray(offset, offset + 7));
    const result = await pending;
    f.connection.close();
    expect(result.value?.body.toString()).toBe('fragmented reply');
    expect(f.errors).toEqual([]);
  });

  it('consumes a complete encrypted frame even when the next one is incomplete', () => {
    const f = fixture();
    const received: Reply[] = [];
    f.connection.on('rtsp-response', reply => received.push(reply));
    const first = f.peer.encrypt(response(10));
    const next = f.peer.encrypt(response(11));
    f.transport.onEncryptedData(Buffer.concat([first, next.subarray(0, 5)]));
    expect(received.map(reply => reply.headers.cseq)).toEqual(['10']);
    f.transport.onEncryptedData(next.subarray(5));
    expect(received.map(reply => reply.headers.cseq)).toEqual(['10', '11']);
    f.connection.close();
  });

  it('correlates coalesced replies in reverse order and ignores unrelated sequences', async () => {
    const f = fixture();
    const first = outcome(f.transport.sendRTSP('SETUP', '/one'));
    const second = outcome(f.transport.sendRTSP('POST', '/two'));
    f.transport.onEncryptedData(f.peer.encrypt(Buffer.concat([response(99, 'unsolicited'), response(2, 'second'), response(1, 'first')])));
    const results = await Promise.all([first, second]);
    f.connection.close();
    expect(results.map(result => result.value?.body.toString())).toEqual(['first', 'second']);
  });

  it('registers a waiter before a synchronous response arrives during write', async () => {
    const f = fixture();
    f.transport.socket.write = (_data, callback) => {
      f.transport.onEncryptedData(f.peer.encrypt(response(1, 'immediate')));
      callback?.();
      return true;
    };
    const result = await outcome(f.transport.sendRTSP('POST', '/feedback'));
    f.connection.close();
    expect(result.value?.body.toString()).toBe('immediate');
  });

  it('rejects non-success status and times out missing responses', async () => {
    const rejected = fixture();
    const pending = outcome(rejected.transport.sendRTSP('SETUP', '/setup'));
    rejected.transport.onEncryptedData(rejected.peer.encrypt(response(1, '', 403)));
    expect((await pending).error?.message).toMatch(/403/);
    rejected.connection.close();
    const timeout = fixture(20);
    expect((await outcome(timeout.transport.sendRTSP('POST', '/feedback'))).error?.message).toMatch(/timed out/i);
    expect(timeout.destroyed()).toBeGreaterThan(0);
    timeout.connection.close();
  });

  it('settles pending response and write work immediately on close', async () => {
    const f = fixture();
    f.transport.socket.write = () => true; // Simulate backpressure with a pending write callback.
    const pending = outcome(f.transport.sendRTSP('POST', '/feedback'));
    f.connection.close();
    expect((await pending).error?.message).toMatch(/closed/i);
  });

  it('matches MRP identifiers without consuming unrelated state pushes', async () => {
    const f = fixture();
    const request = await MRPMessage.sendCommand(MessageType.GetState);
    const decoded = await MRPMessage.decode(request);
    const pending = outcome(f.connection.sendMRPMessageAndWait(request, MessageType.SetState, 100));
    await delay(0);
    const identifier = Buffer.from(decoded.identifier as string);
    // Independent wire encoding: type=4, identifier field=2.
    const reply = Buffer.concat([Buffer.from([8, 4, 18, identifier.length]), identifier]);
    const unsolicited = Buffer.from([8, 4]);
    f.transport.onDataChannelData(f.peer.encrypt(buildDataStreamFrame(unsolicited)));
    f.transport.onDataChannelData(f.peer.encrypt(buildDataStreamFrame(reply)));
    const result = await pending;
    f.connection.close();
    expect(result.value?.identifier).toBe(decoded.identifier);
  });

  it('rejects an MRP protocol error without waiting for the expected type', async () => {
    const f = fixture();
    const request = await MRPMessage.sendCommand(MessageType.GetState);
    const decoded = await MRPMessage.decode(request);
    const pending = outcome(f.connection.sendMRPMessageAndWait(request, MessageType.SetState, 100));
    await delay(0);
    const id = Buffer.from(decoded.identifier as string);
    const reply = Buffer.concat([Buffer.from([18, id.length]), id, Buffer.from([32, 6])]);
    f.transport.onDataChannelData(f.peer.encrypt(buildDataStreamFrame(reply)));
    const result = await pending;
    f.connection.close();
    expect(result.error?.message).toMatch(/MRP.*6/);
  });

  it('keeps simultaneous same-type MRP requests separate', async () => {
    const f = fixture();
    const requests = await Promise.all([MRPMessage.sendCommand(MessageType.GetState), MRPMessage.sendCommand(MessageType.GetState)]);
    const ids = await Promise.all(requests.map(async request => (await MRPMessage.decode(request)).identifier as string));
    const pending = requests.map(request => outcome(f.connection.sendMRPMessageAndWait(request, MessageType.SetState, 500)));
    await delay(0);
    for (const value of [...ids].reverse()) {
      const id = Buffer.from(value);
      f.transport.onDataChannelData(f.peer.encrypt(buildDataStreamFrame(Buffer.concat([Buffer.from([8, 4, 18, id.length]), id]))));
    }
    const results = await Promise.all(pending);
    f.connection.close();
    expect(results.map(result => result.value?.identifier)).toEqual(ids);
  });

  it('rejects MRP work on close and ignores late messages', async () => {
    const f = fixture();
    const request = await MRPMessage.sendCommand(MessageType.GetState);
    const pending = outcome(f.connection.sendMRPMessageAndWait(request, MessageType.SetState, 500));
    await delay(0);
    let messages = 0;
    let closes = 0;
    f.connection.on('mrp-message', () => messages++);
    f.connection.on('close', () => closes++);
    f.connection.close();
    f.connection.close();
    f.transport.onDataChannelData(f.peer.encrypt(buildDataStreamFrame(Buffer.from([8, 4]))));
    expect((await pending).error?.message).toMatch(/closed/i);
    expect(messages).toBe(0);
    expect(closes).toBe(1);
    await expect(f.connection.sendMRPMessage(request)).rejects.toThrow(/closed/i);
  });
});

describe('real TCP cancellation', () => {
  async function stalledPeer(run: (port: number, sockets: Set<Socket>) => Promise<void>) {
    const sockets = new Set<Socket>();
    const server = createServer(socket => {
      sockets.add(socket);
      socket.on('close', () => sockets.delete(socket));
      socket.on('data', () => {}); // Accept pair-verify but deliberately never reply.
      socket.on('error', () => {});
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    try { await run((server.address() as AddressInfo).port, sockets); }
    finally {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  }

  it('aborts pairing promptly and closes the real socket', async () => {
    await stalledPeer(async (port, sockets) => {
      const connection = new AirPlayConnection('127.0.0.1', port, credentials, { timeoutMs: 1000, logger: () => {} });
      const controller = new AbortController();
      const pending = outcome(connection.connect({ signal: controller.signal }));
      await expect.poll(() => sockets.size).toBe(1);
      controller.abort();
      const result = await pending;
      connection.close();
      expect(result.error?.message).toMatch(/abort|cancel/i);
      await expect.poll(() => sockets.size).toBe(0);
    });
  });

  it('times out a stalled handshake and never leaves an orphan socket', async () => {
    await stalledPeer(async (port, sockets) => {
      const connection = new AirPlayConnection('127.0.0.1', port, credentials, { timeoutMs: 20, logger: () => {} });
      const result = await outcome(connection.connect());
      connection.close();
      expect(result.error?.message).toMatch(/timed out/i);
      await expect.poll(() => sockets.size).toBe(0);
    });
  });

  it('honors cancellation before connecting and while TCP is still opening', async () => {
    await stalledPeer(async (port, sockets) => {
      for (const alreadyAborted of [true, false]) {
        const connection = new AirPlayConnection('127.0.0.1', port, credentials, { logger: () => {} });
        const controller = new AbortController();
        if (alreadyAborted) controller.abort();
        const pending = outcome(connection.connect({ signal: controller.signal }));
        controller.abort();
        expect((await pending).error?.message).toMatch(/cancel/i);
        await delay(20);
        expect(sockets.size).toBe(0);
        await expect(connection.connect()).rejects.toThrow(/closed/i);
      }
    });
  });

  it('rejects a stalled handshake when the peer closes', async () => {
    await stalledPeer(async (port, sockets) => {
      const connection = new AirPlayConnection('127.0.0.1', port, credentials, { logger: () => {} });
      const pending = outcome(connection.connect());
      await expect.poll(() => sockets.size).toBe(1);
      for (const socket of sockets) socket.destroy();
      expect((await pending).error?.message).toMatch(/closed|ECONNRESET|EPIPE/i);
      connection.close();
    });
  });
});

describe('AppleTV over AirPlay', () => {
  it('rejects AppleTV.connect() without an unhandled error when the peer hangs up', async () => {
    const sockets = new Set<Socket>();
    const server = createServer(socket => { sockets.add(socket); socket.destroy(); });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    try {
      const { port } = server.address() as AddressInfo;
      const atv = new AppleTV({ name: 'TV', address: '127.0.0.1', port, deviceId: 'aa:bb', model: 'AppleTV6,2' });
      const closes = vi.fn();
      atv.on('close', closes);
      vi.spyOn(console, 'error').mockImplementation(() => {});
      const result = await outcome(atv.connect(new Credentials(credentials)));
      expect(result.error?.message).toMatch(/closed|ECONNRESET|EPIPE/i);
      expect(closes).toHaveBeenCalledOnce();
      await atv.close();
    } finally {
      vi.restoreAllMocks();
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });
});
