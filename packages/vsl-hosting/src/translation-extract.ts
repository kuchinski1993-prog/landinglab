import { createHash } from 'node:crypto';

import { parse, serialize } from 'parse5';


export type VslTranslationUnit = { id: string; locator: number[]; type: 'text'|'attribute'; attribute?: string; original: string; context: string; sourceHash: string };
const ignored = new Set(['script','style','noscript']);
const hash = (s: string) => createHash('sha256').update(s).digest('hex');
export function extractVslTranslationUnits(html: string, sourceHash = hash(html)) {
  const root: any = parse(html); const units: VslTranslationUnit[] = [];
  const visit = (node: any, path: number[], context = '') => { const tag=String(node.nodeName ?? '').toLowerCase(); if (ignored.has(tag)) return; const nextContext=tag || context;
    if (node.nodeName === '#text' && node.value?.trim()) units.push({id:hash(`${sourceHash}:${path.join('.')}:text`),locator:path,type:'text',original:node.value,context:nextContext,sourceHash});
    if (node.attrs) for (const attr of node.attrs) if (['alt','title','placeholder','aria-label'].includes(attr.name) && attr.value.trim()) units.push({id:hash(`${sourceHash}:${path.join('.')}:${attr.name}`),locator:path,type:'attribute',attribute:attr.name,original:attr.value,context:nextContext,sourceHash});
    for (let i=0;i<(node.childNodes?.length ?? 0);i++) visit(node.childNodes[i],[...path,i],nextContext);
  }; visit(root,[]); return units;
}
export function applyVslTranslations(html: string, units: VslTranslationUnit[], values: Record<string,string>, expectedHash: string) {
  if (hash(html)!==expectedHash) throw new Error('VSL source revision changed'); const root: any=parse(html);
  for(const unit of units){const value=values[unit.id]; if(value===undefined) continue; if(value.includes('<')||value.includes('>')) throw new Error('VSL translation must remain text'); let node=root; for(const index of unit.locator) node=node.childNodes[index]; if(unit.type==='text') node.value=value; else {const attr=node.attrs?.find((x:any)=>x.name===unit.attribute); if(attr) attr.value=value;}}
  return serialize(root);
}
