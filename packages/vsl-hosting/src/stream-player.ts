/** Browser-only VSL runtime. No provider credentials, iframe DOM access or watched-time. */
export const STREAM_PLAYER_SOURCE = `
const EVENTS = ['play','pause','playing','waiting','timeupdate','seeking','seeked','ended','error','loadedmetadata'];
const SDK = 'https://embed.cloudflarestream.com/embed/sdk.latest.js';
// options (all optional): {autoplay, muted, controls, poster (https URL), primaryColor (#RRGGBB), preload, fill}
export function vslStreamIframeUrl(base, options = {}) {
 const url = new URL(base.href);
 if (options.autoplay === true) url.searchParams.set('autoplay', 'true');
 if (options.muted === true) url.searchParams.set('muted', 'true');
 if (options.controls === false) url.searchParams.set('controls', 'false');
 if (['auto','metadata','none'].includes(options.preload)) url.searchParams.set('preload', options.preload);
 if (typeof options.primaryColor === 'string' && /^#[0-9a-fA-F]{6}$/.test(options.primaryColor)) url.searchParams.set('primaryColor', options.primaryColor);
 if (typeof options.poster === 'string') { try { const poster = new URL(options.poster); if (poster.protocol === 'https:' && !poster.username && !poster.password) url.searchParams.set('poster', poster.href); } catch {} }
 return url;
}
export async function mountVslStreamPlayer(target, descriptor, onEvent = () => {}, options = {}) {
 const url = new URL(descriptor.iframeUrl);
 if (!/^[0-9a-f]{32}$/.test(descriptor.videoId) || descriptor.sdkUrl !== SDK || url.protocol !== 'https:' || !/^customer-[a-z0-9]+\\.cloudflarestream\\.com$/.test(url.hostname) || url.username || url.password || url.port || url.pathname !== '/' + descriptor.videoId + '/iframe' || url.search || url.hash) throw new Error('Invalid VSL playback descriptor');
 if (target.dataset.vslStreamMounted) throw new Error('VSL player already mounted');
 target.dataset.vslStreamMounted = 'true';
 const iframe = document.createElement('iframe');
 iframe.src = vslStreamIframeUrl(url, options || {}).href; iframe.title = 'VSL Stream player'; iframe.allow = 'autoplay; encrypted-media; picture-in-picture; fullscreen'; iframe.allowFullscreen = true;
 // Allowed Origins needs this hostname, but must never receive grant paths/query tokens.
 iframe.referrerPolicy = 'origin'; iframe.style.border = '0'; iframe.style.width = '100%';
 if (options && options.fill) { iframe.style.position = 'absolute'; iframe.style.inset = '0'; iframe.style.height = '100%'; }
 target.appendChild(iframe);
 try {
  if (!window.Stream) await new Promise((resolve,reject) => {
   let script = document.querySelector('script[data-vsl-stream-sdk]');
   if (!script) { script = document.createElement('script'); script.src = SDK; script.dataset.vslStreamSdk = 'true'; script.referrerPolicy = 'no-referrer'; document.head.appendChild(script); }
   if (window.Stream) return resolve();
   script.addEventListener('load',resolve,{once:true}); script.addEventListener('error',()=>reject(new Error('VSL Stream SDK unavailable')),{once:true});
  });
  if (!window.Stream) throw new Error('VSL Stream SDK unavailable');
  const player = window.Stream(iframe);
  const listeners = EVENTS.map(type => {
   const listener = () => { const event = {type, videoId:descriptor.videoId}; onEvent(event); target.dispatchEvent(new CustomEvent('vsl:stream',{detail:event})); };
   player.addEventListener(type,listener); return [type,listener];
  });
  return {player, destroy() { for (const [type,listener] of listeners) player.removeEventListener(type,listener); iframe.remove(); delete target.dataset.vslStreamMounted; }};
 } catch (error) { iframe.remove(); delete target.dataset.vslStreamMounted; throw error; }
}
export function attachVslStreamPlayer(descriptor, selector) {
 let mounted = false;
 const tryMount = () => {
  const targets = document.querySelectorAll(selector);
  if (mounted || targets.length !== 1) return;
  mounted = true; observer.disconnect(); clearTimeout(timeout);
  mountVslStreamPlayer(targets[0],descriptor).catch(()=>targets[0].dispatchEvent(new CustomEvent('vsl:stream',{detail:{type:'error',videoId:descriptor.videoId}})));
 };
 const observer = new MutationObserver(tryMount);
 observer.observe(document.documentElement,{childList:true,subtree:true});
 const timeout = setTimeout(()=>observer.disconnect(),30000);
 tryMount();
}
`;
