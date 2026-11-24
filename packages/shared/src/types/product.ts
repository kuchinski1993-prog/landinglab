import type {
  Product as DbProduct,
  ProductVariant as DbProductVariant,
  ProductImage as DbProductImage,
} from '@blackshop/db';

export type ProductStatus = 'draft' | 'ready' | 'published' | 'archived';
export type ProductSyncStatus = 'unsynced' | 'synced' | 'out_of_sync';

export type Product = DbProduct;
export type ProductVariant = DbProductVariant;
export type ProductImage = DbProductImage;

export interface ProductWithRelations extends Product {
  variants: ProductVariant[];
  images: ProductImage[];
}
