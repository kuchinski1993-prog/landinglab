import { createClient } from '@supabase/supabase-js';
import ws from 'ws';

let _client: ReturnType<typeof createClient> | null = null;

export function getSupabaseAdmin(): ReturnType<typeof createClient> {
  if (_client) return _client;

  const url = process.env['SUPABASE_URL'] ?? process.env['NEXT_PUBLIC_SUPABASE_URL'];
  const key = process.env['SUPABASE_SERVICE_ROLE_KEY'];

  if (!url || !key) {
    throw new Error(
      'Supabase admin client requires SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY env vars',
    );
  }

  _client = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
    // Node.js 20 não tem WebSocket nativo — ws satisfaz a interface em runtime mas não no type-level
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    realtime: { transport: ws as any },
  });

  return _client;
}

export const IMAGES_BUCKET = 'product-images';
