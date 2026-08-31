// Wrap a 256x256 PNG into a single-entry .ico (PNG-compressed, Vista+):
// node tools/makeico.js <src.png> <dst.ico>
import fs from 'node:fs';

const [src, dst] = process.argv.slice(2);
const png = fs.readFileSync(src);
const header = Buffer.alloc(6);
header.writeUInt16LE(0, 0); // reserved
header.writeUInt16LE(1, 2); // type: icon
header.writeUInt16LE(1, 4); // count
const entry = Buffer.alloc(16);
entry[0] = 0; // width 256
entry[1] = 0; // height 256
entry[2] = 0; // palette
entry[3] = 0; // reserved
entry.writeUInt16LE(1, 4);  // planes
entry.writeUInt16LE(32, 6); // bpp
entry.writeUInt32LE(png.length, 8);
entry.writeUInt32LE(22, 12); // offset
fs.writeFileSync(dst, Buffer.concat([header, entry, png]));
console.log(`wrote ${dst} (${png.length + 22} bytes)`);
