'use strict';
// fixture: 違反なし。プロトコル相対 URL 検査の「過検知」を検知するための対照検体。
// 行コメントは // で始まる。//で始まる語がコメント中にあっても違反ではない。
// 例: //example.com のような表記や、//foo.bar//baz といった記述もコメントである。
// 日本語コメントが大量にある実物の src を落とさないことを、この検体で機構として押さえる。
var ratio = 1 / 2; // 除算の // ではない
var path = '/watch'; // 単スラッシュで始まる相対パスは許可
var player = document.getElementById('movie_player'); //末尾コメント//区切り無し
