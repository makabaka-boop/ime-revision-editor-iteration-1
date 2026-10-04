// 编辑器控制器：与 DOM 无关。持有文档、选区、撤销/重做栈、修订计数器，
// 以及输入法组合（IME）状态机。DOM 事件由视图层适配后转发到这里。

import {
  createDoc, cloneDoc, textLength, insertTextInto, deleteRange, markDeleted,
  splitParagraph, insertParagraphs, setBold, allBold, insertionAttrs,
  acceptRevision, rejectRevision, mapThroughRemovals,
  replaceRangePlain, replaceRangeTracked,
} from './model.js';
import { listRevisions } from './derive.js';
import { sanitizeHtml, textToParagraphs } from './sanitize.js';
import { findAll, segmentsFor } from './find.js';

const collapsed = (o) => ({ anchor: o, head: o });
const rangeOf = (sel) => [Math.min(sel.anchor, sel.head), Math.max(sel.anchor, sel.head)];

// 把旧坐标系偏移映射到一批“从右向左应用的同段替换”之后的新坐标系。
// edits 按应用顺序（from 降序）排列；落在被替换区间内的偏移折叠到区间起点。
function mapThroughReplacements(offset, edits) {
  let result = offset;
  for (const e of edits) { // 右 -> 左：每次调整都发生在当前已处理部分之外
    const delta = e.len - (e.to - e.from);
    if (result >= e.to) result += delta;
    else if (result > e.from) result = e.from;
  }
  return result;
}

export class Editor {
  // view: { render(state) }。state 见 getState()。
  constructor(view) {
    this.view = view;
    this.doc = createDoc();
    this.sel = collapsed(0);
    this.trackChanges = false;
    this.typingBold = false;
    this.undoStack = [];
    this.redoStack = [];
    this.revCounter = 1;
    this.composing = null;      // { sel } 组合会话
    this._mergeType = null;     // 'insert' | 'delete' | null：可合并的连续输入
    this._runRevId = null;      // 当前输入合并段使用的修订 id
    this.docVersion = 0;        // 每次文档变更自增；用于使旧预览失效
    this.preview = null;        // 绑定到 docVersion 的“全部替换”预览
    this.onrender = null;
  }

  // ---- 状态与渲染 -------------------------------------------------------

  getState() {
    return {
      doc: this.doc,
      sel: this.sel,
      trackChanges: this.trackChanges,
      typingBold: this.typingBold,
      revisions: listRevisions(this.doc),
      canUndo: this.undoStack.length > 0,
      canRedo: this.redoStack.length > 0,
      docVersion: this.docVersion,
      composing: this.composing != null,
    };
  }

  render() {
    const state = this.getState();
    this.view.render(state);
    if (this.onrender) this.onrender(state);
  }

  _clampOffset(o) {
    return Math.max(0, Math.min(o, textLength(this.doc)));
  }

  // 外部（DOM selectionchange）上报选区。与当前相同则忽略，
  // 否则视为用户主动移动光标：打断输入合并。
  setSelection(sel) {
    const anchor = this._clampOffset(sel.anchor);
    const head = this._clampOffset(sel.head);
    if (anchor === this.sel.anchor && head === this.sel.head) return;
    this.sel = { anchor, head };
    this._mergeType = null;
    this._runRevId = null;
  }

  // ---- 事务与历史 ---------------------------------------------------------

  _newRev() {
    return this.revCounter++;
  }

  // mergeType 相同且连续的提交合并为同一笔可撤销事务。
  _commit(doc, sel, mergeType = null) {
    if (mergeType === null || mergeType !== this._mergeType) {
      this.undoStack.push({ doc: this.doc, sel: this.sel });
    }
    this._mergeType = mergeType;
    if (mergeType !== 'insert' && mergeType !== 'delete') this._runRevId = null;
    this.redoStack.length = 0;
    this.doc = doc;
    this.docVersion++;
    // 不清空 preview：旧预览保留，确认时按 version 判其过期（stale）。
    this.sel = { anchor: this._clampOffset(sel.anchor), head: this._clampOffset(sel.head) };
    this.render();
  }

