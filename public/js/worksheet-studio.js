/* One workspace, retained mode documents. Provider and persistence code stays in its existing mode. */
document.addEventListener('DOMContentLoaded', () => {
  const modes = [
    {path:'/worksheet', label:'Worksheet Only', description:'Turn worksheet images or PDFs into an editable quiz.'},
    {path:'/worksheet_answers', label:'Worksheet + Answer Key', description:'Upload questions and a key, then review the matched answers.'},
    {path:'/rmxflash', label:'RMX Flash', description:'Extract contest questions with RMX metadata and spreadsheet export.'}
  ];
  const initial = location.pathname === '/worksheet_upload' ? 0 : modes.findIndex(m => m.path === location.pathname);
  if (initial < 0) return;
  document.body.classList.add('studio-mode');
  const embedded = window.parent !== window;
  if (embedded) { document.body.classList.add('studio-embedded'); return; }
  const content = document.querySelector('.dashboard-container');
  if (!content) return;
  const workspace = document.createElement('section');
  workspace.className = 'studio-workspace';
  workspace.innerHTML = `<header class="studio-heading"><div><h1>Worksheet Studio</h1><p id="studio-description"></p></div><a class="btn-secondary" href="/">My Quizzes</a></header><div class="studio-tabs" role="tablist" aria-label="Worksheet mode"></div><p class="studio-retention">Files and edits stay in each mode while this page is open.</p><ol class="studio-steps" aria-label="Worksheet progress"><li>Upload</li><li>Extract</li><li>Review</li><li>Check answers</li><li>Create draft</li></ol><p id="studio-status" role="status" aria-live="polite"></p>`;
  content.before(workspace);
  content.id ||= 'studio-original-panel';
  content.setAttribute('role','tabpanel');
  const tabs = workspace.querySelector('.studio-tabs');
  const panels = new Map([[initial,content]]);
  let active = initial;
  let changed = false;
  const dirty = () => { changed = true; };
  document.addEventListener('input',dirty);
  document.addEventListener('change',dirty);
  function syncTheme(panel) {
    if (panel.tagName !== 'IFRAME' || !panel.contentDocument) return;
    const theme = document.documentElement.getAttribute('data-theme');
    const child = panel.contentWindow;
    if (child.document.documentElement.getAttribute('data-theme') !== theme && child.toggleTheme) child.toggleTheme();
  }
  function observe(panel) {
    const doc = panel.tagName === 'IFRAME' ? panel.contentDocument : document;
    if (!doc) return;
    const update = () => {
      if (panels.get(active) !== panel) return;
      const visible = el => el && !el.hidden && doc.defaultView.getComputedStyle(el).display !== 'none';
      const processing = visible(doc.getElementById('progress-overlay'));
      const review = visible(doc.getElementById('extraction-preview')) || visible(doc.getElementById('results-card'));
      const task = doc.getElementById('worksheet-solve-progress');
      const checking = doc.getElementById('solve-btn')?.disabled && visible(task);
      const draftReady = visible(task) && task.querySelector('a[href^="/edit/"]');
      const hasFiles = [...doc.querySelectorAll('input[type=file]')].some(el => el.files.length);
      const step = draftReady ? 4 : checking ? 3 : processing ? (review ? 3 : 1) : review ? 2 : hasFiles ? 1 : 0;
      workspace.querySelectorAll('.studio-steps li').forEach((el,i) => {
        el.classList.toggle('complete',i<step);el.classList.toggle('current',i===step);
        if(i===step)el.setAttribute('aria-current','step');else el.removeAttribute('aria-current');
      });
      const text = checking || draftReady ? task.textContent : processing ? (doc.getElementById('progress-text')?.textContent || 'Processing your files…') : review ? 'Review the questions below, then check answers or export your RMX file.' : hasFiles ? 'Files ready. Select Extract to continue.' : 'Upload files to begin.';
      const status = workspace.querySelector('#studio-status');
      if(status.textContent !== text)status.textContent=text;
    };
    const observer = new MutationObserver(update);
    observer.observe(doc.querySelector('.dashboard-container') || doc.body,{subtree:true,childList:true,attributes:true,attributeFilter:['style','hidden','disabled']});
    doc.addEventListener('change',()=>{dirty();update();});doc.addEventListener('input',dirty);
    window.addEventListener('pagehide',()=>observer.disconnect(),{once:true});
    update();panel.studioUpdate=update;
  }
  function select(index,focus=false) {
    active=index;
    if(!panels.has(index)) {
      const frame=document.createElement('iframe');frame.className='studio-frame';frame.id=`studio-panel-${index}`;
      frame.title=modes[index].label;frame.setAttribute('role','tabpanel');
      frame.src=modes[index].path;
      frame.addEventListener('load',()=>{
        const url=new URL(frame.contentWindow.location.href);
        if(!modes.some(m=>m.path===url.pathname)) { location.assign(url.href);return; }
        syncTheme(frame);observe(frame);
      });
      workspace.after(frame);panels.set(index,frame);
    }
    for(const [key,panel] of panels) { panel.hidden=key!==index;panel.setAttribute('aria-labelledby',`studio-tab-${key}`); }
    [...tabs.children].forEach((tab,i)=>{tab.setAttribute('aria-selected',String(i===index));tab.tabIndex=i===index?0:-1;});
    workspace.querySelector('#studio-description').textContent=modes[index].description;
    workspace.querySelector('.studio-steps li:last-child').textContent=index===2?'Export':'Create draft';
    syncTheme(panels.get(index));panels.get(index).studioUpdate?.();
    if(focus)tabs.children[index].focus();
  }
  modes.forEach((mode,i)=>{
    const tab=document.createElement('button');tab.type='button';tab.id=`studio-tab-${i}`;tab.setAttribute('role','tab');tab.textContent=mode.label;
    tab.setAttribute('aria-controls',i===initial?content.id:`studio-panel-${i}`);
    tab.addEventListener('click',()=>select(i));
    tab.addEventListener('keydown',event=>{
      let next;
      if(event.key==='ArrowRight')next=(i+1)%modes.length;
      if(event.key==='ArrowLeft')next=(i+modes.length-1)%modes.length;
      if(event.key==='Home')next=0;if(event.key==='End')next=modes.length-1;
      if(next!==undefined){event.preventDefault();select(next,true);}
    });tabs.append(tab);
  });
  window.addEventListener('themechanged',()=>panels.forEach(syncTheme));
  window.addEventListener('beforeunload',event=>{if(changed){event.preventDefault();event.returnValue='';}});
  select(initial);observe(content);
});
