// Methods deliberately use `this` so Vue's reactive proxy sees async updates.
export function createPager(fetchPage,key=item=>item.id||item.line_id){
  return {items:[],total:null,loading:false,error:'',hasMore:true,cursor:null,args:{},generation:0,controller:null,loadedAt:0,pending:null,
    reset(args={}){this.controller?.abort();this.generation++;this.args=args;this.items=[];this.total=null;this.cursor=null;this.hasMore=true;this.loading=false;this.error='';this.loadedAt=0;return this.load();},
    load(){
      if(this.loading)return this.pending;
      if(!this.hasMore)return Promise.resolve();
      this.loading=true;this.error='';const generation=this.generation;
      this.controller=new AbortController();
      this.pending=(async()=>{try{
        const page=await fetchPage({...this.args,...(this.cursor?{cursor:this.cursor}:{})},this.controller.signal);
        if(generation!==this.generation)return;
        const seen=new Set(this.items.map(key));this.items.push(...page.items.filter(x=>{const id=key(x);if(seen.has(id))return false;seen.add(id);return true;}));
        this.total=page.matched_count;this.cursor=page.next_cursor;this.hasMore=page.has_more;this.loadedAt=Date.now();
      }catch(e){if(generation===this.generation&&e.name!=='AbortError')this.error=e.message;}
      finally{if(generation===this.generation){this.loading=false;this.pending=null;}}
      })();return this.pending;
    },
    dispose(){this.controller?.abort();this.generation++;},
  };
}
