'use strict';
/*
 * 文書中の `ファイル名:行番号` 引用を検査する本体。tools/scan_doc_cites.sh から呼ばれる。
 * 違反は "対象.md:LINE: 理由" 形式で stdout に出し、1件でもあれば exit 1。
 *
 * 設計の意図と限界は tools/scan_doc_cites.sh の冒頭コメントに書いてある（唯一の説明箇所）。
 * ここには実装上の細部だけを書く。
 */
const fs = require('node:fs');
const path = require('node:path');

// ------------------------------------------------------------------ 引用の抽出規則
// `名前.拡張子:N` / `名前.拡張子:N-M`。拡張子（ドット）を必須にしているのは
// `z-index: 60` や `chrome://extensions` や `ch:<チャンネル名>` を引用と誤読しないため。
// 直前が [A-Za-z0-9_./-] のときは拾わない（URL の `//host/a.b:1` 等の途中一致を避ける）。
const CITE_RE = /(?<![A-Za-z0-9_./\\-])([A-Za-z0-9_][A-Za-z0-9_./-]*\.[A-Za-z0-9]+):(\d+)(?:-(\d+))?(?![\d-])/g;

// アンカー語の最低長。短すぎる語はどこにでも当たるので検査の役に立たない。
const MIN_CODE_ANCHOR = 3;
// 「」引用の最低長。短い「」は UI のラベルや節名（例:「権限方針」）であって
// 引用先の逐語ではないことが多い。過検知を避けるため長いものだけをアンカーにする。
const MIN_QUOTE_ANCHOR = 8;

// basename の逆引きから外すディレクトリ。test/fixtures は「わざと壊した検体」置き場なので
// 文書の根拠になり得ない。.git / node_modules は走査コスト。
const RESOLVE_EXCLUDE = new Set(['.git', 'node_modules']);
const RESOLVE_EXCLUDE_PATHS = new Set(['test/fixtures']);

function walk(root, rel, out) {
  let ents;
  try {
    ents = fs.readdirSync(path.join(root, rel), { withFileTypes: true });
  } catch (e) {
    return;
  }
  for (const ent of ents) {
    const r = rel ? rel + '/' + ent.name : ent.name;
    if (RESOLVE_EXCLUDE.has(ent.name) || RESOLVE_EXCLUDE_PATHS.has(r)) continue;
    if (ent.isDirectory()) walk(root, r, out);
    else if (ent.isFile()) {
      if (!out.has(ent.name)) out.set(ent.name, []);
      out.get(ent.name).push(r);
    }
  }
}