  undo() {
    const s = this.undoStack.pop();
    if (!s) return;
    this.redoStack.push({ doc: this.doc, sel: this.sel });
    this.doc = s.doc;
    this.docVersion++;
    // 预览保留；版本不再匹配，确认时报告 stale。
    this.sel = { anchor: this._clampOffset(s.sel.anchor), head: this._clampOffset(s.sel.head) };
    this._mergeType = null;
    this._runRevId = null;
    this.render();
  }

  redo() {
    const s = this.redoStack.pop();
    if (!s) return;
    this.undoStack.push({ doc: this.doc, sel: this.sel });
    this.doc = s.doc;
    this.docVersion++;
    // 预览保留；版本不再匹配，确认时报告 stale。
    this.sel = { anchor: this._clampOffset(s.sel.anchor), head: this._clampOffset(s.sel.head) };
    this._mergeType = null;
    this._runRevId = null;
    this.render();
  }

  // ---- 编辑操作 -----------------------------------------------------------

  // 在 [from, to) 上应用“若有选区先删除”的逻辑，返回删除后的文档与插入点。
  _deleteSelectionIfAny(doc, from, to) {
    if (from === to) return doc;
    if (this.trackChanges) markDeleted(doc, from, to, this._newRev());
    else deleteRange(doc, from, to);
    return doc;
  }

  insertText(text) {
    if (!text || this.composing) return;
    const [from, to] = rangeOf(this.sel);
    const doc = cloneDoc(this.doc);
    this._deleteSelectionIfAny(doc, from, to);
    let revId = null;
    if (this.trackChanges) {
      revId = this._mergeType === 'insert' && this._runRevId != null
        ? this._runRevId
        : this._newRev();
      this._runRevId = revId;
    }
    const attrs = insertionAttrs(doc, from, { bold: this.typingBold, trackRevId: revId });
    insertTextInto(doc, from, text, attrs);
    this._commit(doc, collapsed(from + text.length), 'insert');
  }

  _applyDelete(from, to, mergeType) {
    if (from >= to) return;
    const doc = cloneDoc(this.doc);
    if (this.trackChanges) {
      const revId = mergeType === 'delete' && this._mergeType === 'delete' && this._runRevId != null
        ? this._runRevId
        : this._newRev();
      this._runRevId = revId;
      markDeleted(doc, from, to, revId);
    } else {
      deleteRange(doc, from, to);
    }
    this._commit(doc, collapsed(from), mergeType);
  }

  deleteBackward() {
    const [from, to] = rangeOf(this.sel);
    const f = from === to ? from - 1 : from;
    if (f < 0) return;
    this._applyDelete(f, to, 'delete');
  }

  deleteForward() {
    const [from, to] = rangeOf(this.sel);
    const t = from === to ? to + 1 : to;
    if (t > textLength(this.doc)) return;
    this._applyDelete(from, t, 'delete');
  }

  deleteSelection() {
    const [from, to] = rangeOf(this.sel);
    this._applyDelete(from, to, null);
  }

  insertParagraph() {
    const [from, to] = rangeOf(this.sel);
    const doc = cloneDoc(this.doc);
    this._deleteSelectionIfAny(doc, from, to);
    splitParagraph(doc, from, this.trackChanges ? this._newRev() : null);
    this._commit(doc, collapsed(from + 1), null);
  }

  toggleBold() {
    const [from, to] = rangeOf(this.sel);
    if (from === to) {
      this.typingBold = !this.typingBold;
      this.render();
      return;
    }
    const bold = !allBold(this.doc, from, to);
    const doc = cloneDoc(this.doc);
    setBold(doc, from, to, bold);
    this.typingBold = bold;
    this._commit(doc, { ...this.sel }, null);
  }

  setTrackChanges(on) {
    this.trackChanges = !!on;
    this._mergeType = null;
    this._runRevId = null;
    // 不清空 preview：confirmReplaceAll 会用 trackChanges 字段判其过期（stale）。
    this.render();
  }

  // 粘贴：纯文本或净化后的 HTML，一笔事务。
  paste({ text = '', html = null } = {}) {
    const paras = html != null ? sanitizeHtml(html) : textToParagraphs(text);
    const [from, to] = rangeOf(this.sel);
    const doc = cloneDoc(this.doc);
    this._deleteSelectionIfAny(doc, from, to);
    const ins = this.trackChanges ? this._newRev() : null;
    const inserted = insertParagraphs(doc, from, paras, { ins });
    this._commit(doc, collapsed(from + inserted), null);
  }

