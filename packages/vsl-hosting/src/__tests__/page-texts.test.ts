// Extrator de textos (F1b): blocos visíveis, atributos, title/meta e strings de quiz detectadas com segurança;
// aplicar edições só troca os trechos editados (resto byte a byte).
import { describe, expect, it } from 'vitest';

import { applyPageTextEdits, decodePageHtml, extractPageTextBlocks, PageTextError } from '../page-texts.js';

const HTML = `<!doctype html>
<html lang="pt-BR"><head><meta charset="utf-8"><title>Oferta &amp; Bônus</title>
<meta name="description" content="Descubra o método"><meta property="og:title" content="Método X"><meta name="viewport" content="width=device-width">
<style>.x{content:"não é texto"}</style></head>
<body><h1 class="hero-title">  Emagreça   rápido </h1><p>Por apenas <b>R$ 197,00</b> hoje.</p>
<img src="a.png" alt="Foto do produto"><input type="submit" value="Quero agora"><input placeholder="Seu e-mail"><input type="hidden" value="secreto">
<a class="btn-cta" href="#">Comprar agora</a><a href="/termos">Termos de uso</a><button aria-label="Fechar janela">×</button>
<noscript>Ative o JavaScript</noscript><template><p>Modelo</p></template>
<script>const quiz = { questions: [{ question: 'Qual sua idade?', answers: ['Menos de 30', "Mais de 30"] },
  { question: \`Você já tentou dietas?\`, options: [{ text: 'Sim', value: 'yes' }, { text: 'Não', value: 'no' }] }] };
var greeting = 'hello world'; el.className = 'active'; fetch('/api/x'); const cfg = { title: 'Configuração interna' };</script>
<script type="application/json" id="data">{"quiz":{"title":"Descubra seu perfil","steps":[{"pergunta":"Quantos kg quer perder?","respostas":["Até 5 kg","Mais de 10 kg"]}]}}</script>
<script type="application/ld+json">{"name":"Produto"}</script>
<script src="/app.js"></script>
</body></html>`;

describe('extractPageTextBlocks', () => {
  const blocks = extractPageTextBlocks(HTML);
  const byText = (text: string) => blocks.find((block) => block.text === text);

  it('extracts visible text, attributes, title and meta with PT-BR labels', () => {
    expect(byText('Oferta & Bônus')).toMatchObject({ kind: 'title', label: 'Título da página (aba do navegador)' });
    expect(byText('Descubra o método')).toMatchObject({ kind: 'meta', label: 'Descrição da página (SEO)' });
    expect(byText('Método X')).toMatchObject({ kind: 'meta', label: 'Título para compartilhamento' });
    expect(byText('Emagreça   rápido')).toMatchObject({ kind: 'text', label: 'Título', path: 'h1.hero-title' });
    expect(byText('R$ 197,00')).toMatchObject({ kind: 'text', label: 'Parágrafo', context: 'Por apenas R$ 197,00 hoje.' });
    expect(byText('Foto do produto')).toMatchObject({ kind: 'attribute', label: 'Texto alternativo da imagem' });
    expect(byText('Quero agora')).toMatchObject({ kind: 'attribute', label: 'Botão' });
    expect(byText('Seu e-mail')).toMatchObject({ kind: 'attribute', label: 'Texto de exemplo do campo' });
    expect(byText('Comprar agora')).toMatchObject({ kind: 'text', label: 'Botão' });
    expect(byText('Termos de uso')).toMatchObject({ kind: 'text', label: 'Link' });
    expect(byText('Fechar janela')).toMatchObject({ kind: 'attribute', label: 'Rótulo de acessibilidade' });
  });

  it('skips code, hidden values, styles, noscript, templates and non-quiz script strings', () => {
    for (const text of ['secreto', 'não é texto', 'Ative o JavaScript', 'Modelo', 'hello world', 'active', '/api/x', 'Configuração interna', 'Produto', 'width=device-width', '×'])
      expect(byText(text), text).toBeUndefined();
  });

  it('detects quiz strings in JS literals and embedded JSON only', () => {
    expect(byText('Qual sua idade?')).toMatchObject({ kind: 'script-string', label: 'Pergunta do quiz' });
    expect(byText('Menos de 30')).toMatchObject({ kind: 'script-string', label: 'Resposta do quiz', context: 'Pergunta: Qual sua idade?' });
    expect(byText('Você já tentou dietas?')).toMatchObject({ kind: 'script-string', label: 'Pergunta do quiz' });
    expect(byText('Sim')).toMatchObject({ kind: 'script-string', label: 'Resposta do quiz' });
    expect(byText('Descubra seu perfil')).toMatchObject({ kind: 'script-string', label: 'Texto do quiz' });
    expect(byText('Até 5 kg')).toMatchObject({ kind: 'script-string', label: 'Resposta do quiz' });
    expect(blocks.filter((block) => block.kind === 'script-string')).toHaveLength(10);
  });

  it('has stable ids per revision content and unique ids', () => {
    expect(extractPageTextBlocks(HTML).map((block) => block.id)).toEqual(blocks.map((block) => block.id));
    expect(new Set(blocks.map((block) => block.id)).size).toBe(blocks.length);
    expect(blocks.every((block) => /^t[0-9a-f]{16}$/.test(block.id))).toBe(true);
  });
});

