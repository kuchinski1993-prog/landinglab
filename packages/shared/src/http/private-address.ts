// Story 18.2 · faixas de IP que o servidor nunca deve sondar (promovido de
// packages/vsl-hosting/src/domain-service.ts `isPrivateVslAddress`, QA F4 M3 do VSL — mesmas faixas).
// Privadas, loopback, link-local (metadados 169.254.169.254), CGNAT, reservadas e multicast.
// Listas separadas: o BlockList compara IPv4 com regras IPv6 como v4 mapeado (::ffff:0:0/96 pegaria tudo).
import { BlockList, isIP } from 'node:net';

const BLOCKED_V4 = new BlockList();
const BLOCKED_V6 = new BlockList();
for (const [network, prefix] of [['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12],
  ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 3]] as const)
  BLOCKED_V4.addSubnet(network, prefix, 'ipv4');
for (const [network, prefix] of [['::', 127], ['::ffff:0:0', 96], ['64:ff9b::', 96], ['64:ff9b:1::', 48], ['100::', 64], ['2001:db8::', 32],
  ['2002::', 16], ['fc00::', 7], ['fe80::', 10], ['fec0::', 10], ['ff00::', 8]] as const)
  BLOCKED_V6.addSubnet(network, prefix, 'ipv6');

/** IP privado/loopback/link-local/reservado (v4 e v6, inclusive v4 mapeado em v6). Texto que não é IP conta como bloqueado. */
export function isPrivateAddress(ip: string): boolean {
  const family = isIP(ip);
  if (family === 4) return BLOCKED_V4.check(ip, 'ipv4');
  if (family === 6) return BLOCKED_V6.check(ip, 'ipv6');
  return true;
}
