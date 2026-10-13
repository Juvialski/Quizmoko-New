/* Shared teacher UI mechanics. No persistence, authorization or AI decisions. */
(() => {
  'use strict';
  const status = question => {
    const v = question?.verification;
    if (v?.verification_status === 'verified') return {label:'Verified', reason:'Answer checked.', action:'Edit Question'};
    const codes = (v?.issues || []).map(issue => String(issue.code || '').toLowerCase());
    if (codes.some(code => /worksheet|extraction|fragment|missing_content/.test(code))) return {label:'Extraction Issue',reason:'Check this question against the original worksheet.',action:'Edit Question'};
    if (codes.some(code => /diagram/.test(code))) return {label:'Diagram Needs Review',reason:'Inspect the diagram and its labels before approving.',action:'Preview Diagram'};
    if (codes.some(code => /wrong|incorrect|contradiction|answer_conflict/.test(code))) return {label:'Incorrect Answer',reason:'Check the answer and choices before approving.',action:'Edit Choices'};
    return {label:'Needs Review',reason:'Check the question and answer, then approve or re-check.',action:'Edit Question'};
  };
  const progressLabel = message => {
    const text = String(message || '').toLowerCase();
    if (/complete|created|ready|redirect/.test(text)) return 'Preparing your draft';
    if (/check|verif|consensus|solv|adjudicat/.test(text)) return 'Checking answers';
    if (/extract|recover|page/.test(text)) return 'Reading your worksheet';
    if (/generat|draft/.test(text)) return 'Generating questions';
    return 'Preparing your quiz';
  };
  window.QuizMoKoTeacher = {status,progressLabel};
  // Label existing legacy controls without changing their handlers or payloads.
  function labelControls(root = document) {
    root.querySelectorAll('input:not([type=hidden]),select,textarea').forEach((control,i) => {
      if (control.getAttribute('aria-label') || control.labels?.length) return;
      const label = control.previousElementSibling;
      const text = label?.tagName === 'LABEL' ? label.textContent.trim() : '';
      control.setAttribute('aria-label', text || control.placeholder || control.name?.replaceAll('_',' ') || control.id?.replaceAll('-',' ') || 'Question field ' + (i+1));
    });
  }
  document.addEventListener('DOMContentLoaded', () => {
    labelControls();
    const observer = new MutationObserver(() => labelControls());
    observer.observe(document.body,{childList:true,subtree:true});
    let previousFocus = null;
    const visibleModal = () => [...document.querySelectorAll('.modal-overlay')].find(el => getComputedStyle(el).display !== 'none');
    new MutationObserver(() => {
      const modal = visibleModal();
      if (modal && modal.dataset.r4Active !== 'true') {
        previousFocus = document.activeElement;
        modal.dataset.r4Active = 'true'; modal.setAttribute('role','dialog'); modal.setAttribute('aria-modal','true');
        if (!modal.getAttribute('aria-labelledby')) modal.setAttribute('aria-label',modal.querySelector('h2,h3')?.textContent || 'Dialog');
        modal.querySelector('input,select,button,a[href]')?.focus();
      } else if (!modal) {
        document.querySelectorAll('[data-r4-active]').forEach(el => delete el.dataset.r4Active);
        if (previousFocus) { previousFocus.focus(); previousFocus = null; }
      }
    }).observe(document.body,{subtree:true,attributes:true,attributeFilter:['style','class']});
    document.addEventListener('keydown', event => {
      const modal = visibleModal();
      if (!modal) return;
      const controls = [...modal.querySelectorAll('button,input,select,textarea,a[href],[tabindex="0"]')].filter(el => !el.disabled && el.getClientRects().length);
      if (event.key === 'Tab' && controls.length) {
        const first = controls[0], last = controls.at(-1);
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
      }
      if (event.key === 'Escape') {
        const close = [...modal.querySelectorAll('button')].find(el => /cancel|close/i.test(el.textContent));
        close?.click();
      }
    });
  });
})();
