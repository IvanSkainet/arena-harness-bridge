'use strict';

const ArenaNativeQuestions = (() => {
  const stack = '.bg-surface-primary.rounded-xl.border.w-full > .px-3.pb-3 > .flex.flex-col.gap-2';
  const card = 'div.mb-1.flex.flex-col.items-start.overflow-hidden.rounded-md.border.border-border-faint.bg-surface-secondary';
  const excluded = '.prose,.markdown,pre,code,blockquote,[data-state="closed"],[data-state="open"],[role="dialog"],[role="alertdialog"],form,[contenteditable="true"],.group.items-end,.group.self-end';
  const shown = node => node && !node.closest('[hidden],[inert],[aria-hidden="true"]') &&
    node.checkVisibility({checkOpacity:true,checkVisibilityCSS:true}) && node.getClientRects().length;
  const clean = text => (text || '').trim();

  function find(message, ended) {
    if (!message.id.startsWith('chat-message-')) return null;
    const candidates = Array.from(message.querySelectorAll(stack+' > div[style] > '+card+','+stack+' > '+card))
      .filter(node=>shown(node) && !node.closest(excluded) && node.closest('[id^="chat-message-"]')===message);
    if (candidates.length !== 1) return null;
    const node = candidates[0], [header,group] = node.children;
    if (node.children.length===1 && header.matches('div.flex.w-full.items-center.gap-2.p-3')) {
      const [icon,label,check]=header.children;
      if (header.children.length===3 && icon.matches('svg.text-text-tertiary.shrink-0') &&
          label.matches('span.body-sm.text-text-tertiary.italic') && shown(label) && !label.childElementCount &&
          clean(label.innerText)==='Questions dismissed' && check.matches('svg.text-interactive-positive.shrink-0'))
        return {id:message.id,status:'dismissed',options:[]};
      return null;
    }
    const summary = header?.querySelector(':scope > span.body-sm.text-text-secondary:only-child');
    if (node.children.length===2 && shown(summary) && clean(summary.innerText)==='Summary') {
      const question=group.querySelector(':scope > div.body-base.text-text-tertiary');
      const selected=group.querySelector(':scope > div.flex.items-center > svg.text-interactive-positive + span.body-base.text-text-secondary.font-medium');
      if (shown(question) && shown(selected) && !node.querySelector('button,input,[role="radio"]'))
        return {id:message.id,question:clean(question.innerText),options:[],selected:clean(selected.innerText),summary:true,status:'answered'};
      return null;
    }
    if (node.children.length !== 2 || !header?.matches('div.flex.justify-between.border-b') ||
        !group?.matches('[role="radiogroup"][aria-label]') || !shown(header) || !shown(group)) return null;
    const skip = header.querySelectorAll('button');
    const question = clean(group.getAttribute('aria-label'));
    if (skip.length !== 1 || clean(skip[0].innerText) !== 'Skip' || !shown(skip[0]) ||
        !question || !header.innerText.includes(question)) return null;
    const buttons = Array.from(group.querySelectorAll('[role="radio"]'));
    if (!buttons.length || buttons.some(b=>!b.matches('button[type="button"][aria-checked]') || !shown(b) ||
        b.closest('[role="radiogroup"]')!==group)) return null;
    const custom = group.querySelectorAll('button[aria-label="Submit custom response"]');
    const fields = group.querySelectorAll('input,textarea');
    if (custom.length===0) {
      if (group.children.length!==buttons.length || buttons.some(button=>button.parentElement!==group) || fields.length) return null;
    } else if (custom.length!==1 || fields.length!==1 || !fields[0].matches('input:not([type]),input[type="text"],textarea') ||
        group.querySelectorAll('button').length!==buttons.length+1) return null;
    const wire = {id:message.id,question,options:buttons.map(button=>clean(button.innerText))};
    if (!ArenaBridge.validQuestion(wire)) return null;
    const statuses = Array.from(node.closest(stack).children).filter(el=>
      el.matches('.text-text-primary.rounded-md.border.border-border-faint.my-1') && shown(el));
    const lines = statuses.flatMap(el => el.innerText.split(/\n+/).map(clean));
    const selected = buttons.filter(button=>button.getAttribute('aria-checked')==='true');
    let status = 'active';
    if (lines.some(line=>/^(Question failed|The tool failed\.)$/i.test(line))) status='failed';
    else if (selected.length===1) status='answered';
    else if (statuses.length || selected.length || ended) status='closed';
    else if (buttons.some(button=>button.disabled || button.getAttribute('aria-disabled')==='true' ||
      button.getAttribute('aria-checked')!=='false')) status='loading';
    const draft = Array.from(group.querySelectorAll('input,textarea')).some(field=>field.value);
    return {...wire,status,selected:selected.length===1 ? clean(selected[0].innerText) : null,buttons,draft};
  }

  function describe(q) {
    if (q.status==='dismissed') return 'Questions dismissed';
    const label = {active:'Waiting for a choice',loading:'Question loading',failed:'Question failed',answered:'Question answered',closed:'Question closed'}[q.status];
    return [q.question,...q.options.map(option=>'• '+option),q.selected ? label+' — '+q.selected : label].join('\n');
  }

  const imagePanel = 'div.my-4.rounded-md.border.border-border-faint.bg-surface-primary.p-4';

  function imageButtons(view, index) {
    if (!view?.matches('button[aria-label="View image '+(index+1)+'"]') || !shown(view)) return null;
    const images = view.querySelectorAll(':scope > img');
    return images.length===1 ? images[0] : null;
  }

  function activeImages(panel) {
    const [header, grid] = panel.children;
    const [prompt, skip] = header?.children || [];
    if (panel.children.length!==2 || !shown(prompt) || !prompt.matches('p') ||
        !grid?.matches('div.grid.grid-cols-2') || !shown(grid) || header.children.length>2 ||
        skip && (!shown(skip) || !skip.matches('button[aria-label="Skip image selection"]'))) return null;
    const question=clean(prompt.innerText);
    const images=[], buttons=[], options=[];
    for (const [index, tile] of Array.from(grid.children).entries()) {
      const [view, select] = tile.children;
      const img=imageButtons(view,index);
      if (tile.tagName!=='DIV' || tile.children.length!==2 || !img || !shown(select) ||
          !select.matches('button[type="button"]') || select.childElementCount || clean(select.innerText)!=='Select') return null;
      images.push(img);
      buttons.push(select);
      options.push('Image '+(index+1));
    }
    if (skip) { buttons.push(skip); options.push('Skip'); }
    if (!question || !images.length || images.length>ArenaBridge.maxGeneratedImages ||
        panel.querySelectorAll('a,button,input,textarea,[role="button"]').length!==images.length+buttons.length) return null;
    const sources=images.map(ArenaGeneratedImages.source);
    if (images.some((img,index)=>(img.currentSrc || img.getAttribute('src')) && !sources[index]) ||
        new Set(sources.filter(Boolean)).size!==sources.filter(Boolean).length) return null;
    const ready=sources.every(Boolean) && images.every(img=>shown(img) && img.complete && img.naturalWidth && img.naturalHeight) &&
      buttons.every(button=>!button.disabled && button.getAttribute('aria-disabled')!=='true');
    return {question,options,images,sources,buttons,status:ready?'active':'loading'};
  }

  function closedImages(panel) {
    const [header, body, footer] = panel.children;
    if (panel.children.length===3 &&
        clean(header.querySelector(':scope > span')?.innerText)==='Image generated by' &&
        clean(footer.querySelector(':scope > span')?.innerText)==='You selected this image' &&
        body.matches('button[aria-label="Open in viewer"]')) {
      const img=body.querySelector(':scope > img[alt="Selected image"]');
      const source=img && ArenaGeneratedImages.source(img);
      return source ? {status:'selected',sources:[source]} : null;
    }
    if (panel.children.length!==2 || clean(header.querySelector(':scope > span')?.innerText)!=='No image selected') return null;
    const sources=Array.from(body.children, (view,index) => {
      const img=imageButtons(view,index);
      return img ? ArenaGeneratedImages.source(img) : '';
    });
    return sources.length && sources.every(Boolean) ? {status:'skipped',sources} : null;
  }

  function findImageChoices(message) {
    if (!message.id.startsWith('chat-message-')) return [];
    const containers=message.querySelectorAll(':scope > '+stack);
    if (containers.length!==1) return [];
    const choices=[];
    for (const panel of containers[0].children) {
      if (!shown(panel)) continue;
      const card=panel.matches(imagePanel) && panel.querySelector('button[aria-label^="View image "]')
        ? activeImages(panel) || {status:'invalid'} : panel.matches('div.my-2') ? closedImages(panel) : null;
      if (card) choices.push({...card,id:message.id+'/image-choice/'+(choices.length+1)});
    }
    return choices;
  }

  return {find,describe,findImageChoices};
})();
