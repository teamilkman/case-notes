export interface Pager<T=any>{
  items:T[];total:number|null;loading:boolean;error:string;hasMore:boolean;cursor:string|null;args:Record<string,unknown>;loadedAt:number;
  reset(args?:Record<string,unknown>):Promise<void>;load():Promise<void>;dispose():void;
}
export function createPager<T=any>(fetchPage:(args:any,signal:AbortSignal)=>Promise<any>,key?:(item:T)=>string):Pager<T>;
