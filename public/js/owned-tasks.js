(function () {
  let area, pending = false;
  let latestJobs=[];
  async function key(task, intent) {
    const name = 'qm-task-' + task;
    const safe = JSON.stringify(intent || {}, (field,value)=>/api.?key|token|authorization|credential|password|secret/i.test(field)?undefined:value);
    const digest = await crypto.subtle.digest('SHA-256',new TextEncoder().encode(safe));
    const fingerprint = Array.from(new Uint8Array(digest),b=>b.toString(16).padStart(2,'0')).join('');
    let prior;
    try { prior=JSON.parse(sessionStorage.getItem(name) || 'null'); } catch { prior=null; }
    if (!prior || prior.fingerprint!==fingerprint) {
      prior={key:crypto.randomUUID(),fingerprint};sessionStorage.setItem(name,JSON.stringify(prior));
    }
    return prior.key;
  }
  async function refresh() {
    if (pending || !area) return;
    pending = true;
    try {
      const response = await fetch('/api/tasks',{cache:'no-store'});
      if (!response.ok) return;
      const { jobs } = await response.json();
      if (!Array.isArray(jobs)) return;
      latestJobs=jobs;window.dispatchEvent(new CustomEvent('qm-tasks-updated',{detail:jobs}));
      area.replaceChildren();
      area.hidden = jobs.length === 0;
      const seen=new Set();
      const listed=jobs.filter(job=>{
        if(document.getElementById('worksheet-solve-progress') && job.task==='worksheet_solving')return false;
        const identity=job.status==='running'?job.id:(job.quiz_id || job.id);
        if(seen.has(identity))return false;seen.add(identity);return true;
      });
      area.hidden=listed.length===0;
      for (const job of listed.slice(0,5)) {
        const row = document.createElement('div');
        const label = document.createElement('span');
        const published=job.status!=='running' && job.quiz_state==='published';
        label.textContent = published ? `${job.label}: finished. Saved quiz is Published. ` : `${job.label}: ${job.status==='needs_attention'?'finished with review items':job.status.replaceAll('_',' ')}${job.total ? ` (${job.completed}/${job.total})` : ''}. `;
        row.append(label);
        if (job.quiz_id && job.quiz_state !== null && job.status !== 'running') {
          const link = document.createElement('a');
          link.href = '/edit/' + encodeURIComponent(job.quiz_id);
          link.textContent = published ? 'Open quiz' : 'Open draft';
          row.append(link);
        }
        if (['completed','needs_attention','failed','interrupted'].includes(job.status)) {
          const again=document.createElement('button');again.type='button';again.className='btn-secondary';again.textContent='Start another';
          again.onclick=()=>{sessionStorage.removeItem('qm-task-'+job.task);again.textContent='Ready for a new task';again.disabled=true;};row.append(again);
        }
        if (job.error && !published) { const message = document.createElement('p'); message.textContent=job.error; row.append(message); }
        if (['failed','interrupted'].includes(job.status) && !published) {
          const retry=document.createElement('a');retry.href=job.task==='generation'?'/#ai-generator-card':'/worksheet';retry.textContent='Review inputs & retry';row.append(retry);
        }
        area.append(row);
      }
    } catch { /* Retain the last known task list during connectivity loss. */ }
    finally { pending=false; }
  }
  window.QuizMoKoTasks = { key, accepted(task, job) { if(job){latestJobs=[job,...latestJobs.filter(j=>j.id!==job.id)];window.dispatchEvent(new CustomEvent('qm-tasks-updated',{detail:latestJobs}));} refresh(); }, refresh };
  document.addEventListener('DOMContentLoaded',()=>{
    area=document.createElement('section'); area.className='qm-owned-tasks'; area.hidden=true;
    area.setAttribute('aria-label','Your AI tasks'); area.setAttribute('aria-live','polite');
    document.body.prepend(area); refresh(); setInterval(refresh,3000);
  });
  window.addEventListener('pageshow',refresh);
})();
