/**
 * @module core/zip
 *
 * A zip archive from a list of text files, without compression.
 *
 * A run kit is a handful of small scripts and inputs; stored entries keep the
 * writer to the two record types every unzip reads, with no dependency. The
 * archive is written in the order the files are given, with the Unix
 * permission bits carried in the external attributes, so that an executable
 * script comes out executable from `unzip`.
 */

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

/**
 * CRC-32 of a byte array, as zip and gzip use it.
 *
 * @param {Uint8Array} bytes
 * @returns {number} Unsigned.
 */
export function crc32(bytes) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

function dosDateTime(date) {
  const d = date instanceof Date && !Number.isNaN(date.getTime()) ? date : new Date(2000, 0, 1);
  const year = Math.min(2107, Math.max(1980, d.getFullYear()));
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
  const day = ((year - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  return { time, day };
}

function encode(text) {
  return new TextEncoder().encode(String(text == null ? '' : text));
}

/**
 * Build a zip archive.
 *
 * @param {Array<{path:string, text?:string, bytes?:Uint8Array, executable?:boolean}>} files
 *        Paths use `/` and have no leading slash.
 * @param {{date?:Date}} [options]
 * @returns {Uint8Array}
 */
export function buildZip(files, options = {}) {
  const { time, day } = dosDateTime(options.date || new Date());
  const local = [];
  const central = [];
  let offset = 0;
  const seen = new Set();

  for (const f of files || []) {
    const path = String(f.path || '').replace(/\\/g, '/').replace(/^\/+/, '');
    if (!path || seen.has(path)) continue;
    seen.add(path);
    const name = encode(path);
    const data = f.bytes instanceof Uint8Array ? f.bytes : encode(f.text);
    const crc = crc32(data);
    // Unix mode in the high 16 bits: 0755 for a script, 0644 otherwise.
    const mode = f.executable ? 0o100755 : 0o100644;
    const external = (mode << 16) >>> 0;

    const head = new DataView(new ArrayBuffer(30));
    head.setUint32(0, 0x04034B50, true);
    head.setUint16(4, 20, true);
    head.setUint16(6, 0x0800, true);      // names are UTF-8
    head.setUint16(8, 0, true);           // stored
    head.setUint16(10, time, true);
    head.setUint16(12, day, true);
    head.setUint32(14, crc, true);
    head.setUint32(18, data.length, true);
    head.setUint32(22, data.length, true);
    head.setUint16(26, name.length, true);
    head.setUint16(28, 0, true);
    local.push(new Uint8Array(head.buffer), name, data);

    const dir = new DataView(new ArrayBuffer(46));
    dir.setUint32(0, 0x02014B50, true);
    dir.setUint16(4, (3 << 8) | 20, true); // made on Unix
    dir.setUint16(6, 20, true);
    dir.setUint16(8, 0x0800, true);
    dir.setUint16(10, 0, true);
    dir.setUint16(12, time, true);
    dir.setUint16(14, day, true);
    dir.setUint32(16, crc, true);
    dir.setUint32(20, data.length, true);
    dir.setUint32(24, data.length, true);
    dir.setUint16(28, name.length, true);
    dir.setUint16(30, 0, true);
    dir.setUint16(32, 0, true);
    dir.setUint16(34, 0, true);
    dir.setUint16(36, 0, true);
    dir.setUint32(38, external, true);
    dir.setUint32(42, offset, true);
    central.push(new Uint8Array(dir.buffer), name);

    offset += 30 + name.length + data.length;
  }

  const centralSize = central.reduce((n, p) => n + p.length, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054B50, true);
  end.setUint16(4, 0, true);
  end.setUint16(6, 0, true);
  end.setUint16(8, seen.size, true);
  end.setUint16(10, seen.size, true);
  end.setUint32(12, centralSize, true);
  end.setUint32(16, offset, true);
  end.setUint16(20, 0, true);

  const parts = [...local, ...central, new Uint8Array(end.buffer)];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}
