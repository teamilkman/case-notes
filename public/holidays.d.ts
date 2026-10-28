export interface HolidayDay{date:string;name:string;isOffDay:boolean;}
export function holidayDays(value:unknown):HolidayDay[];
export function peekHolidayYear(year:number):HolidayDay[];
export function loadHolidayYear(year:number,options?:{force?:boolean;fetcher?:(year:number)=>Promise<unknown>;now?:number}):Promise<HolidayDay[]>;
