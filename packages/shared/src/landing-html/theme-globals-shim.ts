// Utilitários globais do Dawn (global.js) para temas que perderam o script que os define.
//
// Temas Shopify derivados do Dawn (Shrine, etc.) declaram `debounce`, `pauseAllMedia`,
// `fetchConfig`, `trapFocus`... num script global e os componentes (media-gallery.js,
// product-modal.js, cart...) só os chamam. No Shrine esse script é o `main.js` licenciado
// por domínio: fora da loja original ele não roda, e a galeria quebra com
// "debounce is not defined" — as miniaturas não trocam a imagem principal.
//
// Aqui só entram utilitários genéricos e cada um é definido apenas se o tema não tiver o seu
// (`window.x = ...` é configurável: um `function debounce` ou `const debounce` do tema, depois,
// continua valendo). Nada de licença do tema é tocado.
//
// Vai logo depois do guarda anti-wipe no <head>: antes de qualquer script do tema.

export const THEME_GLOBALS_SHIM_SCRIPT = `<script id="ll-theme-globals-shim">(function(){
  try {
    var w = window;
    var def = function(name, fn){ if (typeof w[name] !== 'function') w[name] = fn; };
    def('debounce', function(fn, wait){
      var t;
      return function(){ var ctx = this, args = arguments; clearTimeout(t); t = setTimeout(function(){ fn.apply(ctx, args); }, wait); };
    });
    def('throttle', function(fn, delay){
      var last = 0;
      return function(){ var now = Date.now(); if (now - last >= delay) { last = now; return fn.apply(this, arguments); } };
    });
    def('fetchConfig', function(type){
      return { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/' + (type || 'json') } };
    });
    def('pauseAllMedia', function(){
      var each = function(sel, cb){ Array.prototype.forEach.call(document.querySelectorAll(sel), function(el){ try { cb(el); } catch (e) {} }); };
      each('.js-youtube', function(el){ el.contentWindow.postMessage('{"event":"command","func":"pauseVideo","args":""}', '*'); });
      each('.js-vimeo', function(el){ el.contentWindow.postMessage('{"method":"pause"}', '*'); });
      each('video', function(el){ el.pause(); });
      each('product-model', function(el){ if (el.modelViewerUI) el.modelViewerUI.pause(); });
    });
    def('getFocusableElements', function(container){
      return Array.prototype.slice.call(container.querySelectorAll(
        'summary, a[href], button:enabled, [tabindex]:not([tabindex^="-"]), [draggable], area, input:not([type=hidden]):enabled, select:enabled, textarea:enabled, object, iframe'
      ));
    });
    def('trapFocus', function(container, elementToFocus){
      var target = elementToFocus || container;
      if (target && typeof target.focus === 'function') target.focus();
    });
    def('removeTrapFocus', function(elementToFocus){
      if (elementToFocus && typeof elementToFocus.focus === 'function') elementToFocus.focus();
    });
    def('onKeyUpEscape', function(event){
      if (!event || event.code !== 'Escape') return;
      var open = event.target && event.target.closest && event.target.closest('details[open]');
      if (!open) return;
      open.removeAttribute('open');
      var summary = open.querySelector('summary');
      if (summary) { summary.setAttribute('aria-expanded', 'false'); summary.focus(); }
    });
  } catch (e) {}
})();</script>`;
