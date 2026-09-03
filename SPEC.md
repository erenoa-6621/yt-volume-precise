# SPEC（確定した契約。実装はこれを勝手に変えない）

実装は複数のファイルに分かれる。**契約を変えたくなったら、実装で押し切らず、まずこの文書を直す。**

## 0. 前提

- ビルド工程なし。npm 依存なし。素の JS/CSS/HTML のみ。
- content script は **classic script**（MV3 は content_scripts の ESM を許さない）。
  よって `import` は使わない。共有ロジックは `src/lib/volume.js` がグローバル `YTVP` に生やす。
- Node のテストから同じファイルを `require()` できるよう、`src/lib/volume.js` は
  末尾で `module.exports` にも同じ API を代入する（下記ひな形）。
- `package.json` は置かない（`.js` を CJS のまま扱うため）。

## 1. ファイル配置と担当

```
manifest.json          [A]
src/lib/volume.js      [A]  純粋ロジック（DOM に触れない）
src/page.js            [A]  MAIN world ブリッジ
src/content.js         [A]  ISOLATED world 本体
src/overlay.js         [B]  プレイヤー内オーバーレイ UI
src/overlay.css        [B]
src/popup.html         [B]
src/popup.css          [B]
src/popup.js           [B]
test/volume.test.js    [C]
test/manifest.test.js  [C]
tools/scan_permissions.sh [C]
tools/scan_network.sh     [C]
verify.sh              [C]
```

## 2. `src/lib/volume.js` の API（署名は固定。test/volume.test.js が検査する）

ひな形（この外殻は変えない）:

```js
;(function (root) {
  'use strict';
  // ... 実装 ...
  var api = { MIN_VOL, MAX_VOL_PLAIN, MAX_VOL_BOOST, DEFAULT_PRESETS,
              clampVolume, parseVolumeInput, normalizePresets,
              volumeToGain, channelKey, stepFromWheel };
  if (typeof module !== 'undefined' && module.exports) { module.exports = api; }
  root.YTVP = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
```

| 名前 | 仕様 |
|---|---|
| `MIN_VOL` | `0` |
| `MAX_VOL_PLAIN` | `100` |
| `MAX_VOL_BOOST` | `300` |
| `DEFAULT_PRESETS` | `[15, 30, 50, 70, 100]` |
| `clampVolume(value, opts)` | `opts = {boost=false, fallback=50}`。数値に解釈できない値（`null`/`undefined`/`NaN`/非数文字列/`Infinity`）は `fallback` を返す。それ以外は `Math.round` して `0`〜(`boost` なら 300 / さもなくば 100) に収める。戻り値は必ず整数。 |
| `parseVolumeInput(raw)` | 文字列/数値を受ける。前後空白除去、全角数字（`０-９`）を半角化、末尾の `%` を除去。整数に解釈できれば **クランプせず**その整数を返す。できなければ `null`。`""`・`null`・`undefined` は `null`。 |
| `normalizePresets(list, opts)` | `opts = {boost=false}`。配列以外なら `DEFAULT_PRESETS` のコピー。各要素を `clampVolume` で整数化（解釈不能な要素は捨てる）、重複除去、昇順ソート、先頭 8 件まで。結果が空なら `DEFAULT_PRESETS` のコピー。**返す配列は `DEFAULT_PRESETS` と同一参照にしない**（呼び出し側の破壊を防ぐ）。 |
| `volumeToGain(volume)` | `clampVolume(volume, {boost:true})` した値 / 100 を返す。例: `100 -> 1`、`250 -> 2.5`、`0 -> 0`。 |
| `channelKey(raw)` | 文字列以外は `null`。前後空白除去 → 先頭の `@` を1個だけ除去 → 小文字化。結果が空文字なら `null`。 |
| `stepFromWheel(current, deltaY, opts)` | `opts = {shift=false, boost=false}`。刻みは `shift` なら 5、さもなくば 1。`deltaY < 0` で増、`deltaY > 0` で減、`deltaY === 0`（または非数）なら `clampVolume(current, {boost})` をそのまま返す。結果は `clampVolume` で丸める。 |

