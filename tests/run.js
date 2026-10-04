// 测试：node tests/run.js
// 覆盖：模型操作、HTML 粘贴净化、中文 IME 组合输入事件序列、
// 跨段选择/删除、粘贴、撤销/重做顺序、接受/拒绝修订后的光标映射、
// 以及模型 <-> DOM 选区双向映射（使用简易假 DOM）。

import {
  createDoc, cloneDoc, span, paragraph, textLength, plainText, normalize,
  locate, offsetOf, insertTextInto, deleteRange, markDeleted, splitParagraph,
  insertParagraphs, setBold, allBold, insertionAttrs,
  acceptRevision, rejectRevision, mapThroughRemovals,
  replaceRangePlain, replaceRangeTracked,
} from '../src/model.js';
import { finalParagraphs, exportHtml, exportText, listRevisions } from '../src/derive.js';
import { sanitizeHtml, textToParagraphs, decodeEntities } from '../src/sanitize.js';
import { Editor } from '../src/editor.js';
import { DomView, domPositionFromModelOffset, modelOffsetFromDomPosition } from '../src/domview.js';
import { findAll, segmentsFor } from '../src/find.js';

// ---------- 微型测试框架 ----------

let passed = 0;
let failed = 0;
const failures = [];

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`ok   ${name}`);
  } catch (e) {
    failed++;
    failures.push(name);
    console.error(`FAIL ${name}\n     ${e.message}`);
  }
}

function eq(actual, expected, msg = '') {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a !== b) throw new Error(`${msg}\n     期望: ${b}\n     实际: ${a}`);
}

function ok(cond, msg = '断言失败') {
  if (!cond) throw new Error(msg);
}

// 结构不变量：≥1 段、span 非空、相邻 span 不重复属性、光标在界内。
function assertValid(ed) {
  const doc = ed.doc;
  ok(doc.paragraphs.length >= 1, '至少一个段落');
  for (const p of doc.paragraphs) {
    for (let i = 0; i < p.spans.length; i++) {
      ok(p.spans[i].text.length > 0, 'span 非空');
      if (i > 0) {
        const a = p.spans[i - 1];
        const b = p.spans[i];
        ok(!(a.bold === b.bold && a.ins === b.ins && a.del === b.del), '相邻 span 属性不同');
      }
    }
  }
  const len = textLength(doc);
  ok(ed.sel.anchor >= 0 && ed.sel.anchor <= len, 'anchor 在界内');
  ok(ed.sel.head >= 0 && ed.sel.head <= len, 'head 在界内');
}

// ---------- 控制器测试辅助 ----------

class MockView {
  constructor() { this.states = []; }
  render(state) { this.states.push(state); }
  get last() { return this.states[this.states.length - 1]; }
}

function newEditor() {
  const view = new MockView();
  const ed = new Editor(view);
  ed.render();
  return ed;
}

// 模拟普通键盘输入：beforeinput(prevent) -> input（被忽略）。
function type(ed, text) {
  for (const ch of text) {
    const r = ed.handleBeforeInput({ inputType: 'insertText', data: ch, isComposing: false });
    ok(r.preventDefault, 'insertText 应 preventDefault');
    ed.handleInput({ inputType: 'insertText', data: ch, isComposing: false });
  }
}

function pressEnter(ed) {
  ed.handleBeforeInput({ inputType: 'insertParagraph', data: null, isComposing: false });
}

function backspace(ed) {
  ed.handleBeforeInput({ inputType: 'deleteContentBackward', data: null, isComposing: false });
}

function docText(ed) {
  return plainText(ed.doc);
}

// ---------- 模型测试 ----------

test('locate/offsetOf 在所有偏移上互逆（含空段与多 span）', () => {
  const doc = {
    paragraphs: [
      paragraph([span('AB'), span('CD', { bold: true })]),
      paragraph([]),
      paragraph([span('EFG', { ins: 7 })]),
    ],
  };
  const len = textLength(doc); // 4 + 1 + 0 + 1 + 3 = 9
  eq(len, 9);
  for (let o = 0; o <= len; o++) {
    const loc = locate(doc, o);
    eq(offsetOf(doc, loc.para, loc.span, loc.char), o, `偏移 ${o} 往返`);
  }
  // 换行偏移归入前一段末尾
  eq(locate(doc, 4), { para: 0, span: 1, char: 2 });
  eq(locate(doc, 5), { para: 1, span: 0, char: 0 }); // 空段
  eq(locate(doc, 6), { para: 2, span: 0, char: 0 });
});

test('insertTextInto：同属性合并、异属性拆分', () => {
  const doc = createDoc();
  insertTextInto(doc, 0, 'AB', {});
  insertTextInto(doc, 1, 'x', {});
  eq(doc.paragraphs[0].spans, [span('AxB')]);
  insertTextInto(doc, 1, 'B', { bold: true });
  eq(doc.paragraphs[0].spans, [span('A'), span('B', { bold: true }), span('xB')]);
});

test('deleteRange：段内与跨段', () => {
  const doc = createDoc();
  insertTextInto(doc, 0, 'AAA', {});
  splitParagraph(doc, 3);
  insertTextInto(doc, 4, 'BBB', {});
  splitParagraph(doc, 7);
  insertTextInto(doc, 8, 'CCC', {});
  eq(plainText(doc), 'AAA\nBBB\nCCC');
  deleteRange(doc, 1, 9); // 从 p0[1] 到 p2[1]
  eq(plainText(doc), 'ACC');
  eq(doc.paragraphs.length, 1);
});

test('markDeleted：文字标 del、换行标 delBreak、未接受插入直接移除', () => {
  const doc = createDoc();
  insertTextInto(doc, 0, 'AAA', {});
  splitParagraph(doc, 3);
  insertTextInto(doc, 4, 'BBB', {});
  splitParagraph(doc, 7);
  insertTextInto(doc, 8, 'CCC', {});
  markDeleted(doc, 1, 9, 42);
  const [p0, p1, p2] = doc.paragraphs;
  eq(p0.spans, [span('A'), span('AA', { del: 42 })]);
  eq(p0.delBreak, 42);
  eq(p1.spans, [span('BBB', { del: 42 })]);
  eq(p1.delBreak, 42);
  eq(p2.spans, [span('C', { del: 42 }), span('CC')]);
  // 未接受的插入文字被删除时直接移除
  const doc2 = createDoc();
  insertTextInto(doc2, 0, 'xy', { ins: 5 });
  insertTextInto(doc2, 2, 'z', {});
  markDeleted(doc2, 0, 3, 9);
  eq(doc2.paragraphs[0].spans, [span('z', { del: 9 })]);
});

test('splitParagraph：修订模式下新段落带 ins 标记', () => {
  const doc = createDoc();
  insertTextInto(doc, 0, 'ABCD', {});
  splitParagraph(doc, 2, 7);
  eq(doc.paragraphs.length, 2);
  eq(doc.paragraphs[0].ins, null);
  eq(doc.paragraphs[1].ins, 7);
  eq(plainText(doc), 'AB\nCD');
});

