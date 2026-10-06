module.exports = function (getRect) {
  return function () {
    const selectors = [];
    const query = {
      in: function () { return query; },
      select: function (selector) { selectors.push(selector); return query; },
      boundingClientRect: function () { return query; },
      exec: function (callback) {
        callback(selectors.map(function (selector) {
          return getRect ? getRect(selector) : { width: 320, height: 100 };
        }));
      }
    };
    return query;
  };
};