### 2-b. 第2章の曖昧点の確定（2026-09-02 追記。SPEC の穴だった）

- `parseVolumeInput` は **整数のみ**受ける。`"87.5"` は `null`。
- 除去する `%` は **半角 `%` のみ**。全角 `％`(U+FF05) は除去せず `null` を返す。
- `clampVolume` の `fallback` は**クランプしない**。範囲外の `fallback` はそのまま返す。

## 3. MAIN ⇄ ISOLATED のメッセージ契約（content.js と page.js の両側）

`document` 上の `CustomEvent`。

- ISOLATED → MAIN: 種別 `ytvp:cmd`、`detail = { id: string, action: string, payload?: object }`
  - `action: "get"` … payload なし
  - `action: "set"` … `payload = { volume: number }`（0〜300 の整数）
  - `action: "boost"` … `payload = { enabled: boolean }`
- MAIN → ISOLATED: 種別 `ytvp:res`、`detail = { id: string, ok: boolean, data?: object, error?: string }`
  - `get` の `data` = `{ volume: number, muted: boolean, boost: boolean, available: boolean }`

`id` は要求と応答の対応付け。MAIN 側は受け取った `id` をそのまま返す。

## 3-b. popup ⇄ content のメッセージ契約（★2026-09-02 新設。旧契約は動かない設計だった）

**旧契約の誤り**：ポップアップから `chrome.runtime.sendMessage` を投げても **content script には届かない**
（拡張ページからのメッセージは content script に配送されない）。実装中にこの穴が判明した。

**確定した方式**：ポップアップは `chrome.tabs` API を使う。**`tabs` 権限は追加しない**
（`chrome.tabs.query` は無権限でも `id` を返し、`chrome.tabs.sendMessage` は当該タブの host_permissions で足りる。
`url` は youtube の host_permissions を持つので YouTube タブに限り返る）。

```js
const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
const res = await chrome.tabs.sendMessage(tab.id, { type: 'get' });
```

メッセージ形状（popup が投げ、content が `chrome.runtime.onMessage` で応答する）:

| 要求 | 応答 |
|---|---|
| `{type:'get'}` | `{ok:true, state:{volume,muted,boost,available}}` |
| `{type:'set', volume:number}` | `{ok:true, state:{...}}` / 不正値は `{ok:false, error:'invalid-volume'}` |
| `{type:'setBoost', enabled:boolean}` | `{ok:true, state:{...}}` |
| `{type:'getSettings'}` | `{ok:true, settings:{presets:number[], boostAllowed:boolean, rememberChannel:boolean}}` |
| `{type:'setSettings', settings:{...}}` | `{ok:true, settings:{...}}` |

- 設定キーは **`presets` / `boostAllowed` / `rememberChannel`** で固定する（SPEC に無く、popup が content のコードから読んでいた）。
- 応答が無い・`chrome.runtime.lastError` が立つ・タブが YouTube でない場合、ポップアップは
  「YouTube を開いてください」を表示して静かに終わる。

## 3-c. 契約の空白を埋める（2026-09-02 決定）

SPEC 3-b の非対称・未定義が4件見つかった。決定は次のとおり。

1. **`boostAllowed` の既定は `false`。** SPEC 第4章「ブースト既定 OFF」の素直な読みはこれ。
   100 超は歪みと聴覚リスクを伴うので、明示的に ON にさせる。
   `boostAllowed:false` のとき、ポップアップの数値入力の上限は 100、`src/popup.html` の
   `<input type="number">` の `max` も **初期値 100** とし、ON になったら JS が 300 へ上げる。
2. **YouTube ホスト判定は `host_permissions` と完全一致させる。** 許可するのは
   `www.youtube.com` と `music.youtube.com` の2つだけ。`youtube.com`（サブドメイン無し）や
   `m.youtube.com` を通さない。**判定の範囲が権限の範囲より広いのは、権限を売りにする拡張として矛盾する。**
3. **`{type:'set'}` が `{ok:false,error:'invalid-volume'}` を返したら、ポップアップは
   `{type:'get'}` を投げ直して真の状態へ戻す**（実装側の提案を契約として採用）。get の失敗は再送しない。
