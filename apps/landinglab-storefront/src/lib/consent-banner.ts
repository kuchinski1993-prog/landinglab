// Banner de consentimento (GDPR / ePrivacy — Garante, 2021) para o Meta Pixel da landing.
//
// Roda no <head> ANTES do snippet do pixel embutido no HTML clonado. Sem consentimento,
// pré-define o stub oficial do `fbq` (fila sem carregar fbevents.js): o snippet do pixel
// vê `window.fbq` já existente e retorna sem carregar nada, e todas as chamadas
// (init, PageView, ViewContent…) ficam na fila. "Accetta" carrega fbevents.js, que
// processa a fila; "Rifiuta" descarta a fila. O relay CAPI do runtime espera o mesmo
// consentimento (`__LL_ON_CONSENT__`) e então envia `marketingConsent: true`, o que
// libera IP + user agent no servidor (sem isso a Meta rejeita por dados insuficientes).

export const CONSENT_COOKIE = 'll_consent';

interface ConsentTexts {
  message: string;
  privacy: string;
  accept: string;
  reject: string;
  /** Link discreto para reabrir o banner depois de recusar. */
  prefs: string;
}

const TEXTS: Record<string, ConsentTexts> = {
  it: {
    message:
      'Usiamo cookie tecnici necessari al funzionamento del sito e, solo con il tuo consenso, il Pixel di Meta per misurare e migliorare i nostri annunci. Puoi cambiare idea in qualsiasi momento.',
    privacy: 'Informativa sulla privacy',
    accept: 'Accetta',
    reject: 'Rifiuta',
    prefs: 'Preferenze cookie',
  },
  en: {
    message:
      'We use technical cookies required for the site to work and, only with your consent, the Meta Pixel to measure and improve our ads. You can change your mind at any time.',
    privacy: 'Privacy policy',
    accept: 'Accept',
    reject: 'Reject',
    prefs: 'Cookie preferences',
  },
  es: {
    message:
      'Usamos cookies técnicas necesarias para el funcionamiento del sitio y, solo con tu consentimiento, el Píxel de Meta para medir y mejorar nuestros anuncios. Puedes cambiar de opinión en cualquier momento.',
    privacy: 'Política de privacidad',
    accept: 'Aceptar',
    reject: 'Rechazar',
    prefs: 'Preferencias de cookies',
  },
  pt: {
    message:
      'Usamos cookies técnicos necessários ao funcionamento do site e, só com o seu consentimento, o Pixel da Meta para medir e melhorar os nossos anúncios. Pode mudar de ideia a qualquer momento.',
    privacy: 'Política de privacidade',
    accept: 'Aceitar',
    reject: 'Recusar',
    prefs: 'Preferências de cookies',
  },
  fr: {
    message:
      'Nous utilisons des cookies techniques nécessaires au fonctionnement du site et, uniquement avec votre consentement, le Pixel Meta pour mesurer et améliorer nos annonces. Vous pouvez changer d’avis à tout moment.',
    privacy: 'Politique de confidentialité',
    accept: 'Accepter',
    reject: 'Refuser',
    prefs: 'Préférences cookies',
  },
  de: {
    message:
      'Wir verwenden technisch notwendige Cookies und, nur mit Ihrer Einwilligung, das Meta-Pixel, um unsere Anzeigen zu messen und zu verbessern. Sie können Ihre Entscheidung jederzeit ändern.',
    privacy: 'Datenschutzerklärung',
    accept: 'Akzeptieren',
    reject: 'Ablehnen',
    prefs: 'Cookie-Einstellungen',
  },
};

// UE + EEE (IS, LI, NO) + Reino Unido + Suíça: o pixel só carrega com
// consentimento. Fora deles não há banner e o pixel dispara direto.
const CONSENT_REQUIRED_COUNTRIES = new Set([
  'AT', 'BE', 'BG', 'HR', 'CY', 'CZ', 'DK', 'EE', 'FI', 'FR', 'DE', 'GR', 'HU', 'IE', 'IT',
  'LV', 'LT', 'LU', 'MT', 'NL', 'PL', 'PT', 'RO', 'SK', 'SI', 'ES', 'SE',
  'IS', 'LI', 'NO', 'GB', 'CH',
]);

/** País do visitante (ISO alpha-2). Desconhecido → exige consentimento (padrão seguro). */
export function consentRequired(country: string | null | undefined): boolean {
  const cc = (country ?? '').trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(cc)) return true;
  return CONSENT_REQUIRED_COUNTRIES.has(cc);
}

