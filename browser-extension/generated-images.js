'use strict';

const ArenaGeneratedImages = (() => {
  const cardSelector = '.bg-surface-primary.rounded-xl.border.w-full > .px-3.pb-3 > .flex.flex-col.gap-2 > div.my-1';
  const exclude = '.prose,.markdown,pre,code,blockquote,[contenteditable="true"],.chat-user,.group.items-end,.group.self-end';
  const maxBytes = 8 * 1024 ** 2;
  const loading = new WeakMap();

  function source(img) {
    const value = img.currentSrc || img.getAttribute('src');
    if (!value) return '';
    let url;
    try { url = new URL(value,img.ownerDocument.baseURI); } catch { return ''; }
    if (!['https:','blob:'].includes(url.protocol) || url.origin !== img.ownerDocument.location.origin || url.username || url.password) return '';
    return url.href;
  }

  function displayed(el) {
    return !el.closest('[hidden],[aria-hidden="true"],[inert]') &&
      el.checkVisibility({opacityProperty:true,visibilityProperty:true,contentVisibilityAuto:false});
  }

  function visibleHeader(el) {
    if (!displayed(el)) return false;
    const bounds = el.getBoundingClientRect();
    return bounds.width > 0 && bounds.height > 0;
  }

  function find(message, previous) {
    if (!message.id.startsWith('chat-message-')) return null;
    const cards = [];
    let generating = false;
    for (const card of message.querySelectorAll(cardSelector)) {
      if (card.closest(exclude) || card.closest('[id^="chat-message-"]') !== message || !displayed(card)) continue;
      const header = card.firstElementChild;
      const labels = header?.querySelectorAll(':scope > span');
      if (!header?.matches('div.body-sm') || !header.querySelector(':scope > svg') ||
          labels.length !== 1 || !visibleHeader(labels[0])) continue;
      const label = labels[0].textContent.trim();
      if (label === 'Generated image') cards.push(card);
      else if (['Generating image','Image generation'].includes(label)) {
        const status = card.getAttribute('data-status') || card.getAttribute('data-state');
        if (['failed','error'].includes(status)) return {error:'Arena reported a failed image generation in this reply.'};
        if (card.getAttribute('aria-busy') !== 'false' && !['complete','completed','success','succeeded','done'].includes(status)) generating = true;
      }
    }
    if (!cards.length) return generating ? {pending:true,progressOnly:true} : null;
    if (cards.length > ArenaBridge.maxGeneratedImages) return {error:'Arena returned more than 20 generated images.'};
    const images = [], sources = [];
    let pending = generating;
    for (const card of cards) {
      const viewers = card.querySelectorAll(':scope > button[aria-label="Open in viewer"]');
      const pictures = viewers[0]?.querySelectorAll(':scope > img');
      if (!viewers.length || !pictures?.length) { pending = true; continue; }
      if (viewers.length !== 1 || pictures.length !== 1) return {error:'Ambiguous Arena generated image card.'};
      const img = pictures[0];
      if (!displayed(img) || (!img.currentSrc && !img.getAttribute('src'))) { pending = true; continue; }
      const url = source(img);
      if (!url) return {error:'Arena generated image is outside the readable conversation origin.'};
      if (img.hasAttribute('srcset') && !img.currentSrc) return {error:'Arena has not selected a verifiable native image source.'};
      if (previous.has(url) || sources.includes(url)) return {error:'Arena reused an earlier image resource. Its generated origin is ambiguous.'};
      if (!img.complete || !img.naturalWidth || !img.naturalHeight) pending = true;
      else if (img.naturalWidth < 16 || img.naturalHeight < 16) return {error:'Arena generated image is too small to verify as an artwork.'};
      else if (!visibleHeader(img)) { pending = true; continue; }
      images.push(img);
      sources.push(url);
    }
    return {pending,images,sources};
  }

  function activate(artifact) {
    for (const [index,img] of artifact.images.entries()) {
      const url = artifact.sources[index];
      if (!img.isConnected || source(img) !== url || !displayed(img)) continue;
      const current = loading.get(img);
      if (current?.url === url) {
        if (current.failed) throw Error('Arena could not load the native generated image. Inspect its viewer and reconnect.');
        continue;
      }
      const request = {url,failed:false};
      loading.set(img,request);
      img.loading = 'eager';
      img.decode().catch(() => {
        if (source(img) === url && img.complete && !img.naturalWidth) request.failed = true;
      });
    }
  }

  async function pixels(img, allowance) {
    const canvas = img.ownerDocument.createElement('canvas');
    try {
      for (const [area, type] of [[4*1024**2,'image/png'],[4*1024**2,'image/webp'],[Math.floor(allowance/5),'image/png']]) {
        const scale = Math.min(1,Math.sqrt(area/(img.naturalWidth*img.naturalHeight)),4096/Math.max(img.naturalWidth,img.naturalHeight));
        canvas.width = Math.max(1,Math.round(img.naturalWidth*scale));
        canvas.height = Math.max(1,Math.round(img.naturalHeight*scale));
        canvas.getContext('2d').drawImage(img,0,0,canvas.width,canvas.height);
        const blob = await new Promise(resolve=>canvas.toBlob(resolve,type,0.9));
        if (!blob || !blob.size || blob.size > allowance) continue;
        const data = await new Promise((resolve,reject) => {
          const reader=new FileReader();
          reader.onload=()=>resolve(reader.result.slice(reader.result.indexOf(',')+1));
          reader.onerror=()=>reject(Error('Could not encode the generated image.'));
          reader.readAsDataURL(blob);
        });
        return {mediaType:blob.type,data};
      }
      throw Error('Arena generated image exceeds the transfer limit.');
    } finally { canvas.width=canvas.height=1; }
  }

  async function encode(artifact) {
    if (!artifact.images?.length || artifact.images.length > ArenaBridge.maxGeneratedImages) throw Error('Invalid generated image selection.');
    const wire=[];
    for (let i=0;i<artifact.images.length;i++) {
      const img=artifact.images[i];
      if (!img.isConnected || source(img)!==artifact.sources[i]) throw Error('Arena generated image changed before capture.');
      wire.push(await pixels(img,Math.floor(maxBytes/artifact.images.length)));
    }
    return wire;
  }
  return {find,source,activate,encode};
})();
