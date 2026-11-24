// Stub template — Wave 1 React SSR de-risk (Story 13.6, AC5).
//
// Purpose: prove that React SSR + JSX transform works in this monorepo before
// investing in the 3 full templates (long-form-advertorial, short-form-direct,
// story-driven) in Wave 2.
//
// If this template renders correctly via renderToString() in the smoke test
// (packages/landinglab-build/src/orchestrator.smoke.test.ts), the whole
// React SSR pipeline is validated. If it does not, Wave 2 is blocked.

import * as React from 'react';

export interface StubTemplateProps {
  slot: string;
}

export const StubTemplate: React.FC<StubTemplateProps> = ({ slot }) => (
  <div id="stub-root">{slot}</div>
);
