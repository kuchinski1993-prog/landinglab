// Story 26.1 — overlay de seções, botões e preços do preview `?edit=inline`.
//
// Os elementos já chegam marcados pelo servidor (`markInlineEditTargets`): `data-ll-eid`, `data-ll-kind`,
// `data-ll-label`, `data-ll-cur-text`, `data-ll-cur-href`, `data-ll-multi-text`, `data-ll-text-host`.
// Este script só cuida de hover, seleção e prévia — nada aqui vai para o HTML gravado.
//
// iframe → parent:
//   - `ll-sections`      { sections: [{ id, label, hidden }] }  (no carregamento)
//   - `ll-target-click`  { chain: [{ id, kind, label, text, href, multi, hidden }] } (mais interno primeiro)
// parent → iframe:
//   - `ll-apply-preview` { sectionEdits, buttonEdits, priceEdits } (estado pendente completo; refaz do zero)
//   - `ll-select`        { id } (seleciona e rola até o elemento)

export const TARGET_OVERLAY_HTML = `
<style id="ll-target-overlay-style">
  [data-ll-kind="section"].ll-hover{outline:2px dashed rgba(44,110,203,.9) !important;outline-offset:-2px !important}
  [data-ll-kind="button"].ll-hover,[data-ll-kind="price"].ll-hover{outline:2px dashed rgba(142,68,173,.95) !important;outline-offset:2px !important;cursor:pointer !important}
  [data-ll-kind].ll-selected{outline:3px solid rgba(44,110,203,1) !important;outline-offset:-3px !important}
  [data-ll-kind="button"].ll-selected,[data-ll-kind="price"].ll-selected{outline-color:rgba(142,68,173,1) !important;outline-offset:2px !important}
  [data-ll-kind="section"].ll-is-hidden{opacity:.35 !important;background-image:repeating-linear-gradient(45deg,rgba(0,0,0,.06) 0 10px,transparent 10px 20px) !important}
  [data-ll-kind="section"].ll-is-removed{opacity:.25 !important;outline:3px dashed rgba(215,44,13,.95) !important;outline-offset:-3px !important}
  #ll-target-label{position:fixed !important;z-index:2147483646 !important;pointer-events:none !important;background:#1f2124 !important;color:#fff !important;font:600 12px/1.3 -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif !important;padding:4px 8px !important;border-radius:6px !important;max-width:320px !important;white-space:nowrap !important;overflow:hidden !important;text-overflow:ellipsis !important;display:none}
</style>
<script id="ll-target-overlay-script">
(function(){
  var SEL='[data-ll-kind="button"],[data-ll-kind="price"],[data-ll-kind="section"]';
  var NAMES={section:'Seção',button:'Botão',price:'Preço'};
  var label=null, hovered=null, selected=null;
  var origText={};
  function post(m){try{window.parent.postMessage(m,'*')}catch(e){}}
  function deepest(t){
    if(!t||!t.closest)return null;
    if(t.closest('[data-ll-kind="text"],[data-ll-kind="image"],.ll-img-overlay'))return null;
    return t.closest(SEL);
  }
  function info(el){
    var kind=el.getAttribute('data-ll-kind');
    return {
      id:el.getAttribute('data-ll-eid'), kind:kind,
      label:kind==='section'?(el.getAttribute('data-ll-label')||''):(el.getAttribute('data-ll-cur-text')||''),
      text:el.getAttribute('data-ll-cur-text')||'',
      href:el.getAttribute('data-ll-cur-href')||'',
      multi:el.getAttribute('data-ll-multi-text')==='1',
      hidden:el.classList.contains('ll-is-hidden')
    };
  }
  function chainOf(el){
    var out=[];
    for(var c=el;c;c=c.parentElement){ if(c.matches&&c.matches(SEL)) out.push(info(c)); }
    return out;
  }
  function byId(id){return document.querySelector('[data-ll-eid="'+String(id).replace(/"/g,'')+'"]')}
  function showLabel(el){
    if(!label){label=document.createElement('div');label.id='ll-target-label';document.body.appendChild(label)}
    var i=info(el); var r=el.getBoundingClientRect();
    label.textContent=NAMES[i.kind]+(i.label?' · '+i.label:'')+(i.hidden?' (oculta)':'');
    label.style.display='block';
    label.style.left=Math.max(4,Math.min(r.left,window.innerWidth-330))+'px';
    label.style.top=(r.top>26?r.top-24:Math.max(4,r.top+4))+'px';
  }
  function setHover(el){
    if(hovered===el)return;
    if(hovered)hovered.classList.remove('ll-hover');
    hovered=el;
    if(el){el.classList.add('ll-hover');showLabel(el)}else if(label){label.style.display='none'}
  }
  function select(el,scroll){
    if(selected)selected.classList.remove('ll-selected');
    selected=el;
    if(!el)return;
    el.classList.add('ll-selected');
    if(scroll&&el.scrollIntoView)el.scrollIntoView({behavior:'smooth',block:'center'});
  }
  document.addEventListener('mouseover',function(e){setHover(deepest(e.target))},true);
  document.addEventListener('mouseleave',function(){setHover(null)});
  window.addEventListener('scroll',function(){if(hovered)showLabel(hovered)},true);
  // Botões e preços: o clique só seleciona (não abre carrinho nem navega). Seções: seleciona e deixa o clique
  // seguir (abas e FAQ continuam abrindo para editar o texto de dentro).
  window.addEventListener('click',function(e){
    var el=deepest(e.target); if(!el)return;
    if(el.getAttribute('data-ll-kind')!=='section'){
      e.preventDefault(); e.stopPropagation(); if(e.stopImmediatePropagation)e.stopImmediatePropagation();
    }
    select(el,false);
    post({type:'ll-target-click',chain:chainOf(el)});
  },true);
  function mainText(el){
    var best=null;
    (function walk(n){
      for(var c=n.firstChild;c;c=c.nextSibling){
        if(c.nodeType===3){var v=(c.nodeValue||'').trim(); if(v&&(!best||v.length>best.nodeValue.trim().length))best=c}
        else if(c.nodeType===1&&!/^(SCRIPT|STYLE|NOSCRIPT|TEMPLATE|svg|SVG)$/.test(c.tagName))walk(c);
      }
    })(el);
    return best;
  }
  function setPreviewText(id,text){
    var el=byId(id); if(!el)return;
    if(el.tagName==='INPUT'){ if(!(id in origText))origText[id]=el.value; el.value=text==null?origText[id]:text; return; }
    var n=mainText(el); if(!n)return;
    if(!(id in origText))origText[id]=n.nodeValue;
    n.nodeValue=text==null?origText[id]:text;
  }
  function sections(){
    var els=document.querySelectorAll('[data-ll-kind="section"]'); var out=[];
    for(var i=0;i<els.length;i++)out.push({id:els[i].getAttribute('data-ll-eid'),label:els[i].getAttribute('data-ll-label')||'',hidden:els[i].hasAttribute('data-ll-hidden')});
    return out;
  }
  function applyPreview(d){
    var secs=document.querySelectorAll('[data-ll-kind="section"]');
    for(var i=0;i<secs.length;i++){
      secs[i].classList.remove('ll-is-removed');
      secs[i].classList.toggle('ll-is-hidden',secs[i].hasAttribute('data-ll-hidden'));
    }
    for(var id in origText)setPreviewText(id,null);
    (d.sectionEdits||[]).forEach(function(s){
      var el=byId(s.id); if(!el)return;
      if(s.action==='remove')el.classList.add('ll-is-removed');
      else el.classList.toggle('ll-is-hidden',s.action==='hide');
    });
    (d.buttonEdits||[]).concat(d.priceEdits||[]).forEach(function(b){
      if(typeof b.text==='string'&&b.text.trim())setPreviewText(b.id,b.text.trim());
    });
  }
  window.addEventListener('message',function(ev){
    var d=ev.data; if(!d||typeof d!=='object')return;
    if(d.type==='ll-apply-preview')applyPreview(d);
    else if(d.type==='ll-select'){var el=byId(d.id); if(el)select(el,true)}
  });
  function init(){
    // Seções ocultas aparecem esmaecidas no editor (o display:none inline é só da página publicada).
    var hidden=document.querySelectorAll('[data-ll-hidden]');
    for(var i=0;i<hidden.length;i++){hidden[i].style.removeProperty('display');hidden[i].classList.add('ll-is-hidden')}
    post({type:'ll-sections',sections:sections()});
  }
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',init);else init();
})();
</script>
`;