test('acceptRevision：插入转正、删除移除、换行合并，removals 正确', () => {
  const doc = createDoc();
  insertTextInto(doc, 0, 'AB', { ins: 1 });
  insertTextInto(doc, 2, 'CD', {});
  insertTextInto(doc, 4, 'EF', { del: 2 });
  splitParagraph(doc, 6);
  doc.paragraphs[0].delBreak = 2;
  insertTextInto(doc, 7, 'GH', {});
  // 接受修订 2（删除 'EF' 与换行）
  const removals = acceptRevision(doc, 2);
  eq(plainText(doc), 'ABCDGH');
  eq(doc.paragraphs.length, 1);
  eq(removals, [{ start: 4, end: 6 }, { start: 6, end: 7 }]);
  // 接受修订 1（插入转正）
  acceptRevision(doc, 1);
  eq(doc.paragraphs[0].spans.every((s) => s.ins == null), true);
  eq(plainText(doc), 'ABCDGH');
});

test('rejectRevision：插入移除（含插入的段落并回）、删除恢复', () => {
  const doc = createDoc();
  insertTextInto(doc, 0, 'AB', {});
  splitParagraph(doc, 2, 5); // 第二段是修订 5 的插入
  insertTextInto(doc, 3, 'CD', { ins: 5 });
  insertTextInto(doc, 5, 'EF', { del: 6 });
  eq(plainText(doc), 'AB\nCDEF');
  const removals = rejectRevision(doc, 5);
  eq(plainText(doc), 'ABEF');
  eq(doc.paragraphs.length, 1);
  eq(removals, [{ start: 2, end: 3 }, { start: 3, end: 5 }]); // 换行 + 'CD'
  rejectRevision(doc, 6);
  eq(doc.paragraphs[0].spans.every((s) => s.del == null), true);
});

test('mapThroughRemovals：区间内折叠、区间后平移、边界一致', () => {
  const rem = [{ start: 2, end: 5 }, { start: 8, end: 9 }];
  eq(mapThroughRemovals(0, rem), 0);
  eq(mapThroughRemovals(2, rem), 2);
  eq(mapThroughRemovals(3, rem), 2); // 区间内 -> 区间起点
  eq(mapThroughRemovals(5, rem), 2);
  eq(mapThroughRemovals(7, rem), 4);
  eq(mapThroughRemovals(9, rem), 5);
  eq(mapThroughRemovals(12, rem), 8);
});

test('setBold / allBold', () => {
  const doc = createDoc();
  insertTextInto(doc, 0, 'hello world', {});
  setBold(doc, 0, 5, true);
  eq(allBold(doc, 0, 5), true);
  eq(allBold(doc, 0, 6), false);
  eq(doc.paragraphs[0].spans, [span('hello', { bold: true }), span(' world')]);
  setBold(doc, 0, 5, false);
  eq(doc.paragraphs[0].spans, [span('hello world')]);
});

test('insertParagraphs：段中插入多段并保留右半部分', () => {
  const doc = createDoc();
  insertTextInto(doc, 0, 'XY', {});
  const inserted = insertParagraphs(doc, 1, [
    { spans: [{ text: 'a', bold: true }] },
    { spans: [{ text: 'b', bold: false }] },
  ], { ins: 3 });
  eq(inserted, 3); // 'a' + 'b' + 1 个换行
  eq(plainText(doc), 'Xa\nbY');
  eq(doc.paragraphs[0].spans, [span('X'), span('a', { bold: true, ins: 3 })]);
  eq(doc.paragraphs[1].ins, 3);
  eq(doc.paragraphs[1].spans, [span('b', { ins: 3 }), span('Y')]);
});

test('insertionAttrs：延续左侧未接受的插入', () => {
  const doc = createDoc();
  insertTextInto(doc, 0, 'ab', { ins: 4 });
  eq(insertionAttrs(doc, 2, { bold: false }), { bold: false, ins: 4 });
  eq(insertionAttrs(doc, 2, { bold: false, trackRevId: 9 }), { bold: false, ins: 9 });
  insertTextInto(doc, 2, 'cd', {});
  eq(insertionAttrs(doc, 4, { bold: false }), { bold: false, ins: null });
});

// ---------- 净化测试 ----------

test('textToParagraphs：\\n、\\r\\n、空行', () => {
  eq(textToParagraphs('a\nb\r\nc\r'), [
    { spans: [{ text: 'a', bold: false }] },
    { spans: [{ text: 'b', bold: false }] },
    { spans: [{ text: 'c', bold: false }] },
    { spans: [] },
  ]);
});

test('sanitizeHtml：段落与加粗', () => {
  eq(sanitizeHtml('<p>Hello <b>wor</b>ld</p><p>二<strong>号</strong></p>'), [
    { spans: [{ text: 'Hello ', bold: false }, { text: 'wor', bold: true }, { text: 'ld', bold: false }] },
    { spans: [{ text: '二', bold: false }, { text: '号', bold: true }] },
  ]);
});

test('sanitizeHtml：script/事件属性/样式不会进入文档', () => {
  const out = sanitizeHtml(
    '<p onclick="x()">a</p><script>alert(1)</script>' +
    '<p><img src=x onerror="alert(2)">b</p>' +
    '<style>body{display:none}</style><p>c</p>'
  );
  eq(out, [
    { spans: [{ text: 'a', bold: false }] },
    { spans: [{ text: 'b', bold: false }] },
    { spans: [{ text: 'c', bold: false }] },
  ]);
  const all = JSON.stringify(out);
  ok(!all.includes('alert'), '不含脚本内容');
  ok(!all.includes('onerror') && !all.includes('onclick'), '不含事件属性');
  ok(!all.includes('<'), '不含任何标记');
});

test('sanitizeHtml：实体解码为纯文本而非标记', () => {
  eq(sanitizeHtml('<p>a &lt;b&gt; c &amp; d&#65;</p>'), [
    { spans: [{ text: 'a <b> c & dA', bold: false }] },
  ]);
  eq(decodeEntities('&quot;&#x4F60;&nbsp;x'), '"你 x');
});

test('sanitizeHtml：孤立 < 当作文本，自闭合 skip 标签不吞掉后续内容', () => {
  eq(sanitizeHtml('<p>1 < 2 and 3 > 2</p>'), [
    { spans: [{ text: '1 < 2 and 3 > 2', bold: false }] },
  ]);
  eq(sanitizeHtml('<meta charset="utf-8"/><p>ok</p>'), [
    { spans: [{ text: 'ok', bold: false }] },
  ]);
});

// ---------- 派生视图测试 ----------

test('finalParagraphs / exportHtml / listRevisions 来自同一模型', () => {
  const doc = createDoc();
  insertTextInto(doc, 0, 'AB', { ins: 1 });
  insertTextInto(doc, 2, 'CD', {});
  insertTextInto(doc, 4, 'EF', { del: 2 });
  setBold(doc, 0, 2, true);
  eq(finalParagraphs(doc), [
    { spans: [{ text: 'AB', bold: true }, { text: 'CD', bold: false }] },
  ]);
  eq(exportHtml(doc), '<p><strong>AB</strong>CD</p>');
  eq(exportText(doc), 'ABCD');
  eq(listRevisions(doc), [
    { id: 1, kind: 'insert', text: 'AB', paragraphs: [0] },
    { id: 2, kind: 'delete', text: 'EF', paragraphs: [0] },
  ]);
});

test('exportHtml 转义特殊字符', () => {
  const doc = createDoc();
  insertTextInto(doc, 0, '<b> & "x"', {});
  eq(exportHtml(doc), '<p>&lt;b&gt; &amp; &quot;x&quot;</p>');
});

// ---------- 控制器：输入与撤销 ----------

