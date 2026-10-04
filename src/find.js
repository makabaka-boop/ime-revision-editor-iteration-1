// 查找并全部替换：在阅读视图的可见文字上做区分大小写、非重叠匹配。
// 命中允许跨越加粗 span，但不跨段落；含未决修订（插入/删除标记，
// 或可见文字中间夹着被删文字）的命中会被跳过并报告，绝不触碰已有修订。

import { locateInPara } from './model.js';

// 在 doc 的阅读视图可见文字中查找 find（区分大小写、非重叠、不跨段落）。
// 返回 { matches: [{from,to}], skipped: [{from,to}] }（模型线性偏移，各自升序）。
export function findAll(doc, find) {
  const matches = [];
  const skipped = [];
  if (!find) return { matches, skipped };
  let paraStart = 0;
  for (const p of doc.paragraphs) {
    // 本段可见文字 + 每个可见字符的模型偏移与“干净”标记（无未决修订）。
    let visible = '';
    const offs = [];
    const clean = [];
    let pos = paraStart;
    for (const s of p.spans) {
      if (s.del == null) { // 被删文字在阅读视图中隐藏，不参与匹配
        for (let i = 0; i < s.text.length; i++) {
          visible += s.text[i];
          offs.push(pos + i);
          clean.push(s.ins == null);
        }
      }
      pos += s.text.length;
    }
    let idx = 0;
    while ((idx = visible.indexOf(find, idx)) !== -1) {
      const end = idx + find.length;
      // 干净：每个字符都无未决插入标记，且模型偏移连续
      // （中间没有夹着阅读视图隐藏的被删文字）。
      let ok = true;
      for (let k = idx; k < end; k++) {
        if (!clean[k] || (k > idx && offs[k] !== offs[k - 1] + 1)) {
          ok = false;
          break;
        }
      }
      const rec = { from: offs[idx], to: offs[end - 1] + 1 };
      (ok ? matches : skipped).push(rec);
      idx = end; // 非重叠：无论命中是否被跳过，都消耗这段文字
    }
    paraStart = pos + 1; // +1：段后换行偏移
  }
  return { matches, skipped };
}

// 模型偏移处字符的加粗属性（替换词继承被替换文字首字符的格式）。
export function boldAt(doc, offset) {
  const { para, char } = locateInPara(doc, offset);
  let pos = 0;
  for (const s of doc.paragraphs[para].spans) {
    if (char < pos + s.text.length) return !!s.bold;
    pos += s.text.length;
  }
  return false;
}
