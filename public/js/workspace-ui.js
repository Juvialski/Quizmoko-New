/* Shared presentation and navigation. Existing forms own their data and requests. */
document.addEventListener('DOMContentLoaded', () => {
  const header = document.querySelector('.qm-app-header');
  const legacy = document.querySelector('[data-legacy-header]');
  if (header && legacy) {
    const actions = legacy.querySelector('.header-nav-actions');
    if (actions) {
      actions.querySelector('[data-theme-toggle]')?.remove();
      header.querySelector('.qm-header-actions').prepend(...actions.children);
    }
    legacy.hidden = true;
  }
  const generator = document.getElementById('ai-generator-card');
  const launch = document.querySelector('[data-open-generator]');
  function showGenerator() {
    if (!generator) return;
    generator.hidden = false;
    launch?.setAttribute('aria-expanded', 'true');
    generator.scrollIntoView({block:'start', behavior:matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth'});
    document.getElementById('topic-input')?.focus({preventScroll:true});
  }
  launch?.addEventListener('click', showGenerator);
  document.querySelector('[data-close-generator]')?.addEventListener('click', () => {
    generator.hidden = true;
    launch?.setAttribute('aria-expanded', 'false');
    launch?.focus();
  });
  if (location.hash === '#ai-generator-card') {
    showGenerator();
    // Native fragment focus runs after DOMContentLoaded on a fresh page.
    window.addEventListener('load',()=>requestAnimationFrame(()=>document.getElementById('topic-input')?.focus({preventScroll:true})),{once:true});
  }
  // The classroom table keeps its real columns and handlers; each row is a
  // labelled list on narrow screens, so no information is hidden offscreen.
  const table = document.getElementById('live-table');
  if (table) {
    const labels = [...table.querySelectorAll('thead th')].map(el => el.textContent.trim());
    const labelRows = () => table.querySelectorAll('tbody tr').forEach(row => {
      row.querySelectorAll('td').forEach((cell, index) => {
        if (!cell.colSpan || cell.colSpan === 1) cell.dataset.label = labels[index] || '';
      });
    });
    labelRows();
    new MutationObserver(labelRows).observe(table.querySelector('tbody'), {childList:true, subtree:true});
  }
  document.querySelectorAll('.r4-results table').forEach(table => {
    table.classList.add('qm-results-table');
    const labels=[...table.querySelectorAll('thead th')].map(el=>el.textContent.trim());
    table.querySelectorAll('tbody>tr:not(.details-row)').forEach(row=>{
      [...row.children].forEach((cell,index)=>{if(cell.colSpan===1)cell.dataset.label=labels[index] || '';});
    });
  });
  document.querySelectorAll('time[data-local-date]').forEach(el=>{
    const date=new Date(el.dateTime);
    if(!Number.isNaN(date.getTime()))el.textContent=new Intl.DateTimeFormat(undefined,{dateStyle:'medium',timeStyle:'short'}).format(date);
  });
});
