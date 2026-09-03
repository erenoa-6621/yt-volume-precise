'use strict';
/*
 * 最小の偽 DOM（検査専用）。
 *
 * 目的は「本物の src/content.js と src/popup.js を、実物のまま読み込んで動かす」こと。
 * jsdom は入れない（SPEC 第0章: npm 依存なし）。popup.js / content.js が実際に触る
 * API だけを実装する。足りない API に触れたら TypeError で赤くなるので、
 * 「偽 DOM が黙って吸収して緑になる」事故は起きにくい。
 */

function makeClassList() {
  const set = new Set();
  return {
    add() { for (const c of arguments) { set.add(String(c)); } },
    remove() { for (const c of arguments) { set.delete(String(c)); } },
    contains(c) { return set.has(String(c)); },
    toggle(c, force) {
      const on = (force === undefined) ? !set.has(String(c)) : !!force;
      if (on) { set.add(String(c)); } else { set.delete(String(c)); }
      return on;
    },
    values() { return Array.from(set); }
  };
}

/*
 * 単純セレクタだけを解する最小の照合器（`.cls` / `#id` / `tag`）。
 * 解せないセレクタは **例外にする**。null を返すと「見つからなかった」と
 * 区別が付かず、検査したつもりで何も検査していない状態になるため。
 */
function matchesSimple(el, sel) {
  const s = String(sel).trim();
  if (s.startsWith('.')) {
    return String(el.className || '').split(/\s+/).indexOf(s.slice(1)) >= 0;
  }
  if (s.startsWith('#')) { return String(el.id || '') === s.slice(1); }
  if (/^[A-Za-z][\w-]*$/.test(s)) { return el.tagName === s.toUpperCase(); }
  throw new Error('偽 DOM が解さないセレクタ: ' + s);
}

function descendants(el, out) {
  for (const c of (el.childNodes || [])) { out.push(c); descendants(c, out); }
  return out;
}

function makeElement(doc, tag) {
  const listeners = Object.create(null);
  const el = {
    tagName: String(tag).toUpperCase(),
    ownerDocument: doc,
    parentNode: null,
    childNodes: [],
    attrs: Object.create(null),
    classList: makeClassList(),
    className: '',
    id: '',
    type: '',
    value: '',
    max: '',
    min: '',
    src: '',
    async: false,
    disabled: false,
    hidden: false,
    _text: '',
    appendChild(child) {
      child.parentNode = el;
      el.childNodes.push(child);
      doc._register(child);
      return child;
    },
    /*
     * 先頭への挿入（src/overlay.js の insertFirst が最初に試す経路。SPEC 9-a）。
     * 本物と同じく可変長で受ける。1つしか受けない実装にすると、2つ目を黙って
     * 捨てる偽 DOM になり「先頭に入った」の検査が嘘になる。
     */
    prepend() {
      const nodes = Array.prototype.slice.call(arguments);
      for (let i = nodes.length - 1; i >= 0; i--) {
        const child = nodes[i];
        if (child.parentNode && typeof child.parentNode.removeChild === 'function') {
          child.parentNode.removeChild(child);
        }
        child.parentNode = el;
        el.childNodes.unshift(child);
        doc._register(child);
      }
    },
    removeChild(child) {
      const i = el.childNodes.indexOf(child);
      if (i >= 0) { el.childNodes.splice(i, 1); }
      child.parentNode = null;
      return child;
    },
    setAttribute(name, v) { el.attrs[String(name)] = String(v); },
    getAttribute(name) {
      return Object.prototype.hasOwnProperty.call(el.attrs, String(name)) ? el.attrs[String(name)] : null;
    },
    removeAttribute(name) { delete el.attrs[String(name)]; },
    // src/content.js の findNativeAnchor が player.querySelector('.ytp-right-controls')
    // を呼ぶ（SPEC 9-c）。子孫を実際に歩いて探す。
    querySelector(sel) {
      for (const d of descendants(el, [])) { if (matchesSimple(d, sel)) { return d; } }
      return null;
    },
    querySelectorAll(sel) {
      return descendants(el, []).filter((d) => matchesSimple(d, sel));
    },
    addEventListener(type, fn) {
      if (typeof fn !== 'function') { return; }
      (listeners[type] || (listeners[type] = [])).push(fn);
    },
    removeEventListener(type, fn) {
      const list = listeners[type];
      if (!list) { return; }
      const i = list.indexOf(fn);
      if (i >= 0) { list.splice(i, 1); }
    },
    dispatchEvent(ev) {
      const list = listeners[ev && ev.type] || [];
      for (const fn of list.slice()) { fn.call(el, ev); }
      return true;
    },
    /*
     * フォーカスの最小実装（SPEC 10-a 追補・§4-11 項目31 の検査に要る）。
     *
     * 以前この偽 DOM には focus / blur / select が無かった。src/overlay.js は
     * どれも isFn() で守って呼ぶので、**無くても例外にならず素通りしていた**。
     * その結果「ホバーで開いたときは入力欄にフォーカスしない／クリックのときだけ
     * 全選択する」という分岐は、偽 DOM 側に観測点が無いので検査しようが無かった。
     * ここで document.activeElement と focus/blur イベントまで本物と同じ順序で
     * 再現する（blur は「今フォーカスを持っている要素」だけに飛ばす）。
     * select() は回数を数えるだけ（選択範囲そのものは検査に要らない）。
     */
    focus() {
      if (doc.activeElement === el) { return; }
      const prev = doc.activeElement;
      doc.activeElement = el;
      if (prev && typeof prev.dispatchEvent === 'function') {
        prev.dispatchEvent(new FakeEvent('blur'));
      }
      el.dispatchEvent(new FakeEvent('focus'));
    },
    blur() {
      if (doc.activeElement !== el) { return; }
      doc.activeElement = null;
      el.dispatchEvent(new FakeEvent('blur'));
    },
    select() { el._selectCount += 1; },
    _selectCount: 0,
    _listenerCount(type) { return (listeners[type] || []).length; }
  };
  // textContent への代入は子要素を消す（popup.js が pills の中身を消すのに使う）
  Object.defineProperty(el, 'textContent', {
    get() { return el._text; },
    set(v) { el._text = String(v); el.childNodes.length = 0; },
    enumerable: true,
    configurable: true
  });
  return el;
}

