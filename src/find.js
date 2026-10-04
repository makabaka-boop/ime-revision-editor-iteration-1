// “查找并全部替换”的匹配逻辑。
//
// 匹配基于阅读视图（finalParagraphs）的可见文字：
//   - 区分大小写、非重叠；
//   - 允许命中跨越加粗 span（匹配只看可见文字）；
//   - 不跨段落（逐行匹配；换行在阅读视图中不出现为字符）。
// 每个命中映射回模型中的连续字符区间。映射时若发现：
//   - 区间内有未决插入（span.ins）或未决删除（span.del）文字，或
//   - 可见拼接跨过了被删除的段间换行（delBreak，阅读视图里两段并成一行），
// 则该命中被跳过并给出原因，绝不改动既有修订身份。
//
// 结果：
//   matches: [{ para, from, to, replacement, bolds }]  模型坐标，同段、from<to
//   skipped: [{ index, para, at, snippet, reason }]
//     reason: 'insert' 命中范围含未决插入
//             'delete' 命中范围含未决删除，或跨过被删除的段界

import { paraLen } from './model.js';

// 构建阅读视图一行（模型段落经 delBreak 合并后的可见串）到模型字符的映射。
// visible 由 finalParagraphs 给出，我们直接从模型重建，逐 span 过滤 del 文字。
// 返回 { text, chars: [{ para, offset, ch, bold }] }，offset 为模型线性偏移。
function buildVisibleLine(doc, startPara) {
  const text = [];
  const chars = [];
  let pi = startPara;
  while (pi < doc.paragraphs.length) {
    const p = doc.paragraphs[pi];
    // 本段在全文线性坐标系中的起点（计入此前所有段文本与换行）。
    let pos = 0;
    for (let i = 0; i < pi; i++) pos += paraLen(doc.paragraphs[i]) + 1;
    for (const s of p.spans) {
      // 与模型一致使用 UTF-16 码元偏移：按码元遍历（含代理对的两半），
      // 线性偏移 pos 与 s.text.length/indexOf 同坐标系。
      for (let k = 0; k < s.text.length; k++) {
        const ch = s.text[k];
        if (s.del == null) {
          text.push(ch);
          chars.push({ para: pi, offset: pos, ch, bold: !!s.bold, ins: s.ins ?? null });
        }
        pos++;
      }
    }
    if (p.delBreak == null || pi === doc.paragraphs.length - 1) break;
    pi++; // 段后换行被标记删除：阅读视图中下段与本段并为同一行
  }
  return { text: text.join(''), chars, endPara: pi };
}

// 合并相邻同粗体的替换段（按 UTF-16 码元，与模型偏移一致）。
export function segmentsFor(text, bolds) {
  const segs = [];
  for (let i = 0; i < text.length; i++) {
    const bold = bolds[Math.min(i, bolds.length - 1)];
    const last = segs[segs.length - 1];
    if (last && last.bold === bold) last.text += text[i];
    else segs.push({ text: text[i], bold });
  }
  return segs;
}

// 在单个可见行内做区分大小写的非重叠匹配，产出 match/skipped。
function scanLine(doc, startPara, query, out, counters) {
  const line = buildVisibleLine(doc, startPara);
  const hay = line.text;
  let fromIdx = 0;
  let cut;
  while ((cut = hay.indexOf(query, fromIdx)) !== -1) {
    fromIdx = cut + query.length; // 非重叠：下一次从命中之后继续
    const covered = line.chars.slice(cut, cut + query.length);
    const first = covered[0];
    const last = covered[covered.length - 1];
    const snippet = hay.slice(Math.max(0, cut - 6), cut + query.length + 6);

    // 跨越被删除的段界：可见行内包含多个模型段落。
    let reason = first.para === last.para ? null : 'delete';
    // 模型连续性检查（检测 del 字符造成的间隙）与未决插入检查。
    if (!reason) {
      for (let k = 1; k < covered.length; k++) {
        if (covered[k].offset !== covered[k - 1].offset + 1) {
          reason = 'delete'; // 中间夹着被隐藏的删除文字
          break;
        }
      }
    }
    if (!reason) {
      for (const c of covered) {
        if (c.ins != null) { reason = 'insert'; break; }
      }
    }

    if (reason) {
      out.skipped.push({
        index: counters.skipped,
        para: first.para,
        at: first.offset,
        snippet,
        reason,
      });
      counters.skipped++;
      continue;
    }
    const bolds = covered.map((c) => c.bold);
    out.matches.push({
      index: counters.match,
      para: first.para,
      from: first.offset,
      to: last.offset + 1,
      found: query,
      bolds,
    });
    counters.match++;
  }
  return line.endPara;
}

// 全文查找。返回 { query, matches, skipped }。matches 按位置升序。
export function findAll(doc, query) {
  const out = { query, matches: [], skipped: [] };
  if (!query) return out;
  const counters = { match: 0, skipped: 0 };
  let pi = 0;
  while (pi < doc.paragraphs.length) {
    const endPara = scanLine(doc, pi, query, out, counters);
    pi = endPara + 1;
  }
  return out;
}
