import { deflateRawSync } from "node:zlib";

function crc(bytes) {
  let c = 0xffffffff;
  for (const b of bytes) { c ^= b; for (let n = 0; n < 8; n++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1)); }
  return (c ^ 0xffffffff) >>> 0;
}
export function zip(entries, { descriptor = false } = {}) {
  const local = [], central = []; let offset = 0;
  for (const [name, raw, mode = 0o100644] of entries) {
    const bytes = Buffer.from(raw), filename = Buffer.from(name), data = deflateRawSync(bytes), checksum = crc(bytes);
    const h = Buffer.alloc(30); h.writeUInt32LE(0x04034b50); h.writeUInt16LE(20, 4); h.writeUInt16LE(descriptor ? 8 : 0, 6); h.writeUInt16LE(8, 8);
    if (!descriptor) { h.writeUInt32LE(checksum, 14); h.writeUInt32LE(data.length, 18); h.writeUInt32LE(bytes.length, 22); }
    h.writeUInt16LE(filename.length, 26);
    const d = descriptor ? Buffer.alloc(16) : Buffer.alloc(0);
    if (descriptor) { d.writeUInt32LE(0x08074b50); d.writeUInt32LE(checksum, 4); d.writeUInt32LE(data.length, 8); d.writeUInt32LE(bytes.length, 12); }
    const c = Buffer.alloc(46); c.writeUInt32LE(0x02014b50); c.writeUInt16LE(0x314, 4); c.writeUInt16LE(20, 6);
    c.writeUInt16LE(descriptor ? 8 : 0, 8); c.writeUInt16LE(8, 10); c.writeUInt32LE(checksum, 16); c.writeUInt32LE(data.length, 20);
    c.writeUInt32LE(bytes.length, 24); c.writeUInt16LE(filename.length, 28); c.writeUInt32LE((mode * 65536) >>> 0, 38); c.writeUInt32LE(offset, 42);
    local.push(h, filename, data, d); central.push(c, filename); offset += h.length + filename.length + data.length + d.length;
  }
  const cd = Buffer.concat(central), end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50); end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10); end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, cd, end]);
}
