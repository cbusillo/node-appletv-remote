import { describe, expect, it } from 'vitest';
import { MRPMessage } from '../messages.js';

// Independently encoded by pyatv 0.18.0, using synthetic identifiers only.
const fixtures = {
  volume: '0832120b726561642d766f6c756d65b203050d0000c03e',
  zero: '0832120b726561642d766f6c756d65b203050d00000000',
  absent: '0832120b726561642d766f6c756d65b20300',
  request: '0831120b726561642d766f6c756d65aa03120a1073796e7468657469632d6f7574707574',
};

describe('read-only volume queries', () => {
  it('encodes an explicit output request with a fresh correlation identifier', async () => {
    const reference = await MRPMessage.decode(Buffer.from(fixtures.request, 'hex'));
    const first = await MRPMessage.getVolume('synthetic-output');
    const decoded = await MRPMessage.decode(first);
    expect(decoded.type).toBe(reference.type);
    expect(decoded['.getVolumeMessage']).toEqual(reference['.getVolumeMessage']);
    expect(first.subarray(-20)).toEqual(Buffer.from(fixtures.request, 'hex').subarray(-20));
    expect(decoded.identifier).toBeTruthy();
    expect((await MRPMessage.decode(await MRPMessage.getVolume('synthetic-output'))).identifier)
      .not.toBe(decoded.identifier);
    await expect(MRPMessage.getVolume('')).rejects.toThrow(/identifier/);
  });

  it('decodes a result while keeping missing volume distinct from an observed zero', async () => {
    const result = await MRPMessage.decode(Buffer.from(fixtures.volume, 'hex'));
    expect(result.type).toBe(50);
    expect(result.identifier).toBe('read-volume');
    expect(result['.getVolumeResultMessage']).toMatchObject({ volume: 0.375 });
    const zero = (await MRPMessage.decode(Buffer.from(fixtures.zero, 'hex')))['.getVolumeResultMessage'] as object;
    const absent = (await MRPMessage.decode(Buffer.from(fixtures.absent, 'hex')))['.getVolumeResultMessage'] as object;
    expect(Object.hasOwn(zero, 'volume')).toBe(true);
    expect(Object.hasOwn(absent, 'volume')).toBe(false);
  });
});
