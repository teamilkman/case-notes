// Application parents are explicit; URL history is only a shareable address.
export function createNavigation(state,viewFor){
  return {
    openView(view){
      if(!['kanban','cases','calendar'].includes(view)||viewFor('cases')?.saving)return false;
      state.view=view;return true;
    },
    openCase(path){
      if(viewFor('cases')?.saving)return false;
      state.caseParent=state.view==='cases'?'cases':state.view;
      state.pageOrder=state.caseParent==='calendar'?['calendar','cases','kanban']:['kanban','cases','calendar'];
      state.selCase=path;state.view='cases';return true;
    },
    back(){
      const view=viewFor(state.view);
      if(view?.saving)return true;
      if(view?.dlg){view.dlg=false;return true;}
      if(view?.monthPickerOpen){view.closeMonthPicker();return true;}
      if(view?.editing){view.leaveEdit();return true;}
      if(state.view==='cases'&&state.selCase){
        view?.prepareBack?.();
        const parent=state.caseParent||'cases';state.selCase=null;state.caseParent=null;state.view=parent;return true;
      }
      if(state.view!=='kanban'){state.view='kanban';return true;}
      return false;
    },
    swiped(view){
      if(state.view==='cases'&&state.selCase&&state.caseParent!== 'cases'&&view===state.caseParent)return this.back();
      return this.openView(view);
    },
    settled(){if((state.view!=='cases'||!state.selCase)&&state.pageOrder?.[0]!=='kanban')state.pageOrder=['kanban','cases','calendar'];},
  };
}
