import { describe, expect, it } from 'vitest';

import { applyPixelId } from '../lib/pixel-id';

describe('applyPixelId', () => {
  it('troca o ID do snippet (init e set autoConfig) pelo pixel atual', () => {
    const html =
      "<script>fbq('init','1741152926934827');fbq('track','PageView');</script>" +
      "<script>fbq('set','autoConfig','false','1741152926934827');fbq('init', \"1741152926934827\",{},{eventID:'T'});</script>";
    const out = applyPixelId(html, '1077855071828347');
    expect(out).not.toContain('1741152926934827');
    expect(out.match(/1077855071828347/g)).toHaveLength(3);
    expect(out).toContain("fbq('track','PageView')");
  });

  it('sem pixel resolvido mantém o HTML', () => {
    const html = "fbq('init','1741152926934827');";
    expect(applyPixelId(html, null)).toBe(html);
  });
});
