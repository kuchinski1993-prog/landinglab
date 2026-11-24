/** @type {import('next').NextConfig} */

// Task #43 — Content-Security-Policy pra landings clonadas.
//
// Trade-offs justificados (por que precisamos de 'unsafe-inline'):
// - style-src 'unsafe-inline': landings clonadas trazem `style="..."` inline
//   em quase todos os elementos (frameworks tipo Tailwind/inline styles) e
//   blocos <style> extraídos do source. Sem unsafe-inline nada renderiza.
// - script-src 'unsafe-inline': mantemos <script type="application/ld+json">
//   inline (SEO). JSON-LD não é executável, mas o browser ainda checa CSP no
//   parsing. Alternativa nonces requer Edge runtime + injeção per-render —
//   futura melhoria.
// - script-src exclui 'unsafe-eval' — bloqueia eval/new Function.
// - object-src 'none' e frame-ancestors 'none' — clickjacking + Flash-style
//   ataques.
// - Sanitização em profundidade via DOMPurify (src/lib/sanitize-landing-html.ts)
//   remove <script> executável de fato — CSP é a rede de segurança.
// CSP relaxada para landings clonadas: elas carregam scripts do próprio
// Supabase (assets clonados) + CDN Shopify (custom elements como product-form,
// media-gallery, kaching-bundles). Sem esses hosts explícitos as landings
// ficam quebradas (bundles não clicáveis, galeria travada) porque o browser
// bloqueia os scripts que definem os custom elements.
//
// Threat model: operator escolhe qual URL clonar — não é usuário anônimo
// hostil. Cloner já sanitiza trackers. Aqui a rede de segurança é bloquear
// eval e limitar frame-src.
const CSP_DIRECTIVES = [
  "default-src 'self' https:",
  "script-src 'self' 'unsafe-inline' https:",
  "style-src 'self' 'unsafe-inline' https:",
  "img-src 'self' data: blob: https:",
  "font-src 'self' data: https:",
  "media-src 'self' data: blob: https:",
  "connect-src 'self' https: wss:",
  "frame-src 'self' https:",
  "frame-ancestors 'none'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self' https:",
  'upgrade-insecure-requests',
].join('; ');

const SECURITY_HEADERS = [
  { key: 'Content-Security-Policy', value: CSP_DIRECTIVES },
  { key: 'X-Frame-Options', value: 'DENY' },
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=(), interest-cohort=()' },
  { key: 'X-DNS-Prefetch-Control', value: 'on' },
];

const nextConfig = {
  reactStrictMode: true,
  eslint: { ignoreDuringBuilds: true },
  // isomorphic-dompurify carrega jsdom que faz readFileSync de default-stylesheet.css
  // em runtime. Next 14 relocaliza assets via webpack e quebra o caminho. Externalizamos
  // ambos pra que sejam resolvidos do node_modules em runtime.
  experimental: {
    serverComponentsExternalPackages: ['isomorphic-dompurify', 'jsdom'],
  },
  webpack(config) {
    // Workspace packages use TypeScript ESM imports with explicit .js extensions
    // (e.g. './sanitize.js' resolving to './sanitize.ts'). This alias teaches
    // webpack to try .ts/.tsx before falling back to .js when resolving those imports.
    config.resolve.extensionAlias = {
      '.js': ['.ts', '.tsx', '.js'],
      '.jsx': ['.tsx', '.jsx'],
    };
    return config;
  },
  transpilePackages: [
    '@blackshop/db',
    '@blackshop/payments',
    '@blackshop/landinglab-domains',
    '@blackshop/landinglab-render',
    '@blackshop/pricing',
    '@blackshop/shared',
  ],
  env: {
    NEXT_PUBLIC_API_URL: process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001',
  },
  async redirects() {
    // Redirect (não rewrite) — usuário setou links do Cloaker apontando pra
    // https://cubipiccanti.online/api/t/:slug. Rewrite não funciona porque
    // o request sai via Vercel edge (AWS Amazon) → blacklist:isp do tracker
    // bloqueia com 404. Redirect 302 faz o BROWSER DO CLIENTE seguir pra
    // t.authenlondon.com direto — assim o IP que chega no tracker é o
    // real do usuário, não do Vercel.
    const apiBase = process.env.NEXT_PUBLIC_API_URL?.replace(/\/$/, '') ?? 'https://t.authenlondon.com';
    return [
      {
        source: '/api/t/:slug',
        destination: `${apiBase}/api/t/:slug`,
        permanent: false, // 302 pra preservar SEO/marketing tracking
      },
    ];
  },
  async headers() {
    return [
      {
        // Aplica em todas as rotas — landings servidas em qualquer host.
        source: '/:path*',
        headers: SECURITY_HEADERS,
      },
    ];
  },
};

export default nextConfig;
