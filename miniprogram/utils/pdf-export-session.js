let current = null;
let sequence = 0;
function set(value) { const key = String(++sequence); current = { key: key, value: value }; return key; }
function take(key) { if (!current || current.key !== key) return null; const value = current.value; current = null; return value; }
function clear(key) { if (current && current.key === key) current = null; }
module.exports = { set: set, take: take, clear: clear };
