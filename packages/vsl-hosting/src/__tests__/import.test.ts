import { tmpdir } from 'node:os';
import { mkdtemp, readFile, rm, symlink } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

import { afterEach, describe, expect, it } from 'vitest';

import {
  analyze,
  canonical,
  extractSource,
  LocalVslStorage,
  LIMITS,
  safePath,
  validateImportConfig,
  previewConfig,
  previewHeaders,
  vslStorageFromEnv,
  digest,
} from '../index.js';

import { fixtureEntries, zip } from './helpers.js';
const fixture = path.resolve(import.meta.dirname, '../../../../tests/fixtures/vsl-import');
const adversarial = JSON.parse(await readFile(`${fixture}/adversarial/cases.json`, 'utf8')) as {
  paths: string[];
  specialModes: number[];
};
const html = Buffer.from(
  '<html><body><div data-blackshop-video></div><a data-blackshop-checkout data-blackshop-offer>CTA</a></body></html>'
);
const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
describe('VSL adversarial import', () => {
  it('requires explicit HTTPS origin approval for external page scripts', () => {
    const page = Buffer.from('<html><body><script src="https://cdn.example.com/app.js"></script></body></html>');
    const files = extractSource(page, 'html');
    expect(analyze(files, 'index.html', { requiredTargets: [] }).report.pending.length).toBeGreaterThan(0);
    expect(analyze(files, 'index.html', { requiredTargets: [], externalOrigins: ['https://cdn.example.com'] }).report.pending).toEqual([]);
    expect(() => validateImportConfig({ externalOrigins: ['https://127.0.0.1'] })).toThrow();
  });
  it('imports HTML and nested valid ZIP without choosing ambiguous HTML', () => {
    expect(extractSource(html, 'html')[0]!.mime).toBe('text/html');
    expect(
      extractSource(zip([{ name: 'index.html', bytes: html, compress: true }]), 'zip')[0]!.bytes
    ).toEqual(html);
    expect(
      extractSource(
        zip([
          { name: 'quiz/index.html', bytes: html },
          { name: 'page.html', bytes: html },
        ]),
        'zip'
      ).map((f) => f.path)
    ).toEqual(['quiz/index.html', 'page.html']);
  });
  it.each(adversarial.paths)('rejects path %s', (name) =>
    expect(() => extractSource(zip([{ name, bytes: html }]), 'zip')).toThrow()
  );
  it.each(adversarial.specialModes)('rejects POSIX special entry %i', (mode) =>
    expect(() => extractSource(zip([{ name: 'index.html', bytes: html, mode }]), 'zip')).toThrow()
  );
  it('rejects encryption, nested archives, executable content, prohibited types, path collisions', () => {
    for (const entries of [
      [{ name: 'index.html', bytes: html, flags: 2049 }],
      [{ name: 'x.zip', bytes: zip([{ name: 'index.html', bytes: html }]) }],
      [{ name: 'x.js', bytes: Buffer.from('MZexe') }],
      [{ name: 'x.php', bytes: Buffer.from('<?php evil();') }],
      [
        { name: 'x.html', bytes: html },
        { name: 'X.html', bytes: html },
      ],
      [
        { name: 'x.html', bytes: html },
        { name: 'x.html/a.css', bytes: Buffer.from('a{}') },
      ],
    ])
      expect(() => extractSource(zip(entries), 'zip')).toThrow();
  });
  it('bounds compressed/extracted bytes, count, actual inflate output and CRC', () => {
    expect(() => extractSource(Buffer.alloc(LIMITS.html + 1), 'html')).toThrow();
    expect(() => extractSource(Buffer.alloc(LIMITS.zip + 1), 'zip')).toThrow();
    expect(() =>
      extractSource(
        zip([{ name: 'x.css', bytes: Buffer.from('a{}'), declaredSize: LIMITS.extracted + 1 }]),
        'zip'
      )
    ).toThrow();
    expect(() =>
      extractSource(
        zip(
          Array.from({ length: 2001 }, (_, i) => ({ name: `${i}.css`, bytes: Buffer.from('a{}') }))
        ),
        'zip'
      )
    ).toThrow();
    expect(() =>
      extractSource(
        zip([
          {
            name: 'x.css',
            bytes: Buffer.alloc(2 * 1024 ** 2, 65),
            compress: true,
            declaredSize: 1,
          },
        ]),
        'zip'
      )
    ).toThrow();
    const corrupt = zip([{ name: 'index.html', bytes: html }]);
    corrupt[40] ^= 1;
    expect(() => extractSource(corrupt, 'zip')).toThrow();
  });
  it('keeps nested archives, executables, prohibited types and invalid assets out of the revision without failing the import', () => {
    const files = extractSource(
      zip([
        { name: 'index.html', bytes: html },
        { name: 'x.zip', bytes: zip([{ name: 'index.html', bytes: html }]) },
        { name: 'x.js', bytes: Buffer.from('MZexe') },
        { name: 'x.php', bytes: Buffer.from('<?php evil();') },
        { name: 'x.png', bytes: html },
        { name: 'x.svg', bytes: Buffer.from('<svg onload="evil()"/>') },
        { name: 'x.json', bytes: Buffer.from('not json') },
      ]),
      'zip'
    );
    expect(files.map((f) => f.path)).toEqual(['index.html']);
    expect(files.discarded?.map((d) => [d.path, d.reason])).toEqual([
      ['x.zip', 'unsupported-type'],
      ['x.js', 'executable'],
      ['x.php', 'unsupported-type'],
      ['x.png', 'invalid-content'],
      ['x.svg', 'invalid-content'],
      ['x.json', 'invalid-content'],
    ]);
    const report = analyze(files, 'index.html').report;
    expect(report.findings.filter((f) => f.category.startsWith('discarded-')).every((f) => f.severity === 'warning')).toBe(true);
    expect(report.pending).toEqual([]);
  });
  it('downgrades mixed inline trackers only when the runtime strips them (G3)', async () => {
    const files = extractSource(await readFile(`${fixture}/variants/mixed.html`), 'html');
    const legacy = analyze(files, 'index.html').report;
    expect(legacy.findings.find((f) => f.category === 'tracker-mixed')?.severity).toBe('blocking');
    const g3 = analyze(files, 'index.html', { runtimeTrackerRemoval: true }).report;
    expect(g3.findings.find((f) => f.category === 'tracker-mixed')?.severity).toBe('warning');
  });
  it('validates content discrepancy and active SVG', () => {
    for (const entry of [
      { name: 'x.png', bytes: html },
      { name: 'x.svg', bytes: Buffer.from('<svg onload="evil()"/>') },
      { name: 'x.json', bytes: Buffer.from('not json') },
      { name: 'x.js', bytes: Buffer.from('<?php evil();') },
    ])
      expect(() => extractSource(zip([entry]), 'zip')).toThrow();
  });
});
describe('VSL behavior and assets', () => {
  it('allows independent quiz and presell pages without video, offer or checkout targets', () => {
    const page = Buffer.from('<html><body><main><form><input name="answer"></form><script>window.quizReady=true</script></main></body></html>');
    const files = extractSource(page, 'html');
    expect(analyze(files, 'index.html').report.pending.length).toBeGreaterThan(0);
    const result = analyze(files, 'index.html', { requiredTargets: [], allowForms: true });
    expect(result.report.pending).toEqual([]);
    expect(result.files[0]!.bytes.toString()).toContain('window.quizReady=true');
  });
  it('rewrites local assets to an immutable independent revision URL', () => {
    const revisionId = randomUUID();
    const files = extractSource(zip([
      { name: 'index.html', bytes: Buffer.from('<html><body><script src="js/quiz.js"></script></body></html>') },
      { name: 'js/quiz.js', bytes: Buffer.from('window.quizReady = true;') },
    ]), 'zip');
    const result = analyze(files, 'index.html', { requiredTargets: [], assetBasePath: `/__vsl/assets/${revisionId}/` });
    expect(result.report.pending).toEqual([]);
    expect(result.files.find((file) => file.path === 'index.html')!.bytes.toString()).toContain(`/__vsl/assets/${revisionId}/js/quiz.js`);
  });
  it('preserves quiz, script order, modules, selectors, CSS and reports removable tracker', async () => {
    const files = extractSource(zip(await fixtureEntries(`${fixture}/controlled`)), 'zip'),
      result = analyze(files, 'index.html');
    expect(result.report.pending).toEqual([]);
    expect(result.manifest.files['scripts/module.mjs']!.mimeType).toBe('application/javascript');
    expect(
      result.files
        .find((f) => f.path === 'scripts/quiz.js')!
        .bytes.equals(files.find((f) => f.path === 'scripts/quiz.js')!.bytes)
    ).toBe(true);
    expect(result.files.find((f) => f.path === 'index.html')!.bytes.toString()).toContain(
      'window.fixtureInline'
    );
    expect(result.files.find((f) => f.path === 'index.html')!.bytes.toString()).not.toContain(
      'google-analytics.com'
    );
    expect(
      result.report.findings.some((f) => f.category === 'tracker-removable' && f.afterHash)
    ).toBe(true);
  });
  it('requires justified resolution for mixed tracker and missing dependencies; no quiz accepted', async () => {
    for (const name of ['mixed', 'missing']) {
      const bytes = await readFile(`${fixture}/variants/${name}.html`),
        files = extractSource(bytes, 'html'),
        initial = analyze(files, 'index.html');
      expect(initial.report.pending.length).toBeGreaterThan(0);
      const resolutions = Object.fromEntries(
        initial.report.pending.map((id) => [
          id,
          'Operator accepts this controlled fixture dependency',
        ])
      );
      expect(analyze(files, 'index.html', { resolutions }).report.pending).toEqual([]);
    }
    expect(
      analyze(
        extractSource(await readFile(`${fixture}/variants/no-quiz.html`), 'html'),
        'index.html'
      ).report.pending
    ).toEqual([]);
  });
  it('resolves CSS, srcset/static module references and reports missing/external/dynamic dependencies', () => {
    const files = extractSource(
      zip([
        {
          name: 'quiz/index.html',
          bytes: Buffer.from(
            '<html><div data-blackshop-video></div><a data-blackshop-checkout data-blackshop-offer></a><img src="/images/a.svg" srcset="../images/a.svg 1x"><script type="module" src="../scripts/a.mjs"></script></html>'
          ),
        },
        { name: 'images/a.svg', bytes: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>') },
        {
          name: 'scripts/a.mjs',
          bytes: Buffer.from("import '/scripts/missing.mjs'; fetch('https://external.test');"),
        },
      ]),
      'zip'
    );
    const result = analyze(files, 'quiz/index.html');
    expect(result.files[0]!.bytes.toString()).toContain('src="../images/a.svg"');
    expect(result.report.findings.map((f) => f.category)).toContain('missing-dependency');
    expect(result.report.findings.map((f) => f.category)).toContain('dynamic-script');
  });
  it('rewrites root-relative module specifiers precisely and keeps other JS unchanged', () => {
    const files = extractSource(
      zip([
        { name: 'index.html', bytes: html },
        {
          name: 'scripts/main.mjs',
          bytes: Buffer.from("import '/scripts/child.mjs'; window.quizReady = true;"),
        },
        { name: 'scripts/child.mjs', bytes: Buffer.from('export const ready = true;') },
      ]),
      'zip'
    );
    const result = analyze(files, 'index.html');
    expect(result.report.pending).toEqual([]);
    expect(result.files.find((f) => f.path === 'scripts/main.mjs')!.bytes.toString()).toBe(
      'import "./child.mjs"; window.quizReady = true;'
    );
  });
  it('diagnoses directory navigation without rejecting or rewriting the page', () => {
    const files = extractSource(
      Buffer.from(
        '<html><div data-blackshop-video></div><a data-blackshop-checkout data-blackshop-offer href="/">Home</a></html>'
      ),
      'html'
    );
    const result = analyze(files, 'index.html');
    expect(result.report.pending).toEqual([]);
    expect(result.report.findings.some((f) => f.category === 'navigation-reference')).toBe(true);
    expect(result.files[0]!.bytes.equals(files[0]!.bytes)).toBe(true);
  });
  it('canonical config does not depend on key insertion order', () =>
    expect(canonical({ b: 1, a: { z: 2, y: 3 } })).toBe(canonical({ a: { y: 3, z: 2 }, b: 1 })));
});
describe('VSL extended contracts', () => {
  it('validates configured selectors; preserves unknown scripts and JSON-LD', async () => {
    const files = extractSource(await readFile(`${fixture}/variants/no-quiz.html`), 'html');
    expect(
      analyze(files, 'index.html', { videoSelector: '.absent' }).report.pending.length
    ).toBeGreaterThan(0);
    const unknown = extractSource(await readFile(`${fixture}/variants/unknown.html`), 'html');
    expect(
      analyze(unknown, 'index.html').report.findings.some(
        (f) => f.trackerClassification === 'DESCONHECIDO'
      )
    ).toBe(true);
    expect(analyze(unknown, 'index.html').files[0]!.bytes.equals(unknown[0]!.bytes)).toBe(true);
    const json = extractSource(
      Buffer.from(
        '<html><div data-blackshop-video></div><a data-blackshop-checkout data-blackshop-offer></a><script type="application/ld+json">{"name":"quiz"}</script></html>'
      ),
      'html'
    );
    expect(analyze(json, 'index.html').report.pending).toEqual([]);
  });
  it('discards OS metadata explicitly and preserves data srcset', () => {
    const files = extractSource(
      zip([
        { name: 'index.html', bytes: html },
        { name: '__MACOSX/._index.html', bytes: Buffer.from('metadata') },
        { name: 'index.html:Zone.Identifier', bytes: Buffer.from('[ZoneTransfer]\nZoneId=3') },
      ]),
      'zip'
    );
    expect(files).toHaveLength(1);
    expect(
      analyze(files, 'index.html').report.findings.some((f) => f.category === 'metadata')
    ).toBe(true);
    const data = extractSource(
      Buffer.from(
        '<html><div data-blackshop-video></div><a data-blackshop-checkout data-blackshop-offer></a><img srcset="data:image/png;base64,abc 1x"></html>'
      ),
      'html'
    );
    expect(analyze(data, 'index.html').files[0]!.bytes.toString()).toContain(
      'data:image/png;base64,abc 1x'
    );
  });
});
describe('VSL fail-closed configuration', () => {
  const env = {
    NODE_ENV: 'production',
    VSL_PREVIEW_TOKEN_SECRET: 'local-only-test-secret-12345678901234567890',
    VSL_PREVIEW_DOMAIN: 'preview.example.net',
    VSL_PREVIEW_FRAME_ORIGIN: 'https://admin.example.com',
  };
  it('requires signing/domain/frame configuration and rejects shared administrative site', () => {
    expect(() => previewConfig({})).toThrow();
    expect(() => previewConfig({ ...env, VSL_PREVIEW_DOMAIN: 'preview.example.com' })).toThrow();
    expect(() =>
      previewConfig({
        ...env,
        VSL_PREVIEW_LOCAL_TEST: 'true',
        VSL_PREVIEW_FRAME_ORIGIN: 'http://localhost:53140',
      })
    ).toThrow();
    expect(() =>
      vslStorageFromEnv({
        ...env,
        VSL_PREVIEW_STORAGE_ROOT: path.join(tmpdir(), 'production-is-not-configured'),
      })
    ).toThrow();
  });
  it('requires exact framing/CORS and blocks workers, object content and cookie authorization', () => {
    const headers = previewHeaders(previewConfig(env), 'image/png');
    expect(headers['content-security-policy']).toContain(
      'frame-ancestors https://admin.example.com'
    );
    expect(headers['content-security-policy']).toContain("worker-src 'none'");
    expect(headers['access-control-allow-origin']).toBe('https://admin.example.com');
    expect(headers['origin-agent-cluster']).toBe('?1');
    expect(headers['x-content-type-options']).toBe('nosniff');
    expect(headers).not.toHaveProperty('set-cookie');
  });
});
describe('VSL private storage', () => {
  it('seals verified objects and rejects overwrite/unsafe paths/symlinks; cleanup stays attempt-scoped', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'vsl-storage-'));
    roots.push(root);
    const storage = new LocalVslStorage(root),
      page = randomUUID(),
      release = randomUUID(),
      prefix = `vsl/releases/${page}/${release}`;
    const manifest = {
      version: 1 as const,
      entryPath: 'index.html',
      files: {
        'index.html': {
          storageKey: 'index.html',
          bytes: html.length,
          sha256: digest(html),
          mimeType: 'text/html',
        },
      },
    };
    await storage.putExclusive(`${prefix}/index.html`, html);
    await storage.seal(prefix, manifest);
    expect(await storage.isSealed(prefix, manifest)).toBe(true);
    await expect(storage.putExclusive(`${prefix}/new.css`, Buffer.from('a{}'))).rejects.toThrow();
    const id = randomUUID(),
      attempt = randomUUID();
    await storage.putExclusive(`vsl/quarantine/${id}/attempts/${attempt}/index.html`, html);
    await storage.removeAttempt(id, attempt);
    expect(await storage.read(`${prefix}/index.html`)).toEqual(html);
    await symlink(path.join(root, prefix, 'index.html'), `${root}/vsl/evil`);
    await expect(storage.read('vsl/evil')).rejects.toThrow();
    expect(() => safePath('%252e%252e/x')).toThrow();
  });
});
