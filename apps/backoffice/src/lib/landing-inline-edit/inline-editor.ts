// Editor inline PageFly-style (Camada 1) do preview `?edit=inline` — injetado antes do </body>.
//
// Injeta CSS+JS que:
//   1. Liga a edição nos textos/imagens que o servidor marcou (`data-ll-eid` + `data-ll-kind`, IDs
//      `e_` calculados sobre o HTML cru — os mesmos que o PATCH procura). O navegador NÃO calcula ID:
//      aqui os scripts da landing já mexeram no DOM e o ID não batia ("Nenhum edit aplicado").
//   2. Recoloca as marcas (receitas `#ll-editor-recipes`) nos elementos que os scripts redesenharam —
//      textos/imagens só se o conteúdo ainda for o original; botões/preços sempre (link volta ao painel).
//   3. Texto: contenteditable ao focar, plaintext-only, sem quebrar layout.
//   4. Imagens: overlay verde ao hover, click → postMessage pro parent.
//   5. Parent pode fazer postMessage 'll-image-preview' pra atualizar src
//      visualmente antes de salvar.

import { editorRecipesTag, type EditorRecipe } from './editor-recipes';
import { TARGET_OVERLAY_HTML } from './overlay';

export function inlineEditorHtml(recipes: EditorRecipe[]): string {
  return `
<style id="ll-inline-editor-style">
  /* Landings Shopify usam MUITO pointer-events:none e user-select:none.
     !important obrigatório porque as regras da landing têm especificidade
     alta (ex: .cart-drawer *). */
  [data-ll-eid]{pointer-events:auto !important;user-select:auto !important;-webkit-user-select:auto !important}
  /* Estado idle: outline verde tracejado 2px SEMPRE VISÍVEL — user precisa
     saber que aquilo é editável sem precisar hover. */
  [data-ll-eid][data-ll-kind="text"]{outline:2px dashed rgba(0,150,120,.9) !important;outline-offset:3px !important;cursor:text !important;background:rgba(0,180,140,.06) !important;border-radius:3px}
  [data-ll-eid][data-ll-kind="text"]:hover{outline:3px solid rgba(0,180,140,1) !important;background:rgba(255,240,150,.4) !important;box-shadow:0 0 0 4px rgba(0,180,140,.25) !important}
  [data-ll-eid][data-ll-kind="text"][contenteditable]{outline:3px solid rgba(255,140,0,1) !important;background:rgba(255,240,150,.7) !important;user-select:text !important;-webkit-user-select:text !important;box-shadow:0 0 0 6px rgba(255,180,50,.35) !important}
  /* Imagens: outline permanente amarelo/verde grosso pra destacar */
  [data-ll-eid][data-ll-kind="image"]{outline:4px solid rgba(0,180,140,.9) !important;outline-offset:-4px !important;cursor:pointer !important;position:relative !important}
  [data-ll-eid][data-ll-kind="image"]:hover{outline:5px solid rgba(255,140,0,1) !important}
  .ll-img-overlay{position:absolute !important;inset:0 !important;background:rgba(0,150,120,.7) !important;display:flex !important;align-items:center !important;justify-content:center !important;color:#fff !important;font-weight:800 !important;font-size:16px !important;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif !important;pointer-events:none !important;opacity:0;transition:opacity 120ms;text-shadow:0 1px 3px rgba(0,0,0,.9);z-index:9999}
  [data-ll-eid][data-ll-kind="image"]:hover .ll-img-overlay{opacity:1}
  /* Badge fixo no topo mostrando total de editáveis */
  #ll-editor-badge{position:fixed !important;top:12px !important;right:12px !important;background:#008060 !important;color:#fff !important;padding:8px 14px !important;border-radius:20px !important;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif !important;font-size:13px !important;font-weight:700 !important;box-shadow:0 4px 12px rgba(0,0,0,.25) !important;z-index:2147483647 !important;pointer-events:none !important;user-select:none !important}
</style>
${editorRecipesTag(recipes)}
<script id="ll-inline-editor-script">
(function(){
  var RECIPES=[];
  try{var rt=document.getElementById('ll-editor-recipes');if(rt)RECIPES=JSON.parse(rt.textContent||'[]')||[]}catch(_){}
  // Elementos do próprio editor não contam na posição das receitas (wrapper/overlay de imagem, badge).
  function isOwn(el){return (el.id&&el.id.indexOf('ll-')===0)||/(^|\\s)ll-img-(wrap|overlay)(\\s|$)/.test(el.className||'')}
  function guardOk(el,r){
    if(r.g==null)return true;
    if(r.a['data-ll-kind']==='image')return el.tagName==='IMG'&&el.getAttribute('src')===r.g;
    return el.childNodes.length===1&&el.childNodes[0].nodeType===3&&(el.textContent||'').trim()===r.g;
  }
  function restore(){
    if(!RECIPES.length)return 0;
    var have={};var cur=document.querySelectorAll('[data-ll-eid]');
    for(var k=0;k<cur.length;k++)have[cur[k].getAttribute('data-ll-eid')]=1;
    var cache={};var n=0;
    for(var i=0;i<RECIPES.length;i++){
      var r=RECIPES[i];var id=r&&r.a&&r.a['data-ll-eid'];
      if(!id||have[id])continue;
      var list=cache[r.s];
      if(!list){
        list=[];try{var m=document.querySelectorAll(r.s);for(var j=0;j<m.length;j++)if(!isOwn(m[j]))list.push(m[j])}catch(_){}
        cache[r.s]=list;
      }
      var el=list[r.i];
      if(!el||el.hasAttribute('data-ll-eid')||!guardOk(el,r))continue;
      // Texto de botão/preço é editado pelo painel, não inline.
      if(r.a['data-ll-kind']==='text'&&el.closest('[data-ll-kind="button"],[data-ll-kind="price"]'))continue;
      for(var a in r.a)if(Object.prototype.hasOwnProperty.call(r.a,a))el.setAttribute(a,r.a[a]);
      have[id]=1;n++;
    }
    return n;
  }
  function markText(el){
    if(el.__llBound||el.getAttribute('contenteditable')==='false')return;
    el.__llBound=true;
    var id=el.getAttribute('data-ll-eid');
    var text=el.textContent||'';
    el.setAttribute('spellcheck','false');
    el.addEventListener('mousedown',function(e){
      try{console.log('[ll-editor] text mousedown',id,el.tagName)}catch(_){}
      el.setAttribute('contenteditable','true');
      // Alguns navegadores/CSS bloqueiam foco automático — força
      setTimeout(function(){try{el.focus()}catch(_){}},0);
    },true);
    el.addEventListener('focus',function(){el.setAttribute('contenteditable','true')},true);
    el.addEventListener('blur',function(){
      var newText=(el.textContent||'').trim();
      el.removeAttribute('contenteditable');
      if(newText!==text.trim()){
        window.parent.postMessage({type:'ll-text-edit',id:id,newText:newText},'*');
      }
    },true);
    // Enter: bloqueado em tags inline; permitido em P/DIV mas apenas como quebra simples
    el.addEventListener('keydown',function(e){
      if(e.key==='Enter'){
        if(el.tagName!=='P'&&el.tagName!=='DIV'){e.preventDefault()}
      }
      // Escape: cancela edição
      if(e.key==='Escape'){el.blur();e.preventDefault()}
    },true);
    // Paste sanitizado: só plaintext
    el.addEventListener('paste',function(e){
      e.preventDefault();
      var t=(e.clipboardData||window.clipboardData).getData('text/plain');
      document.execCommand('insertText',false,t);
    },true);
  }
  function markImage(el){
    if(el.__llBound)return;
    el.__llBound=true;
    var id=el.getAttribute('data-ll-eid');
    el.setAttribute('data-ll-original-src',el.src);
    var ov=document.createElement('span');
    ov.className='ll-img-overlay';
    ov.textContent='Clique para trocar';
    // wrap: só funciona se img for elemento block/inline-block. Como injectamos
    // dentro de um span filho, o overlay usa position:absolute em relação ao pai.
    // Se o pai não tem position, sobe pra offsetParent. Simplificamos: envolvemos
    // com wrapper apenas se o parent não tiver position estabelecida.
    var parent=el.parentElement;
    if(parent&&getComputedStyle(parent).position==='static'){
      // Cria wrapper inline-block preservando dimensões
      var wrap=document.createElement('span');
      wrap.className='ll-img-wrap';
      wrap.style.position='relative';
      wrap.style.display='inline-block';
      wrap.style.lineHeight='0';
      parent.insertBefore(wrap,el);
      wrap.appendChild(el);
      wrap.appendChild(ov);
    }else if(parent){
      parent.style.position=parent.style.position||'relative';
      parent.appendChild(ov);
    }
    el.addEventListener('click',function(e){
      e.stopPropagation();e.preventDefault();
      try{console.log('[ll-editor] image click',id,el.src.slice(0,80))}catch(_){}
      window.parent.postMessage({type:'ll-image-click',id:id,currentSrc:el.src},'*');
    },true);
  }
  function scan(){
    var restored=restore();
    var texts=document.querySelectorAll('[data-ll-eid][data-ll-kind="text"]');
    for(var i=0;i<texts.length;i++)markText(texts[i]);
    var imgs=document.querySelectorAll('img[data-ll-eid][data-ll-kind="image"]');
    for(var j=0;j<imgs.length;j++)markImage(imgs[j]);
    try{console.log('[ll-editor] scan: text='+texts.length+' images='+imgs.length+' restored='+restored)}catch(e){}
    // Badge visual mostrando total encontrado
    try{
      var badge=document.getElementById('ll-editor-badge');
      if(!badge){badge=document.createElement('div');badge.id='ll-editor-badge';document.body.appendChild(badge)}
      var txt='✏️ '+texts.length+' textos · 🖼 '+imgs.length+' imagens editáveis';
      if(badge.textContent!==txt)badge.textContent=txt;
    }catch(e){}
  }
  // Scripts da landing redesenham blocos depois do load: remarca com debounce.
  var timer=null;
  function watch(){
    if(!window.MutationObserver)return;
    new MutationObserver(function(){if(timer)return;timer=setTimeout(function(){timer=null;scan()},300)})
      .observe(document.body,{childList:true,subtree:true});
  }
  // Bloqueia navegação de <a> — sempre preventDefault (não deve navegar dentro
  // do editor), mas SEM stopPropagation pra que mousedown/focus dos elementos
  // editáveis dentro do <a> ainda cheguem. Se o <a> ele mesmo é editável, o
  // handler de mousedown dele já vai ativar contenteditable primeiro.
  document.addEventListener('click',function(e){
    var t=e.target;
    var a=t&&t.closest?t.closest('a'):null;
    if(a){e.preventDefault()}
  },false);
  // Também bloqueia submit de forms (caso <a> caia dentro)
  document.addEventListener('submit',function(e){e.preventDefault()},true);
  // Preview de imagem: parent manda { type:'ll-image-preview', id, newSrc }
  window.addEventListener('message',function(ev){
    var d=ev.data;
    if(!d||d.type!=='ll-image-preview')return;
    var img=document.querySelector('img[data-ll-eid="'+d.id+'"]');
    if(img&&d.newSrc)img.src=d.newSrc;
  });
  if(document.readyState==='loading'){
    document.addEventListener('DOMContentLoaded',function(){scan();watch();window.parent.postMessage({type:'ll-editor-ready'},'*')});
  }else{
    scan();watch();window.parent.postMessage({type:'ll-editor-ready'},'*');
  }
})();
</script>
${TARGET_OVERLAY_HTML}`;
}
