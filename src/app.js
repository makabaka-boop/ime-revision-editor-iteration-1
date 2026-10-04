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
const findInput = document.getElementById('find-input');
const replaceInput = document.getElementById('replace-input');
const btnPreviewReplace = document.getElementById('btn-preview-replace');
const btnReplaceAll = document.getElementById('btn-replace-all');
const replaceStatus = document.getElementById('replace-status');

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

editorEl.addEventListener('compositionstart', () => ed.compositionStart());
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
// 预览绑定文档版本号；任何文档变更（含撤销/重做）都会使旧预览失效。
// IME 组合期间控制器拒绝预览与执行，这里同步禁用按钮。

let pendingPreview = null;

function syncReplaceAllButton() {
  btnReplaceAll.disabled =
    !pendingPreview || pendingPreview.version !== ed.docVersion || !!ed.composing;
}

btnPreviewReplace.addEventListener('click', () => {
  const p = ed.previewReplaceAll(findInput.value, replaceInput.value);
  if (!p) {
    pendingPreview = null;
    replaceStatus.textContent = ed.composing ? '输入法组合中，稍后再试' : '请输入查找内容';
  } else {
    pendingPreview = p;
    replaceStatus.textContent =
      `命中 ${p.matches.length} 处` +
      (p.skipped.length ? `，${p.skipped.length} 处含未决修订已跳过` : '');
  }
  syncReplaceAllButton();
});

btnReplaceAll.addEventListener('click', () => {
  const r = ed.applyReplaceAll(pendingPreview);
  if (!r) {
    replaceStatus.textContent = '文档已变更，预览过期，请重新预览';
  } else {
    pendingPreview = null;
    replaceStatus.textContent =
      `已替换 ${r.applied} 处` + (r.skipped ? `，跳过 ${r.skipped} 处` : '');
  }
  syncReplaceAllButton();
});

// 查找/替换词一变，旧预览即失效
for (const input of [findInput, replaceInput]) {
  input.addEventListener('input', () => {
    pendingPreview = null;
    replaceStatus.textContent = '';
    syncReplaceAllButton();
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') btnPreviewReplace.click();
  });
}

// 组合开始/结束时刷新按钮可用性（组合期间禁止提交替换）
editorEl.addEventListener('compositionstart', () => syncReplaceAllButton());
editorEl.addEventListener('compositionend', () => syncReplaceAllButton());

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
    badge.textContent = r.kind === 'insert' ? '插入' : r.kind === 'delete' ? '删除' : '替换';
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
  syncReplaceAllButton(); // 文档版本可能已变，旧预览随之失效
}

ed.onrender = renderPanels;
ed.render();
