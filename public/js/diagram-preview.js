/* Transient image rendering only. Never writes question or approval metadata. */
(() => {
  window.QuizMoKoDiagramPreview = {
    watch(image, onState) {
      let disposed=false, observer, timer, state='waiting', version=0, source=image.src;
      const emit=(next,message='')=>{if(disposed)return;state=next;image.dataset.renderState=next;onState(next,message);};
      const fail=()=>{if(state==='failed'||disposed||image.src!==source)return;clearTimeout(timer);emit('failed','Diagram could not be decoded. Check or replace its source before publishing.');};
      const loaded=async()=>{
        if(disposed)return;
        const current=++version;clearTimeout(timer);
        try {
          if(image.decode)await image.decode();
          if(disposed||current!==version||image.src!==source)return;
          if(image.naturalWidth<2||image.naturalHeight<2||image.naturalWidth>10000||image.naturalHeight>10000)return fail();
          emit('decoded');
        }catch{if(current===version)fail();}
      };
      const start=()=>{
        if(disposed||state!=='waiting')return;
        emit('loading');image.loading='eager';
        // A slow transport is not evidence of a corrupt diagram or wrong answer.
        timer=setTimeout(()=>{if(state==='loading')emit('loading','Diagram is still loading. Your saved question is unchanged.');},10000);
        if(image.complete){if(image.naturalWidth)void loaded();else fail();}
      };
      image.addEventListener('load',loaded);image.addEventListener('error',fail);
      const schedule=()=>{
        emit('waiting');
        if(image.complete&&image.naturalWidth)void loaded();
        else if(image.loading==='lazy'&&window.IntersectionObserver){
          observer=new IntersectionObserver(entries=>{if(entries.some(e=>e.isIntersecting)){observer.disconnect();start();}});
          observer.observe(image);
        }else start();
      };
      const sourceObserver=new MutationObserver(()=>{
        if(disposed||image.src===source)return;
        source=image.src;version++;clearTimeout(timer);observer?.disconnect();schedule();
      });
      sourceObserver.observe(image,{attributes:true,attributeFilter:['src']});schedule();
      return ()=>{disposed=true;version++;clearTimeout(timer);observer?.disconnect();sourceObserver.disconnect();image.removeEventListener('load',loaded);image.removeEventListener('error',fail);};
    }
  };
})();
