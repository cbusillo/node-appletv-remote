/** Finite local-file tag extraction for RAOP metadata; this never reads PCM sources. */
import { open } from 'node:fs/promises';
import { parseFile } from 'music-metadata';
import type { RaopMetadata } from './stream.js';

const MAX_ARTWORK_BYTES = 1024 * 1024;

export interface ExtractedRaopMetadata {
  metadata: RaopMetadata;
  duration?: number;
}

/** Read one bounded ID3v2 APIC frame without asking music-metadata to materialize every cover. */
async function id3Artwork(file: string): Promise<Buffer | undefined> {
  const handle = await open(file, 'r');
  try {
    const header = Buffer.alloc(10);
    const { bytesRead } = await handle.read(header, 0, header.length, 0);
    if (bytesRead !== header.length || header.toString('ascii', 0, 3) !== 'ID3' || ![3, 4].includes(header[3])) return undefined;
    const tagSize = ((header[6] & 0x7f) << 21) | ((header[7] & 0x7f) << 14) | ((header[8] & 0x7f) << 7) | (header[9] & 0x7f);
    if (tagSize > MAX_ARTWORK_BYTES + 1024) return undefined;
    const tag = Buffer.alloc(tagSize);
    if ((await handle.read(tag, 0, tag.length, 10)).bytesRead !== tag.length) return undefined;
    for (let offset = 0; offset + 10 <= tag.length;) {
      const id = tag.toString('ascii', offset, offset + 4);
      const frameSize = header[3] === 4
        ? ((tag[offset + 4] & 0x7f) << 21) | ((tag[offset + 5] & 0x7f) << 14) | ((tag[offset + 6] & 0x7f) << 7) | (tag[offset + 7] & 0x7f)
        : tag.readUInt32BE(offset + 4);
      offset += 10;
      if (!/^[A-Z0-9]{4}$/.test(id) || frameSize > tag.length - offset) return undefined;
      if (id === 'APIC') {
        const frame = tag.subarray(offset, offset + frameSize);
        const mimeEnd = frame.indexOf(0, 1);
        if (mimeEnd > 1 && frame.subarray(1, mimeEnd).toString('ascii').toLowerCase() === 'image/jpeg') {
          const description = mimeEnd + 2;
          const utf16 = frame[0] === 1 || frame[0] === 2;
          let image = description;
          while (image < frame.length && (utf16 ? image + 1 >= frame.length || frame[image] !== 0 || frame[image + 1] !== 0 : frame[image] !== 0)) image += utf16 ? 2 : 1;
          image += utf16 ? 2 : 1;
          const artwork = frame.subarray(image);
          if (artwork.length >= 3 && artwork.length <= MAX_ARTWORK_BYTES && artwork[0] === 0xff && artwork[1] === 0xd8 && artwork[2] === 0xff) return Buffer.from(artwork);
        }
      }
      offset += frameSize;
    }
    return undefined;
  } finally {
    await handle.close();
  }
}

/** Find one bounded binary JPEG cover without buffering a media container or its non-cover chunks. */
async function binaryJpegArtwork(file: string): Promise<Buffer | undefined> {
  const handle = await open(file, 'r');
  try {
    const chunk = Buffer.allocUnsafe(65536);
    const artwork = Buffer.allocUnsafe(MAX_ARTWORK_BYTES);
    let position = 0; let previous = -1; let collecting = false; let length = 0;
    while (true) {
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, position);
      if (!bytesRead) return undefined;
      position += bytesRead;
      for (let index = 0; index < bytesRead; index++) {
        const byte = chunk[index];
        if (!collecting) {
          if (previous === 0xff && byte === 0xd8 && index + 1 < bytesRead && chunk[index + 1] === 0xff) {
            collecting = true; artwork[0] = 0xff; artwork[1] = 0xd8; artwork[2] = 0xff; length = 3; index++;
          }
        } else {
          if (length === artwork.length) return undefined;
          artwork[length++] = byte;
          if (previous === 0xff && byte === 0xd9) return Buffer.from(artwork.subarray(0, length));
        }
        previous = byte;
      }
    }
  } finally {
    await handle.close();
  }
}

/** Decode one bounded Vorbis/Opus METADATA_BLOCK_PICTURE comment from the header region. */
async function oggArtwork(file: string): Promise<Buffer | undefined> {
  const handle = await open(file, 'r');
  try {
    const encoded = Buffer.allocUnsafe(2 * 1024 * 1024);
    const { bytesRead } = await handle.read(encoded, 0, encoded.length, 0);
    const match = /METADATA_BLOCK_PICTURE=([A-Za-z0-9+/=]+)/.exec(encoded.subarray(0, bytesRead).toString('latin1'));
    if (!match || match[1].length > Math.ceil((MAX_ARTWORK_BYTES + 1024) * 4 / 3)) return undefined;
    const picture = Buffer.from(match[1], 'base64');
    if (picture.length < 32) return undefined;
    const mimeLength = picture.readUInt32BE(4);
    const mimeEnd = 8 + mimeLength;
    if (mimeEnd + 20 > picture.length || picture.subarray(8, mimeEnd).toString('ascii').toLowerCase() !== 'image/jpeg') return undefined;
    const descriptionLength = picture.readUInt32BE(mimeEnd);
    const imageLengthOffset = mimeEnd + 4 + descriptionLength + 16;
    if (imageLengthOffset + 4 > picture.length) return undefined;
    const imageLength = picture.readUInt32BE(imageLengthOffset);
    const image = picture.subarray(imageLengthOffset + 4);
    if (image.length !== imageLength || image.length < 3 || image.length > MAX_ARTWORK_BYTES ||
      image[0] !== 0xff || image[1] !== 0xd8 || image[2] !== 0xff) return undefined;
    return Buffer.from(image);
  } finally {
    await handle.close();
  }
}

/**
 * Extract tags from a finite local media file. Caller metadata wins over embedded tags.
 * `music-metadata` skips covers, while a bounded ID3v2 reader selects one valid embedded JPEG.
 */
export async function extractRaopMetadata(file: string, explicit: RaopMetadata = {}): Promise<ExtractedRaopMetadata> {
  const [parsed, id3, ogg, binary] = await Promise.all([parseFile(file, { skipCovers: true }), id3Artwork(file), oggArtwork(file), binaryJpegArtwork(file)]);
  const artwork = id3 ?? ogg ?? binary;
  const extracted: RaopMetadata = {
    ...(parsed.common.title === undefined ? {} : { title: parsed.common.title }),
    ...(parsed.common.artist === undefined ? {} : { artist: parsed.common.artist }),
    ...(parsed.common.album === undefined ? {} : { album: parsed.common.album }),
    ...(artwork === undefined ? {} : { artwork }),
  };
  return {
    metadata: { ...extracted, ...explicit },
    ...(Number.isFinite(parsed.format.duration) && parsed.format.duration! >= 0 ? { duration: parsed.format.duration } : {}),
  };
}
