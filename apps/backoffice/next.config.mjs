// build-ts: 1789764000

// Story 20.1 — /ds-lab (laboratório do design system) só existe em
// desenvolvimento ou com NEXT_PUBLIC_DS_LAB=true: o arquivo da rota é
// `page.lab.tsx`, reconhecido só quando a extensão `lab.tsx` está ligada.
const dsLabEnabled = process.env.NODE_ENV !== 'production' || process.env.NEXT_PUBLIC_DS_LAB === 'true';

// Story 20.5f — build de produção não tem fallback local para a vitrine: sem
// NEXT_PUBLIC_STOREFRONT_URL, "Ver na loja"/"Ver loja" ficam desabilitados com
// aviso (src/lib/storefront-url.ts) em vez de abrir http://localhost:3002.
const isProductionBuild = process.env.VERCEL_ENV === 'production' || process.env.NODE_ENV === 'production';
const storefrontUrl = process.env.NEXT_PUBLIC_STOREFRONT_URL ?? (isProductionBuild ? '' : 'http://localhost:3002');

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  pageExtensions: dsLabEnabled ? ['tsx', 'ts', 'jsx', 'js', 'lab.tsx'] : ['tsx', 'ts', 'jsx', 'js'],
  eslint: { ignoreDuringBuilds: true },
  webpack(config, { isServer }) {
    // Workspace packages use TypeScript ESM imports with explicit .js extensions
    // (e.g. './cart.store.js' resolving to './cart.store.ts'). This alias teaches
    // webpack to try .ts/.tsx before falling back to .js when resolving those imports.
    config.resolve.extensionAlias = {
      '.js': ['.ts', '.tsx', '.js'],
      '.jsx': ['.tsx', '.jsx'],
    };
    // LandingLab (Fase 5.A) — Playwright + landinglab-cloner NÃO podem ser
    // bundlados pelo webpack (chromium-bidi tem deps CJS estranhas). Externals
    // no server bundle → resolvidos via require() em runtime.
    if (isServer) {
      const externals = Array.isArray(config.externals) ? config.externals : [];
      externals.push(
        'playwright',
        'playwright-core',
        'chromium-bidi',
        '@blackshop/landinglab-cloner',
        // SM-DEPLOY: Skeleton Mode adiciona pipeline com sharp + tesseract (OCR
        // de reviews) + lazy import de landinglab-build via string dinâmica.
        'sharp',
        'tesseract.js',
      );
      config.externals = externals;
    }
    return config;
  },
  // Playwright + tesseract NÃO podem ser bundlados no server bundle. Marca como
  // external no server components (Next 14 API).
  experimental: {
    // O Skeleton Mode carrega o gerador de HTML em runtime por import dinâmico ignorado pelo
    // webpack, que o rastreamento de arquivos não enxerga; inclui só o arquivo (sem links
    // simbólicos de node_modules, que quebraram a publicação na Vercel).
    outputFileTracingIncludes: {
      '/api/skeleton/create': ['../../packages/landinglab-build/dist/html-builder.mjs'],
    },
    serverComponentsExternalPackages: [
      'playwright',
      'playwright-core',
      '@blackshop/landinglab-cloner',
      'sharp',
      'tesseract.js',
    ],
  },
  async headers() {
    // Força no-store no edge para rotas dinâmicas críticas do LandingLab.
    // Sem isso, o Vercel CDN cacheia respostas 404 quando a rota AINDA não existe
    // no build anterior — e não invalida em deploys posteriores mesmo com a rota
    // já compilada. Aconteceu com /landing-pages/[id]/edit e /api/landing-pages/[id]/edit-inline.
    // Story 22.1b (AC6, T2) — telas de criar senha (o link do e-mail leva o token na query):
    // nada de Referer para fora e nada em cache (navegador/CDN).
    const setPasswordHeaders = [
      { key: 'Referrer-Policy', value: 'no-referrer' },
      { key: 'Cache-Control', value: 'no-store' },
    ];
    return [
      { source: '/criar-senha', headers: setPasswordHeaders },
      { source: '/login/criar-senha', headers: setPasswordHeaders },
      {
        source: '/landing-pages/:id/edit',
        headers: [{ key: 'Cache-Control', value: 'no-store, must-revalidate' }],
      },
      {
        source: '/landing-pages/:id/edit/:path*',
        headers: [{ key: 'Cache-Control', value: 'no-store, must-revalidate' }],
      },
      {
        source: '/api/landing-pages/:id/edit-inline',
        headers: [{ key: 'Cache-Control', value: 'no-store, must-revalidate' }],
      },
    ];
  },
  async rewrites() {
    // Same-origin proxy: browser calls /api/* against the backoffice's own
    // domain; Vercel forwards server-side to the Fastify API on Railway. This
    // makes the session cookie set/sent under the backoffice domain so the
    // Next.js middleware (apps/backoffice/src/middleware.ts) can see it.
    //
    // LandingLab (Fase 5.A) — /api/clone-landing e /api/translate-landing são
    // route handlers locais (rodam Playwright/parse5 dentro do Next). NÃO
    // redirecionar pro Fastify — regex negative-lookahead exclui esses paths.
    const apiUrl = (process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001').replace(/\/$/, '');
    return {
      beforeFiles: [],
      afterFiles: [],
      fallback: [
        {
          source: '/api/:path((?!clone-landing|translate-landing|translate-images|landing-cta|landing-product-extract|domains|skeleton|admin/kill-switch).*)*',
          destination: `${apiUrl}/:path*`,
        },
      ],
    };
  },
  transpilePackages: [
    '@blackshop/cart',
    '@blackshop/db',
    '@blackshop/errors',
    '@blackshop/factory',
    '@blackshop/importer',
    '@blackshop/landinglab-build',
    '@blackshop/landinglab-domains',
    '@blackshop/landinglab-render',
    '@blackshop/landinglab-visual',
    '@blackshop/pricing',
    '@blackshop/shared',
    '@blackshop/shopify-adapter',
    '@blackshop/shopify-storefront',
    '@blackshop/storefront-engine',
    '@blackshop/tracker-engine',
    '@blackshop/tracking',
    '@blackshop/trustshield',
    '@blackshop/vault',
    '@blackshop/whitelabel',
  ],
  env: {
    // Public base URL of the Fastify API (default points to local PORT_API=3001).
    NEXT_PUBLIC_API_URL: process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001',
    // Public base URL of the storefront (local PORT_STOREFRONT=3002 only outside production builds).
    NEXT_PUBLIC_STOREFRONT_URL: storefrontUrl,
  },
};

export default nextConfig;
