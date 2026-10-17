/** Structural artwork fixtures keep image-looking audio bytes distinct from declared cover records. */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { extractRaopMetadata } from '../metadata.js';

const parser = vi.hoisted(() => ({ parseFile: vi.fn() }));
vi.mock('music-metadata', () => parser);
const artwork = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 2, 0xff, 0xd9]);
let directory: string;
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'node-atv-metadata-'));
  parser.parseFile.mockResolvedValue({ common: {}, format: {} });
});
afterEach(() => rmSync(directory, { recursive: true, force: true }));

function syncsafe(size: number): Buffer {
  return Buffer.from([(size >>> 21) & 127, (size >>> 14) & 127, (size >>> 7) & 127, size & 127]);
}
function id3(image: Buffer = artwork, version: 3 | 4 = 3, dataLengthIndicator = false): Buffer {
  const payload = Buffer.concat([Buffer.from('\0image/jpeg\0'), Buffer.from([3, 0]), image]);
  const picture = dataLengthIndicator ? Buffer.concat([syncsafe(payload.length), payload]) : payload;
  const frame = Buffer.alloc(10); frame.write('APIC');
  if (version === 4) syncsafe(picture.length).copy(frame, 4);
  else frame.writeUInt32BE(picture.length, 4);
  frame[9] = dataLengthIndicator ? 1 : 0;
  return Buffer.concat([Buffer.from([0x49, 0x44, 0x33, version, 0, 0]), syncsafe(frame.length + picture.length), frame, picture]);
}
function flacPicture(image: Buffer = artwork): Buffer {
  const block = Buffer.alloc(42 + image.length);
  block.writeUInt32BE(3); block.writeUInt32BE(10, 4); block.write('image/jpeg', 8);
  block.writeUInt32BE(1, 22); block.writeUInt32BE(1, 26); block.writeUInt32BE(24, 30);
  block.writeUInt32BE(image.length, 38); image.copy(block, 42);
  return block;
}
function flac(image: Buffer = artwork): Buffer {
  const block = flacPicture(image);
  const header = Buffer.alloc(4); header[0] = 0x86; header.writeUIntBE(block.length, 1, 3);
  return Buffer.concat([Buffer.from('fLaC'), Buffer.from([0, 0, 0, 34]), Buffer.alloc(34), header, block]);
}
function atom(name: string, payload: Buffer): Buffer {
  const header = Buffer.alloc(8); header.writeUInt32BE(payload.length + 8); header.write(name, 4, 'latin1');
  return Buffer.concat([header, payload]);
}
function mp4(image: Buffer = artwork): Buffer {
  const kind = Buffer.alloc(8); kind.writeUInt32BE(13);
  const cover = atom('covr', atom('data', Buffer.concat([kind, image])));
  return Buffer.concat([atom('ftyp', Buffer.from('M4A \0\0\0\0isom')), atom('mdat', artwork),
    atom('moov', atom('udta', atom('meta', Buffer.concat([Buffer.alloc(4), atom('ilst', cover)]))))]);
}
function riffChunk(name: string, payload: Buffer): Buffer {
  const header = Buffer.alloc(8); header.write(name); header.writeUInt32LE(payload.length, 4);
  return Buffer.concat([header, payload, payload.length % 2 ? Buffer.alloc(1) : Buffer.alloc(0)]);
}
function wav(image: Buffer = artwork): Buffer {
  const format = Buffer.from('0100020044ac000010b1020004001000', 'hex');
  const chunks = Buffer.concat([riffChunk('fmt ', format), riffChunk('data', Buffer.alloc(4)), riffChunk('id3 ', id3(image))]);
  const header = Buffer.alloc(12); header.write('RIFF'); header.writeUInt32LE(chunks.length + 4, 4); header.write('WAVE', 8);
  return Buffer.concat([header, chunks]);
}
function oggPacket(packet: Buffer, firstSequence: number, serial = 7): Buffer[] {
  const pages: Buffer[] = []; let offset = 0;
  do {
    const left = packet.length - offset;
    const bytes = Math.min(left, 65025);
    const laces: number[] = Array(Math.floor(bytes / 255)).fill(255);
    if (bytes < 65025) laces.push(bytes % 255);
    const header = Buffer.alloc(27); header.write('OggS'); header[5] = offset ? 1 : firstSequence === 0 ? 2 : 0;
    header.writeUInt32LE(serial, 14); header.writeUInt32LE(firstSequence + pages.length, 18); header[26] = laces.length;
    pages.push(Buffer.concat([header, Buffer.from(laces), packet.subarray(offset, offset + bytes)]));
    offset += bytes;
    if (left === bytes && bytes === 65025) {
      const last = Buffer.from(header); last[5] = 1; last[26] = 1; last.writeUInt32LE(firstSequence + pages.length, 18);
      pages.push(Buffer.concat([last, Buffer.from([0])]));
    }
  } while (offset < packet.length);
  return pages;
}
function ogg(image: Buffer = artwork, opus = false): Buffer {
  const entry = Buffer.from(`METADATA_BLOCK_PICTURE=${flacPicture(image).toString('base64')}`);
  const fields = Buffer.alloc(12); fields.writeUInt32LE(0); fields.writeUInt32LE(1, 4); fields.writeUInt32LE(entry.length, 8);
  const identification = opus ? Buffer.concat([Buffer.from('OpusHead'), Buffer.alloc(11)]) : Buffer.concat([Buffer.from([1]), Buffer.from('vorbis'), Buffer.alloc(23)]);
  const comment = Buffer.concat([opus ? Buffer.from('OpusTags') : Buffer.concat([Buffer.from([3]), Buffer.from('vorbis')]), fields, entry]);
  const first = oggPacket(identification, 0);
  return Buffer.concat([...first, ...oggPacket(comment, first.length)]);
}

