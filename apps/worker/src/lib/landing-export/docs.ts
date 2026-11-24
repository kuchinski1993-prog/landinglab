// CLAUDE.md dos pacotes de export — instruções para o Claude Code de quem recebe a landing.

import type { ExportLanding, OffersFile } from './build-export.js';

const EDITS_DOC = `
## Edições do editor visual

- O \`<script data-landinglab-engine="edits">\` do \`<head>\` aplica as edições feitas no editor do BlackShop. Mantenha antes de \`landing-offers.js\`.
- \`data-ll-href\` no botão = link escolhido (o clique vai para ele levando utm/fbclid); \`data-ll-lock-text\` = texto fixo (preço/botão) que os scripts não trocam. Para mudar, edite o atributo (e o texto visível junto).
- \`data-ll-hidden="1"\` = seção oculta (\`display:none\`). Para mostrar de novo, apague o atributo e o \`display:none\` do \`style\`.
`;

export function portableClaudeMd(landing: ExportLanding, offers: OffersFile, hasEdits = false): string {
  const missing = offers.offers.filter((o) => !o.checkoutUrl).length;
  return `# ${landing.title} — landing exportada (HTML)

Landing estática exportada do BlackShop. Abre em qualquer hospedagem de arquivos
(Netlify, Vercel, Cloudflare Pages, S3, hospedagem comum): suba a pasta inteira.

## Arquivos

| Arquivo | O que é |
|---|---|
| \`index.html\` | A página. HTML do tema original, já sem scripts de rastreio e de checkout da loja de origem. |
| \`assets/\` | Imagens, CSS, JS e fontes baixados. Os nomes têm um hash na frente; não renomeie sem trocar as referências. |
| \`offers.json\` | **As ofertas (preço, título, link de checkout).** É aqui que se muda preço e link. |
| \`landing-offers.js\` | Lê \`offers.json\` e aplica nos cards de oferta e no botão de compra. |

## Ofertas e checkout

**Para trocar links e textos, edite só o \`offers.json\`.** O \`landing-offers.js\` aplica na página ao carregar.

\`offers.json\` (moeda: ${offers.currency}; ofertas ${offers.source === 'system' ? 'no bloco do BlackShop (`.ll-sys-offers`)' : 'no bloco original da página'}):

- \`offers[i]\` corresponde ao card de oferta \`i\` da página, na ordem em que aparecem.
- \`title\`, \`badge\` (selo; vazio esconde), \`saveText\` (texto de economia): textos do card.
- \`bullets\`: lista de benefícios do card, um texto por item (até 8).
- \`price\` / \`compareAt\`: valores em unidade da moeda (ex.: 29.9). \`compareAt: null\` esconde o preço riscado.
- \`checkoutUrl\`: para onde o botão de compra leva quando essa oferta está selecionada
  (checkout Shopify \`https://sualoja.myshopify.com/cart/<id-da-variante>:1\`, Stripe Payment Link,
  Hotmart, etc.). Vazio (\`""\`): o botão não navega e o console do navegador mostra um aviso.${missing ? `\n- **${missing} oferta(s) estão sem \`checkoutUrl\`**: o botão de compra não faz nada até preencher.` : ''}

Exemplo — trocar o link e os bullets da segunda oferta:

\`\`\`json
{
  "currency": "${offers.currency}",
  "offers": [
    { "title": "1 unidade", "price": 29.9, "checkoutUrl": "https://buy.stripe.com/abc123" },
    {
      "title": "3 unidades",
      "badge": "Mais vendido",
      "bullets": ["Frete grátis", "Garantia de 30 dias"],
      "price": 69.9,
      "compareAt": 89.7,
      "checkoutUrl": "https://pay.hotmart.com/XYZ?off=kit3"
    }
  ]
}
\`\`\`

(No arquivo real cada oferta tem todos os campos; mude só os valores.) Parâmetros \`utm_*\` da página
não são repassados automaticamente: inclua no \`checkoutUrl\` se precisar.
- Uma cópia das ofertas fica embutida no \`index.html\` (\`#ll-offers-inline\`), usada só quando a página
  é aberta direto do disco (\`file://\`). **Depois de editar \`offers.json\`, atualize a cópia também**,
  ou teste sempre por um servidor local: \`npx serve .\`

### Como o script acha os cards e o botão

- Cards: elementos com \`data-ll-offer\`; se não houver, os cards do app Kaching (\`[data-deal-bar-id]\`).
  Para marcar cards de outro layout, adicione \`data-ll-offer\` em cada um, na ordem das ofertas.
- Dentro de cada card, o script preenche (se existirem) título (\`[data-ll-title]\`, \`[data-ll-offer-title]\`),
  selo (\`[data-ll-badge]\`), bullets (\`[data-ll-bullets]\`), preço (\`[data-ll-price]\`), riscado
  (\`[data-ll-compare]\`) e economia (\`[data-ll-save]\`); no bloco do BlackShop, os \`.ll-sys-offer__*\`.
  O card ativo recebe \`data-ll-offer-active="true"\`.
- Botão de compra: \`[data-ll-cta]\`, \`[data-landing-cta="buy"]\`, \`button[name="add"]\` e alguns padrões de temas Shopify.
  Elementos \`[data-ll-cta-price]\` mostram o preço da oferta ativa.

## Scripts que precisam continuar no topo do \`<head>\`

- \`#ll-anti-wipe-guard\`: alguns temas apagam a página quando rodam fora da loja original. Este script impede isso.
- \`#ll-theme-globals-shim\`: funções que os temas derivados do Dawn esperam (\`debounce\`, \`pauseAllMedia\`…).
  Sem ele, a galeria de imagens e outros componentes travam.
${hasEdits ? EDITS_DOC : ''}
## Rastreamento

Pixel da Meta, Google e afins foram removidos de propósito. Para medir, adicione o seu pixel no \`<head>\`
e dispare \`InitiateCheckout\` no clique do botão de compra (em \`landing-offers.js\`, função \`go\`).

## Ao editar com o Claude Code

- O HTML é grande e gerado por tema Shopify. Prefira mudanças pontuais (textos, imagens, seções) a reformatar o arquivo.
- Mantenha os caminhos \`assets/…\` relativos.
- Imagens novas: coloque em \`assets/\` e referencie como \`assets/nome.webp\`.
`;
}

export function shopifyClaudeMd(landing: ExportLanding, slug: string, hasEdits = false): string {
  return `# ${landing.title} — landing exportada (tema Shopify)

Pacote para instalar a landing num tema Shopify existente, ligada às variantes reais de um produto.

## Instalação

A instalação é **só por Editar código** (ou Shopify CLI). Não use "Adicionar tema → Fazer upload de zip":
este pacote não é um tema completo e a Shopify recusa.

1. No admin da Shopify: Loja virtual → Temas → \`…\` → **Editar código** (faça antes uma cópia do tema).
2. Envie os arquivos para as pastas de mesmo nome no tema:
   - \`layout/landinglab.liquid\`
   - \`sections/landinglab-${slug}.liquid\`
   - \`snippets/landinglab-${slug}-*.liquid\` (o HTML da landing, dividido em partes por causa do limite de tamanho de arquivo)
   - \`templates/product.landinglab.json\`
   - tudo de \`assets/\` (\`ll-…\`)

   Com o Shopify CLI é mais rápido: copie as pastas para o tema local e rode \`shopify theme push\`.
3. No produto: Produtos → (produto) → **Modelo do tema** → \`landinglab\`.
4. Personalizar tema → abra o produto → seção da landing → ajuste os blocos **Oferta**.

## Ofertas

Cada bloco **Oferta** é um card de oferta da página, na ordem:

- **ID da variante**: ID numérico da variante deste produto (aparece na URL ao editar a variante).
  O preço e o preço "de" vêm da variante, já na moeda da loja. Vazio ou inválido = variante selecionada.
- **Título**, **Selo**, **Pré-selecionada**: textos e oferta inicial.
- **Bullets**: benefícios do card, um por linha (até 8).
- **Link** (opcional): checkout desta oferta (Stripe, Hotmart…). Preenchido, tem prioridade sobre a variante.
- Sem Link, o botão de compra leva para \`/cart/<variante>:1\` (checkout direto da loja).

Tudo isso se edita em **Personalizar tema**, sem mexer em código.

Os IDs vieram preenchidos com os da loja de onde a landing foi exportada. **Se for outra loja, troque.**

## Como funciona

- \`layout/landinglab.liquid\` traz o \`<head>\` do tema original (CSS/JS da landing), sem o layout do seu tema.
- A seção monta \`window.__LL_OFFERS__\` a partir das variantes; \`assets/ll-landing-offers.js\` aplica nos cards
  (\`[data-ll-offer]\` ou cards Kaching \`[data-deal-bar-id]\`) e no botão de compra.
- Os snippets estão em \`{% raw %}\`: o HTML é literal, só as referências \`asset_url\` são Liquid.
- \`#ll-anti-wipe-guard\` e \`#ll-theme-globals-shim\` no layout precisam ficar no topo do \`<head>\`: impedem que
  o tema original apague a página fora da loja dele e fornecem funções que a galeria espera.
- Vídeos e arquivos acima de 20 MB continuam no link original (o tema não aceita).
${hasEdits ? EDITS_DOC : ''}
## Rastreamento

Pixels da loja de origem foram removidos. O \`{{ content_for_header }}\` do layout carrega os pixels e apps da sua loja.
`;
}
