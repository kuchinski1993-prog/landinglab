// Guarda contra "kill switch" anti-clone de temas Shopify.
//
// Alguns temas (ex.: Shrine, lpxavira.com) apagam a página inteira quando percebem que estão
// fora da loja original. O secondary.js do Shrine conta os `[data-defer]` e, se faltar o
// main.js do tema (o clone remove), faz `document.body.innerHTML = ""` — a landing fica em
// branco, sem erro no console. A condição muda de tema para tema; o efeito é sempre o mesmo:
// esvaziar <body>/<html>. Então o guarda bloqueia o efeito, não a condição:
//   - innerHTML / outerHTML / textContent / innerText vazios em <body> ou <html>;
//   - replaceChildren() sem argumentos em <body> ou <html>;
//   - body.remove() / html.removeChild(body);
//   - document.write / document.open depois que a página carregou (apagam o documento).
// Atribuições com conteúdo (ex.: um tema que re-renderiza o body) continuam passando.
//
// Tem que ser o PRIMEIRO script do <head>: roda antes de qualquer script do tema.

export const ANTI_WIPE_GUARD_SCRIPT = `<script id="ll-anti-wipe-guard">(function(){
  try {
    var warn = function(what){ try { console.warn('[landinglab] bloqueado: ' + what + ' (kill switch anti-clone)'); } catch (e) {} };
    var isRoot = function(el){ return el === document.body || el === document.documentElement; };
    var isEmpty = function(v){ return v == null || String(v).trim() === ''; };
    var guardProp = function(proto, prop){
      var d = Object.getOwnPropertyDescriptor(proto, prop);
      if (!d || !d.set || !d.configurable) return;
      Object.defineProperty(proto, prop, {
        configurable: true,
        enumerable: d.enumerable,
        get: d.get,
        set: function(v){
          if (isRoot(this) && isEmpty(v)) { warn(this.tagName + '.' + prop + ' = ""'); return; }
          return d.set.call(this, v);
        }
      });
    };
    guardProp(Element.prototype, 'innerHTML');
    guardProp(Element.prototype, 'outerHTML');
    guardProp(Node.prototype, 'textContent');
    if (window.HTMLElement) guardProp(HTMLElement.prototype, 'innerText');

    var rc = Element.prototype.replaceChildren;
    if (rc) Element.prototype.replaceChildren = function(){
      if (isRoot(this) && arguments.length === 0) { warn(this.tagName + '.replaceChildren()'); return; }
      return rc.apply(this, arguments);
    };
    var rm = Element.prototype.remove;
    if (rm) Element.prototype.remove = function(){
      if (isRoot(this)) { warn(this.tagName + '.remove()'); return; }
      return rm.apply(this, arguments);
    };
    var rmc = Node.prototype.removeChild;
    Node.prototype.removeChild = function(child){
      if (isRoot(child)) { warn('removeChild(' + child.tagName + ')'); return child; }
      return rmc.call(this, child);
    };

    var loaded = false;
    window.addEventListener('load', function(){ loaded = true; });
    ['write', 'writeln', 'open'].forEach(function(name){
      var orig = document[name];
      if (typeof orig !== 'function') return;
      document[name] = function(){
        if (loaded) { warn('document.' + name + '() depois do load'); return document; }
        return orig.apply(document, arguments);
      };
    });
  } catch (e) {}
})();</script>`;