test('连续输入合并为一笔撤销事务；撤销/重做恢复', () => {
  const ed = newEditor();
  type(ed, 'abc');
  eq(docText(ed), 'abc');
  eq(ed.undoStack.length, 1, '三次击键合并为一笔');
  ed.undo();
  eq(docText(ed), '');
  eq(ed.sel, { anchor: 0, head: 0 });
  ed.redo();
  eq(docText(ed), 'abc');
  eq(ed.sel, { anchor: 3, head: 3 });
  assertValid(ed);
});

test('移动光标打断输入合并', () => {
  const ed = newEditor();
  type(ed, 'ab');
  ed.setSelection({ anchor: 0, head: 0 });
  type(ed, 'c');
  eq(ed.undoStack.length, 2);
  eq(docText(ed), 'cab');
});

test('选区替换输入', () => {
  const ed = newEditor();
  type(ed, 'hello');
  ed.setSelection({ anchor: 1, head: 4 });
  type(ed, 'X');
  eq(docText(ed), 'hXo');
  eq(ed.sel, { anchor: 2, head: 2 });
});

// ---------- 控制器：IME 组合 ----------

test('中文组合输入：组合期间不记录，结束时一笔事务，补发事件不重复记录', () => {
  const ed = newEditor();
  const undoBefore = ed.undoStack.length;
  const rendersBefore = ed.view.states.length;

  ed.compositionStart();
  // 拼音过程：n -> ni -> ni h -> ni ha -> ni hao
  for (const s of ['n', 'ni', 'ni h', 'ni ha', 'ni hao']) {
    const r = ed.handleBeforeInput({ inputType: 'insertCompositionText', data: s, isComposing: true });
    ok(!r.preventDefault, '组合中的 beforeinput 应放行以显示临时内容');
    ed.handleInput({ inputType: 'insertCompositionText', data: s, isComposing: true });
    eq(docText(ed), '', '组合期间模型不变');
    eq(ed.undoStack.length, undoBefore, '组合期间不产生撤销记录');
  }
  eq(ed.view.states.length, rendersBefore, '组合期间控制器不重渲染（临时内容归浏览器管）');

  ed.compositionEnd('你好');
  eq(docText(ed), '你好');
  eq(ed.undoStack.length, undoBefore + 1, '组合结束恰好提交一笔事务');
  eq(ed.sel, { anchor: 2, head: 2 });

  // 浏览器在 compositionend 后补发的 input / beforeinput 不得再记一遍
  ed.handleInput({ inputType: 'insertCompositionText', data: '你好', isComposing: false });
  eq(docText(ed), '你好');
  eq(ed.undoStack.length, undoBefore + 1);

  ed.undo();
  eq(docText(ed), '');
  ed.redo();
  eq(docText(ed), '你好');
  assertValid(ed);
});

test('两次中文组合各成一笔；修订模式下每次组合一条插入修订', () => {
  const ed = newEditor();
  ed.setTrackChanges(true);
  ed.compositionStart();
  ed.handleBeforeInput({ inputType: 'insertCompositionText', data: 'ni', isComposing: true });
  ed.compositionEnd('你');
  ed.handleInput({ inputType: 'insertCompositionText', data: '你', isComposing: false });
  ed.compositionStart();
  ed.handleBeforeInput({ inputType: 'insertCompositionText', data: 'hao', isComposing: true });
  ed.compositionEnd('好');
  eq(docText(ed), '你好');
  eq(ed.undoStack.length, 2);
  const revs = listRevisions(ed.doc);
  eq(revs.length, 2);
  eq(revs[0], { id: revs[0].id, kind: 'insert', text: '你', paragraphs: [0] });
  eq(revs[1].text, '好');
  ed.undo();
  eq(docText(ed), '你');
  ed.undo();
  eq(docText(ed), '');
  assertValid(ed);
});

test('组合取消（空 data）不产生事务', () => {
  const ed = newEditor();
  type(ed, 'a');
  const undoBefore = ed.undoStack.length;
  ed.compositionStart();
  ed.handleBeforeInput({ inputType: 'insertCompositionText', data: 'x', isComposing: true });
  ed.compositionEnd('');
  eq(docText(ed), 'a');
  eq(ed.undoStack.length, undoBefore);
});

test('组合替换选区', () => {
  const ed = newEditor();
  type(ed, 'abcdef');
  ed.setSelection({ anchor: 2, head: 4 });
  ed.compositionStart();
  ed.handleBeforeInput({ inputType: 'insertCompositionText', data: 'zh', isComposing: true });
  ed.compositionEnd('中');
  eq(docText(ed), 'ab中ef');
  eq(ed.sel, { anchor: 3, head: 3 });
  ed.undo();
  eq(docText(ed), 'abcdef');
});

// ---------- 控制器：跨段选择与删除 ----------

test('跨段选择删除（非修订）：段落合并，光标在接合点', () => {
  const ed = newEditor();
  ed.paste({ text: 'AAA\nBBB\nCCC' });
  eq(docText(ed), 'AAA\nBBB\nCCC');
  ed.setSelection({ anchor: 1, head: 9 }); // p0[1] -> p2[1]
  ed.deleteSelection();
  eq(docText(ed), 'ACC');
  eq(ed.doc.paragraphs.length, 1);
  eq(ed.sel, { anchor: 1, head: 1 });
  ed.undo();
  eq(docText(ed), 'AAA\nBBB\nCCC');
  assertValid(ed);
});

test('跨段删除（修订模式）：标记 del/delBreak，阅读视图已合并', () => {
  const ed = newEditor();
  ed.paste({ text: 'AAA\nBBB\nCCC' });
  ed.setTrackChanges(true);
  ed.setSelection({ anchor: 1, head: 9 });
  ed.deleteSelection();
  eq(docText(ed), 'AAA\nBBB\nCCC', '模型保留原文');
  eq(exportText(ed.doc), 'ACC', '阅读视图为删除后的样子');
  const revs = listRevisions(ed.doc);
  eq(revs.length, 1);
  eq(revs[0].kind, 'delete');
  // 接受 -> 真正合并
  ed.acceptRevision(revs[0].id);
  eq(docText(ed), 'ACC');
  eq(ed.doc.paragraphs.length, 1);
  eq(ed.sel, { anchor: 1, head: 1 }, '光标映射到接合点');
  ed.undo();
  // 拒绝 -> 恢复原样
  const revs2 = listRevisions(ed.doc);
  ed.rejectRevision(revs2[0].id);
  eq(docText(ed), 'AAA\nBBB\nCCC');
  eq(ed.doc.paragraphs.length, 3);
  assertValid(ed);
});

test('markDeleted：跨段删除覆盖未接受的插入段落时直接并段', () => {
  const ed = newEditor();
  type(ed, 'AB');                    // 普通文字
  ed.setTrackChanges(true);
  pressEnter(ed);                    // 换行 = 修订 r1（para.ins）
  type(ed, 'CD');                    // 插入文字 = 修订 r2
  eq(docText(ed), 'AB\nCD');
  // 全选并修订删除
  ed.setSelection({ anchor: 0, head: textLength(ed.doc) });
  ed.deleteSelection();              // 修订 r3
  eq(ed.doc.paragraphs.length, 1, '插入的段落被直接并回');
  eq(ed.doc.paragraphs[0].spans, [span('AB', { del: listRevisions(ed.doc)[0].id })],
    '普通文字标记删除，未接受的插入文字直接移除');
  eq(exportText(ed.doc), '', '阅读视图为空');
  const [rev] = listRevisions(ed.doc);
  ed.rejectRevision(rev.id);
  eq(docText(ed), 'AB');
  eq(ed.doc.paragraphs.length, 1);
  assertValid(ed);
});

