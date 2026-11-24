import { selectAll } from 'css-select';
import { parse } from 'parse5';
import { adapter } from 'parse5-htmlparser2-tree-adapter';

export interface VslVideoPlacement { strategy: 'PLACEHOLDER' | 'SELECTOR' | 'DEDICATED'; selector?: string }

export function validateVideoPlacement(html: string, placement: VslVideoPlacement): void {
  if (placement.strategy === 'DEDICATED') return;
  const selector = placement.strategy === 'PLACEHOLDER' ? '[data-blackshop-video]' : placement.selector;
  if (!selector) throw new Error('Video selector is required');
  const tree = parse(html, { treeAdapter: adapter });
  let matches: unknown[];
  try { matches = selectAll(selector, tree.children); }
  catch { throw new Error('Invalid video selector'); }
  if (matches.length !== 1) throw new Error('Video placement must match exactly one element');
}
