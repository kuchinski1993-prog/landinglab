// React SSR smoke test — Wave 1 de-risk (Story 13.6, AC5).
//
// Purpose: prove that `renderToString()` from react-dom/server works inside
// this monorepo, that TypeScript's JSX transform is configured correctly for
// packages/landinglab-render, and that landinglab-build can consume templates from
// landinglab-render via workspace protocol.
//
// If this test fails, Wave 2 (agents + real templates) is BLOCKED.

import * as React from 'react';
import { renderToString } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { StubTemplate } from '@blackshop/landinglab-render/templates/landinglab';

describe('React SSR smoke test — Wave 1 de-risk', () => {
  it('renderToString(<StubTemplate slot="hello" />) returns <div id="stub-root">hello</div>', () => {
    const html = renderToString(React.createElement(StubTemplate, { slot: 'hello' }));
    expect(html).toContain('<div id="stub-root">hello</div>');
  });

  it('renderToString escapes JSX children safely', () => {
    const html = renderToString(
      React.createElement(StubTemplate, { slot: '<script>alert(1)</script>' }),
    );
    // React SSR must escape the raw HTML — no live script tag in output.
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;');
  });

  it('renderToString handles multi-byte UTF-8 (multilanguage readiness)', () => {
    const html = renderToString(
      React.createElement(StubTemplate, { slot: 'Olá 你好 مرحبا' }),
    );
    expect(html).toContain('Olá 你好 مرحبا');
  });
});