4. **`{type:'setSettings'}` の不正値応答を `{ok:false, error:'invalid-settings'}` と定める**
   （`set` にはあって `setSettings` に無かった非対称を埋める）。

## 3-d. ブーストは1つの概念に統合する（2026-09-02 決定。結合テストで発見）

**旧契約の誤り**：SPEC は `boost`（今の状態）と `boostAllowed`（許可）を別々に定義しておきながら、
**両者の関係を1行も書いていなかった。** 結果、実装は `setBoost` で両方を同じ storage に書き、
ポップアップは `boostAllowed === true` でないとトグルを押せない作りになり、
**一度 OFF にすると許可ごと消えて二度と ON に戻せない一方通行**が生まれた（実測で確認）。

**確定**：`boostAllowed` と `boost` は **同一の概念**とする。ユーザーが押すトグルは1つだけ。

- `settings.boostAllowed` が、ブーストが有効かどうかの**唯一の真実**。既定は `false`（3-c(1) を維持）。
- `state.boost` は `settings.boostAllowed` をそのまま反映する。両者が食い違う状態は存在しない。
- `{type:'setBoost', enabled}` が、この1つのフラグを **ON にも OFF にも**する。往復できること。
- **ブーストを切り替えるコントロールは、`boostAllowed` の値によって `disabled` にしても、
  非表示にしても、生成をやめてもならない。** これは**ポップアップと
  オーバーレイの両方**に適用する（★2026-09-02 範囲を訂正。原則を書きながら適用範囲を
  ポップアップだけに絞っていたため、オーバーレイに同型の残存が見つかった）。
  無効化してよいのは「オフライン（content と疎通していない）」ときだけ。
  **自分自身の値で自分を押せなくする作りは、必ず一方通行を生む。**
  この原則は `boostAllowed` に限らない。**あるフラグを切り替えるコントロールの可否を、
  そのフラグ自身で決めてはならない。**
- `boostAllowed` が `false` のとき上限 100・`true` のとき上限 300 は 3-c(1) のまま。

## 3-e. 楽観更新の線引きと「オフライン」の定義（2026-09-02 決定）

「ブーストは楽観更新を廃止したのに、オーバーレイの音量変更は楽観更新のまま。方針が不揃い」
という指摘が出た。**不揃いのままにする。ただし理由をここに書く。**

1. **音量の変更は楽観更新してよい**（オーバーレイ・ポップアップとも）。
   ホイールやドラッグで連続的に動かす操作なので、応答を待つと操作そのものが壊れて感じる。
   ずれても次の `update(state)` で即座に真実へ戻る。
2. **ブースト・チャンネル記憶のトグルは楽観更新しない。** 離散的な ON/OFF であり、
   content が死んでいるのに UI だけ ON になった状態が放置される害のほうが大きい。
   失敗したら見た目を変えず、オフライン表示へ落とす。
3. **「一貫性のために揃える」ではなく「操作の性質に合わせる」を採る。**
   理由を書かない不揃いは、次に読む人には単なるバグに見える。だからここに書いた。

### オフラインの定義（契約の穴を埋める）

SPEC 3-d は「無効化してよいのはオフラインのときだけ」と書いたが、
**オーバーレイの `bridge` には疎通状態を表す口が無い**。当面は次で確定する。

- ポップアップの「オフライン」＝ content と疎通できない（応答なし / `lastError` / 非 YouTube タブ）。
- オーバーレイの「オフライン」＝ `state.available === false`（プレーヤーが見つからない）で**代用する**。
  オーバーレイは content script と同じページに居るので、疎通不能はほぼ起きない。
  **これは近似であって同義ではない。** 厳密にするなら `bridge` に疎通状態を足すが、
  実害が観測されるまでは足さない（様式を厚くして精度を買おうとしない）。

## 4. 音量の当て先（page.js）

- **必ず `document.getElementById('movie_player').setVolume()` / `.getVolume()` を使う。**
  `<video>.volume` を直接書かない（YouTube の UI と乖離し、動画遷移でリセットされる）。
