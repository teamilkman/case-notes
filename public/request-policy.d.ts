export interface RequestPolicy {
  retryAfter():number;error():Error&{code:string;status:number;retryable:boolean;commitState:string;retryAfter:number};
  check():void;limit(response:{headers?:{get(name:string):string|null}},seconds?:number):void;failure():void;success():void;
}
export function createRequestPolicy(options?:{now?:()=>number}):RequestPolicy;
export const requestPolicy:RequestPolicy|null;