describe('applyPageTextEdits', () => {
  const blocks = extractPageTextBlocks(HTML);
  const id = (text: string) => blocks.find((block) => block.text === text)!.id;

  it('replaces only the edited ranges and keeps every other byte', () => {
    const edits = [
      { id: id('Emagreça   rápido'), text: 'Lose <weight> fast & easy' },
      { id: id('Quero agora'), text: 'I want "it"' },
      { id: id('Qual sua idade?'), text: "What's your age?" },
      { id: id('Você já tentou dietas?'), text: 'Tried `diets`? ${x}' },
      { id: id('Até 5 kg'), text: 'Up to "5" kg' },
      { id: id('Oferta & Bônus'), text: 'Offer & Bonus' },
    ];
    const out = applyPageTextEdits(HTML, edits);
    expect(out).toContain('<h1 class="hero-title">  Lose &lt;weight&gt; fast &amp; easy </h1>');
    expect(out).toContain('value="I want &quot;it&quot;"');
    expect(out).toContain("question: 'What\\'s your age?'");
    expect(out).toContain('question: `Tried \\`diets\\`? \\${x}`');
    expect(out).toContain('"respostas":["Up to \\"5\\" kg"');
    expect(out).toContain('<title>Offer &amp; Bonus</title>');
    // Scripts continuam válidos e o que não foi editado é idêntico.
    const after = extractPageTextBlocks(out);
    expect(after.find((block) => block.text === 'Tried `diets`? ${x}')).toBeUndefined(); // ${ não é string de quiz segura
    expect(after.find((block) => block.text === "What's your age?")).toBeTruthy();
    expect(after.find((block) => block.text === 'Up to "5" kg')).toBeTruthy();
    const untouched = applyPageTextEdits(HTML, [{ id: id('Comprar agora'), text: 'Comprar agora' }]);
    expect(untouched).toBe(HTML);
    const single = applyPageTextEdits(HTML, [{ id: id('Comprar agora'), text: 'Buy now' }]);
    expect(single.replace('Buy now', 'Comprar agora')).toBe(HTML);
  });

  it('updates or inserts <html lang>', () => {
    expect(applyPageTextEdits(HTML, [], { lang: 'it' })).toContain('<html lang="it">');
    expect(applyPageTextEdits('<!doctype html><html class="x"><body><p>Oi</p></body></html>', [], { lang: 'en' }))
      .toBe('<!doctype html><html lang="en" class="x"><body><p>Oi</p></body></html>');
  });

  it('rejects unknown blocks and unsafe quiz strings', () => {
    expect(() => applyPageTextEdits(HTML, [{ id: 't0000000000000000', text: 'x' }])).toThrow(PageTextError);
    try { applyPageTextEdits(HTML, [{ id: id('Menos de 30'), text: '<img src=x onerror=alert(1)>' }]); expect.unreachable(); }
    catch (error) { expect(error).toMatchObject({ reason: 'invalid_text', ids: [id('Menos de 30')] }); }
  });

  it('requires exact UTF-8 round trip to preserve bytes', () => {
    expect(decodePageHtml(Buffer.from('<p>olá</p>'))).toBe('<p>olá</p>');
    expect(() => decodePageHtml(Buffer.from([0x3c, 0x70, 0x3e, 0xe9, 0x3c]))).toThrow(PageTextError);
  });
});
