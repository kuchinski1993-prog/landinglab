/**
 * Spaceship adapter — registro/DNS de domínios raiz L0i.
 *
 * Contrato final (Story 13.4): chamadas à Spaceship API pra
 * checar disponibilidade, comprar domínios e configurar DNS.
 *
 * Stub v1 (Story 13.1): apenas a interface — nenhuma chamada real.
 */

export interface SpaceshipAdapter {
  checkAvailability(domain: string): Promise<{ available: boolean; price?: number }>;
  register(domain: string, opts: { years: number }): Promise<{ orderId: string }>;
  configureDNS(domain: string, records: DnsRecord[]): Promise<void>;
  /**
   * Renew registration for `domain` by `years` (1..10).
   * Task #40: pós-compra lifecycle. Se a API do Spaceship não expõe o
   * endpoint de renovação, implementações devem lançar erro claro para que a
   * rota `/api/domains/[id]/renew` retorne HTTP 501 com instruções manuais.
   */
  renew(
    domain: string,
    opts: { years: number },
  ): Promise<{ orderId: string; cost?: number }>;
}

export interface DnsRecord {
  type: 'A' | 'AAAA' | 'CNAME' | 'TXT' | 'MX';
  name: string;
  value: string;
  ttl?: number;
}
