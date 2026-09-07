// Decode once on first perspective view. Keys remain compact in memory.
let table;
let prefixes;
let tokenCodes;

function neutralToken(token) { return token.replace(/&[ol]$/, '').replace(/^[ol]([bs])$/, 'x$1'); }

function initialize() {
  if (table) return;
  const data = require('./kinship-data/dictionary');
  table = new Map();
  prefixes = new Set(['']);
  tokenCodes = {};
  data.tokens.forEach(function (token, index) { tokenCodes[token] = String.fromCharCode(65 + index); });
  let key = '';
  let label = '';
  data.encoded.split('\n').forEach(function (line) {
    const split = line.indexOf(' ');
    key = key.slice(0, line.charCodeAt(0) - 65) + line.slice(1, split);
    label = label.slice(0, line.charCodeAt(split + 1) - 65) + line.slice(split + 2);
    table.set(key, label);
    let neutral = '';
    for (let index = 0; index < key.length; index += 1) {
      const token = data.tokens[key.charCodeAt(index) - 65];
      if (token === '0' || token === '1') continue;
      neutral += tokenCodes[neutralToken(token)];
      prefixes.add(neutral);
    }
  });
}

function encode(tokens) {
  let result = '';
  for (let index = 0; index < tokens.length; index += 1) {
    if (!tokenCodes[tokens[index]]) return null;
    result += tokenCodes[tokens[index]];
  }
  return result;
}

function hasPrefix(tokens) {
  initialize();
  return prefixes.has(encode(tokens.map(neutralToken)));
}

function lookup(tokens, sex) {
  initialize();
  // Exact ages first; then neutral sibling order. Never invent a known age.
  const variants = [tokens, tokens.map(function (token) { return token.replace(/^[ol]([bs])$/, 'x$1'); })];
  for (let i = 0; i < variants.length; i += 1) {
    const key = encode(variants[i]);
    if (key === null) continue;
    if (sex !== 'unknown') {
      const qualified = tokenCodes[sex === 'male' ? '1' : '0'] + key;
      if (table.has(qualified)) return table.get(qualified);
    }
    if (table.has(key)) return table.get(key);
  }
  return '';
}

module.exports = { lookup: lookup, hasPrefix: hasPrefix, neutralToken: neutralToken };
