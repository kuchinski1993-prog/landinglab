// Decodificação de "encoded-words" RFC 2047 (=?charset?B|Q?texto?=) em
// assuntos e nomes de remetente.
//
// O Email Worker grava o header Subject cru, então parte dos assuntos chega
// ao banco como "=?UTF-8?B?Q29uZmlndXJhw6fDtWVz?= de pagamento alteradas".
// Este helper é só de EXIBIÇÃO (Story 16.1): o valor no banco não muda.
//
// Puro e sem dependências de Node — roda na API e no navegador (TextDecoder
// e atob existem nos dois).

const ENCODED_WORD = /=\?([^?\s]+)\?([BbQq])\?([^?]*)\?=/g;
// Espaço entre duas encoded-words adjacentes é descartado (RFC 2047 §6.2).
const BETWEEN_ENCODED_WORDS = /(\?=)\s+(=\?)/g;

function base64ToBytes(input: string): Uint8Array {
  const clean = input.replace(/[^A-Za-z0-9+/=]/g, '');
  const binary = atob(clean);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function quotedPrintableToBytes(input: string): Uint8Array {
  const out: number[] = [];
  const text = input.replace(/_/g, ' ');
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (ch === '=' && /^[0-9A-Fa-f]{2}$/.test(text.slice(i + 1, i + 3))) {
      out.push(parseInt(text.slice(i + 1, i + 3), 16));
      i += 2;
    } else {
      out.push(ch.charCodeAt(0) & 0xff);
    }
  }
  return Uint8Array.from(out);
}

function decodeBytes(bytes: Uint8Array, charset: string): string {
  // RFC 2231 permite "UTF-8*pt" — o sufixo de idioma é ignorado.
  const label = charset.split('*')[0]!.toLowerCase();
  try {
    return new TextDecoder(label).decode(bytes);
  } catch {
    return new TextDecoder('utf-8').decode(bytes);
  }
}

/**
 * Decodifica todas as encoded-words de um header. Texto sem encoded-words
 * volta igual; trechos malformados são mantidos como vieram.
 */
export function decodeMimeWords(value: string | null | undefined): string | null {
  if (value == null) return null;
  if (!value.includes('=?')) return value;
  const joined = value.replace(BETWEEN_ENCODED_WORDS, '$1$2');
  return joined.replace(ENCODED_WORD, (match, charset: string, encoding: string, text: string) => {
    try {
      const bytes =
        encoding.toUpperCase() === 'B' ? base64ToBytes(text) : quotedPrintableToBytes(text);
      return decodeBytes(bytes, charset);
    } catch {
      return match;
    }
  });
}
