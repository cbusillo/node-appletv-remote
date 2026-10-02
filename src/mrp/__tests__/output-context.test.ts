import { describe, expect, it } from 'vitest';
import { MRPMessage, MessageType, OutputContextType } from '../messages.js';

// Encoded by pyatv 0.18.0 with synthetic identifiers, exactly as the supervised
// AirPods probe built them: pyatv's closed enum knows only value 1, so type 2 was
// merged as a raw varint and serializes after the device fields.
const fixtures = {
  personal:
    '0830120c726f7574652d6f7574707574a20338221973796e7468657469632d706572736f6e616c2d6f75747075743a19' +
    '73796e7468657469632d706572736f6e616c2d6f75747075740802',
  group:
    '0830120c726f7574652d6f7574707574a20352221373796e7468657469632d74762d6f7574707574221173796e746865' +
    '7469632d737065616b65723a1373796e7468657469632d74762d6f75747075743a1173796e7468657469632d73706561' +
    '6b65720802',
};
const field = (tag: number, value: string): Buffer =>
  Buffer.concat([Buffer.from([tag, value.length]), Buffer.from(value)]);

describe('system audio output selection', () => {
  it('matches the pyatv SharedSystemAudio request for one personal output', async () => {
    const reference = await MRPMessage.decode(Buffer.from(fixtures.personal, 'hex'));
    const encoded = await MRPMessage.setSystemAudioOutputs(['synthetic-personal-output']);
    const decoded = await MRPMessage.decode(encoded);
    expect(decoded.type).toBe(MessageType.ModifyOutputContextRequest);
    expect(reference.type).toBe(48);
    expect(decoded['.modifyOutputContextRequestMessage']).toEqual(reference['.modifyOutputContextRequestMessage']);
    expect(decoded['.modifyOutputContextRequestMessage']).toMatchObject({
      type: OutputContextType.SharedSystemAudio,
      settingDevices: ['synthetic-personal-output'],
      clusterAwareSettingDevices: ['synthetic-personal-output'],
    });
    // Canonical field order: type 2 first, then settingDevices (4) and clusterAwareSettingDevices (7).
    const inner = Buffer.concat([
      Buffer.from([0x08, 0x02]),
      field(0x22, 'synthetic-personal-output'),
      field(0x3a, 'synthetic-personal-output'),
    ]);
    const extension = Buffer.concat([Buffer.from([0xa2, 0x03, inner.length]), inner]);
    expect(encoded.subarray(0, 2)).toEqual(Buffer.from([0x08, 0x30]));
    expect(encoded.subarray(-extension.length)).toEqual(extension);
    expect(decoded.identifier).toBeTruthy();
    expect((await MRPMessage.decode(await MRPMessage.setSystemAudioOutputs(['x']))).identifier).not.toBe(
      decoded.identifier,
    );
  });

  it('keeps several default outputs in order and rejects empty or duplicate selections', async () => {
    const reference = await MRPMessage.decode(Buffer.from(fixtures.group, 'hex'));
    const decoded = await MRPMessage.decode(
      await MRPMessage.setSystemAudioOutputs(['synthetic-tv-output', 'synthetic-speaker']),
    );
    const inner = decoded['.modifyOutputContextRequestMessage'] as Record<string, unknown>;
    expect(inner.settingDevices).toEqual(['synthetic-tv-output', 'synthetic-speaker']);
    expect(inner.clusterAwareSettingDevices).toEqual(inner.settingDevices);
    expect(reference['.modifyOutputContextRequestMessage']).toMatchObject({
      type: OutputContextType.SharedSystemAudio,
      settingDevices: inner.settingDevices,
      clusterAwareSettingDevices: inner.settingDevices,
    });
    for (const invalid of [[], [''], ['same', 'same']])
      await expect(MRPMessage.setSystemAudioOutputs(invalid)).rejects.toThrow(/identifiers/);
  });
});
