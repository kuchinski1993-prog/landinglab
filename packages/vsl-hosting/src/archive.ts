import { inflateRawSync } from 'node:zlib';

import { validateBinary } from './content.js';
import { safePath, digest } from './storage.js';
export const LIMITS = {
  html: 5 * 1024 ** 2,
  zip: 100 * 1024 ** 2,
  extracted: 300 * 1024 ** 2,
  files: 2000,
};
/** Motivo do descarte de um arquivo do ZIP (vira achado `discarded-*` no relatório do import). */
export type DiscardReason = 'os-metadata' | 'reserved-name' | 'hidden-file' | 'unsupported-type' | 'empty-file' | 'executable' | 'invalid-content';
export interface DiscardedFile {
  path: string; sha256: string; reason: DiscardReason; detail?: string;
  /**
   * Conteúdo do `manifest.json` da raiz (até 2 MB), guardado só para o import inteligente: ferramentas de
   * "salvar página" gravam ali o mapa URL original → arquivo do ZIP. Nunca entra na revisão.
   */
  bytes?: Buffer;
}
export type SourceFiles = SourceFile[] & { discarded?: DiscardedFile[] };
export interface SourceFile {
  path: string;
  bytes: Buffer;
  mime: string;
}
/** Erro do arquivo enviado com o motivo em PT-BR (mostrado ao operador em `job.error.message`). */
export class ArchiveError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ArchiveError';
  }
}
/** Arquivo do ZIP que não entra na revisão, mas não derruba o import. */
class Discard extends Error {
  constructor(readonly reason: DiscardReason, readonly detail?: string) {
    super(reason);
  }
}
const types: Record<string, string> = {
  html: 'text/html',
  htm: 'text/html',
  css: 'text/css',
  js: 'application/javascript',
  mjs: 'application/javascript',
  json: 'application/json',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
  ico: 'image/x-icon',
  svg: 'image/svg+xml',
  woff: 'font/woff',
  woff2: 'font/woff2',
  ttf: 'font/ttf',
  otf: 'font/otf',
  mp4: 'video/mp4',
  webm: 'video/webm',
  mp3: 'audio/mpeg',
  ogg: 'audio/ogg',
  wav: 'audio/wav',
  m4a: 'audio/mp4',
};
/** Nomes internos da revisão (`<prefixo>/manifest.json`, `.sealed`) e o namespace do runtime. */
function isReserved(path: string): boolean {
  const parts = path.split('/');
  return path === 'manifest.json' || parts.includes('.sealed') || parts.includes('__vsl');
}
/**
 * Valida um arquivo da fonte. HTML inválido lança `ArchiveError` (pode ser a página de entrada);
 * qualquer outro arquivo problemático lança `Discard` (fica fora da revisão com aviso).
 */
