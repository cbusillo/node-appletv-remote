import { createServer, type Socket, type AddressInfo } from 'node:net';
import { once } from 'node:events';
import { describe, expect, it } from 'vitest';
import { CompanionPairSetup } from '../pair-setup.js';
import { encodeFrame, FrameType } from '../framing.js';
import { opackEncode, type OpackValue } from '../opack.js';
import { tlvEncode, TlvTag } from '../../util/tlv.js';

async function peer(operation: (port: number, sockets: Set<Socket>) => Promise<void>, reply = false): Promise<void> {
  const sockets = new Set<Socket>();
  const server = createServer(socket => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => {});
    let sent = false;
    socket.on('data', () => {
      if (!reply || sent) return;
      sent = true;
      const data = tlvEncode({ [TlvTag.SeqNo]: Buffer.from([2]), [TlvTag.Salt]: Buffer.alloc(16, 1), [TlvTag.PublicKey]: Buffer.alloc(384, 7) });
      socket.write(encodeFrame(FrameType.PS_Next, opackEncode(new Map<OpackValue, OpackValue>([['_pd', data]]))));
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try { await operation((server.address() as AddressInfo).port, sockets); }
  finally { for (const socket of sockets) socket.destroy(); await new Promise<void>(resolve => server.close(() => resolve())); }
}

describe('Companion pairing lifetime', () => {
  it('cancels before opening a socket', async () => {
    await peer(async (port, sockets) => {
      const pair = new CompanionPairSetup('127.0.0.1', port);
      await expect(pair.start({ signal: AbortSignal.abort() })).rejects.toThrow(/closed/);
      expect(sockets.size).toBe(0);
      pair.destroy();
    });
  });

  it('times out an unanswered handshake and closes its socket', async () => {
    await peer(async port => {
      const pair = new CompanionPairSetup('127.0.0.1', port, { timeoutMs: 50 });
      await expect(pair.start()).rejects.toThrow(/timed out/);
      await expect(pair.start()).rejects.toThrow(/once/);
      pair.destroy();
    });
  });

  it('rejects immediately when the peer closes during a response wait', async () => {
    await peer(async (port, sockets) => {
      const pair = new CompanionPairSetup('127.0.0.1', port);
      const started = pair.start();
      const rejected = expect(started).rejects.toThrow(/closed/);
      while (!sockets.size) await new Promise(resolve => setTimeout(resolve, 1));
      for (const socket of sockets) socket.destroy();
      await rejected;
    });
  });

  it('keeps the PIN session alive, rejects duplicate start and cancels a pending finish', async () => {
    await peer(async port => {
      const cancel = new AbortController();
      const pair = new CompanionPairSetup('127.0.0.1', port);
      await pair.start({ signal: cancel.signal });
      await expect(pair.start()).rejects.toThrow(/once/);
      await expect(pair.finish('abc')).rejects.toThrow(/four-digit/);
      const rejected = expect(pair.finish('1234')).rejects.toThrow(/cancelled|closed/);
      cancel.abort();
      await rejected;
      pair.destroy();
      await expect(pair.finish('1234')).rejects.toThrow(/start/);
    }, true);
  });

  it('notifies the caller when the peer closes while waiting for the PIN', async () => {
    await peer(async (port, sockets) => {
      const pair = new CompanionPairSetup('127.0.0.1', port);
      await pair.start();
      expect(pair.stage).toBe('pin');
      for (const socket of sockets) socket.destroy();
      await pair.closed;
      await expect(pair.finish('1234')).rejects.toThrow(/start/);
      expect(pair.stage).toBe('pin');
      pair.destroy();
      await pair.closed;
    }, true);
  });
});