test('段首退格（非修订）合并段落；修订模式标记换行删除', () => {
  const ed = newEditor();
  type(ed, 'AB');
  pressEnter(ed);
  type(ed, 'CD');
  eq(docText(ed), 'AB\nCD');
  ed.setSelection({ anchor: 3, head: 3 }); // 第二段段首
  backspace(ed);
  eq(docText(ed), 'ABCD');
  eq(ed.sel, { anchor: 2, head: 2 });

  const ed2 = newEditor();
  type(ed2, 'AB');
  pressEnter(ed2);
  type(ed2, 'CD');
  ed2.setTrackChanges(true);
  ed2.setSelection({ anchor: 3, head: 3 });
  backspace(ed2);
  eq(docText(ed2), 'AB\nCD', '换行仍在模型中');
  eq(exportText(ed2.doc), 'ABCD', '阅读视图已合并');
  eq(ed2.doc.paragraphs[0].delBreak != null, true);
  const [rev] = listRevisions(ed2.doc);
  ed2.rejectRevision(rev.id);
  eq(exportText(ed2.doc), 'AB\nCD');
  assertValid(ed2);
});

// ---------- 控制器：粘贴 ----------

test('粘贴纯文本：拆段、一笔事务、光标落在粘贴内容之后', () => {
  const ed = newEditor();
  type(ed, 'XY');
  ed.setSelection({ anchor: 1, head: 1 });
  const undoBefore = ed.undoStack.length;
  ed.paste({ text: 'a\nb\nc' });
  eq(docText(ed), 'Xa\nb\ncY');
  eq(ed.doc.paragraphs.length, 3);
  eq(ed.undoStack.length, undoBefore + 1, '粘贴是一笔事务');
  eq(ed.sel, { anchor: 6, head: 6 }, '光标在粘贴内容末尾'); // X0 a1 \n2 b3 \n4 c5 |Y6
  // 粘贴后继续输入位置正确
  type(ed, '!');
  eq(docText(ed), 'Xa\nb\nc!Y');
  ed.undo(); // 撤销 '!'
  ed.undo(); // 撤销粘贴
  eq(docText(ed), 'XY');
  assertValid(ed);
});

test('粘贴替换选区', () => {
  const ed = newEditor();
  type(ed, 'hello world');
  ed.setSelection({ anchor: 0, head: 5 });
  ed.paste({ text: '你好' });
  eq(docText(ed), '你好 world');
  eq(ed.sel, { anchor: 2, head: 2 });
});

test('粘贴 HTML：只保留段落/文字/加粗，脚本不进文档', () => {
  const ed = newEditor();
  ed.paste({
    html: '<p>Hello <b>粗</b>体</p><script>alert(1)</script><p><img src=x onerror=alert(2)>二</p>',
    text: 'Hello 粗体\n二',
  });
  eq(docText(ed), 'Hello 粗体\n二');
  eq(ed.doc.paragraphs[0].spans, [
    span('Hello '),
    span('粗', { bold: true }),
    span('体'),
  ]);
  ok(!JSON.stringify(ed.doc).includes('alert'), '文档不含脚本');
  ok(!exportHtml(ed.doc).includes('onerror'), '导出不带事件属性');
  eq(exportHtml(ed.doc), '<p>Hello <strong>粗</strong>体</p>\n<p>二</p>');
  assertValid(ed);
});

test('修订模式下粘贴：插入内容标为一条修订', () => {
  const ed = newEditor();
  type(ed, 'AB');
  ed.setTrackChanges(true);
  ed.setSelection({ anchor: 1, head: 1 });
  ed.paste({ text: 'x\ny' });
  eq(docText(ed), 'Ax\nyB');
  const revs = listRevisions(ed.doc);
  eq(revs.length, 1);
  eq(revs[0].kind, 'insert');
  ed.rejectRevision(revs[0].id);
  eq(docText(ed), 'AB');
  eq(ed.doc.paragraphs.length, 1);
  assertValid(ed);
});

// ---------- 控制器：修订接受/拒绝与光标 ----------

test('接受删除：光标按移除区间平移；落在被删区内则折叠到起点', () => {
  const ed = newEditor();
  type(ed, 'hello world');
  ed.setTrackChanges(true);
  ed.setSelection({ anchor: 0, head: 5 });
  ed.deleteSelection(); // 'hello' 标记删除
  ed.setSelection({ anchor: 11, head: 11 }); // 文档末尾
  const [rev] = listRevisions(ed.doc);
  ed.acceptRevision(rev.id);
  eq(docText(ed), ' world');
  eq(ed.sel, { anchor: 6, head: 6 }, '光标前移 5');

  // 光标在被删区域内
  const ed2 = newEditor();
  type(ed2, 'hello world');
  ed2.setTrackChanges(true);
  ed2.setSelection({ anchor: 0, head: 5 });
  ed2.deleteSelection();
  ed2.setSelection({ anchor: 3, head: 3 });
  const [rev2] = listRevisions(ed2.doc);
  ed2.acceptRevision(rev2.id);
  eq(ed2.sel, { anchor: 0, head: 0 }, '折叠到移除起点');
  assertValid(ed2);
});

test('拒绝插入：插入文字移除，光标折叠；拒绝后段落结构有效', () => {
  const ed = newEditor();
  type(ed, 'X');
  ed.setTrackChanges(true);
  ed.setSelection({ anchor: 0, head: 0 });
  type(ed, 'abc'); // 修订：在 X 前插入 abc
  eq(docText(ed), 'abcX');
  ed.setSelection({ anchor: 2, head: 2 }); // 插入文字内部
  const [rev] = listRevisions(ed.doc);
  ed.rejectRevision(rev.id);
  eq(docText(ed), 'X');
  eq(ed.sel, { anchor: 0, head: 0 });
  assertValid(ed);
});

test('接受/拒绝全部：一笔事务，撤销可整体还原', () => {
  const ed = newEditor();
  type(ed, 'AB');
  ed.setTrackChanges(true);
  ed.setSelection({ anchor: 1, head: 1 });
  type(ed, '新');
  ed.setSelection({ anchor: 0, head: 1 });
  ed.deleteSelection();
  eq(listRevisions(ed.doc).length, 2);
  const undoBefore = ed.undoStack.length;
  ed.acceptAll();
  eq(ed.undoStack.length, undoBefore + 1, '接受全部是一笔事务');
  eq(docText(ed), '新B');
  eq(listRevisions(ed.doc).length, 0);
  ed.undo();
  eq(listRevisions(ed.doc).length, 2);
  ed.rejectAll();
  eq(docText(ed), 'AB');
  assertValid(ed);
});

// ---------- 控制器：撤销/重做顺序 ----------

