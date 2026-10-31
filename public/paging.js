// Methods deliberately use `this` so Vue's reactive proxy sees async updates.
export function createPager(fetchPage,key=item=>item.id||item.line_id,peek=null){
  return {items:[],total:null,loading:false,error:'',hasMore:true,cursor:null,args:{},generation:0,controller:null,loadedAt:0,pending:null,preview:false,
    reset(args={}){this.controller?.abort();this.generation++;this.args=args;this.items=[];this.total=null;this.cursor=null;this.hasMore=true;this.loading=false;this.error='';this.loadedAt=0;this.preview=false;return this.load();},
    load(){
      if(this.loading)return this.pending;
      if(!this.hasMore&&!this.preview)return Promise.resolve();
      this.loading=true;this.error='';const generation=this.generation;
      const cursor=this.cursor,replace=!this.items.length||this.preview;
      this.controller=new AbortController();
      this.pending=(async()=>{try{
        // Display the cached page at once with a loading state; the network
        // page that follows completes it, an offline failure keeps it.
        if(peek&&!this.items.length){
          try{
            const cached=await peek({...this.args,...(cursor?{cursor}:{})});
            if(generation!==this.generation)return;
            if(cached&&Array.isArray(cached.items)){
              const seen=new Set(this.items.map(key));
              this.items.push(...cached.items.filter(x=>{const id=key(x);if(seen.has(id))return false;seen.add(id);return true;}));
              this.preview=true;
              if(cached.matched_count!=null)this.total=cached.matched_count;
              if(typeof cached.has_more==='boolean')this.hasMore=cached.has_more;
            }
          }catch{}
          if(generation!==this.generation)return;
        }
        const page=await fetchPage({...this.args,...(cursor?{cursor}:{})},this.controller.signal);
        if(generation!==this.generation)return;
        if(replace)this.items=[];
        this.preview=false;
        const seen=new Set(this.items.map(key));this.items.push(...page.items.filter(x=>{const id=key(x);if(seen.has(id))return false;seen.add(id);return true;}));
        this.total=page.matched_count;this.cursor=page.next_cursor;this.hasMore=page.has_more;this.loadedAt=Date.now();
      }catch(e){if(generation===this.generation&&e.name!=='AbortError')this.error=e.message;}
      finally{if(generation===this.generation){this.loading=false;this.pending=null;}}
      })();return this.pending;
    },
    dispose(){this.controller?.abort();this.generation++;},
  };
}
