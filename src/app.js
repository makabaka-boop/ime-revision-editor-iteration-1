// 页面装配：事件接线 + 阅读视图 / 修订表 / 导出面板（全部从同一模型生成）。

import { Editor } from './editor.js';
import { DomView, domPositionFromModelOffset, modelOffsetFromDomPosition } from './domview.js';
import { finalParagraphs, exportHtml } from './derive.js';

const editorEl = document.getElementById('editor');
const readingEl = document.getElementById('reading');
const revisionsEl = document.getElementById('revisions');
const exportEl = document.getElementById('export');
const btnUndo = document.getElementById('btn-undo');
const btnRedo = document.getElementById('btn-redo');
const btnBold = document.getElementById('btn-bold');
const chkTrack = document.getElementById('chk-track');
const btnAcceptAll = document.getElementById('btn-accept-all');
const btnRejectAll = document.getElementById('btn-reject-all');
const findText = document.getElementById('find-text');
const replaceText = document.getElementById('replace-text');
const btnPreview = document.getElementById('btn-preview');
const btnConfirm = document.getElementById('btn-confirm');
const btnCancel = document.getElementById('btn-cancel');
const findStatus = document.getElementById('find-status');

let syncingSelection = false;

const view = new DomView(editorEl, (sel) => {
  const a = domPositionFromModelOffset(editorEl, sel.anchor);
  const h = domPositionFromModelOffset(editorEl, sel.head);
  const s = window.getSelection();
  syncingSelection = true;
  try {
    s.setBaseAndExtent(a.node, a.offset, h.node, h.offset);
  } catch {
    /* 忽略个别浏览器对边界位置的拒绝 */
  }
  setTimeout(() => { syncingSelection = false; }, 0);
});

const ed = new Editor(view);

// ---- 编辑器 DOM 事件 -> 控制器 ----

editorEl.addEventListener('beforeinput', (e) => {
  const r = ed.handleBeforeInput({
    inputType: e.inputType,
    data: e.data,
    isComposing: e.isComposing,
  });
  if (r.preventDefault) e.preventDefault();
});

editorEl.addEventListener('input', () => ed.handleInput());

editorEl.addEventListener('compositionstart', () => {
  ed.compositionStart();
  // 组合期间禁止查找替换，避免提交替换或丢失临时输入。
  btnPreview.disabled = true;
  btnConfirm.disabled = true;
  btnCancel.disabled = true;
});
editorEl.addEventListener('compositionend', (e) => ed.compositionEnd(e.data ?? ''));

editorEl.addEventListener('paste', (e) => {
  e.preventDefault();
  const html = e.clipboardData.getData('text/html');
  const text = e.clipboardData.getData('text/plain');
  ed.paste({ html: html || null, text });
});

document.addEventListener('selectionchange', () => {
  if (syncingSelection || ed.composing) return;
  const s = window.getSelection();
  if (!s.anchorNode || !editorEl.contains(s.anchorNode) || !editorEl.contains(s.focusNode)) return;
  ed.setSelection({
    anchor: modelOffsetFromDomPosition(editorEl, s.anchorNode, s.anchorOffset),
    head: modelOffsetFromDomPosition(editorEl, s.focusNode, s.focusOffset),
  });
});

editorEl.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key.toLowerCase() === 'b') {
    e.preventDefault();
    ed.toggleBold();
  }
});

// ---- 工具栏 ----

btnUndo.addEventListener('click', () => ed.undo());
btnRedo.addEventListener('click', () => ed.redo());
btnBold.addEventListener('click', () => ed.toggleBold());
chkTrack.addEventListener('change', () => ed.setTrackChanges(chkTrack.checked));
btnAcceptAll.addEventListener('click', () => ed.acceptAll());
btnRejectAll.addEventListener('click', () => ed.rejectAll());

// ---- 查找并全部替换 ----
// 预览绑定文档修订（docVersion）：任何文档变更都会让确认按钮失效，
// 必须重新预览；IME 组合期间按钮禁用，既不提交也不打断临时输入。

const SKIP_REASON_TEXT = {
  insert: '范围含未决插入修订',
  delete: '范围含未决删除修订或被删段界',
};

let pendingPreview = false;

function setFindStatus(text, isError = false) {
  findStatus.textContent = text;
  findStatus.style.color = isError ? '#dc2626' : '#6b7280';
}

function setPreviewButtons(hasPreview) {
  pendingPreview = hasPreview;
  btnConfirm.disabled = !hasPreview;
  btnCancel.disabled = !hasPreview;
}

function skipSummary(skipped) {
  if (!skipped.length) return '';
  const reasons = {};
  for (const s of skipped) reasons[s.reason] = (reasons[s.reason] || 0) + 1;
  const detail = Object.entries(reasons)
    .map(([r, n]) => `${SKIP_REASON_TEXT[r] || r} ${n} 处`)
    .join('；');
  return `；跳过 ${skipped.length} 处（${detail}），未改动其修订`;
}