function makeDocument() {
  const byId = new Map();
  const listeners = Object.create(null);
  const doc = {
    readyState: 'complete',
    activeElement: null,
    _register(el) {
      if (!el) { return; }
      if (el.id) { byId.set(String(el.id), el); }
      for (const c of (el.childNodes || [])) { doc._register(c); }
    },
    getElementById(id) { return byId.get(String(id)) || null; },
    createElement(tag) { return makeElement(doc, tag); },
    /*
     * document 側は要素側と違って **null を返したまま**にしてある。
     * 本実装が document 全体から探すのは「見つからなければ諦める」種類の探索だけで
     * （SPEC 9-b/9-c。差し込み先は #movie_player 配下を要素側 querySelector で見る）、
     * 見つからないことが正常系だから。要素側だけを実装するのはその線引きによる。
     */
    querySelector() { return null; },
    querySelectorAll() { return []; },
    addEventListener(type, fn) {
      if (typeof fn !== 'function') { return; }
      (listeners[type] || (listeners[type] = [])).push(fn);
    },
    removeEventListener(type, fn) {
      const list = listeners[type];
      if (!list) { return; }
      const i = list.indexOf(fn);
      if (i >= 0) { list.splice(i, 1); }
    },
    dispatchEvent(ev) {
      const list = listeners[ev && ev.type] || [];
      for (const fn of list.slice()) { fn.call(doc, ev); }
      return true;
    },
    _listenerCount(type) { return (listeners[type] || []).length; }
  };
  doc.documentElement = makeElement(doc, 'html');
  doc.head = makeElement(doc, 'head');
  doc.body = makeElement(doc, 'body');
  doc.addElement = function (id, tag) {
    const el = makeElement(doc, tag || 'div');
    el.id = String(id);
    doc.body.appendChild(el);
    return el;
  };
  return doc;
}

// content.js が new CustomEvent(...) で作り、page.js 相当が detail を読む。
class FakeEvent {
  constructor(type, init) {
    this.type = String(type);
    this.detail = init ? init.detail : undefined;
    this.defaultPrevented = false;
  }
  preventDefault() { this.defaultPrevented = true; }
  stopPropagation() {}
}

module.exports = { makeElement, makeDocument, makeClassList, FakeEvent, matchesSimple };