  // ---- 修订接受 / 拒绝 ------------------------------------------------------

  _applyRevisionOp(op, revId) {
    const doc = cloneDoc(this.doc);
    const removals = op(doc, revId);
    const sel = {
      anchor: mapThroughRemovals(this.sel.anchor, removals),
      head: mapThroughRemovals(this.sel.head, removals),
    };
    this._commit(doc, sel, null);
  }

  acceptRevision(revId) {
    if (!listRevisions(this.doc).some((r) => r.id === revId)) return;
    this._applyRevisionOp(acceptRevision, revId);
  }

  rejectRevision(revId) {
    if (!listRevisions(this.doc).some((r) => r.id === revId)) return;
    this._applyRevisionOp(rejectRevision, revId);
  }

  acceptAll() {
    const ids = listRevisions(this.doc).map((r) => r.id);
    if (!ids.length) return;
    const doc = cloneDoc(this.doc);
    let sel = { ...this.sel };
    for (const id of ids) {
      const removals = acceptRevision(doc, id);
      sel = {
        anchor: mapThroughRemovals(sel.anchor, removals),
        head: mapThroughRemovals(sel.head, removals),
      };
    }
    this._commit(doc, sel, null);
  }

  rejectAll() {
    const ids = listRevisions(this.doc).map((r) => r.id);
    if (!ids.length) return;
    const doc = cloneDoc(this.doc);
    let sel = { ...this.sel };
    for (const id of ids) {
      const removals = rejectRevision(doc, id);
      sel = {
        anchor: mapThroughRemovals(sel.anchor, removals),
        head: mapThroughRemovals(sel.head, removals),
      };
    }
    this._commit(doc, sel, null);
  }

  // ---- 查找并全部替换 ------------------------------------------------------
  //
  // 流程：previewReplaceAll 按当前阅读视图可见文字计算命中并生成**绑定到
  // docVersion 的预览**；confirmReplaceAll 执行时若文档已变更（版本不符）或
  // 修订模式被切换，则拒绝旧预览。整批替换只提交一笔事务（一次撤销/重做）。
  // 从右向左逐处应用，先分配修订 id 再执行，因此新插入的词不会再次成为
  // 本批命中；修订模式下每处产生“删除 + 插入”两条相互独立的修订身份。

  // 生成预览。组合期间拒绝（避免与浏览器临时 DOM 冲突）。
  // 返回 { ok, query, replacement, matches, skipped, version, trackChanges }
  // 或 { ok:false, error }。
  previewReplaceAll(query, replacement) {
    if (this.composing) return { ok: false, error: 'composing' };
    query = String(query ?? '');
    replacement = String(replacement ?? '');
    if (!query) {
      this.preview = null;
      return { ok: false, error: 'empty-query' };
    }
    const found = findAll(this.doc, query);
    // 为每处命中预算替换段（粗体按命中字符对位继承，多余字符沿用末位粗体）。
    const matches = found.matches.map((m) => ({
      ...m,
      replacement,
      segments: segmentsFor(replacement, m.bolds),
    }));
    this.preview = {
      query,
      replacement,
      matches,
      skipped: found.skipped,
      version: this.docVersion,
      trackChanges: this.trackChanges,
    };
    return {
      ok: true,
      query,
      replacement,
      matches,
      skipped: found.skipped,
      version: this.docVersion,
      trackChanges: this.trackChanges,
    };
  }

  cancelPreview() {
    this.preview = null;
  }

