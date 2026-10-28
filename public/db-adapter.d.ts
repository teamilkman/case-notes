export function legacyView(cases: any[], rows: any[]): any;
export interface EditorRow {line_id?:string;text:string;}
export interface CaseDocument {ref:string;revision:number;text:string;lines:EditorRow[];case?:unknown;}
export interface NoteEditor {ref:string;revision:number;rows:EditorRow[];text:string;edit:{start:number;end:number;inputType:string}|null;draftUnversioned:boolean;draftNotice:string;}
export function beginEdit(doc:CaseDocument):NoteEditor;
export function changeEdit(editor:NoteEditor,next:string):void;
export function restoreDraft(editor:NoteEditor):string;
export function save(editor:NoteEditor):Promise<any>;
export function createCase(fields:{name:string;kind:'case'|'affair'}):Promise<any>;
export function pendingCreate():{name:string;kind:'case'|'affair';request_key:string}|null;
export function updateCase(ref:string,version:number,fields:Record<string,unknown>):Promise<any>;
export function pendingMetadata(ref:string):{case_ref:string;expected_metadata_version:number;fields:Record<string,unknown>;request_key:string}|null;
export function logout():Promise<void>;
export function complete(todo:any):Promise<any>;
export function feed(name:string,args?:Record<string,any>):any;
export function invalidateReads(savedDoc?:any):void;
