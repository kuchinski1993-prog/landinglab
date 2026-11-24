import { describe, expect, it } from 'vitest';

import { normalizeVslHostname } from '../domains.js';
describe('VSL domain persistence contracts',()=>{it('requires normalized hostnames and explicit lifecycle states',()=>{expect(normalizeVslHostname('Example.Test')).toBe('example.test');expect(()=>normalizeVslHostname('https://example.test')).toThrow();});});
