// Barrel export para todos os providers do Squad 1.
//
// Uso:
//   import { createSerpApiClient } from '@blackshop/landinglab-research/providers';

export {
  NotImplementedError,
  ProviderConfigError,
  ProviderHttpError,
} from './errors.js';

export { createSerpApiClient, type SerpApiClient } from './serpapi.js';
export { createFirecrawlClient, type FirecrawlClient } from './firecrawl.js';
export { createApifyClient, type ApifyClient } from './apify.js';
export { createPerplexityClient, type PerplexityClient } from './perplexity.js';
export { createClaudeVisionClient, type ClaudeVisionClient } from './claude-vision.js';
export {
  createGeminiVisionClient,
  type GeminiVisionClient,
  type GeminiContentBlock,
  type GeminiMessagesOpts,
  type GeminiMessagesResult,
  type GeminiModel,
} from './gemini-vision.js';
export {
  createCheerioClient,
  type CheerioClient,
  type CheerioExtractResult,
  type CheerioIdentity,
  type CheerioSource,
  type CheerioStatus,
} from './cheerio.js';
