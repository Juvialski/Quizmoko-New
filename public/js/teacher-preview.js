// Stored/source HTML is untrusted. Build a closed, inert display subset.
(() => {
  'use strict';
  const tags = new Set(['DIV','P','SPAN','B','STRONG','EM','I','U','BR','SUB','SUP','OL','UL','LI','TABLE','THEAD','TBODY','TR','TD','TH','IMG']);
  function safeImage(value) {
    if (/^data:image\/(?:png|jpeg|webp|gif);base64,[a-z0-9+/=\s]+$/i.test(value)) return value;
    try { const url = new URL(value); return url.protocol === 'https:' && !url.username && !url.password ? url.href : ''; }
    catch { return ''; }
  }
  function copy(node) {
    if (node.nodeType === Node.TEXT_NODE) return document.createTextNode(node.textContent);
    if (node.nodeType !== Node.ELEMENT_NODE || !tags.has(node.tagName)) return document.createTextNode('');
    const el = document.createElement(node.tagName.toLowerCase());
    if (node.tagName === 'IMG') {
      const src = safeImage(node.getAttribute('src') || '');
      if (!src) return document.createTextNode('[Image unavailable in preview]');
      el.src = src; el.alt = node.getAttribute('alt') || 'Question diagram';
      const width = (node.getAttribute('style') || '').match(/(?:^|;)\s*width:\s*(\d+(?:\.\d+)?)(%|px)/i);
      if (width) el.style.width = Math.min(Number(width[1]),width[2] === '%' ? 100 : 1600) + width[2];
    }
    for (const child of node.childNodes) el.appendChild(copy(child));
    return el;
  }
  document.querySelectorAll('[data-preview-html]').forEach(target => {
    const template = document.createElement('template');
    template.innerHTML = target.getAttribute('data-preview-html');
    for (const child of template.content.childNodes) target.appendChild(copy(child));
    target.removeAttribute('data-preview-html');
  });
  window.QuizMoKoMath?.typeset(document.querySelector('main'));
})();
