import { Editor } from './src/editor.js';
import { listRevisions, exportText } from './src/derive.js';
import { plainText } from './src/model.js';
const V=class{render(){}};

// 1) 替换词为空 = 删除命中词（非修订）
let ed = new Editor(new V());
ed.paste({text:'a-b-c'});
let pv = ed.previewReplaceAll('-', '');
console.log('1 empty repl matches', pv.matches.length);
let r = ed.confirmReplaceAll();
console.log('  result', plainText(ed.doc), JSON.stringify(r));

// 2) 无命中确认：applied 0，一笔事务都不该产生
ed = new Editor(new V());
ed.paste({text:'hello'});
const ub = ed.undoStack.length;
pv = ed.previewReplaceAll('zzz', 'q');
console.log('2 no match', pv.matches.length, pv.skipped.length);
r = ed.confirmReplaceAll();
console.log('  applied', r.applied, 'undoDelta', ed.undoStack.length - ub, 'text', plainText(ed.doc));

// 3) 替换词更长，命中只有部分粗体：'ab' a普通 b粗 -> 'XYZ' 的粗体对位
ed = new Editor(new V());
ed.paste({text:'ab'});
const { setBold } = await import('./src/model.js');
setBold(ed.doc, 1, 2, true); ed.render();
pv = ed.previewReplaceAll('ab', 'XYZ');
console.log('3 bolds map', JSON.stringify(pv.matches[0].bolds));
r = ed.confirmReplaceAll();
console.log('  spans', JSON.stringify(ed.doc.paragraphs[0].spans));

// 4) 修订模式空替换词：删除修订 + 空插入（不产生插入修订）
ed = new Editor(new V());
ed.paste({text:'a-b'});
ed.setTrackChanges(true);
pv = ed.previewReplaceAll('-', '');
r = ed.confirmReplaceAll();
console.log('4 tracked empty repl revs', listRevisions(ed.doc).map(x=>[x.kind,x.text]), 'read', exportText(ed.doc));
