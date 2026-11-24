import type { PriceRule as DbPriceRule } from '@blackshop/db';

export type RoundingStrategy = 'ceil' | 'round' | 'floor' | 'none';

export type PriceRule = DbPriceRule;
