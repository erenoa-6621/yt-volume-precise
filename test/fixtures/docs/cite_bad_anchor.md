# 行番号は範囲内だが内容が違う検体（NG-1 と同じ形）

行番号 4 は実在する（volume.js は 121 行ある）。だが 4 行目は `MIN_VOL` の宣言であって
`DEFAULT_PRESETS` ではない。範囲チェックだけではこれを捕まえられない。

プリセットの既定値は5個（src/lib/volume.js:4 `DEFAULT_PRESETS`）。
