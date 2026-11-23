'use strict';

// The site's Copy action receives its Markdown before it is rendered.
// Run in the page world so the synchronous write can be captured locally.
(() => {
  let capturingReply = false;
  function captureReply(event) {
    const row = event.target;
    const messages = document.querySelectorAll('[data-agent-transcript-message="true"][id^="chat-message-"]');
    if (capturingReply || typeof event.detail !== 'string' || !/^[a-f0-9-]{36}$/.test(event.detail) ||
        !(row instanceof HTMLElement) || !Array.from(messages).includes(row) ||
        event.type === 'arena-harness-read-reply' && row !== messages[messages.length - 1] ||
        row.id !== 'chat-message-' + row.dataset.chatMessageId) return;
    const identities = [row.id,row.dataset.chatMessageId,row.dataset.messageId].filter(Boolean).map(CSS.escape);
    if (document.querySelectorAll(identities.map(id => '#'+id+',[data-chat-message-id="'+id+'"],[data-message-id="'+id+'"]').join(',')).length !== 1) return;
    const buttons = row.querySelectorAll(':scope > .bg-surface-primary.rounded-xl.border.w-full > .px-3.pb-3 > .mt-3 > div > div > button[aria-label="Copy"]');
    if (buttons.length !== 1 || !buttons[0].checkVisibility({checkOpacity:true,checkVisibilityCSS:true}) ||
        buttons[0].disabled || !navigator.clipboard) return;
    const clipboard = navigator.clipboard;
    const previous = Object.getOwnPropertyDescriptor(clipboard, 'writeText');
    const written = [];
    const restore = () => {
      if (previous) Object.defineProperty(clipboard, 'writeText', previous);
      else delete clipboard.writeText;
      capturingReply = false;
    };
    try {
      Object.defineProperty(clipboard, 'writeText', {
        configurable:true,
        value:async text => { if (typeof text === 'string') written.push(text); }
      });
    } catch { return; }
    capturingReply = true;
    try {
      buttons[0].click();
    } finally {
      // Only an immediate Copy is a source. Keep the stub through the first
      // microtask if an updated control defers the write instead.
      if (written.length) restore();
      else queueMicrotask(restore);
    }
    if (written.length === 1 && written[0].length <= 180000 && row.isConnected) {
      row.dispatchEvent(new CustomEvent('arena-harness-reply-source', {
        detail:JSON.stringify({nonce:event.detail,source:written[0]})
      }));
    }
  }
  document.addEventListener('arena-harness-read-reply',captureReply);
  document.addEventListener('arena-harness-check-history',captureReply);
})();
