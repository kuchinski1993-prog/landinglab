// Global 404 do storefront.
// Renderizado quando resolveLanding retorna null (hostname não cadastrado,
// slug não bindado, landing arquivada, etc).

export default function NotFound(): JSX.Element {
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
        <h1 style={{ fontSize: '2rem', margin: '0 0 0.5rem', color: '#1a1a1a' }}>
          Página não encontrada
        </h1>
        <p style={{ color: '#666', lineHeight: 1.5, margin: 0 }}>
          A landing que você tentou acessar não existe ou foi despublicada.
        </p>
      </div>
    </main>
  );
}