test('混合操作序列的撤销/重做严格逆序', () => {
  const ed = newEditor();
  // 在每次变更操作之前（含选区调整之后）记录快照，
  // 使快照恰好等于撤销该操作时恢复的状态。
  const snaps = [];
  const snap = () => snaps.push(JSON.stringify({ doc: ed.doc, sel: ed.sel }));

  snap();                            // S0
  type(ed, 'Hello');                 // 事务 1（合并）
  snap();                            // S1
  pressEnter(ed);                    // 事务 2
  snap();                            // S2
  type(ed, 'World');                 // 事务 3
  ed.setTrackChanges(true);
  ed.setSelection({ anchor: 6, head: 11 });
  snap();                            // S3（删除前，含选区）
  ed.deleteSelection();              // 事务 4：修订删除 'World'
  snap();                            // S4
  ed.paste({ text: 'A\nB' });        // 事务 5：修订粘贴
  snap();                            // S5
  ed.compositionStart();             // 事务 6：修订组合输入
  ed.handleBeforeInput({ inputType: 'insertCompositionText', data: 'zhong', isComposing: true });
  ed.compositionEnd('中');
  ed.handleInput({ inputType: 'insertCompositionText', data: '中', isComposing: false });
  const finalSnap = JSON.stringify({ doc: ed.doc, sel: ed.sel }); // S6

  eq(ed.undoStack.length, 6, '共 6 笔事务');

  // 逐步撤销，每一步都必须等于当初的快照
  for (let i = snaps.length - 1; i >= 0; i--) {
    ed.undo();
    eq(JSON.stringify({ doc: ed.doc, sel: ed.sel }), snaps[i], `撤销到快照 ${i}`);
    assertValid(ed);
  }
  // 逐步重做，严格正序还原
  for (let i = 1; i < snaps.length; i++) {
    ed.redo();
    eq(JSON.stringify({ doc: ed.doc, sel: ed.sel }), snaps[i], `重做到快照 ${i}`);
    assertValid(ed);
  }
  ed.redo();
  eq(JSON.stringify({ doc: ed.doc, sel: ed.sel }), finalSnap, '重做到最终状态');
  assertValid(ed);
});

test('撤销后新操作清空重做栈', () => {
  const ed = newEditor();
  type(ed, 'a');
  pressEnter(ed);
  ed.undo();
  type(ed, 'b');
  eq(ed.redoStack.length, 0);
  eq(docText(ed), 'ab');
});

test('beforeinput 路由：historyUndo/historyRedo 与未知类型', () => {
  const ed = newEditor();
  type(ed, 'ab');
  ed.handleBeforeInput({ inputType: 'historyUndo', data: null, isComposing: false });
  eq(docText(ed), '');
  ed.handleBeforeInput({ inputType: 'historyRedo', data: null, isComposing: false });
  eq(docText(ed), 'ab');
  const r = ed.handleBeforeInput({ inputType: 'formatBold', data: null, isComposing: false });
  ok(r.preventDefault, '未知类型被阻止');
  eq(docText(ed), 'ab', '未知类型不改变文档');
});

// ---------- DOM 选区映射（假 DOM） ----------

class FText {
  constructor(d) { this.nodeType = 3; this.data = d; this.childNodes = []; this.parentNode = null; }
  get textContent() { return this.data; }
  set textContent(v) { this.data = v; }
}
class FEl {
  constructor(tag, doc) {
    this.nodeType = 1;
    this.tagName = tag.toUpperCase();
    this.childNodes = [];
    this.parentNode = null;
    this.ownerDocument = doc;
    this.className = '';
  }
  appendChild(c) { c.parentNode = this; this.childNodes.push(c); return c; }
  get children() { return this.childNodes.filter((n) => n.nodeType === 1); }
  get textContent() { return this.childNodes.map((c) => c.textContent).join(''); }
  set textContent(v) { this.childNodes = []; }
}
class FDoc {
  createElement(t) { return new FEl(t, this); }
  createTextNode(d) { return new FText(d); }
}

function renderToFake(doc, sel = { anchor: 0, head: 0 }) {
  const fdoc = new FDoc();
  const root = fdoc.createElement('div');
  const view = new DomView(root);
  view.render({ doc, sel });
  return root;
}

test('DomView 渲染结构：strong/rev-ins/rev-del/br', () => {
  const doc = {
    paragraphs: [
      paragraph([span('AB'), span('CD', { bold: true })]),
      paragraph([]),
      paragraph([span('EF', { ins: 1 }), span('GH', { del: 2 })]),
    ],
  };
  const root = renderToFake(doc);
  eq(root.children.length, 3);
  eq(root.children[0].children[0].tagName, 'STRONG');
  eq(root.children[1].children[0].tagName, 'BR', '空段落渲染 <br>');
  eq(root.children[2].children[0].tagName, 'SPAN');
  eq(root.children[2].children[0].className, 'rev-ins');
  eq(root.children[2].children[1].tagName, 'DEL');
});

test('模型偏移 -> DOM -> 模型偏移：所有偏移往返一致', () => {
  const doc = {
    paragraphs: [
      paragraph([span('AB'), span('CD', { bold: true })]),
      paragraph([]),
      paragraph([span('EF', { ins: 1 }), span('GH', { del: 2 })]),
    ],
  };
  const root = renderToFake(doc);
  const len = textLength(doc); // 4+1+0+1+4 = 10
  for (let o = 0; o <= len; o++) {
    const pos = domPositionFromModelOffset(root, o);
    eq(modelOffsetFromDomPosition(root, pos.node, pos.offset), o, `偏移 ${o} 经 DOM 往返`);
  }
});

test('DOM 位置 -> 模型偏移：跨段选择锚点/焦点', () => {
  const doc = {
    paragraphs: [
      paragraph([span('AAA')]),
      paragraph([span('BBB')]),
      paragraph([span('CCC')]),
    ],
  };
  const root = renderToFake(doc);
  const textOf = (p) => root.children[p].childNodes[0];
  // 锚点在 p0 字符 1，焦点在 p2 字符 2（p0:0-2, \n:3, p1:4-6, \n:7, p2:8-10）
  const anchor = modelOffsetFromDomPosition(root, textOf(0), 1);
  const head = modelOffsetFromDomPosition(root, textOf(2), 2);
  eq(anchor, 1);
  eq(head, 10);
  // 跨段删除该选区
  const ed = newEditor();
  ed.paste({ text: 'AAA\nBBB\nCCC' });
  ed.setSelection({ anchor, head });
  ed.deleteSelection();
  eq(docText(ed), 'AC');
});

test('拆段/并段后 DOM 映射仍指向正确字符', () => {
  const ed = newEditor();
  type(ed, 'ABCD');
  ed.setSelection({ anchor: 2, head: 2 });
  pressEnter(ed); // 拆段：AB|CD -> AB\nCD，光标 3
  eq(ed.sel, { anchor: 3, head: 3 });
  const root = renderToFake(ed.doc, ed.sel);
  const pos = domPositionFromModelOffset(root, ed.sel.anchor);
  eq(pos.node.parentNode.tagName, 'P');
  eq(modelOffsetFromDomPosition(root, pos.node, pos.offset), 3);
  // 并段（撤销拆段）后光标 2，仍指向 C 前
  ed.undo();
  eq(ed.sel, { anchor: 2, head: 2 });
  const root2 = renderToFake(ed.doc, ed.sel);
  const pos2 = domPositionFromModelOffset(root2, ed.sel.anchor);
  eq(modelOffsetFromDomPosition(root2, pos2.node, pos2.offset), 2);
});

// ---------- 查找并全部替换 ----------