btnPreview.addEventListener('click', () => {
  const r = ed.previewReplaceAll(findText.value, replaceText.value);
  if (!r.ok) {
    setPreviewButtons(false);
    if (r.error === 'composing') setFindStatus('输入法组合中，请稍后再试', true);
    else if (r.error === 'empty-query') setFindStatus('请输入要查找的词', true);
    else setFindStatus('无法生成预览', true);
    return;
  }
  setPreviewButtons(true);
  const where = r.trackChanges ? '修订模式：每处将生成独立的删除/插入修订' : '非修订模式：直接替换';
  setFindStatus(`将替换 ${r.matches.length} 处（${where}）${skipSummary(r.skipped)}`);
});

btnConfirm.addEventListener('click', () => {
  const r = ed.confirmReplaceAll();
  if (!r.ok) {
    setPreviewButtons(false);
    if (r.error === 'stale') setFindStatus('文档已改变，旧预览已失效，请重新预览', true);
    else if (r.error === 'composing') setFindStatus('输入法组合中，请稍后再试', true);
    else if (r.error === 'no-preview') setFindStatus('请先生成预览', true);
    else setFindStatus('替换被拒绝', true);
    return;
  }
  setPreviewButtons(false);
  setFindStatus(`已替换 ${r.applied} 处${skipSummary(r.skipped)}`);
});

btnCancel.addEventListener('click', () => {
  ed.cancelPreview();
  setPreviewButtons(false);
  setFindStatus('已取消预览');
});

// 查找/替换词改变后旧预览作废，需重新预览。
for (const el of [findText, replaceText]) {
  el.addEventListener('input', () => {
    if (pendingPreview) {
      ed.cancelPreview();
      setPreviewButtons(false);
      setFindStatus('查找内容已修改，请重新预览');
    }
  });
}

// ---- 面板（阅读视图 / 修订表 / 导出，均从同一模型派生） ----

function renderPanels(state) {
  readingEl.textContent = '';
  for (const p of finalParagraphs(state.doc)) {
    const pel = document.createElement('p');
    let hasText = false;
    for (const s of p.spans) {
      if (!s.text) continue;
      hasText = true;
      if (s.bold) {
        const st = document.createElement('strong');
        st.textContent = s.text;
        pel.appendChild(st);
      } else {
        pel.appendChild(document.createTextNode(s.text));
      }
    }
    if (!hasText) pel.appendChild(document.createElement('br'));
    readingEl.appendChild(pel);
  }

  revisionsEl.textContent = '';
  if (!state.revisions.length) {
    const li = document.createElement('li');
    li.className = 'empty';
    li.textContent = '无修订';
    revisionsEl.appendChild(li);
  }
  for (const r of state.revisions) {
    const li = document.createElement('li');
    const badge = document.createElement('span');
    badge.className = `badge ${r.kind}`;
    badge.textContent = r.kind === 'insert' ? '插入' : '删除';
    const preview = document.createElement('span');
    preview.className = 'preview';
    const text = r.text.length > 24 ? r.text.slice(0, 24) + '…' : r.text;
    preview.textContent = ` “${text}”`;
    const accept = document.createElement('button');
    accept.textContent = '接受';
    accept.addEventListener('click', () => ed.acceptRevision(r.id));
    const reject = document.createElement('button');
    reject.textContent = '拒绝';
    reject.addEventListener('click', () => ed.rejectRevision(r.id));
    li.append(badge, preview, accept, reject);
    revisionsEl.appendChild(li);
  }

  exportEl.value = exportHtml(state.doc);
  btnUndo.disabled = !state.canUndo;
  btnRedo.disabled = !state.canRedo;
  btnBold.classList.toggle('active', state.typingBold);
  chkTrack.checked = state.trackChanges;

  // 每次重渲染都意味着文档或模式变化（控制器已让旧预览失效）；
  // 组合期间禁止发起/确认替换，避免提交替换或丢失临时输入。
  if (state.composing) {
    btnPreview.disabled = true;
    btnConfirm.disabled = true;
    btnCancel.disabled = true;
  } else {
    btnPreview.disabled = false;
    if (pendingPreview) {
      // 文档变更/撤销重做使版本不符，或模式被切换：预览过期。
      const pv = ed.preview;
      const stale = !pv || pv.version !== state.docVersion || pv.trackChanges !== state.trackChanges;
      if (stale) {
        setPreviewButtons(false);
        setFindStatus('文档已改变，预览已过期，请重新预览');
      } else {
        btnConfirm.disabled = false;
        btnCancel.disabled = false;
      }
    }
  }
}

ed.onrender = renderPanels;
ed.render();
