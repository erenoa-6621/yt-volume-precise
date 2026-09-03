'use strict';
// fixture: 別スレッドの起動と Blob URL。コードを起こして実行する経路。
// 注: この検体のコメントに検査対象の字面を書かないこと。
var blob = new Blob(["postMessage(1)"], { type: "text/javascript" });
var w = new Worker(URL.createObjectURL(blob));
