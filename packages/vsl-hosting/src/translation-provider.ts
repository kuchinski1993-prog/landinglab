import type { VslTranslationUnit } from './translation-extract.js';
export class FakeVslTranslationProvider {
  async translate(units: VslTranslationUnit[], _sourceLocale: string, _targetLocale: string, _model='fake-v1'): Promise<number> { return units.length; }
}