export function consentTexts(locale: string | null | undefined): ConsentTexts {
  const lang = (locale ?? '').toLowerCase().split(/[-_]/)[0] ?? '';
  return TEXTS[lang] ?? TEXTS['en']!;
}

/** Remove o <noscript> do pixel (dispararia PageView sem consentimento). */
export function stripPixelNoscript(html: string): string {
  return html.replace(/<noscript>(?:(?!<\/noscript>)[\s\S])*facebook\.com\/tr(?:(?!<\/noscript>)[\s\S])*<\/noscript>/gi, '');
}

const CSS = `#ll-consent-overlay{position:fixed;inset:0;z-index:2147483646;background:rgba(0,0,0,.45);display:flex;align-items:center;justify-content:center;padding:16px;box-sizing:border-box}
#ll-consent{position:relative;z-index:2147483647;width:100%;max-width:440px;background:#fff;color:#1a1a1a;border-radius:14px;box-shadow:0 12px 40px rgba(0,0,0,.25);padding:22px;font:15px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;box-sizing:border-box}
#ll-consent p{margin:0 0 18px;color:#1a1a1a}
#ll-consent a{color:#1a1a1a;text-decoration:underline}
#ll-consent .ll-consent-actions{display:flex;gap:16px}
#ll-consent button{flex:1;min-height:52px;border-radius:10px;font:600 16px/1 inherit;font-family:inherit;cursor:pointer;border:1px solid #1a1a1a}
#ll-consent .ll-consent-reject{background:#fff;color:#1a1a1a}
#ll-consent .ll-consent-accept{background:#1a1a1a;color:#fff}
#ll-consent-prefs{position:fixed;left:8px;bottom:8px;z-index:2147483645;background:rgba(255,255,255,.85);color:#555;border:0;border-radius:6px;padding:4px 8px;font:12px/1.2 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;text-decoration:underline;cursor:pointer}`;

/**
 * Visitante fora da UE/EEE/UK/CH: sem banner. O pixel do HTML carrega normal e
 * o relay CAPI sai na hora. Uma recusa anterior (cookie `denied`) continua
 * respeitada: o pixel fica na fila e nada é enviado.
 */
function buildNoBannerScript(): string {
  return `<script id="ll-consent-runtime">
(function(){
  var NAME = ${JSON.stringify(CONSENT_COOKIE)};
  var state = null;
  try {
    var m = document.cookie.match(new RegExp('(?:^|; )' + NAME + '=(granted|denied)'));
    state = m ? m[1] : null;
  } catch(_){}
  if(state === 'denied'){
    if(!window.fbq){
      var n = window.fbq = function(){ n.callMethod ? n.callMethod.apply(n, arguments) : n.queue.push(arguments); };
      if(!window._fbq) window._fbq = n;
      n.push = n; n.loaded = true; n.version = '2.0'; n.queue = [];
    }
  } else {
    state = 'granted';
    try {
      document.cookie = NAME + '=granted; path=/; max-age=' + (180 * 24 * 60 * 60) + '; SameSite=Lax' + (location.protocol === 'https:' ? '; Secure' : '');
    } catch(_){}
  }
  window.__LL_CONSENT__ = state;
  window.__LL_ON_CONSENT__ = function(cb){
    if(window.__LL_CONSENT__ === 'granted'){ try { cb(); } catch(_){} }
  };
})();
</script>`;
}

/**
 * `<style>` + `<script>` do banner. ES5 puro (mesma regra da Engine V2).
 * Deve ser injetado logo após `<head>`, antes de qualquer snippet do pixel.
 * `required: false` (visitante fora da UE/EEE/UK/CH) → sem banner.
 */