// 构造文档：paras = [['普通串', ['粗体串'] , { ins:text } | { del:text, id? } ...]]
function buildDoc(paras) {
  const doc = createDoc();
  let first = true;
  for (const toks of paras) {
    if (!first) splitParagraph(doc, textLength(doc));
    first = false;
    for (const t of toks) {
      if (typeof t === 'string') insertTextInto(doc, textLength(doc), t, {});
      else if (Array.isArray(t)) insertTextInto(doc, textLength(doc), t[0], { bold: true });
      else if ('ins' in t) insertTextInto(doc, textLength(doc), t.ins, { ins: t.id ?? 99 });
      else if ('del' in t) insertTextInto(doc, textLength(doc), t.del, { del: t.id ?? 98 });
    }
  }
  return doc;
}

test('segmentsFor：替换词按命中字符对位继承粗体，多余字符沿用末位', () => {
  eq(segmentsFor('xx', [false, false]), [{ text: 'xx', bold: false }]);
  eq(segmentsFor('XY', [false, true]), [
    { text: 'X', bold: false }, { text: 'Y', bold: true },
  ]);
  // 替换词比命中长：尾部沿用命中最后一个字符的粗体
  eq(segmentsFor('ABCD', [false, true]), [
    { text: 'A', bold: false }, { text: 'BCD', bold: true },
  ]);
  eq(segmentsFor('Z', [true]), [{ text: 'Z', bold: true }]);
});

test('匹配：区分大小写、非重叠，允许跨加粗 span', () => {
  const doc = buildDoc([['aA', ['aA'], 'tail']]); // 可见文字 aAaAtail
  const r = findAll(doc, 'aA');
  eq(r.matches.length, 2, '区分大小写：小写 aa / 大写 AA 不匹配');
  eq(r.matches[0].from, 0);
  eq(r.matches[1].from, 2, '第二处跨越普通/加粗 span 边界');
  eq(r.skipped.length, 0);
  // 非重叠：'aaaa' 查 'aa' 为 2 处（位置 0、2），不产生位置 1 的重叠命中
  const doc2 = buildDoc([['xaaaax']]);
  const r2 = findAll(doc2, 'aa');
  eq(r2.matches.length, 2);
  eq(r2.matches.map((m) => m.from), [1, 3]);
  // 'aaa' 查 'aa' 仅 1 处
  eq(findAll(buildDoc([['xaaax']]), 'aa').matches.length, 1);
});

test('匹配不跨段落；逐行各自匹配', () => {
  const doc = buildDoc([['ab'], ['ab']]);
  const r = findAll(doc, 'ab');
  eq(r.matches.length, 2);
  eq(r.matches[0].para, 0);
  eq(r.matches[0].from, 0);
  eq(r.matches[0].to, 2);
  eq(r.matches[1].para, 1);
  eq(r.matches[1].from, 3); // p1 起点：2 + 换行
  eq(r.matches[1].to, 5);
  // 跨行的词不命中（换行不是可见字符，逐行匹配）
  eq(findAll(doc, 'b\na').matches.length, 0);
  eq(findAll(doc, 'b' + String.fromCharCode(10) + 'a').matches.length, 0);
});

test('匹配命中含未决插入/删除：跳过并报告，不碰既有修订身份', () => {
  // 'acb'，其中 c 是未决插入；查 'acb' 应跳过；查 'ab' 命中（不连续夹插？ab不相邻）
  const doc = buildDoc([['a', { ins: 'c', id: 7 }, 'b']]);
  const r = findAll(doc, 'acb');
  eq(r.matches.length, 0);
  eq(r.skipped.length, 1);
  eq(r.skipped[0].reason, 'insert');
  // 文档身份未变
  ok(JSON.stringify(doc).includes('"ins":7'), '插入修订身份保留');

  // 命中范围含未决删除文字（阅读视图隐藏，可见串拼接跨过它）
  const doc2 = buildDoc([['a', { del: 'X', id: 8 }, 'b']]); // 可见 'ab'
  const r2 = findAll(doc2, 'ab');
  eq(r2.matches.length, 0);
  eq(r2.skipped.length, 1);
  eq(r2.skipped[0].reason, 'delete');
  ok(JSON.stringify(doc2).includes('"del":8'), '删除修订身份保留');
});

test('匹配跨越被删除的段界（delBreak 合并的阅读行）：跳过', () => {
  const ed = newEditor();
  ed.paste({ text: 'ab\ncd' });
  ed.setTrackChanges(true);
  // 删除 p0/p1 之间的换行：光标在第二段段首退格
  ed.setSelection({ anchor: 3, head: 3 });
  ed.handleBeforeInput({ inputType: 'deleteContentBackward', data: null, isComposing: false });
  eq(exportText(ed.doc), 'abcd', '阅读视图两段合并为一行');
  const r = findAll(ed.doc, 'bc');
  eq(r.matches.length, 0);
  eq(r.skipped.length, 1);
  eq(r.skipped[0].reason, 'delete');
});

test('非修订模式全部替换：跨加粗 span、重复词、粗体对位继承，一笔事务', () => {
  const ed = newEditor();
  ed.paste({ text: 'Tea and tea' });
  // 把第一个 Tea 整体加粗
  setBold(ed.doc, 0, 3, true);
  ed.render();
  const undoBefore = ed.undoStack.length;
  const pv = ed.previewReplaceAll('Tea', 'COFFEE');
  eq(pv.ok, true);
  eq(pv.matches.length, 1, '区分大小写：只命中大写 Tea');
  const res = ed.confirmReplaceAll();
  eq(res.ok, true);
  eq(res.applied, 1);
  eq(docText(ed), 'COFFEE and tea', '小写 tea 未被替换');
  // 粗体对位继承：原 Tea 全粗 -> COFFEE 全粗
  eq(ed.doc.paragraphs[0].spans, [
    span('COFFEE', { bold: true }), span(' and tea'),
  ]);
  eq(ed.undoStack.length, undoBefore + 1, '整批一笔撤销记录');
  ed.undo();
  eq(docText(ed), 'Tea and tea');
  ed.redo();
  eq(docText(ed), 'COFFEE and tea');
  assertValid(ed);
});

test('全部替换重复词：多处一次完成，替换词不会再次成为命中', () => {
  const ed = newEditor();
  ed.paste({ text: 'aa aa aa' });
  const undoBefore = ed.undoStack.length;
  const pv = ed.previewReplaceAll('aa', 'aaaa'); // 替换词含被查找词
  eq(pv.matches.length, 3);
  const res = ed.confirmReplaceAll();
  eq(res.applied, 3);
  eq(docText(ed), 'aaaa aaaa aaaa', '恰好替换原有 3 处，未级联替换新词');
  eq(ed.undoStack.length, undoBefore + 1, '整批一笔撤销');
  // 替换词更短也正确
  const ed2 = newEditor();
  ed2.paste({ text: 'xx-xx' });
  ed2.previewReplaceAll('xx', 'y');
  ed2.confirmReplaceAll();
  eq(docText(ed2), 'y-y');
});

