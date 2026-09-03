'use strict';
// fixture: manifest から参照されていない置き忘れ。src/ の外にあるので
// 旧来の「src 固定」走査では見えなかった（独立検証の指摘6）。収集対象に入ること。
var stray = 1;