- 100 を超える分は Web Audio で作る：`AudioContext` → `createMediaElementSource(video)` →
  `GainNode`（`volumeToGain`）→ `DynamicsCompressorNode` → `destination`。
  - `createMediaElementSource` は 1 要素につき 1 回しか呼べない。要素ごとに保持して使い回す。
  - **ブースト既定 OFF。** OFF のときは Web Audio を一切挿さない（挿すと元に戻せないため）。
  - 100 以下では player 側の `setVolume` のみを使い、gain は 1.0 に保つ。
- SPA 遷移は `yt-navigate-finish` を `window` で購読して再バインドする。

## 5. `src/overlay.js` の API（content.js が呼ぶ。署名は固定）

`window.YTVPOverlay.mount(bridge, options)` を生やす（classic script）。

- `bridge` = `{ getState(): Promise<{volume,muted,boost,available}>, setVolume(v): Promise<void>, setBoost(b): Promise<void>, subscribe(cb): void }`
  - `subscribe(cb)` に渡した `cb(state)` は、content 側が状態変化のたびに呼ぶ。
- `options` = `{ presets: number[], boostAllowed: boolean }`
  - **`boostAllowed` はボタンを出すか出さないかの判定に使ってはならない**（SPEC 3-d）。
    ブーストボタンは**常に生成する**。`boostAllowed` はその**初期表示（ON/OFF）と上限**にのみ使う。
- 戻り値 = `{ destroy(): void, update(state): void }`
- **overlay.js は `chrome.*` API を呼ばない**（設定の読み書きは content.js の責務）。渡された値を描くだけ。

## 6. UI デザイン指針（overlay.js / overlay.css が従う）

- **YouTube 赤（#FF0000 系）を使わない。** 公式と誤認させない。
- カラートークン（`:root` に CSS 変数で定義。`prefers-color-scheme` で light も定義）
  - `--ytvp-bg: #0F1115` / `--ytvp-surface: #181B22` / `--ytvp-line: #2A2F3A`
  - `--ytvp-text: #E7EAF0` / `--ytvp-muted: #97A0B0`
  - **【2026-09-03 撤回】独自アクセント色（mint `#5EE6A8` / amber `#FF9F45`）と
    「100 を超えたら色が変わる＝警告」という設計は、実機で「design が浮いて見える」と
    分かったため**廃止した**。
    **YouTube のプレイヤー UI は白と黒だけで、色は進行バーの赤しか使わない。**
    独自の色を持ち込むこと自体が異物感の主因だった。文字は白に統一する。
  - **フォントは宣言せず継承する。** 公式 CSS の実物：
    `.html5-video-player { font-family: "YouTube Noto", Roboto, …; font-size: 11px }` /
    `.ytp-button { font-family: inherit; font-size: 100%; color: inherit }`。
    **YouTube 自身のボタンが継承している**ので、同じにすれば言語・環境・将来の変更に自動追随する。
    プレイヤーが居ないポップアップ側だけ、同じ指定を明示する。
  - ブーストの ON/OFF は **YouTube 式のトグルスイッチ**で示す（色に頼らない）。
- 角丸 10px、`backdrop-filter: blur(12px)`、影は控えめ。枠線 1px `--ytvp-line`。
- 現在値は大きく `font-variant-numeric: tabular-nums`（桁で幅が揺れない）。
- プリセットは pill 型ボタン。現在値と一致するものだけ塗る。
- 遷移は 120ms。`@media (prefers-reduced-motion: reduce)` で 0 にする。
- ポップアップ幅 320px。UI 文言は日本語。
- **オーバーレイは既定で折りたたみ**（小さなハンドルのみ）。動画の邪魔をしない。

## 7. 操作（content.js が配線・overlay.js が見た目）

