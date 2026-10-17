import { unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { extractRaopMetadata } from '../metadata.js';

const parser = vi.hoisted(() => ({ parseFile: vi.fn() }));
vi.mock('music-metadata', () => parser);

describe('extractRaopMetadata', () => {
  it('extracts finite-file tags, one bounded ID3 JPEG, and duration while caller values win', async () => {
    const artwork = Buffer.from([0xff, 0xd8, 0xff, 1]);
    const apic = Buffer.concat([Buffer.from([0]), Buffer.from('image/jpeg\0'), Buffer.from([3, 0]), artwork]);
    const frame = Buffer.alloc(10); frame.write('APIC'); frame.writeUInt32BE(apic.length, 4);
    const header = Buffer.from([0x49, 0x44, 0x33, 3, 0, 0, 0, 0, 0, frame.length + apic.length]);
    const file = join(tmpdir(), `node-atv-metadata-${Date.now()}.mp3`);
    writeFileSync(file, Buffer.concat([header, frame, apic]));
    parser.parseFile.mockResolvedValue({ common: { title: 'embedded title', artist: 'embedded artist', album: 'embedded album' }, format: { duration: 1.25 } });
    try {
      await expect(extractRaopMetadata(file, { title: 'caller title' })).resolves.toEqual({
        metadata: { title: 'caller title', artist: 'embedded artist', album: 'embedded album', artwork }, duration: 1.25,
      });
      expect(parser.parseFile).toHaveBeenCalledWith(file, { skipCovers: true });
    } finally { unlinkSync(file); }
  });

  it('skips cover payload parsing and excludes non-finite duration', async () => {
    const file = join(tmpdir(), `node-atv-metadata-${Date.now()}.wav`);
    writeFileSync(file, Buffer.alloc(0));
    parser.parseFile.mockResolvedValue({ common: {}, format: { duration: Infinity } });
    try {
      await expect(extractRaopMetadata(file)).resolves.toEqual({ metadata: {} });
      expect(parser.parseFile).toHaveBeenCalledWith(file, { skipCovers: true });
    } finally { unlinkSync(file); }
  });
  it('extracts a bounded JPEG payload from a FLAC-style container without retaining its non-cover bytes', async () => {
    const file = join(tmpdir(), `node-atv-metadata-${Date.now()}.flac`);
    const artwork = Buffer.from([0xff, 0xd8, 0xff, 0, 0xff, 0xd9]);
    writeFileSync(file, Buffer.concat([Buffer.from('fLaC'), Buffer.alloc(65536), artwork, Buffer.alloc(65536)]));
    parser.parseFile.mockResolvedValue({ common: {}, format: {} });
    try {
      await expect(extractRaopMetadata(file)).resolves.toEqual({ metadata: { artwork } });
    } finally { unlinkSync(file); }
  });

  it('extracts a bounded JPEG from a Vorbis metadata-picture comment', async () => {
    const file = join(tmpdir(), `node-atv-metadata-${Date.now()}.ogg`);
    const artwork = Buffer.from([0xff, 0xd8, 0xff, 0, 0xff, 0xd9]);
    const picture = Buffer.alloc(8 + 10 + 4 + 16 + 4 + artwork.length);
    picture.writeUInt32BE(3, 0); picture.writeUInt32BE(10, 4); picture.write('image/jpeg', 8);
    picture.writeUInt32BE(0, 18); picture.writeUInt32BE(artwork.length, 38); artwork.copy(picture, 42);
    writeFileSync(file, Buffer.from(`OggSMETADATA_BLOCK_PICTURE=${picture.toString('base64')}\n`));
    parser.parseFile.mockResolvedValue({ common: {}, format: {} });
    try {
      await expect(extractRaopMetadata(file)).resolves.toEqual({ metadata: { artwork } });
    } finally { unlinkSync(file); }
  });
});