function normalize(s) {
  // マークダウンの強調記号とバッククォートを落とし、空白を1つに畳む。
  // 引用先のインデントや折り返しに左右されずに突き合わせるため。
  return s.replace(/\*\*/g, '').replace(/[`*]/g, '').replace(/\s+/g, ' ').trim();
}

function usableAnchor(raw, minLen) {
  const a = normalize(raw);
  if (a.length < minLen) return null;
  // <...> を含むものは雛形（例: ch:<チャンネル名>）であって逐語ではない。
  if (/<[^>]*>/.test(a)) return null;
  // それ自体が引用の形をしているもの（例: `verify.sh:12`）はアンカーにしない。
  if (/^[A-Za-z0-9_./-]+:\d+(-\d+)?$/.test(a)) return null;
  return a;
}

function main(argv) {
  const args = argv.slice(2);
  let base = process.cwd();
  // 空振り検知の下限。「内容一致まで検査」した件数がこれを下回ったら赤にする。
  // アンカー規則が対象文書に当たらなくなったとき（＝検査が空になったとき）に鳴らすため。
  let minAnchorChecked = 0;
  const targets = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--base') { base = args[++i]; continue; }
    if (args[i] === '--min-anchor-checked') { minAnchorChecked = parseInt(args[++i], 10); continue; }
    targets.push(args[i]);
  }
  if (!(minAnchorChecked >= 0)) {
    console.log('usage: doc_cite_scan.js [--base DIR] [--min-anchor-checked N] [target.md ...]');
    return 2;
  }
  if (targets.length === 0) targets.push('INSTALL.md');

  const byName = new Map();
  walk(base, '', byName);

  const fileCache = new Map();
  function linesOf(rel) {
    if (!fileCache.has(rel)) {
      fileCache.set(rel, fs.readFileSync(path.join(base, rel), 'utf8').split('\n'));
    }
    return fileCache.get(rel);
  }

  let violations = 0;
  let total = 0;
  let anchorChecked = 0;
  let anchorSkipped = 0;

  for (const target of targets) {
    const abs = path.isAbsolute(target) ? target : path.join(base, target);
    if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) {
      console.log(`${target}:0: 対象のマークダウンが存在しない（検査できないので失敗扱い）`);
      violations++;
      continue;
    }
    const src = fs.readFileSync(abs, 'utf8').split('\n');

    // ---------------------------------------------------------- ブロック分割
    // ブロック = アンカー語を共有してよい範囲。段落・箇条書きの1項目・表の1行。
    // 空行 / 見出し / 箇条書きの開始 / 表の行 で切る。フェンス（```）の中は丸ごと除外。
    const blocks = [];
    let cur = null;
    let inFence = false;
    for (let i = 0; i < src.length; i++) {
      const line = src[i];
      if (/^\s*(```|~~~)/.test(line)) { inFence = !inFence; cur = null; continue; }
      if (inFence) { cur = null; continue; }
      const isBlank = /^\s*$/.test(line);
      const isHeading = /^\s{0,3}#/.test(line);
      const isListStart = /^\s*([-*+]|\d+\.)\s/.test(line);
      const isTableRow = /^\s*\|/.test(line);
      if (isBlank || isHeading) { cur = null; continue; }
      if (cur === null || isListStart || isTableRow || cur.isTableRow) {
        cur = { lines: [], isTableRow: isTableRow };
        blocks.push(cur);
      }
      cur.lines.push({ n: i + 1, text: line });
    }

    for (const block of blocks) {
      // ブロックのテキストを1本につなぐ（各行の前後空白を落として空白1つで連結）。
      // 位置 → 元の行番号 を引けるように写像を作る。
      let text = '';
      const lineAt = [];
      for (const l of block.lines) {
        if (text.length > 0) { text += ' '; lineAt.push(l.n); }
        const t = l.text.trim();
        for (let k = 0; k < t.length; k++) lineAt.push(l.n);
        text += t;
      }

      // 括弧のグループ（全角・半角）。入れ子は内側優先で拾う。
      const groups = [];
      const stack = [];
      for (let i = 0; i < text.length; i++) {
        const c = text[i];
        if (c === '（' || c === '(') stack.push(i);
        else if ((c === '）' || c === ')') && stack.length) {
          const s = stack.pop();
          groups.push({ start: s, end: i });
        }
      }
      groups.sort((a, b) => (a.end - a.start) - (b.end - b.start)); // 内側（短い方）を先に

      // アンカー候補を位置つきで集める。
      const codeSpans = [];
      for (const m of text.matchAll(/`([^`\n]+)`/g)) {
        codeSpans.push({ start: m.index, end: m.index + m[0].length, raw: m[1] });
      }
      const quoteAnchors = [];
      for (const m of text.matchAll(/「([^「」]+)」/g)) {
        const a = usableAnchor(m[1], MIN_QUOTE_ANCHOR);
        if (a) quoteAnchors.push({ start: m.index, end: m.index + m[0].length, text: a });
      }

      for (const m of text.matchAll(CITE_RE)) {
        total++;
        const citedPath = m[1];
        const from = parseInt(m[2], 10);
        const to = m[3] === undefined ? from : parseInt(m[3], 10);
        const mdLine = lineAt[m.index] || block.lines[0].n;
        const shown = m[0];

        // ---- 1. 引用先の解決と実在
        let rel = null;
        if (fs.existsSync(path.join(base, citedPath)) &&
            fs.statSync(path.join(base, citedPath)).isFile()) {
          rel = citedPath;
        } else {
          // 表の「場所」欄のように content.js と略記されることがある。
          // リポジトリ内で basename が一意に定まるときだけ解決する。曖昧なら違反。
          const cands = byName.get(path.basename(citedPath)) || [];
          if (cands.length === 1) rel = cands[0];
          else if (cands.length > 1) {
            console.log(`${target}:${mdLine}: 引用先が一意に定まらない（${shown} → ${cands.join(' / ')}）`);
            violations++;
            continue;
          }
        }
        if (rel === null) {
          console.log(`${target}:${mdLine}: 引用先のファイルが存在しない（${shown}）`);
          violations++;
          continue;
        }

        // ---- 2. 範囲の向き
        if (from > to) {
          console.log(`${target}:${mdLine}: 引用の範囲が逆向き（${shown}）`);
          violations++;
          continue;
        }
        if (from < 1) {
          console.log(`${target}:${mdLine}: 引用の行番号が 1 未満（${shown}）`);
          violations++;
          continue;
        }

        // ---- 3. 行数の範囲内か
        const lines = linesOf(rel);
        const nLines = lines.length > 0 && lines[lines.length - 1] === '' ? lines.length - 1 : lines.length;
        if (to > nLines) {
          console.log(`${target}:${mdLine}: 引用の行番号がファイルの行数を超えている（${shown} / ${rel} は ${nLines} 行）`);
          violations++;
          continue;
        }

        // ---- 4. アンカー語（適用できるものだけ）
        const group = groups.find((g) => g.start < m.index && m.index < g.end);
        // アンカーが「その引用のためのもの」と言える範囲だけを採る。
        //   * 表の行 … 1行が1つの主張なので行内すべて
        //   * 引用を囲む括弧の中 … 例:（src/content.js:155 `chrome.storage.local`）
        //   * その括弧の直前 … 例: `[YTVP] bind 失敗`（src/content.js:390）
        // 段落のどこかにあるだけの語は採らない。採ると、引用と無関係な UI 文言まで
        // 「引用先に無い」と言い出して偽の赤になる（実測で13件出た）。
        const citeStart = m.index;
        const citeEnd = m.index + m[0].length;
        // 隣接判定。同じ括弧の中に複数の語があるとき、遠くの語まで引きずると
        // 「機構の説明（chrome.storage.local）」と「引用先（保存処理の関数）」のような
        // 正しい対応まで赤くなる（実測でこの形の偽の赤が出た）。
        // 引用との間に、他のアンカーと区切り記号しか無いものだけをアンカーとみなす。
        // 「A → B → C、file:N」のように語が数珠つなぎになっている書き方は1つの塊として扱う。
        const SEP = /[\s（）()、，,／/・。=＝→:：]/g;
        const adjacent = (start, end) => {
          const between = (end <= citeStart)
            ? text.slice(end, citeStart)
            : (start >= citeEnd ? text.slice(citeEnd, start) : '');
          const rest = between
            .replace(/`[^`]*`/g, '')
            .replace(/「[^「」]*」/g, '')
            .replace(SEP, '');
          return rest.length <= 3;
        };
        const applies = (start, end) => {
          if (block.isTableRow) return true;          // 表は1行が1つの主張。隣接は問わない
          if (!group) return false;
          const inGroup = start > group.start && end <= group.end;
          const justBefore = end <= group.start && /^\s*$/.test(text.slice(end, group.start));
          if (!inGroup && !justBefore) return false;
          return adjacent(start, end);
        };
        const anchors = [];
        for (const q of quoteAnchors) {
          if (applies(q.start, q.end)) anchors.push(q.text);
        }
        for (const cs of codeSpans) {
          if (!applies(cs.start, cs.end)) continue;
          const a = usableAnchor(cs.raw, MIN_CODE_ANCHOR);
          if (a) anchors.push(a);
        }
        if (anchors.length === 0) {
          anchorSkipped++;
          continue;
        }
        anchorChecked++;
        const body = normalize(lines.slice(from - 1, to).join(' '));
        if (!anchors.some((a) => body.indexOf(a) >= 0)) {
          console.log(`${target}:${mdLine}: 引用先にアンカー語が無い（${shown} / 探した語: ${anchors.map((a) => JSON.stringify(a)).join(', ')}）`);
          violations++;
        }
      }
    }
  }

  if (anchorChecked < minAnchorChecked) {
    console.log(`${targets.join(',')}:0: 内容一致まで検査できた引用が ${anchorChecked} 件しかない（下限 ${minAnchorChecked} 件）。アンカー規則が当たっていない＝この検査は空振りしている`);
    violations++;
  }
  console.log(`scan_doc_cites: 引用 ${total} 件 / 内容一致まで検査 ${anchorChecked} 件 / アンカー無しで範囲のみ ${anchorSkipped} 件 / violations=${violations} target=${targets.join(',')}`);
  return violations > 0 ? 1 : 0;
}

process.exit(main(process.argv));
