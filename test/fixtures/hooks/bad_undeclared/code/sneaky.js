'use strict';
// 検体: あとから足された未宣言のフック。verify.sh が unset しないので穴が復活する。
const p = process.env.YTVP_SNEAKY_PATH || 'src/lib/volume.js';
module.exports = { p };