- ポップアップ：数値入力（Enter で確定）、プリセット pill、ブースト切替、チャンネル記憶切替。
- ホイール：**所有者は `src/overlay.js` ただ一人**（★2026-09-02 確定）。
  オーバーレイのルート要素上で 1 刻み、Shift 併用で 5 刻み。刻みの計算は `window.YTVP.stepFromWheel` を使う。
  **`src/content.js` は wheel リスナを一切持たない。** 旧 SPEC は content と overlay の双方にホイールを書かせており、
  二重発火と「オーバーレイのルート要素名を content 側が当て推量する」穴を生んでいた。契約の誤り。
  オーバーレイのルート要素は **必ず `class="ytvp-root"` を持つ**（契約）。
- チャンネル別記憶：既定 **OFF**。ON のとき `chrome.storage.local` に `ch:<channelKey>` で保存。

## 8. 終了条件

`./verify.sh` が **exit 0**。ブラウザ実機の動作確認は含めない（人間の手が要るため）。

## 9. ネイティブ統合UI（2026-09-02・v0.2）

実機検証通過後、「Loop ボタンのように、YouTube の既存画面に UI を足す方針で」という要望を受けた増分。

### 9-a. 何を作るか
- YouTube のプレイヤー右下コントロール群（設定⚙などが並ぶ `.ytp-right-controls`）に、
  **現在の音量の数値を表示するボタン**を1つ差し込む（`ytp-button` の見た目に揃える）。
- クリックで既存のパネル（数値入力・プリセット pill・ブースト）がボタンの上に開く。
  パネルの中身・挙動は既存オーバーレイと同一（新しい操作体系を作らない）。
- ボタンの数値は音量変化に追随する（subscribe 経由。ブースト域では `--ytvp-boost` 色）。

### 9-b. 失敗時の振る舞い（この増分の肝）
- **`.ytp-right-controls` が見つからない・差し込みに失敗した場合は、黙って従来の
  浮きハンドル（`ytvp-root` の折りたたみ）に戻る。** 例外を外に漏らさない。
- ポップアップは常に独立して動く（ネイティブ統合が全滅しても機能は死なない）。
- **YouTube Music（music.youtube.com）はネイティブ統合の対象外**。DOM が別物なので
  従来の浮きハンドルのまま。判定は content.js が行う。

### 9-c. 責務の分割（依存を散らばらせない）
- **YouTube の DOM を探すのは content.js だけ。** `.ytp-right-controls` の探索・
  SPA 遷移時の再探索（`yt-navigate-finish`）・music の除外判定は content.js が持つ。
- **overlay.js は渡された要素に描くだけ。** YouTube 固有のセレクタを overlay.js に
  書いてはならない（`#movie_player` への既存フォールバックのみ例外として維持）。
- 契約：`mount(bridge, options)` の `options` に **`nativeAnchor`** を追加する。
  - `nativeAnchor: Element` … その要素の**先頭**にネイティブボタンを挿し、パネルをボタン基準で開く
  - `nativeAnchor: null | undefined` … 従来どおり浮きハンドル（完全な後方互換）
  - `nativeAnchor` が不正（Element でない・appendChild 不能）なら**例外を投げず**浮きハンドルへ
- 戻り値 `{destroy, update}`・`class="ytvp-root"` の契約・chrome.* 禁止は不変。

### 9-d. 検査（KNOWN_GAPS A節の弱点拡大への対抗）
- 結合テストに「偽 DOM に `.ytp-right-controls` がある場合＝ボタンがそこに入る／
  無い場合＝浮きハンドルに戻る／anchor が不正でも落ちない」を追加する。
- YouTube 実 DOM の変化は機構では検知できない。**それはこの増分で新たに増えた
  既知の穴**として KNOWN_GAPS に1行追加する。

## 10. パネルの数値入力（2026-09-02・v0.3）

**製品の出発点は「ゲージでは細かく合わせられないから数値で入力したい」だった。**
にもかかわらず、オーバーレイ／ネイティブのパネルには数値入力が無く、主役がスライダー（＝ゲージ）に
なっていた。SPEC 第5章を書いたときに数値入力を契約へ入れ忘れたのが原因。是正する。

