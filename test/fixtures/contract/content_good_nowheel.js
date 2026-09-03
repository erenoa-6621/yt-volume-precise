'use strict';
// 適合検体: wheel リスナを持たない content.js。
// ホイールは overlay.js が所有する（SPEC 7章）。ここでコメントに wheel と書いても違反にならないこと
// （コメント行は検査対象から外れる）も併せて見ている。
// 参考: overlay.addEventListener('wheel', ...) は B 側の責務。
;(function () {
  var player = document.getElementById('movie_player');
  document.addEventListener('ytvp:res', function (ev) { void ev; });
  window.addEventListener('yt-navigate-finish', function () { void player; });
})();
