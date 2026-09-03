'use strict';
// fixture: 違反なし。過検知（fail-closed し過ぎ）を検知するための検体。
// youtube のホストは許可されている。
var HOME = 'https://www.youtube.com/';
var MUSIC = 'https://music.youtube.com/';
function retrieval(x) { return x; }
var prefetch = 1;
var evaluate = 'this word contains eval but is not a call';
document.getElementById('movie_player');
