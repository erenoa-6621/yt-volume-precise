'use strict';
// 適合検体: ルート要素が class="ytvp-root" を持つ overlay.js（SPEC 7章の契約）。
;(function (root) {
  function mount(bridge, options) {
    var el = document.createElement('div');
    el.className = 'ytvp-root ytvp-is-collapsed';
    void bridge; void options;
    return { destroy: function () {}, update: function () {} };
  }
  root.YTVPOverlay = { mount: mount };
})(typeof globalThis !== 'undefined' ? globalThis : this);
