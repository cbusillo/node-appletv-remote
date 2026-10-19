import { describe, expect, it } from 'vitest';
import * as entry from '../../index.js';
import { MRPMessage, MessageType } from '../messages.js';

// Independently encoded by pyatv 0.18.0, using synthetic identifiers only.
const fixtures = {
  request: '0831120b726561642d766f6c756d65aa03120a1073796e7468657469632d6f7574707574',
  volume: '0832120b726561642d766f6c756d65b203050d0000c03e',
  zero: '0832120b726561642d766f6c756d65b203050d00000000',
  absent: '0832120b726561642d766f6c756d65b20300',
};

describe('read-only volume queries', () => {
  it('encodes an explicit output request through the public API with fresh correlation identifiers', async () => {
    expect(entry.MRPMessage).toBe(MRPMessage);
    expect(entry.MessageType).toBe(MessageType);
    const reference = await MRPMessage.decode(Buffer.from(fixtures.request, 'hex'));
    const first = await entry.MRPMessage.getVolume('synthetic-output');
    const decoded = await MRPMessage.decode(first);
    expect(decoded.type).toBe(reference.type);
    expect(decoded.type).toBe(MessageType.GetVolume);
    expect(decoded['.getVolumeMessage']).toEqual(reference['.getVolumeMessage']);
    expect(decoded.identifier).toBeTruthy();
    const next = await MRPMessage.decode(await entry.MRPMessage.getVolume('synthetic-output'));
    expect(next.identifier).not.toBe(decoded.identifier);
    await expect(entry.MRPMessage.getVolume('')).rejects.toThrow();
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