  // 确认预览。返回 { ok, applied, skipped } 或 { ok:false, error }。
  confirmReplaceAll() {
    if (this.composing) return { ok: false, error: 'composing' };
    const pv = this.preview;
    if (!pv) return { ok: false, error: 'no-preview' };
    if (pv.version !== this.docVersion) return { ok: false, error: 'stale' };
    if (pv.trackChanges !== this.trackChanges) return { ok: false, error: 'stale' };
    if (!pv.matches.length) {
      this.preview = null;
      return { ok: true, applied: 0, skipped: pv.skipped };
    }

    // 从右向左应用：右侧替换产生的位移不影响左侧命中的原始坐标；
    // 新插入的词因此也不可能再次进入本批匹配。
    const ordered = [...pv.matches].sort((a, b) => b.from - a.from);
    // 先按从左到右顺序分配修订 id（修订表按 id 升序，id 顺序即文档顺序）。
    const revByIdx = pv.matches.map(() => ({
      del: this.trackChanges ? this._newRev() : null,
      ins: this.trackChanges ? this._newRev() : null,
    }));

    const doc = cloneDoc(this.doc);
    const edits = []; // { from, to, len } 实际应用序列（从右向左）
    for (const m of ordered) {
      const ids = revByIdx[m.index];
      if (this.trackChanges) {
        replaceRangeTracked(doc, m.from, m.to, m.segments, ids.del, ids.ins);
      } else {
        replaceRangePlain(doc, m.from, m.to, m.segments);
      }
      edits.push({ from: m.from, to: m.to, len: m.replacement.length });
    }

    const mapOffset = (o) => mapThroughReplacements(o, edits);
    const sel = { anchor: mapOffset(this.sel.anchor), head: mapOffset(this.sel.head) };
    const applied = pv.matches.length;
    const skipped = pv.skipped;
    this.preview = null;      // 成功消费预览
    this._commit(doc, sel, null); // 整批一笔事务
    return { ok: true, applied, skipped };
  }

  // ---- 输入法组合（IME） -----------------------------------------------------
  // 组合期间浏览器直接往 DOM 里写临时内容，控制器不记录；
  // compositionend 时把最终结果作为一笔可撤销事务提交，
  // 随后浏览器补发的 input 事件被忽略，保证同一次输入不会记两遍。

  compositionStart() {
    if (this.composing) return;
    this.composing = { sel: { ...this.sel } };
  }

  compositionEnd(data) {
    if (!this.composing) return;
    const sel = this.composing.sel;
    this.composing = null;
    this._mergeType = null;
    this._runRevId = null;
    if (!data) {
      this.render(); // 重渲染以清除浏览器留下的临时 DOM
      return;
    }
    const [from, to] = rangeOf(sel);
    const doc = cloneDoc(this.doc);
    this._deleteSelectionIfAny(doc, from, to);
    const revId = this.trackChanges ? this._newRev() : null;
    const attrs = insertionAttrs(doc, from, { bold: this.typingBold, trackRevId: revId });
    insertTextInto(doc, from, data, attrs);
    this.sel = collapsed(from); // 撤销应回到组合前的选区
    this._commit(doc, collapsed(from + data.length), null);
  }

  // ---- 事件路由（由视图层调用） ---------------------------------------------
  // 返回 { preventDefault } 告知视图是否阻止浏览器默认行为。

  handleBeforeInput(e) {
    const t = e.inputType;
    // 组合期间的 insertCompositionText：放行让浏览器显示临时内容，不记录。
    if (this.composing || e.isComposing || t === 'insertCompositionText') {
      return { preventDefault: false };
    }
    switch (t) {
      case 'insertText':
        if (e.data != null && e.data.includes('\n')) this.paste({ text: e.data });
        else this.insertText(e.data ?? '');
        return { preventDefault: true };
      case 'insertParagraph':
      case 'insertLineBreak':
        this.insertParagraph();
        return { preventDefault: true };
      case 'deleteContentBackward':
        this.deleteBackward();
        return { preventDefault: true };
      case 'deleteContentForward':
        this.deleteForward();
        return { preventDefault: true };
      case 'deleteByCut':
        this.deleteSelection();
        return { preventDefault: true };
      case 'historyUndo':
        this.undo();
        return { preventDefault: true };
      case 'historyRedo':
        this.redo();
        return { preventDefault: true };
      default:
        // insertFromPaste / insertFromDrop 由 paste 事件处理；
        // 其余（格式化、替换等）一律阻止，保护模型。
        return { preventDefault: true };
    }
  }

  // 所有编辑都已在 beforeinput / compositionend 中应用；
  // input 事件一律忽略，避免同一次输入被记两遍。
  handleInput() {}
}
