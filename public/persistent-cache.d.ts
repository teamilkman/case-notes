export interface CacheToken {scope:string;epoch:number;change?:string|null;}
export interface PersistentCache {
  activate(session:{cache_scope:string;expires_at:string;change_token?:string}):Promise<unknown>;
  resumeOffline():Promise<{cache_scope:string;expires_at:string}|null>;
  read(key:string):Promise<{hit:boolean;data?:any;token:CacheToken}|null>;
  write(key:string,data:any,token?:CacheToken):Promise<unknown>;
  invalidate(key?:string):Promise<unknown>;
  clear():Promise<unknown>;flush():Promise<void>;close():void;
}
export function createPersistentCache(options?:{name?:string;legacyName?:string|null;isOffline?:()=>boolean;maxEntries?:number;maxBytes?:number;maxEntryBytes?:number;now?:()=>number;dependencies?:{indexedDB:IDBFactory;IDBKeyRange:typeof IDBKeyRange}}):PersistentCache;