test('部分跳过时：命中照常替换，跳过项上报，修订身份不破坏', () => {
  const ed = newEditor();
  // 可见串含两个 'ab'：一个干净（段首）、一个由 'a' + 删除(z) + 'b' 构成
  ed.paste({ text: 'ab azb' });
  ed.setTrackChanges(true);
  // 删除 'z'（偏移 4）：阅读视图里 'a' 'b' 拼成 'ab'
  const delBefore = listRevisions(ed.doc);
  eq(delBefore.length, 0);
  ed.setSelection({ anchor: 4, head: 5 });
  ed.deleteSelection();
  const [delRev] = listRevisions(ed.doc);
  eq(delRev.kind, 'delete');
  const pv = ed.previewReplaceAll('ab', 'XY');
  eq(pv.matches.length, 1, '仅干净的 ab 命中');
  eq(pv.skipped.length, 1);
  eq(pv.skipped[0].reason, 'delete');
  const res = ed.confirmReplaceAll();
  eq(res.applied, 1);
  eq(res.skipped.length, 1);
  eq(exportText(ed.doc), 'XY ab', '阅读视图：干净处替换，跳过处保持');
  // 被跳过处原有的删除修订身份不变（同一条删除修订仍覆盖 z）
  const delMarks = new Set();
  for (const p of ed.doc.paragraphs) for (const s of p.spans) {
    if (s.del != null && s.text === 'z') delMarks.add(s.del);
  }
  eq([...delMarks], [delRev.id], '跳过范围的既有删除修订身份未被改动');
});

test('修订模式全部替换：每处独立的删除+插入修订，可分别接受/拒绝', () => {
  const ed = newEditor();
  ed.paste({ text: 'foo foo' });
  ed.setTrackChanges(true);
  const pv = ed.previewReplaceAll('foo', 'bar');
  eq(pv.matches.length, 2);
  const res = ed.confirmReplaceAll();
  eq(res.applied, 2);
  const revs = listRevisions(ed.doc);
  eq(revs.length, 4, '2 删除 + 2 插入，身份各自独立');
  eq(revs.map((r) => r.kind), ['delete', 'insert', 'delete', 'insert']);
  const delIds = revs.filter((r) => r.kind === 'delete').map((r) => r.id);
  const insIds = revs.filter((r) => r.kind === 'insert').map((r) => r.id);
  ok(delIds[0] !== delIds[1] && insIds[0] !== insIds[1], '两处修订 id 互不相同');
  eq(exportText(ed.doc), 'bar bar', '阅读视图只见新词');
  eq(docText(ed), 'foobar foobar', '模型：旧词删除线保留、新词紧随');

  // 接受第一处“删除”修订 = 接受第一处整组替换：旧词与其新词一并消失；
  // 第二处尚未处理，阅读视图仍显示其新词。
  ed.acceptRevision(delIds[0]);
  eq(exportText(ed.doc), ' bar', '第一处整组消失；第二处新词仍显示');
  eq(docText(ed), ' foobar', '模型中第二处旧词 foo 仍保留');
  // 拒绝第二处的插入：新词移除、旧词仍处删除态
  ed.rejectRevision(insIds[1]);
  eq(exportText(ed.doc), ' ', '第二处新词被拒绝，旧词仍处删除态');
  eq(ed.doc.paragraphs.length, 1, '段界不变');
  // 再拒绝第二处的删除：旧词恢复
  ed.rejectRevision(delIds[1]);
  eq(exportText(ed.doc), ' foo');
  assertValid(ed);
  // 替换整批一笔事务 + 三次接受/拒绝各一笔；逐次撤销回到替换后，再回到原文
  ed.undo();
  eq(exportText(ed.doc), ' ');
  ed.undo();
  eq(exportText(ed.doc), ' bar');
  ed.undo();
  eq(exportText(ed.doc), 'bar bar');
  ed.undo();
  eq(docText(ed), 'foo foo');
  eq(listRevisions(ed.doc).length, 0);
});

test('修订模式替换后：接受插入/拒绝删除的组合语义独立', () => {
  const ed = newEditor();
  ed.paste({ text: 'abc' });
  ed.setTrackChanges(true);
  ed.previewReplaceAll('b', 'XY');
  ed.confirmReplaceAll();
  let revs = listRevisions(ed.doc);
  const del = revs.find((r) => r.kind === 'delete');
  const ins = revs.find((r) => r.kind === 'insert');
  // 拒绝插入：新词移除，旧删除标记仍在
  ed.rejectRevision(ins.id);
  eq(exportText(ed.doc), 'ac');
  // 拒绝删除：旧词恢复 -> 回到 abc
  ed.rejectRevision(del.id);
  eq(docText(ed), 'abc');
  eq(exportText(ed.doc), 'abc');

  // 另一路：接受插入（新词转正、delIns 绑定保留），再接受删除
  // （旧词移除；新词已无 ins，不随 delIns 移除）= 最终替换
  const ed2 = newEditor();
  ed2.paste({ text: 'abc' });
  ed2.setTrackChanges(true);
  ed2.previewReplaceAll('b', 'XY');
  ed2.confirmReplaceAll();
  revs = listRevisions(ed2.doc);
  const insId = revs.find((r) => r.kind === 'insert').id;
  const delId = revs.find((r) => r.kind === 'delete').id;
  ed2.acceptRevision(insId);
  eq(exportText(ed2.doc), 'aXYc', '接受插入后新词仍可见');
  ed2.acceptRevision(delId);
  eq(docText(ed2), 'aXYc', '再接受删除：旧词移除，已转正的新词保留');
  eq(listRevisions(ed2.doc).length, 0);
});

test('过期预览：文档变更或模式切换后确认被拒绝', () => {
  const ed = newEditor();
  type(ed, 'cat cat');
  const pv = ed.previewReplaceAll('cat', 'dog');
  eq(pv.ok, true);
  // 文档改变（再打字）
  type(ed, '!');
  const stale = ed.confirmReplaceAll();
  eq(stale.ok, false);
  eq(stale.error, 'stale');
  eq(docText(ed), 'cat cat!', '过期预览未执行任何替换');
  // 过期预览仍挂着但不可用；取消后再确认报无预览
  ed.cancelPreview();
  eq(ed.confirmReplaceAll().error, 'no-preview');

  // 重新预览后可以确认
  ed.previewReplaceAll('cat', 'dog');
  const ok2 = ed.confirmReplaceAll();
  eq(ok2.ok, true);
  eq(docText(ed), 'dog dog!');

  // 模式切换同样使预览失效（确认时按 trackChanges 字段判 stale）
  const ed3 = newEditor();
  type(ed3, 'dog dog');
  const pv3 = ed3.previewReplaceAll('dog', 'cat');
  eq(pv3.trackChanges, false);
  ed3.setTrackChanges(true); // 经正式 API 切换；预览对象保留但语义已过期
  const stale3 = ed3.confirmReplaceAll();
  eq(stale3.ok, false);
  eq(stale3.error, 'stale');
  eq(docText(ed3), 'dog dog', '模式切换未执行替换');

  // 空查询不产生预览；无预览时确认被拒
  const ed4 = newEditor();
  eq(ed4.previewReplaceAll('', 'x').ok, false);
  eq(ed4.confirmReplaceAll().ok, false);
});

test('撤销/重做后旧预览失效；替换后视图与导出一致', () => {
  const ed = newEditor();
  ed.paste({ text: 'one one' });
  ed.previewReplaceAll('one', 'two');
  ed.confirmReplaceAll();
  eq(docText(ed), 'two two');
  ed.undo();
  eq(docText(ed), 'one one');
  // 撤销产生新版本，旧（已用）预览不可再确认
  eq(ed.confirmReplaceAll().ok, false);
  ed.redo();
  eq(docText(ed), 'two two');
  // 阅读视图 / 导出 / 修订表同源一致
  eq(exportText(ed.doc), 'two two');
  eq(exportHtml(ed.doc), '<p>two two</p>');
  eq(listRevisions(ed.doc).length, 0);
});