function checkFile(name: string, bytes: Buffer): SourceFile {
  const normalized = safePath(name);
  const ext = normalized.includes('.') ? normalized.split('.').pop()!.toLowerCase() : '';
  const isHtml = ext === 'html' || ext === 'htm';
  if (isReserved(normalized)) throw new Discard('reserved-name');
  if (!isHtml && normalized.split('/').some((part) => part.startsWith('.'))) throw new Discard('hidden-file');
  const mime = Object.hasOwn(types, ext) ? types[ext] : undefined;
  if (!mime) throw new Discard('unsupported-type', ext ? `.${ext}` : 'sem extensão');
  if (bytes.length === 0) {
    if (isHtml) throw new ArchiveError(`A página ${normalized} está vazia.`);
    throw new Discard('empty-file');
  }
  if (
    bytes.subarray(0, 2).toString() === 'MZ' ||
    bytes.subarray(0, 4).equals(Buffer.from([0x7f, 69, 76, 70])) ||
    bytes.subarray(0, 4).toString() === 'PK\x03\x04'
  ) {
    if (isHtml) throw new ArchiveError(`O arquivo ${normalized} é um executável ou arquivo compactado, não uma página HTML.`);
    throw new Discard('executable');
  }
  const text = bytes.toString('utf8');
  if (['html', 'htm', 'css', 'js', 'mjs', 'json', 'svg'].includes(ext)) {
    const invalid = (detail: string): never => {
      if (isHtml) throw new ArchiveError(detail);
      throw new Discard('invalid-content', detail);
    };
    if (bytes.includes(0) || !Buffer.from(text).equals(bytes))
      invalid(`O arquivo ${normalized} não é texto UTF-8 válido. Salve-o em UTF-8 e envie de novo.`);
    if (/<\?(?:php|=)|<%|#!\s*\/|^\s*(?:AddHandler|RewriteEngine)/im.test(text))
      invalid(`O arquivo ${normalized} contém código de servidor (PHP/ASP/script), que não é aceito.`);
    if (ext === 'json') {
      try {
        JSON.parse(text);
      } catch {
        invalid(`O arquivo ${normalized} não é um JSON válido.`);
      }
    }
    if (isHtml && bytes.length > LIMITS.html) throw new ArchiveError(`A página ${normalized} passa de 5 MB.`);
    if (isHtml && !/<(?:!doctype\s+html|html|head|body|div|p|section|script|main|h[1-6])\b/i.test(text))
      throw new ArchiveError(`O arquivo ${normalized} não parece ser uma página HTML.`);
    if (
      ext === 'svg' &&
      (!/<svg\b/i.test(text) ||
        /<!DOCTYPE|<!ENTITY|&(?:#|[a-z])|<(?:script|foreignObject|animate|set|iframe|object|embed)\b|<\w+:|\bon\w+\s*=|(?:href|src)\s*=\s*["']\s*(?:https?:|data:|javascript:|\/\/)/i.test(
          text
        ))
    )
      invalid(`O SVG ${normalized} tem script ou conteúdo ativo e não é aceito.`);
  } else {
    const hex = bytes.subarray(0, 16).toString('hex');
    const start = bytes.subarray(0, 12).toString('latin1');
    const valid: Record<string, boolean> = {
      png: hex.startsWith('89504e470d0a1a0a'),
      jpg: hex.startsWith('ffd8ff'),
      jpeg: hex.startsWith('ffd8ff'),
      gif: /^GIF8[79]a/.test(start),
      webp: start.startsWith('RIFF') && start.endsWith('WEBP'),
      avif:
        bytes.subarray(4, 8).toString() === 'ftyp' &&
        /avif|avis/.test(bytes.subarray(8, 32).toString()),
      ico: hex.startsWith('00000100'),
      woff: start.startsWith('wOFF'),
      woff2: start.startsWith('wOF2'),
      ttf: hex.startsWith('00010000') || start.startsWith('true'),
      otf: start.startsWith('OTTO'),
      mp4: bytes.subarray(4, 8).toString() === 'ftyp',
      m4a: bytes.subarray(4, 8).toString() === 'ftyp',
      webm: hex.startsWith('1a45dfa3'),
      mp3: start.startsWith('ID3') || (bytes[0] === 255 && (bytes[1]! & 224) === 224),
      ogg: start.startsWith('OggS'),
      wav: start.startsWith('RIFF') && start.endsWith('WAVE'),
    };
    if (!valid[ext]) throw new Discard('invalid-content', `O conteúdo de ${normalized} não corresponde à extensão .${ext}.`);
    try {
      validateBinary(ext, bytes);
    } catch {
      throw new Discard('invalid-content', `O arquivo ${normalized} está corrompido.`);
    }
  }
  return { path: normalized, bytes, mime };
}
/** Valida um arquivo isolado (HTML enviado direto). Qualquer problema lança `ArchiveError` com o motivo. */
export function validateFile(name: string, bytes: Buffer): SourceFile {
  try {
    return checkFile(name, bytes);
  } catch (error) {
    if (error instanceof Discard) throw new ArchiveError(discardMessage(name, error.reason, error.detail));
    throw error;
  }
}
function discardMessage(path: string, reason: DiscardReason, detail?: string): string {
  if (detail && reason === 'invalid-content') return detail;
  return {
    'os-metadata': `${path} é metadado do sistema operacional.`,
    'reserved-name': `O nome ${path} é reservado pelo VSL Hosting.`,
    'hidden-file': `${path} é um arquivo oculto.`,
    'unsupported-type': `O tipo de arquivo de ${path} (${detail ?? 'sem extensão'}) não é suportado.`,
    'empty-file': `${path} está vazio.`,
    executable: `${path} é um executável ou arquivo compactado.`,
    'invalid-content': `${path} tem conteúdo inválido.`,
  }[reason];
}
export function crc32(bytes: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
/**
 * Extrai e valida a fonte do import. Erros do arquivo saem como `ArchiveError` (motivo em PT-BR);
 * arquivos do ZIP que não servem para a página (metadados, ocultos, tipos não suportados, vazios,
 * executáveis, nomes reservados, conteúdo inválido) ficam em `discarded` e viram aviso no relatório.
 */
export function extractSource(bytes: Buffer, kind: 'html' | 'zip'): SourceFiles {
  try {
    return extractSourceUnsafe(bytes, kind);
  } catch (error) {
    if (error instanceof ArchiveError) throw error;
    const message = error instanceof Error ? error.message : '';
    if (/VSL path|Excessively encoded/.test(message))
      throw new ArchiveError('O ZIP contém um caminho de arquivo inválido (ex.: "../", caminho absoluto ou caracteres de controle).');
    if (/ZIP bomb|exceeds limit|too many files|integrity\/size/.test(message))
      throw new ArchiveError('O arquivo passa dos limites: HTML até 5 MB; ZIP até 100 MB, 300 MB descompactados e 2.000 arquivos.');
    if (/Encrypted/.test(message)) throw new ArchiveError('O ZIP está protegido por senha ou usa um formato de compressão não suportado.');
    if (/Symlink|Invalid file type/.test(message)) throw new ArchiveError('O ZIP contém atalhos (links simbólicos) ou arquivos especiais.');
    if (/collision/.test(message)) throw new ArchiveError('O ZIP tem arquivos com o mesmo nome (diferindo só em maiúsculas/minúsculas) ou um arquivo com o nome de uma pasta.');
    throw new ArchiveError('O ZIP está corrompido ou incompleto. Compacte a pasta de novo e envie outra vez.');
  }
}
function extractSourceUnsafe(bytes: Buffer, kind: 'html' | 'zip'): SourceFiles {
  if (bytes.length > LIMITS[kind]) throw new Error('Upload exceeds limit');
  if (kind === 'html') return [validateFile('index.html', bytes)];
  let end = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i--)
    if (
      bytes.readUInt32LE(i) === 0x06054b50 &&
      i + 22 + bytes.readUInt16LE(i + 20) === bytes.length
    ) {
      end = i;
      break;
    }
  if (end < 0) throw new Error('Invalid ZIP directory');
  const count = bytes.readUInt16LE(end + 10),
    size = bytes.readUInt32LE(end + 12),
    offset = bytes.readUInt32LE(end + 16);
  if (
    bytes.readUInt16LE(end + 4) !== 0 ||
    bytes.readUInt16LE(end + 6) !== 0 ||
    bytes.readUInt16LE(end + 8) !== count ||
    count === 0 ||
    count > LIMITS.files ||
    offset + size !== end
  )
    throw new Error('Unsupported ZIP/too many files');
  const files: SourceFiles = [],
    names = new Set<string>(),
    spans: Array<[number, number]> = [];
  let cursor = offset,
    total = 0;
  for (let n = 0; n < count; n++) {
    if (cursor + 46 > end || bytes.readUInt32LE(cursor) !== 0x02014b50)
      throw new Error('Invalid ZIP entry');
    const flags = bytes.readUInt16LE(cursor + 8),
      method = bytes.readUInt16LE(cursor + 10),
      crc = bytes.readUInt32LE(cursor + 16),
      compressed = bytes.readUInt32LE(cursor + 20),
      expanded = bytes.readUInt32LE(cursor + 24),
      nameSize = bytes.readUInt16LE(cursor + 28),
      extra = bytes.readUInt16LE(cursor + 30),
      comment = bytes.readUInt16LE(cursor + 32),
      attrs = bytes.readUInt32LE(cursor + 38),
      local = bytes.readUInt32LE(cursor + 42);
    if (
      cursor + 46 + nameSize + extra + comment > end ||
      bytes.readUInt16LE(cursor + 34) !== 0 ||
      flags & (1 | 64 | 8192) ||
      ![0, 8].includes(method) ||
      expanded === 0xffffffff ||
      compressed === 0xffffffff
    )
      throw new Error('Encrypted/unsupported ZIP');
    const nameBuffer = bytes.subarray(cursor + 46, cursor + 46 + nameSize),
      name = nameBuffer.toString('utf8');
    if (!Buffer.from(name).equals(nameBuffer)) throw new Error('Invalid ZIP filename encoding');
    cursor += 46 + nameSize + extra + comment;
    const mode = (attrs >>> 16) & 0xf000;
    if (mode && ![0x8000, 0x4000].includes(mode)) throw new Error('Symlink/device ZIP entry');
    const directory = name.endsWith('/');
    const zone = name.endsWith(':Zone.Identifier');
    const normalized = safePath(directory ? name.slice(0, -1) : zone ? name.slice(0, -16) : name);
    const identity = `${normalized.toLowerCase()}${zone ? ':Zone.Identifier' : ''}`;
    if (names.has(identity)) throw new Error('Normalized ZIP path collision');
    names.add(identity);
    if (
      local + 30 > offset ||
      bytes.readUInt32LE(local) !== 0x04034b50 ||
      bytes.readUInt16LE(local + 6) !== flags ||
      bytes.readUInt16LE(local + 8) !== method
    )
      throw new Error('Inconsistent ZIP headers');
    if (
      !(flags & 8) &&
      (bytes.readUInt32LE(local + 14) !== crc ||
        bytes.readUInt32LE(local + 18) !== compressed ||
        bytes.readUInt32LE(local + 22) !== expanded)
    )
      throw new Error('Inconsistent ZIP sizes/CRC');
    const ln = bytes.readUInt16LE(local + 26),
      le = bytes.readUInt16LE(local + 28),
      begin = local + 30 + ln + le,
      finish = begin + compressed;
    if (
      !bytes.subarray(local + 30, local + 30 + ln).equals(nameBuffer) ||
      finish > offset ||
      spans.some(([a, b]) => local < b && finish > a)
    )
      throw new Error('Overlapping ZIP entries');
    spans.push([local, finish]);
    if (directory) {
      if (expanded !== 0) throw new Error('Invalid directory');
      continue;
    }
    if (mode === 0x4000 || attrs & 16) throw new Error('Invalid file type');
    if (
      expanded > LIMITS.extracted - total ||
      (expanded > 1024 * 1024 && expanded > Math.max(1, compressed) * 1000)
    )
      throw new Error('ZIP bomb');
    const data = bytes.subarray(begin, finish);
    const content =
      method === 0
        ? Buffer.from(data)
        : inflateRawSync(data, {
            maxOutputLength: Math.min(LIMITS.extracted - total, expanded) + 1,
          });
    total += content.length;
    if (content.length !== expanded || total > LIMITS.extracted || crc32(content) !== crc)
      throw new Error('ZIP integrity/size failure');
    if (
      zone ||
      normalized.startsWith('__MACOSX/') ||
      normalized.split('/').at(-1) === '.DS_Store'
    ) {
      (files.discarded ??= []).push({ path: name, sha256: digest(content), reason: 'os-metadata' });
      continue;
    }
    try {
      files.push(checkFile(normalized, content));
    } catch (error) {
      if (!(error instanceof Discard)) throw error;
      (files.discarded ??= []).push({ path: normalized, sha256: digest(content), reason: error.reason, ...(error.detail ? { detail: error.detail } : {}),
        ...(normalized === 'manifest.json' && content.length <= 2 * 1024 * 1024 ? { bytes: content } : {}) });
    }
  }
  if (cursor !== end) throw new Error('Invalid ZIP directory size');
  if (!files.some((file) => file.mime === 'text/html'))
    throw new ArchiveError('Nenhum arquivo .html de entrada encontrado no ZIP.');
  for (const name of names)
    if (
      [...names].some((other) => other.startsWith(`${name}/`)) &&
      files.some((f) => f.path.toLowerCase() === name)
    )
      throw new Error('File/directory collision');
  return files;
}
