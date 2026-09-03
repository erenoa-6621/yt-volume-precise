'use strict';
// fixture: UI が直接 chrome.storage を触っている（SPEC 第5章違反）
window.YTVPOverlay = {
  mount: function () {
    chrome.storage.local.get('presets', function () {});
  }
};