export function buildConsentScript(
  locale: string | null | undefined,
  options: { required?: boolean } = {},
): string {
  if (options.required === false) return buildNoBannerScript();
  const t = consentTexts(locale);
  const textsJson = JSON.stringify(t).replace(/</g, '\\u003c');
  return `<style id="ll-consent-style">${CSS}</style>
<script id="ll-consent-runtime">
(function(){
  var T = ${textsJson};
  var NAME = ${JSON.stringify(CONSENT_COOKIE)};
  var MAX_AGE = 180 * 24 * 60 * 60;
  function read(){
    try {
      var m = document.cookie.match(new RegExp('(?:^|; )' + NAME + '=(granted|denied)'));
      return m ? m[1] : null;
    } catch(_){ return null; }
  }
  var state = read();
  window.__LL_CONSENT__ = state;
  // Stub oficial do fbq sem carregar fbevents.js: o snippet do pixel vê fbq definido e não carrega nada.
  if(state !== 'granted' && !window.fbq){
    var n = window.fbq = function(){ n.callMethod ? n.callMethod.apply(n, arguments) : n.queue.push(arguments); };
    if(!window._fbq) window._fbq = n;
    n.push = n; n.loaded = true; n.version = '2.0'; n.queue = [];
  }
  var waiting = [];
  // Sem consentimento os envios ficam só em memória (nada sai do navegador);
  // se o visitante aceitar depois (link "Preferenze cookie"), saem nessa hora.
  window.__LL_ON_CONSENT__ = function(cb){
    if(window.__LL_CONSENT__ === 'granted'){ try { cb(); } catch(_){} }
    else { waiting.push(cb); }
  };
  function loadPixel(){
    var f = window.fbq;
    if(!f || f.callMethod || f.__llLoading) return;
    f.__llLoading = true;
    var s = document.createElement('script');
    s.async = true;
    s.src = 'https://connect.facebook.net/en_US/fbevents.js';
    (document.head || document.documentElement).appendChild(s);
  }
  function hide(){
    var el = document.getElementById('ll-consent-overlay');
    if(el && el.parentNode) el.parentNode.removeChild(el);
  }
  function hidePrefs(){
    var el = document.getElementById('ll-consent-prefs');
    if(el && el.parentNode) el.parentNode.removeChild(el);
  }
  function showPrefs(){
    if(document.getElementById('ll-consent-prefs') || !document.body) return;
    var b = document.createElement('button');
    b.type = 'button';
    b.id = 'll-consent-prefs';
    b.appendChild(document.createTextNode(T.prefs));
    b.onclick = function(){ hidePrefs(); show(); };
    document.body.appendChild(b);
  }
  // Taxa de aceite: só a escolha, sem identificador do visitante.
  function record(value){
    try {
      var api = window.__LL_TRACK_EVENT_API__;
      if(api && window.fetch){
        window.fetch(String(api).replace('/tracking/event', '/tracking/consent'), {
          method: 'POST',
          credentials: 'omit',
          headers: { 'content-type': 'application/json' },
          keepalive: true,
          body: JSON.stringify({ choice: value })
        }).catch(function(){});
      }
    } catch(_){}
  }
  function choose(value){
    try {
      document.cookie = NAME + '=' + value + '; path=/; max-age=' + MAX_AGE + '; SameSite=Lax' + (location.protocol === 'https:' ? '; Secure' : '');
    } catch(_){}
    window.__LL_CONSENT__ = value;
    hide();
    record(value);
    if(value === 'granted'){
      hidePrefs();
      var cbs = waiting; waiting = [];
      loadPixel();
      // Dá tempo do fbevents.js gravar o _fbp antes do relay CAPI ler o cookie.
      setTimeout(function(){ for(var i = 0; i < cbs.length; i++){ try { cbs[i](); } catch(_){} } }, 1200);
    } else {
      showPrefs();
    }
  }
  window.__LL_CONSENT_CHOOSE__ = choose;
  function show(){
    if(document.getElementById('ll-consent-overlay') || !document.body) return;
    var overlay = document.createElement('div');
    overlay.id = 'll-consent-overlay';
    var box = document.createElement('div');
    box.id = 'll-consent';
    box.setAttribute('role', 'dialog');
    box.setAttribute('aria-modal', 'true');
    box.setAttribute('aria-label', T.privacy);
    var p = document.createElement('p');
    p.appendChild(document.createTextNode(T.message + ' '));
    var a = document.createElement('a');
    a.href = '/policies/privacy-policy';
    a.target = '_blank';
    a.rel = 'noopener';
    a.appendChild(document.createTextNode(T.privacy));
    p.appendChild(a);
    box.appendChild(p);
    var actions = document.createElement('div');
    actions.className = 'll-consent-actions';
    var reject = document.createElement('button');
    reject.type = 'button';
    reject.className = 'll-consent-reject';
    reject.appendChild(document.createTextNode(T.reject));
    reject.onclick = function(){ choose('denied'); };
    var accept = document.createElement('button');
    accept.type = 'button';
    accept.className = 'll-consent-accept';
    accept.appendChild(document.createTextNode(T.accept));
    accept.onclick = function(){ choose('granted'); };
    actions.appendChild(reject);
    actions.appendChild(accept);
    box.appendChild(actions);
    overlay.appendChild(box);
    document.body.appendChild(overlay);
  }
  function start(){
    if(state === null) show();
    else if(state === 'denied') showPrefs();
  }
  if(document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();
</script>`;
}
