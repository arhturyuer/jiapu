let current = null;

function set(value) {
  current = value || null;
}

function take() {
  const value = current;
  current = null;
  return value;
}

function clear() {
  current = null;
}

module.exports = { set: set, take: take, clear: clear };
