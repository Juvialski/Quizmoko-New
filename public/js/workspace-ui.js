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
  const create = document.querySelector('#create.create-workspace');
  if (generator && create) {
    const host = create.querySelector('#create-panels');
    const manual = document.getElementById('createBlankModal');
    host.append(generator, manual);
    const library = [document.getElementById('quiz-library-intro'), document.querySelector('.dashboard-container.teacher-view')];
    const navigation = [...create.querySelectorAll('[data-create-method]')];
    let worksheet, resizeWorksheet;
    const markNavigation = creating => {
      header?.querySelectorAll('.qm-main-nav a').forEach(link => {
        const current = creating ? link.hash === '#create' : link.getAttribute('href') === '/';
        if (current) link.setAttribute('aria-current', 'page'); else link.removeAttribute('aria-current');
      });
    };
    const showLibrary = () => {
      create.hidden = true;
      library.forEach(el => { if (el) el.hidden = false; });
      launch?.setAttribute('aria-expanded', 'false');
      markNavigation(false);
    };
    const select = (method, focus = false) => {
      if (!['ai', 'manual', 'worksheet'].includes(method)) method = 'ai';
      create.hidden = false;
      library.forEach(el => { if (el) el.hidden = true; });
      generator.hidden = method !== 'ai';
      manual.hidden = method !== 'manual';
      launch?.setAttribute('aria-expanded', String(method === 'ai'));
      navigation.forEach(link => {
        if (link.dataset.createMethod === method) link.setAttribute('aria-current', 'page'); else link.removeAttribute('aria-current');
      });
      markNavigation(true);
      if (method === 'worksheet' && !worksheet) {
        worksheet = document.createElement('iframe');
        worksheet.id = 'create-worksheet'; worksheet.className = 'create-worksheet-frame';
        worksheet.title = 'Create quiz from a worksheet'; worksheet.dataset.createWorksheet = '';
        worksheet.src = '/worksheet';
        worksheet.addEventListener('load', () => {
          const url = new URL(worksheet.contentWindow.location.href);
          if (!['/worksheet', '/worksheet_upload', '/worksheet_answers', '/rmxflash'].includes(url.pathname)) {
            location.assign(url.href); return;
          }
          const child = worksheet.contentWindow;
          const syncTheme = () => {
            if (child.document.documentElement.dataset.theme !== document.documentElement.dataset.theme) child.toggleTheme?.();
          };
          resizeWorksheet = () => {
            if (worksheet.hidden || create.hidden) return;
            const height = Math.ceil(child.document.body.getBoundingClientRect().height);
            if (height && worksheet.style.height !== `${height}px`) worksheet.style.height = `${height}px`;
            const top = worksheet.getBoundingClientRect().top;
            const style = child.document.documentElement.style;
            style.setProperty('--studio-modal-top', `${Math.max(0, -top)}px`);
            style.setProperty('--studio-modal-height', `${Math.max(0, Math.min(height, innerHeight - Math.max(0, top)))}px`);
          };
          const observer = new ResizeObserver(resizeWorksheet);
          observer.observe(child.document.body);
          window.addEventListener('themechanged', syncTheme);
          window.addEventListener('scroll', resizeWorksheet, {passive:true});
          window.addEventListener('resize', resizeWorksheet);
          window.addEventListener('pagehide', () => {
            observer.disconnect();
            window.removeEventListener('themechanged', syncTheme);
            window.removeEventListener('scroll', resizeWorksheet);
            window.removeEventListener('resize', resizeWorksheet);
          }, {once:true});
          syncTheme(); resizeWorksheet();
        });
        host.append(worksheet);
      }
      if (worksheet) {
        worksheet.hidden = method !== 'worksheet';
        resizeWorksheet?.();
        worksheet.contentWindow?.dispatchEvent(new Event('resize'));
      }
      if (focus) {
        scrollTo({top:0, behavior:'instant'});
        const target = method === 'ai' ? document.getElementById('topic-input') : method === 'manual' ? document.getElementById('blank-quiz-title') : navigation[2];
        target?.focus({preventScroll:true});
      }
    };
    const navigate = (method, focus = false) => {
      if (location.hash !== `#create/${method}`) history.pushState(null, '', `#create/${method}`);
      select(method, focus);
    };
    const returnLibrary = () => {
      history.pushState(null, '', location.pathname + location.search);
      showLibrary(); launch?.focus({preventScroll:true}); scrollTo(0, 0);
    };
    const restore = () => {
      if (location.hash === '#ai-generator-card' || location.hash === '#create') select('ai', true);
      else if (location.hash.startsWith('#create/')) select(location.hash.slice(8), true);
      else showLibrary();
    };
    window.quizCreateWorkspace = {select:navigate, library:returnLibrary};
    navigation.forEach(link => link.addEventListener('click', event => {
      if (event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
      event.preventDefault(); navigate(link.dataset.createMethod);
    }));
    document.querySelector('.create-option[href="/#create/worksheet"]')?.addEventListener('click', event => {
      if (event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
      event.preventDefault(); navigate('worksheet', true);
    });
    launch?.addEventListener('click', () => navigate('ai', true));
    create.querySelector('[data-return-library]')?.addEventListener('click', event => { event.preventDefault(); returnLibrary(); });
    header?.querySelectorAll('.qm-main-nav a[href="/"], .qm-brand[href="/"]').forEach(link => link.addEventListener('click', event => {
      if (event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
      event.preventDefault(); returnLibrary();
    }));
    window.addEventListener('hashchange', restore);
    window.addEventListener('popstate', restore);
    restore();
    // Native fragment focus runs after DOMContentLoaded on a fresh retry link.
    if (location.hash === '#ai-generator-card') window.addEventListener('load', () => requestAnimationFrame(() => document.getElementById('topic-input')?.focus({preventScroll:true})), {once:true});
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