const containers = [
  ['mp3', id3], ['flac', flac], ['m4a', mp4], ['wav', wav],
  ['ogg', ogg], ['opus', (image: Buffer) => ogg(image, true)],
] as const;

describe('extractRaopMetadata', () => {
  it.each(containers)('extracts exact JPEG bytes from declared %s cover structures', async (extension, build) => {
    const file = join(directory, `track.${extension}`); writeFileSync(file, build(artwork));
    expect((await extractRaopMetadata(file)).metadata.artwork).toEqual(artwork);
  });

  it('handles ID3v2.4 APIC data-length indicators and rejects mismatched declared payload sizes', async () => {
    const image = Buffer.alloc(300, 2); artwork.copy(image);
    const file = join(directory, 'length-indicator.mp3');
    const valid = id3(image, 4, true); writeFileSync(file, valid);
    expect((await extractRaopMetadata(file)).metadata.artwork).toEqual(image);
    const invalid = Buffer.from(valid); syncsafe(image.length).copy(invalid, 20); writeFileSync(file, invalid);
    expect((await extractRaopMetadata(file)).metadata.artwork).toBeUndefined();
  });

  it.each([false, true])('selects the audio logical stream after an Ogg Skeleton BOS stream (Opus: %s)', async opus => {
    const skeleton = oggPacket(Buffer.concat([Buffer.from('fishead\0'), Buffer.alloc(56)]), 0, 99);
    const file = join(directory, opus ? 'multiplexed.opus' : 'multiplexed.ogg');
    writeFileSync(file, Buffer.concat([...skeleton, ogg(artwork, opus)]));
    expect((await extractRaopMetadata(file)).metadata.artwork).toEqual(artwork);
  });

  it('preserves caller precedence and finite duration without parsing caller artwork again', async () => {
    const file = join(directory, 'track.mp3'); writeFileSync(file, id3());
    parser.parseFile.mockResolvedValue({ common: { title: 'embedded', artist: 'artist', album: 'album' }, format: { duration: 1.25 } });
    const explicit = Buffer.from([0xff, 0xd8, 0xff, 2]);
    expect(await extractRaopMetadata(file, { title: 'caller', artwork: explicit })).toEqual({
      metadata: { title: 'caller', artist: 'artist', album: 'album', artwork: explicit }, duration: 1.25,
    });
  });

  it('does not promote JPEG-looking media payload or invalid container tails to artwork', async () => {
    const files = [Buffer.concat([Buffer.from('fLaC'), Buffer.from([0x80, 0, 0, 34]), Buffer.alloc(34), artwork]),
      Buffer.concat([atom('ftyp', Buffer.from('M4A \0\0\0\0isom')), atom('mdat', artwork)]),
      Buffer.concat([Buffer.from('OggS'), artwork]), Buffer.concat([Buffer.from('not a container'), artwork])];
    for (let index = 0; index < files.length; index++) {
      const file = join(directory, `decoy-${index}`); writeFileSync(file, files[index]);
      expect((await extractRaopMetadata(file)).metadata).toEqual({});
    }
  });

  it.each(containers)('omits oversized %s covers without retaining their payload', async (extension, build) => {
    const image = Buffer.alloc(1024 * 1024 + 1); artwork.copy(image);
    const file = join(directory, `large.${extension}`); writeFileSync(file, build(image));
    expect((await extractRaopMetadata(file)).metadata).toEqual({});
  });

  it('joins comment packets split across Ogg pages without reading beyond their declared lengths', async () => {
    const image = Buffer.alloc(70000, 2); artwork.copy(image);
    const file = join(directory, 'paged.ogg'); writeFileSync(file, ogg(image));
    expect((await extractRaopMetadata(file)).metadata.artwork).toEqual(image);
  });

  it('omits nonfinite duration and propagates tag parser failures', async () => {
    const file = join(directory, 'track.mp3'); writeFileSync(file, id3());
    parser.parseFile.mockResolvedValueOnce({ common: {}, format: { duration: Infinity } });
    expect((await extractRaopMetadata(file)).duration).toBeUndefined();
    parser.parseFile.mockRejectedValueOnce(new Error('Invalid media tags'));
    await expect(extractRaopMetadata(file)).rejects.toThrow('Invalid media tags');
  });
});
