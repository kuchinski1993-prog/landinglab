// Barrel export dos providers do Squad 3.
//
// Uso:
//   import { createFreepikProvider, type ImageProvider } from '@blackshop/landinglab-visual/providers';

export {
  NotImplementedError,
  ProviderConfigError,
  ProviderHttpError,
  FreepikProviderError,
  HiggsFieldProviderError,
} from './errors.js';

export type {
  ImageProvider,
  GenerateImageInput,
  GenerateImageOutput,
  ImageSize,
} from './types.js';

export { createFreepikProvider } from './freepik.js';
export { createHiggsfieldProvider } from './higgsfield.js';
export {
  createClaudeTextClient,
  type ClaudeTextClient,
  type ClaudeTextMessagesOpts,
  type ClaudeTextMessagesResult,
  type ClaudeModel,
} from './claude.js';
