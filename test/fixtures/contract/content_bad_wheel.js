'use strict';
// 違反検体: content.js が wheel リスナを持つ（SPEC 7章で禁止。所有者は overlay.js ただ一人）。
// 旧 SPEC 時代のコードを模したもの。scan_contract.sh nowheel が捕まえること。
;(function () {
  var root = document.getElementById('movie_player');
  root.addEventListener('wheel', function (ev) {
    ev.preventDefault();
    var next = window.YTVP.stepFromWheel(50, ev.deltaY, { shift: ev.shiftKey });
    void next;
  }, { passive: false });
})();
