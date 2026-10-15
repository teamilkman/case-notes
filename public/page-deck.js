export const MOBILE_QUERY='(max-width:760px), (pointer:coarse) and (max-width:1024px) and (max-height:500px)';
let nextDeckId=0;

// Swiper owns the physical gesture. Vue owns the selected page and its data.
export const pageDeck={
  props:{modelValue:String,items:Array,label:String,desktop:{default:'single'},disabled:Boolean,lazy:Boolean,preload:Boolean,reset:Boolean,contain:Boolean,blockNext:Boolean},
  emits:['update:modelValue','settled'],
  data(){return {deckId:++nextDeckId,mobile:false,ready:false,shown:[Math.max(0,this.items.indexOf(this.modelValue))]};},
  computed:{
    index(){return Math.max(0,this.items.indexOf(this.modelValue));},
    fallbackStyle(){return this.mobile&&!this.ready?{transform:`translate3d(${-this.index*100}%,0,0)`}:null;},
  },
  template:`<div class="page-deck" :class="['desktop-'+desktop,{'is-mobile':mobile}]" :data-deck="deckId" role="group" :aria-label="label" @pointercancel.capture="cancelDrag" @touchcancel.capture="cancelDrag" @touchstart.capture="guardTouches" @pointerdown.capture="guardPointer">
    <div class="swiper-wrapper page-track" :style="fallbackStyle">
      <div v-for="(item,i) in items" :key="item" class="swiper-slide page-panel" :class="{'is-current':i===index}" :inert="mobile&&i!==index" :aria-hidden="mobile&&i!==index?'true':null">
        <slot :item="item" :visible="!lazy||preload||shown.includes(i)" :active="i===index"></slot>
      </div>
    </div>
  </div>`,
  watch:{
    modelValue(){this.sync();},
    items(value,previous){if(value.length!==previous.length||value.some((item,i)=>item!==previous[i]))this.sync();},
    disabled(value){if(this.engine){this.engine.params.allowTouchMove=!value;this.engine.allowTouchMove=!value;}},
    blockNext(value){if(this.engine){this.engine.params.allowSlideNext=!value;this.engine.allowSlideNext=!value;}},
  },
  mounted(){
    this.media=window.matchMedia(MOBILE_QUERY);this.motion=window.matchMedia('(prefers-reduced-motion:reduce)');
    this.mediaChanged=()=>this.configure();this.motionChanged=()=>this.updateMotion();
    this.media.addEventListener('change',this.mediaChanged);this.motion.addEventListener('change',this.motionChanged);
    this.configure();
    this.order=[...this.items];this.activeItem=this.modelValue;
  },
  activated(){this.$nextTick(()=>this.engine?.update());},
  deactivated(){this.cancelDrag();},
  beforeUnmount(){this.media?.removeEventListener('change',this.mediaChanged);this.motion?.removeEventListener('change',this.motionChanged);this.engine?.destroy(true,true);},
  methods:{
    speed(){return this.motion?.matches?0:260;},
    isMoving(){return !!(this.dragging||this.recentering||this.engine?.animating||this.engine?.touchEventsData?.isTouched);},
    updateMotion(){
      if(!this.engine)return;
      this.engine.params.speed=this.speed();
      // Reduced motion removes the CSS transition, so no transitionend follows.
      // Commit the reset deck's existing destination instead of leaving it busy.
      if(this.reset&&this.motion.matches&&this.engine.animating)this.engine.transitionEnd();
    },
    show(index){if(this.lazy&&!this.preload&&!this.shown.includes(index)&&index>=0&&index<this.items.length)this.shown=[...this.shown,index];},
    async configure(){
      this.mobile=this.media.matches;
      if(!this.mobile){this.engine?.destroy(true,true);this.engine=null;this.ready=false;return;}
      if(this.engine||!window.Swiper)return;
      this.ready=true;await this.$nextTick();
      if(!this.mobile)return;
      this.engine=new window.Swiper(this.$el,{
        initialSlide:this.index,speed:this.speed(),nested:true,threshold:6,touchAngle:45,
        longSwipesRatio:.25,resistanceRatio:.55,touchReleaseOnEdges:!this.contain,
        // Do not discard edge contacts. The OS can still cancel a system-back
        // gesture; cancelDrag then restores the page without committing it.
        edgeSwipeDetection:false,simulateTouch:false,
        allowTouchMove:!this.disabled,touchStartPreventDefault:false,
        // Reset decks commit their target and recenter after transitionEnd.
        // New contacts must not force that event before the animation finishes.
        preventInteractionOnTransition:this.reset,
        allowSlideNext:!this.blockNext,
        focusableElements:'input:not([type=checkbox]):not([type=radio]),select,option,textarea,video,[contenteditable]',
        noSwipingSelector:'input:not([type=checkbox]):not([type=radio]),textarea,select,[contenteditable],.dlg-mask,.cal-month-picker,.md-body pre,.md-body table,.hm-wrap,[data-swipe-ignore],'+`[data-deck="${this.deckId}"][data-contact-owned]`,
        on:{
          sliderFirstMove:()=>{this.dragging=true;},
          setTranslate:(swiper,translate)=>{
            if(!this.dragging||!swiper.width)return;
            const position=-translate/swiper.width;
            this.show(position>this.index?Math.ceil(position):Math.floor(position));
          },
          slideChange:swiper=>{
            if(this.recentering||!swiper.initialized)return;
            this.activeItem=this.items[swiper.activeIndex];
            this.show(swiper.activeIndex);
            if(!this.reset)this.$emit('update:modelValue',this.items[swiper.activeIndex]);
          },
          transitionEnd:swiper=>this.settled(swiper),
          touchEnd:()=>{this.dragging=false;},
        },
      });
    },
    async settled(swiper){
      if(this.recentering)return;
      this.dragging=false;
      if(this.reset&&swiper.activeIndex!==this.index){
        this.recentering=true;
        this.$emit('update:modelValue',this.items[swiper.activeIndex]);
        await this.$nextTick();
        if(this.engine&&!this.engine.destroyed)this.engine.slideTo(this.index,0,false);
        this.activeItem=this.modelValue;
        this.recentering=false;
      }
      this.shown=[this.index];
      this.$emit('settled');
    },
    async sync(){
      const sequence=this.syncSequence=(this.syncSequence||0)+1;
      const previous=this.order||this.items;
      if(previous.some((item,i)=>item!==this.items[i])){
        this.shown=this.shown.map(i=>this.items.indexOf(previous[i])).filter(i=>i>=0);
      }
      this.show(this.index);await this.$nextTick();if(sequence!==this.syncSequence)return;
      if(this.engine&&previous.some((item,i)=>item!==this.items[i])){
        this.recentering=true;this.engine.updateSlides();this.move(Math.max(0,this.items.indexOf(this.activeItem)),0,false);this.recentering=false;
      }
      this.order=[...this.items];return this.go(this.index);
    },
    async go(index){
      if(index<0||index>=this.items.length)return;
      this.show(index);await this.$nextTick();
      if(this.engine&&!this.engine.destroyed){if(this.engine.activeIndex!==index)this.move(index,this.speed());}
      else if(this.reset)this.$emit('update:modelValue',this.items[index]);
      else this.shown=[this.index];
    },
    step(delta){return this.go(Math.max(0,Math.min(this.items.length-1,this.index+delta)));},
    move(index,speed,callbacks=true){
      // Direction locks protect user gestures, not an explicit route change.
      this.engine.allowSlideNext=true;this.engine.allowSlidePrev=true;
      this.engine.slideTo(index,speed,callbacks);
      this.engine.allowSlideNext=!this.blockNext;
    },
    guardTouches(event){if(event.touches.length>1)this.cancelDrag(event);},
    guardPointer(event){
      if(event.pointerType!=='touch')return;
      if(!event.isPrimary)this.cancelDrag(event);
      if(!this.engine||!this.$el)return;
      // Inert preview slides can retarget an edge contact to their ancestor.
      // Reserve the origin for the child before the parent's Swiper sees it.
      const owned=[...this.$el.querySelectorAll('[data-swipe-contained]')].some(el=>{
        if(el.closest('[inert]'))return false;
        const r=el.getBoundingClientRect();
        return r.width>0&&r.height>0&&event.clientX>=r.left&&event.clientX<r.right&&event.clientY>=r.top&&event.clientY<r.bottom;
      });
      this.$el.toggleAttribute('data-contact-owned',owned);
      // Native dispatch may run microtasks between capture and bubble listeners.
      setTimeout(()=>this.$el?.removeAttribute('data-contact-owned'),0);
    },
    cancelDrag(event){
      // An ignored contact can still be cancelled by a vertical scroll. It
      // must not roll back the previous contact's acknowledged transition.
      if(event&&this.reset&&(this.recentering||this.engine?.animating)&&!this.engine?.touchEventsData?.isTouched)return;
      this.dragging=false;
      if(this.engine){
        // Swiper 14 keeps pointercancel IDs in Chromium. A cancelled contact must
        // never poison the next gesture or commit a partially dragged page.
        Object.assign(this.engine.touchEventsData,{isTouched:false,isMoved:false,pointerId:null,touchId:null});
        this.engine.allowClick=true;this.move(this.index,this.speed(),false);
      }
      this.shown=[this.index];
    },
  },
};
