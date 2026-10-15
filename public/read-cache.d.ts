export interface ReadEntry<T=any>{data:T|null;loaded:boolean;loading:boolean;error:string;pending:Promise<T>|null;ensure(load:()=>Promise<T>):Promise<T>;invalidate():void;prime(data:T):void;}
export function createReadCache(wrap?:(value:any)=>any,maxEntries?:number,persistence?:import('./persistent-cache.js').PersistentCache|null):{entry<T=any>(key:string):ReadEntry<T>;invalidate(persist?:boolean):void};
export function withSignal<T>(promise:Promise<T>,signal?:AbortSignal):Promise<T>;
