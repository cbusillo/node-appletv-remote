import { createServer, Socket } from 'node:net';
import { expect, it, vi } from 'vitest';
import { CompanionConnection } from '../connection.js';

it('disables TCP batching before time-sensitive Companion events', async () => {
  const server = createServer(socket => socket.resume());
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing loopback port');
  const key = Buffer.alloc(32, 7);
  const connection = new CompanionConnection('127.0.0.1', address.port, {
    clientId: 'synthetic', serverId: 'synthetic', clientLTSK: key, clientLTPK: key, serverLTPK: key,
  });
  const noDelay = vi.spyOn(Socket.prototype, 'setNoDelay');
  try {
    // Exercise the real socket setup without pairing or contacting any device.
    await (connection as unknown as { openSocket(): Promise<void> }).openSocket();
    expect(noDelay).toHaveBeenCalledWith(true);
  } finally {
    connection.close();
    noDelay.mockRestore();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});
