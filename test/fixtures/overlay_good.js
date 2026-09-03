'use strict';
// fixture: chrome を触らない UI（正しい形）
window.YTVPOverlay = {
  mount: function (bridge, options) {
    return { destroy: function () {}, update: function (state) { void state; } };
  }
};
