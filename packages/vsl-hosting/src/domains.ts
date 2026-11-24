export type VslDomainState = 'pending_dns'|'pending_verification'|'pending_ssl'|'active'|'error';
export function normalizeVslHostname(raw: string) {
  const value = raw.trim().toLowerCase().replace(/\.$/, '');
  if (!/^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(value) || value.includes('..')) throw new Error('Invalid VSL hostname');
  return value;
}
export function nextVslDomainState(state: VslDomainState, signal: 'dns_ok'|'verify_ok'|'ssl_ok'|'failed'): VslDomainState {
  if (signal === 'failed') return 'error';
  if (state === 'pending_dns' && signal === 'dns_ok') return 'pending_verification';
  if (state === 'pending_verification' && signal === 'verify_ok') return 'pending_ssl';
  if (state === 'pending_ssl' && signal === 'ssl_ok') return 'active';
  return state;
}
export function assertVslPublishReady(input: { manifest: boolean; videoReady: boolean; checkout: boolean; hostnameActive: boolean }) {
  if (!input.manifest || !input.videoReady || !input.checkout || !input.hostnameActive) throw new Error('VSL publish prerequisites incomplete');
  return true;
}