test('替换后选区映射正确（模型偏移 <-> DOM）', () => {
  const ed = newEditor();
  ed.paste({ text: 'aXbXc' });
  ed.setSelection({ anchor: 5, head: 5 }); // 文档末尾
  ed.previewReplaceAll('X', 'YY');
  ed.confirmReplaceAll();
  eq(docText(ed), 'aYYbYYc');
  eq(ed.sel, { anchor: 7, head: 7 }, '末尾光标随长度增长平移');

  // 光标落在被替换区间内 -> 折叠到该区间起点
  const ed2 = newEditor();
  ed2.paste({ text: 'abcde' });
  ed2.setSelection({ anchor: 3, head: 3 }); // 'cd' 内部
  ed2.previewReplaceAll('cd', 'XYZW');
  ed2.confirmReplaceAll();
  eq(ed2.sel, { anchor: 2, head: 2 }, '折叠到替换区间起点');
  // 边界位置（区间起点）保持不动
  const ed3 = newEditor();
  ed3.paste({ text: 'aXb' });
  ed3.setSelection({ anchor: 1, head: 1 }); // X 起点
  ed3.previewReplaceAll('X', 'YY');
  ed3.confirmReplaceAll();
  eq(ed3.sel, { anchor: 1, head: 1 }, '区间边界位置保持在起点');

  // DOM 往返
  const root = renderToFake(ed.doc, ed.sel);
  const pos = domPositionFromModelOffset(root, ed.sel.anchor);
  eq(modelOffsetFromDomPosition(root, pos.node, pos.offset), ed.sel.anchor);
});

test('IME 组合期间：不提交替换、不丢失临时输入', () => {
  const ed = newEditor();
  ed.paste({ text: 'aa aa' });
  // 组合开始前先生成预览
  const pv = ed.previewReplaceAll('aa', 'bb');
  eq(pv.ok, true);
  // 把光标移到文档末尾，组合输入追加在尾部
  ed.setSelection({ anchor: 5, head: 5 });
  ed.compositionStart();
  // 组合期间预览与确认都被拒绝
  eq(ed.previewReplaceAll('aa', 'bb').ok, false);
  const res = ed.confirmReplaceAll();
  eq(res.ok, false);
  eq(res.error, 'composing');
  eq(docText(ed), 'aa aa', '组合期间文档未被替换');
  // 组合正常进行并提交（临时输入不丢）
  ed.handleBeforeInput({ inputType: 'insertCompositionText', data: 'n', isComposing: true });
  ed.handleBeforeInput({ inputType: 'insertCompositionText', data: 'ni', isComposing: true });
  ed.compositionEnd('你');
  ed.handleInput({ inputType: 'insertCompositionText', data: '你', isComposing: false });
  eq(docText(ed), 'aa aa你', '组合输入完整保留在光标处');
  // 组合已使旧预览过期，确认被拒；重新预览可执行
  eq(ed.confirmReplaceAll().ok, false);
  const pv2 = ed.previewReplaceAll('aa', 'bb');
  eq(pv2.matches.length, 2);
  const res2 = ed.confirmReplaceAll();
  eq(res2.ok, true);
  eq(docText(ed), 'bb bb你');
});

test('模型原语 replaceRangePlain / replaceRangeTracked 直接行为', () => {
  // 替换段与右侧普通 o 粗体属性不同 -> 保留分段
  const doc = buildDoc([['he', ['LL'], 'o']]); // heLLo，LL 粗
  replaceRangePlain(doc, 2, 4, [{ text: 'yy', bold: true }]);
  eq(doc.paragraphs[0].spans, [span('he'), span('yy', { bold: true }), span('o')]);
  // 普通替换段与右侧普通 o 合并
  const doc1 = buildDoc([['he', ['LL'], 'o']]);
  replaceRangePlain(doc1, 2, 4, [{ text: 'yy', bold: false }]);
  eq(doc1.paragraphs[0].spans, [span('heyyo')]);
  const doc2 = buildDoc([['he', ['LL'], 'o']]);
  replaceRangeTracked(doc2, 2, 4, [{ text: 'yy', bold: true }], 21, 22);
  eq(doc2.paragraphs[0].spans, [
    span('he'),
    span('LL', { bold: true, del: 21 }),
    // 新词带独立插入修订，并绑定删除修订（接受删除时随之移除）
    span('yy', { bold: true, ins: 22, delIns: 21 }),
    span('o'),
  ]);
  // 修订表中新词只计入插入修订，删除修订只含旧词
  eq(listRevisions(doc2), [
    { id: 21, kind: 'delete', text: 'LL', paragraphs: [0] },
    { id: 22, kind: 'insert', text: 'yy', paragraphs: [0] },
  ]);
  // 跨段调用不改动文档
  const doc3 = buildDoc([['ab'], ['cd']]);
  const before = JSON.stringify(doc3);
  replaceRangePlain(doc3, 1, 4, [{ text: 'z', bold: false }]);
  eq(JSON.stringify(doc3), before);
});

test('邻处接受/拒绝不影响彼此格式与段界（三处替换中间处单独操作）', () => {
  const ed = newEditor();
  ed.paste({ text: 'x-a-x-b-x' });
  // 把 'a'、'b' 加粗，验证格式隔离
  setBold(ed.doc, 2, 3, true);
  setBold(ed.doc, 6, 7, true);
  ed.render();
  ed.setTrackChanges(true);
  ed.previewReplaceAll('x', 'Q');
  ed.confirmReplaceAll();
  eq(exportText(ed.doc), 'Q-a-Q-b-Q');
  const revs = listRevisions(ed.doc);
  // 只拒绝中间一处的插入修订（第二处 Q）
  const insMid = revs.filter((r) => r.kind === 'insert')[1];
  ed.rejectRevision(insMid.id);
  eq(exportText(ed.doc), 'Q-a--b-Q', '中间新插入被拒，阅读视图恢复旧 x');
  // 加粗的 a/b 仍粗，段数不变
  const p0 = ed.doc.paragraphs[0];
  const boldTexts = p0.spans.filter((s) => s.bold).map((s) => s.text);
  ok(boldTexts.includes('a') && boldTexts.includes('b'), '相邻加粗格式保留');
  eq(ed.doc.paragraphs.length, 1);
  assertValid(ed);
});

test('Unicode 代理对：命中坐标与替换均按 UTF-16 码元，不错位', () => {
  const ed = newEditor();
  ed.paste({ text: '😀a😀' });
  const pv = ed.previewReplaceAll('😀', 'B');
  eq(pv.matches.length, 2);
  eq(pv.matches.map((m) => [m.from, m.to]), [[0, 2], [3, 5]]);
  ed.confirmReplaceAll();
  eq(docText(ed), 'BaB');
  // emoji 作为替换词也按码元落位
  const ed2 = newEditor();
  ed2.paste({ text: 'x-x' });
  ed2.previewReplaceAll('x', '😀');
  ed2.confirmReplaceAll();
  eq(docText(ed2), '😀-😀');
});

// ---------- 汇总 ----------

console.log(`\n${passed} 通过, ${failed} 失败`);
if (failed) {
  console.error('失败用例: ' + failures.join(' | '));
  process.exit(1);
}
