import { describe, it, expect } from 'vitest';
import { CompanionPairSetup } from '../pair-setup.js';
import { opackDecode } from '../opack.js';
import { TlvTag, tlvDecode, type TlvData } from '../../util/tlv.js';
import { hkdfSha512, decryptChaCha20 } from '../../util/crypto.js';

/** Runs M5 against a fixed session key and returns the decrypted sub-TLV the Apple TV would read. */
async function m5Identity(pair: CompanionPairSetup): Promise<TlvData> {
  const sessionKey = Buffer.alloc(64, 7);
  const internals = pair as unknown as {
    sessionKey: Buffer;
    sendPairingData(data: Buffer): void;
    receivePairingData(): Promise<Buffer>;
  };
  internals.sessionKey = sessionKey;
  let m5: Buffer | undefined;
  internals.sendPairingData = (data) => { m5 = data; };
  internals.receivePairingData = () => Promise.reject(new Error('stop after M5'));
  await expect(pair.sendM5()).rejects.toThrow('stop after M5');

  const encrypted = tlvDecode(m5!)[TlvTag.EncryptedData]!;
  const key = await hkdfSha512(sessionKey, 'Pair-Setup-Encrypt-Salt', 'Pair-Setup-Encrypt-Info', 32);
  const nonce = Buffer.alloc(12, 0);
  nonce.write('PS-Msg05', 4);
  const plain = decryptChaCha20(key, nonce, encrypted.subarray(0, -16), encrypted.subarray(-16), Buffer.alloc(0));
  return tlvDecode(plain);
}

describe('CompanionPairSetup name', () => {
  it('sends the name in M5 so the Apple TV can list the pairing', async () => {
    const identity = await m5Identity(new CompanionPairSetup('127.0.0.1', 49153, { name: 'Living Room Remote' }));
    const info = opackDecode(identity[TlvTag.Name]!) as Map<string, unknown>;
    expect(info.get('name')).toBe('Living Room Remote');
  });

  it('sends no name entry when none is given', async () => {
    const identity = await m5Identity(new CompanionPairSetup('127.0.0.1', 49153));
    expect(identity[TlvTag.Name]).toBeUndefined();
    expect(identity[TlvTag.Identifier]).toBeDefined();
  });
});