### 10-a. 仕様
- パネル上部の readout（大きな数値表示）**それ自体を入力欄にする**。
  - 常時 `<input type="text" inputmode="numeric">`（見た目は従来の readout と同じ：
    大きな数字・`tabular-nums`・枠なし。フォーカス時だけ下線等で編集中と分かる控えめな表示）
  - **Enter で確定**：`window.YTVP.parseVolumeInput` で解釈し、解釈できれば `bridge.setVolume`。
    解釈できなければ（"abc" 等）**適用せず**現在値の表示へ戻す。
  - **Esc とフォーカス喪失（blur）は適用せず**現在値へ戻す（ポップアップの Enter 確定と同じ意味論）。
- **編集中は `update(state)` が入力欄の中身を上書きしない**（フォーカス中は readout の再描画を
  スキップする）。これを守らないと、入力の最中に subscribe の更新が来て打った数字が消える。
  フォーカスが外れたら次の update から通常どおり反映する。
- スライダー・プリセット・ブーストは従来どおり残す（数値入力の**補助**であって主役ではない）。
- **パネルを開いたら、入力欄に自動フォーカスして全選択する**（★10-a 追補）。
  効果は2つ：①「ボタンをクリック→数字を打つ→Enter」の3動作で完結する
  ②ボタンにフォーカスが残ったままキーが YouTube へ抜ける穴（数字キー=シーク）が塞がる。
  パネルを閉じるときはフォーカスを外す（blur。入力途中の値は適用しない＝既存の blur 意味論どおり）。
- キーボードイベント（keydown 等）は**パネル内で stopPropagation する**。
  YouTube はプレイヤー上のキー入力（数字キー=シーク、k=停止 等）を拾うため、
  入力欄に「50」と打つと動画が50%位置へシークする事故になる。これを止めること。
- ポップアップ側は既存の入力欄のまま変更しない。

### 10-b. 検査
- 結合テスト：入力欄が存在する／"87"+Enter が `setVolume(87)` に流れる／"abc"+Enter は
  setVolume が飛ばず表示が戻る／編集中（フォーカス中）に update が来ても入力中の文字が保持される。
- 空振り証明：入力欄を生成しない検体・Enter を配線しない検体で、狙ったテストだけが赤くなること。

## 11. ネイティブボタンの置き場所（2026-09-02・v0.4）

> いま、UIが右の雑多の方にあるけど、これを既存の音量の方によせれませんか？
> ２か所音量調整があると面倒だと思うの

正しい指摘。音量の道具が左右2か所に割れていた。**音量の道具は音量の隣に置く。**

### 11-a. 仕様
- ボタンの差し込み先を `.ytp-right-controls` の先頭から、**`.ytp-left-controls` の中の
  純正音量領域（`.ytp-volume-area`。無ければ `.ytp-mute-button`）の**直前**へ移す。
  **右隣（直後）に置いてはならない。** 2026-09-03 の実機で「ボタンが押せない」が出た。
  純正の音量スライダーはホバーで**右へ伸びる**（実測：畳んだ状態は 40x40）ため、
  右隣のボタンは押しに行く途中で押しのけられる／覆われる。左隣なら伸びる向きの外側。
  並びは「再生 → 数値ボタン → 🔊(純正) → 時間表示」。
- 探索は従来どおり content.js に集約（SPEC 9-c）。フォールバックの序列：
  ①左（音量の隣）→ ②右コントロール先頭（v0.2〜v0.3 の位置）→ ③浮きハンドル。
  どの段も**黙って**次へ落ちる。
- パネルはボタン基準で**左寄せ**に開く（左端配置で右寄せのままだとプレイヤー外へはみ出す）。

### 11-b. 契約の変更（mount options）
- `nativeAnchor: Element` … 差し込む親（従来どおり）
- **`nativeBefore: Element | null` を追加** … 指定があれば `insertBefore(btn, nativeBefore)`、
  null/未指定/不正なら従来どおり先頭へ（後方互換）。不正値で例外を投げない。
- **`nativeAlign: 'left' | 'right'` を追加**（既定 `'right'`＝従来）… パネルの寄せ方向。
  overlay は値を CSS クラスに写すだけで、**左右の判断はしない**（判断は content.js。
  overlay に YouTube セレクタを持ち込まない原則の維持）。
