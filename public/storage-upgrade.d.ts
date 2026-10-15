export interface BrowserStorage {
  readonly length:number;
  key(index:number):string|null;
  getItem(key:string):string|null;
  setItem(key:string,value:string):void;
  removeItem(key:string):void;
}
export function migrateSessionStorage(storage?:BrowserStorage):void;
export function clearSessionStorage(storage?:BrowserStorage):void;
export function removePreviousReadCache(database?:IDBFactory):Promise<void>;
