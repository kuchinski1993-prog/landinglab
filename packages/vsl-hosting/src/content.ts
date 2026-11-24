/** Bounded structural checks supplement signatures; never invokes codecs or received code. */
export function validateBinary(ext: string, bytes: Buffer): void {
  const invalid = () => {
    throw new Error('Invalid binary container');
  };
  const length = bytes.length;
  if (['ttf', 'otf'].includes(ext)) {
    if (length < 12) invalid();
    const tables = bytes.readUInt16BE(4);
    if (!tables || 12 + tables * 16 > length) invalid();
    for (let i = 0; i < tables; i++) {
      const offset = bytes.readUInt32BE(12 + i * 16 + 8),
        size = bytes.readUInt32BE(12 + i * 16 + 12);
      if (offset + size > length) invalid();
    }
  } else if (['woff', 'woff2'].includes(ext)) {
    const header = ext === 'woff' ? 44 : 48;
    if (length < header || bytes.readUInt32BE(8) !== length || bytes.readUInt16BE(12) === 0)
      invalid();
    if (ext === 'woff' && header + bytes.readUInt16BE(12) * 20 > length) invalid();
  } else if (ext === 'png') {
    let cursor = 8,
      ihdr = false,
      end = false;
    while (cursor + 12 <= length) {
      const size = bytes.readUInt32BE(cursor),
        tag = bytes.subarray(cursor + 4, cursor + 8).toString();
      if (cursor + size + 12 > length) invalid();
      if (!ihdr) {
        if (
          tag !== 'IHDR' ||
          size !== 13 ||
          bytes.readUInt32BE(cursor + 8) === 0 ||
          bytes.readUInt32BE(cursor + 12) === 0
        )
          invalid();
        ihdr = true;
      }
      cursor += size + 12;
      if (tag === 'IEND') {
        if (size !== 0 || cursor !== length) invalid();
        end = true;
        break;
      }
    }
    if (!ihdr || !end) invalid();
  } else if (['jpg', 'jpeg'].includes(ext)) {
    if (length < 4 || bytes.readUInt16BE(length - 2) !== 0xffd9) invalid();
  } else if (ext === 'gif') {
    if (
      length < 14 ||
      bytes.readUInt16LE(6) === 0 ||
      bytes.readUInt16LE(8) === 0 ||
      bytes[length - 1] !== 0x3b
    )
      invalid();
  } else if (ext === 'webp') {
    if (
      length < 20 ||
      bytes.readUInt32LE(4) + 8 !== length ||
      !['VP8 ', 'VP8L', 'VP8X'].includes(bytes.subarray(12, 16).toString())
    )
      invalid();
  } else if (ext === 'ico') {
    if (length < 22) invalid();
    const count = bytes.readUInt16LE(4);
    if (!count || 6 + count * 16 > length) invalid();
    for (let i = 0; i < count; i++)
      if (bytes.readUInt32LE(6 + i * 16 + 8) + bytes.readUInt32LE(6 + i * 16 + 12) > length)
        invalid();
  } else if (['avif', 'mp4', 'm4a'].includes(ext)) {
    let cursor = 0;
    const tags: string[] = [];
    while (cursor + 8 <= length) {
      const size = bytes.readUInt32BE(cursor),
        tag = bytes.subarray(cursor + 4, cursor + 8).toString();
      if (size < 8 || cursor + size > length) invalid();
      tags.push(tag);
      cursor += size;
    }
    if (
      cursor !== length ||
      !tags.includes('ftyp') ||
      !(ext === 'avif' ? tags.includes('meta') : tags.includes('moov') && tags.includes('mdat'))
    )
      invalid();
  } else if (ext === 'wav') {
    if (length < 44 || bytes.readUInt32LE(4) + 8 !== length) invalid();
    let cursor = 12,
      fmt = false,
      data = false;
    while (cursor + 8 <= length) {
      const tag = bytes.subarray(cursor, cursor + 4).toString(),
        size = bytes.readUInt32LE(cursor + 4);
      if (cursor + 8 + size > length) invalid();
      if (tag === 'fmt ') {
        if (size < 16) invalid();
        fmt = true;
      }
      if (tag === 'data' && size) data = true;
      cursor += 8 + size + (size % 2);
    }
    if (!fmt || !data) invalid();
  } else if (ext === 'ogg') {
    if (length < 28 || 27 + bytes[26]! > length) invalid();
    const payload = bytes.subarray(27, 27 + bytes[26]!).reduce((a, b) => a + b, 0);
    if (!payload || 27 + bytes[26]! + payload > length) invalid();
  } else if (ext === 'webm') {
    if (
      length < 24 ||
      !bytes.subarray(0, 256).includes(Buffer.from('webm')) ||
      !bytes.includes(Buffer.from([0x18, 0x53, 0x80, 0x67]))
    )
      invalid();
  } else if (ext === 'mp3') {
    let offset = 0;
    if (bytes.subarray(0, 3).toString() === 'ID3') {
      if (length < 10 || bytes.subarray(6, 10).some((b) => b & 128)) invalid();
      offset = 10 + bytes.subarray(6, 10).reduce((a, b) => a * 128 + b, 0);
    }
    if (offset + 4 >= length || bytes[offset] !== 255 || (bytes[offset + 1]! & 224) !== 224)
      invalid();
  }
}
