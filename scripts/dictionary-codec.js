// Build-time lossless LZW packing. Runtime decoding uses only standard JS.
function pack(text) {
  const alphabet = Array.from(new Set(text.split(''))).join('');
  const initial = () => new Map(alphabet.split('').map((char, index) => [char, index + 1]));
  let table = initial(); let next = alphabet.length + 1; let previous = ''; const codes = [];
  for (const char of text) {
    const word = previous + char;
    if (table.has(word)) { previous = word; continue; }
    codes.push(table.get(previous));
    if (next < 65535) table.set(word, next++);
    else { codes.push(0); table = initial(); next = alphabet.length + 1; }
    previous = char;
  }
  if (previous) codes.push(table.get(previous));
  const bytes = Buffer.alloc(codes.length * 2);
  codes.forEach((code, index) => bytes.writeUInt16LE(code, index * 2));
  return { alphabet, packed: bytes.toString('base64') };
}
function unpack(packed, alphabet) {
  const base = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  const bytes = []; let bits = 0; let buffer = 0;
  for (let i = 0; i < packed.length; i += 1) {
    const value = base.indexOf(packed[i]); if (value < 0) break;
    buffer = (buffer << 6) | value; bits += 6;
    if (bits >= 8) { bits -= 8; bytes.push((buffer >> bits) & 255); }
  }
  const initial = () => [''].concat(alphabet.split(''));
  let table = initial(); let previous = ''; const result = [];
  for (let i = 0; i < bytes.length; i += 2) {
    const code = bytes[i] | (bytes[i + 1] << 8);
    if (code === 0) { table = initial(); previous = ''; continue; }
    const word = table[code] || (code === table.length && previous ? previous + previous[0] : '');
    if (!word) throw new Error('Invalid packed dictionary');
    result.push(word);
    if (previous) table.push(previous + word[0]);
    previous = word;
  }
  return result.join('');
}
module.exports = { pack, unpack };