- content.js は左に挿せたとき `nativeAlign:'left'`、右フォールバック時 `'right'` を渡す。

### 11-c. 検査
- 結合テスト：左構造がある偽DOMで「音量領域の**直前**」に入ること（後でも末尾でもない）／
  左が無く右だけある偽DOMで従来位置に入ること／どちらも無ければ浮きハンドル。
- 空振り証明：`nativeBefore` を無視して先頭に挿す検体・align を写さない検体で赤。

## 12. プリセットの編集（2026-09-02・v0.5）

> １５，３０とか固定のプリセットあるけど、デフォルトはこれでいいからある程度自由に変えれるようにしたい。

土台（storage の `presets`・`normalizePresets`・setSettings 経路）は v0.1 から存在する。
無いのは編集 UI だけ。

### 12-a. 仕様
- **編集はポップアップに置く**（設定の置き場所はポップアップ、プレイヤー内パネルは操作専用、の
  役割分担を維持）。パネル側には編集 UI を足さない。
- ポップアップに1行のテキスト欄＋適用ボタン（既存の意味論に合わせ Enter でも適用）を追加。
  - 表示：現在のプリセットを空白区切りで（例 `15 30 50 70 100`）
  - 入力：空白・カンマ・読点・スラッシュ等の非数字で区切られた数の列。各断片は
    `parseVolumeInput` で解釈し、解釈できない断片は黙って捨てる
  - 適用：`{type:'setSettings', settings:{presets:[…]}}`。**正規化は content 側の
    `normalizePresets` に任せ、popup で二重実装しない**（重複除去・昇順・最大8個・
    boost 状態に応じた丸めは既存仕様どおり）
  - 適用後：応答の `settings.presets`（＝実際に保存された値）で欄と pill を描き直す。
    打った値と違う形で残った場合、それが正規化の結果である
- **空欄で適用＝既定 `DEFAULT_PRESETS`（15/30/50/70/100）へのリセット**（`normalizePresets` の
  既存挙動。リセットボタンは作らない）
- **プレイヤー内パネルの pill にも反映する**：content.js は setSettings で presets が変わったら
  オーバーレイを作り直す（unmount → mount。稀な操作なので作り直しのコストは許容）。
  ポップアップ側の pill は応答で描き直す（既存挙動）。

### 12-b. 検査
- 結合テスト：popup から `presets:[40,10,10,999]` を送る →（boost OFF なら）`[10,40,100]` に
  正規化されて保存され、popup の pill・overlay の pill の両方に反映される／
  空配列 → DEFAULT_PRESETS に戻る／pill を押すと新しい値が適用される
- 空振り証明：編集を配線しない検体・overlay へ反映しない検体で赤

## 13. 巻き戻しと再適用の方針（2026-09-03 決定）

**事故の記録**：v0.3（パネルの数値入力）・v0.4（ボタンを左へ）・v0.5（プリセット編集）を
**実機で一度も確認しないまま3つ重ねて出し、実機で操作不能になった。**
毎回「実機未確認」と文書に書きながら、確認を挟まずに次を積んでいた。
**書いていたのに、やらなかった。** 検査の穴ではなく進め方の誤り。

**方針**：「動いていた状態に、場所の変更だけを乗せる」。

### 13-a. 決定
1. `src/` を **`b92e7d4`（v0.2＝実機で動作確認済み）へ巻き戻す**。
   失うもの：パネルの数値入力・プリセット編集・左配置。ポップアップの数値入力は v0.2 に在るので残る。
2. その上に **配置の移動（第11章）だけ**を乗せる。
3. **実機確認を挟んでから**、次の1つを乗せる。以後この順序を守る。
   再適用の順（予定）：①配置 → ②パネルの数値入力（第10章）→ ③プリセット編集（第12章）
4. 第10章・第11章・第12章の仕様は**破棄しない**。順に再適用するための契約として残す。

### 13-b. 恒久ルール
- **実機でしか確かめられない変更は、1つ出して確認を得るまで次を積まない。**
  「未確認」と書くことは、確認したことにならない。
- 巻き戻しは失敗ではなく、**未検証の積み上げを解く唯一の手段**である。
