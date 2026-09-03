'use strict';
// fixture: プロトコル相対 URL の「生 IPv6」形（ブラケット表記）。
// 生 IPv4 と同じ理由で、英字 TLD を要求する規則では当たらない。
var u = "//[2001:db8::1]/collect";
var v = '//[::1]:9000/x';
