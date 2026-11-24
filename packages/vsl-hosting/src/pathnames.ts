const MAX_PATHNAME = 512;
const MAX_SEGMENTS = 32;
const MAX_SEGMENT = 100;

export function normalizeVslPathname(input: string): string {
  if (typeof input !== 'string') throw new Error('Pathname must be a string');
  const raw = input.trim();
  if (!raw || raw === '/') return '/';
  // eslint-disable-next-line no-control-regex
  if (/[?#\u0000-\u001f\u007f]/.test(raw) || raw.includes('\\')) throw new Error('Invalid pathname');
  let decoded = raw;
  for (let i = 0; i < 2; i += 1) {
    try { decoded = decodeURIComponent(decoded); } catch { throw new Error('Invalid encoded pathname'); }
  }
  if (decoded.includes('..') || decoded.split('/').some((part) => part === '.' || part === '..')) throw new Error('Path traversal is not allowed');
  const segments = decoded.split('/').filter(Boolean);
  if (segments.length > MAX_SEGMENTS || segments.some((part) => part.length > MAX_SEGMENT || !/^[a-zA-Z0-9._~-]+$/.test(part))) throw new Error('Invalid pathname segment');
  const normalized = `/${segments.join('/')}`;
  if (normalized.length > MAX_PATHNAME) throw new Error('Pathname is too long');
  return normalized;
}

export function pathnameToUrlPath(pathname: string): string { return normalizeVslPathname(pathname); }
