// 从同一文档模型派生的只读视图：阅读视图、修订表、导出。

// 阅读视图：插入视为普通文字，删除隐藏，被删换行合并段落。
// 返回 [{ spans: [{ text, bold }] }]。
export function finalParagraphs(doc) {
  const out = [];
  let mergeIntoPrev = false;
  for (const p of doc.paragraphs) {
    const spans = [];
    for (const s of p.spans) {
      if (s.del != null || !s.text) continue;
      const last = spans[spans.length - 1];
      if (last && last.bold === s.bold) last.text += s.text;
      else spans.push({ text: s.text, bold: s.bold });
    }
    if (mergeIntoPrev && out.length) {
      const prevSpans = out[out.length - 1].spans;
      for (const s of spans) {
        const last = prevSpans[prevSpans.length - 1];
        if (last && last.bold === s.bold) last.text += s.text;
        else prevSpans.push(s);
      }
    } else {
      out.push({ spans });
    }
    mergeIntoPrev = p.delBreak != null;
  }
  if (!out.length) out.push({ spans: [] });
  return out;
}

export function escapeHtml(s) {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

export function exportHtml(doc) {
  return finalParagraphs(doc)
    .map((p) => {
      const inner = p.spans
        .map((s) => (s.bold ? `<strong>${escapeHtml(s.text)}</strong>` : escapeHtml(s.text)))
        .join('');
      return `<p>${inner}</p>`;
    })
    .join('\n');
}

export function exportText(doc) {
  return finalParagraphs(doc)
    .map((p) => p.spans.map((s) => s.text).join(''))
    .join('\n');
}

// 修订表：扫描模型中的 ins/del/delBreak 标记，按修订 id 归组。
// 同一 id 同时带有删除与插入（替换全部产生的一对）时 kind 为 'replace'，
// text 形如 “旧→新”。
// 返回 [{ id, kind: 'insert'|'delete'|'replace', text, paragraphs: [paraIndex] }]。
export function listRevisions(doc) {
  const map = new Map();
  const add = (id, kind, text, para) => {
    if (id == null) return;
    let r = map.get(id);
    if (!r) {
      r = { id, insText: '', delText: '', paragraphs: new Set() };
      map.set(id, r);
    }
    if (kind === 'insert') r.insText += text;
    else r.delText += text;
    r.paragraphs.add(para);
  };
  doc.paragraphs.forEach((p, pi) => {
    if (p.ins != null) add(p.ins, 'insert', '¶', pi);
    for (const s of p.spans) {
      if (s.ins != null) add(s.ins, 'insert', s.text, pi);
      if (s.del != null) add(s.del, 'delete', s.text, pi);
    }
    if (p.delBreak != null) add(p.delBreak, 'delete', '¶', pi);
  });
  return [...map.values()]
    .sort((a, b) => a.id - b.id)
    .map((r) => {
      const both = r.insText !== '' && r.delText !== '';
      return {
        id: r.id,
        kind: both ? 'replace' : r.insText !== '' ? 'insert' : 'delete',
        text: both ? `${r.delText}→${r.insText}` : r.insText !== '' ? r.insText : r.delText,
        paragraphs: [...r.paragraphs],
      };
    });
}
