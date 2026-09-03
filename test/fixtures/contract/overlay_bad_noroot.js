'use strict';
// 違反検体: ルート要素が class="ytvp-root" を持たない overlay.js（SPEC 7章の契約違反）。
// content.js 側がルート要素を特定できなくなる。
;(function (root) {
  function mount(bridge, options) {
    var el = document.createElement('div');
    el.className = 'overlay-wrapper is-collapsed';
    void bridge; void options;
    return { destroy: function () {}, update: function () {} };
  }
  root.YTVPOverlay = { mount: mount };
})(typeof globalThis !== 'undefined' ? globalThis : this);
