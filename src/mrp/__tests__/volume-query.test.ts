import { describe, expect, it } from 'vitest';
import { MRPMessage, MessageType } from '../messages.js';

// Independently encoded by pyatv 0.18.0, using synthetic identifiers only.
const fixtures = {
  request: '0831120b726561642d766f6c756d65aa03120a1073796e7468657469632d6f7574707574',
  volume: '0832120b726561642d766f6c756d65b203050d0000c03e',
  zero: '0832120b726561642d766f6c756d65b203050d00000000',
  absent: '0832120b726561642d766f6c756d65b20300',
};

describe('read-only volume queries', () => {
  it('encodes a request for one output with fresh correlation identifiers', async () => {
    const reference = await MRPMessage.decode(Buffer.from(fixtures.request, 'hex'));
    const decoded = await MRPMessage.decode(await MRPMessage.getVolume('synthetic-output'));
    expect(decoded.type).toBe(reference.type);
    expect(decoded['.getVolumeMessage']).toEqual(reference['.getVolumeMessage']);
    expect(decoded.identifier).toBeTruthy();
    const next = await MRPMessage.decode(await MRPMessage.getVolume('synthetic-output'));
    expect(next.identifier).not.toBe(decoded.identifier);
  });

  it('decodes an independently encoded result and keeps absent volume distinct from zero', async () => {
    const result = await MRPMessage.decode(Buffer.from(fixtures.volume, 'hex'));
    expect(result.type).toBe(MessageType.GetVolumeResult);
    expect(result.identifier).toBe('read-volume');
    expect(result['.getVolumeResultMessage']).toEqual({ volume: 0.375 });
    const zero = (await MRPMessage.decode(Buffer.from(fixtures.zero, 'hex')))['.getVolumeResultMessage'];
    const absent = (await MRPMessage.decode(Buffer.from(fixtures.absent, 'hex')))['.getVolumeResultMessage'];
    expect(zero).toEqual({ volume: 0 });
    expect(absent).toEqual({});
  });
});
