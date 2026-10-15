export function createNavigation(state:any,viewFor:(view:string)=>any):{openView(view:string):boolean;openCase(path:string):boolean;back():boolean;swiped(view:string):boolean;settled():void};
