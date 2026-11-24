// / — home do storefront LandingLab.
//
// Este componente NUNCA renderiza pra usuário final. O middleware.ts reescreve
// TODO request pra /landing/[host]/[[...slug]]. Se por algum motivo o rewrite
// falhar (matcher desabilitado?), cai aqui e mostra info interna.

export default function Home(): JSX.Element {
  return (
    <main
      style={{
        minHeight: '100vh',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '2rem',
        fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
      }}
    >
      <div style={{ textAlign: 'center', maxWidth: 480 }}>
        <h1 style={{ fontSize: '1.5rem', margin: '0 0 0.5rem', color: '#1a1a1a' }}>
          LandingLab Storefront
        </h1>
        <p style={{ color: '#666', margin: 0 }}>
          Este servidor serve landings publicadas em domínios próprios. Acesse
          via um domínio configurado no LandingLab.
        </p>
      </div>
    </main>
  );
}
