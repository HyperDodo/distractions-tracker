import {send} from './api.js';
const tabKey='interruptions.tab.v1';
let tab=sessionStorage.getItem(tabKey); if (!tab) {tab=crypto.randomUUID(); sessionStorage.setItem(tabKey,tab);}
const key=`interruptions.draft.v1.${tab}`;
export function readDraft() { try { return JSON.parse(localStorage.getItem(key)); } catch {return null;} }
export function saveDraft(draft) { if (draft) localStorage.setItem(key,JSON.stringify(draft)); else localStorage.removeItem(key); }
// A single serial mutation stream, with an immutable click time and a coalesced patch.
export class EntryWriter {
  constructor(onChange) {this.onChange=onChange; this.draft=readDraft(); this.running=false;}
  notify() {saveDraft(this.draft); this.onChange();}
  start(preset={}, clickedAt=Date.now()) { if(this.draft) return; this.draft={id:crypto.randomUUID(), phase:'create', started_at:clickedAt, fields:{...preset}, pending:{}, finish:null, entry:null}; this.notify(); this.flush(); }
  update(fields) {if(!this.draft || this.draft.finish || this.draft.switch) return; Object.assign(this.draft.fields, fields); Object.assign(this.draft.pending, fields); this.notify(); this.flush();}
  finish(time) {if(!this.draft || this.draft.finish || this.draft.switch) return; this.draft.finish=time; this.notify(); this.flush();}
  switch(time) {if(!this.draft || this.draft.finish || this.draft.switch) return; this.draft.switch={new_entry_id:crypto.randomUUID(), switch_at:time, payload:null}; this.notify(); this.flush();}
  adopt(entry) {if(!this.draft) {this.draft={id:entry.id,phase:'active',entry,fields:{},pending:{},finish:null}; this.notify();}}
  clearActive() {if(this.draft?.phase==='active' && !Object.keys(this.draft.pending).length && !this.draft.finish && !this.running) {this.draft=null;saveDraft(null);}}
  async flush() {
    if(this.running || !this.draft || this.draft.error) return; this.running=true;
    try {
      while(this.draft) {
        const d=this.draft;
        if(d.phase==='create') {
          const result=await send('/api/entries','POST',{id:d.id,mode:'timer',started_at:d.started_at,...d.fields});
          if (!result.entry || result.entry.id !== d.id) throw new Error('Не удалось подтвердить создание');
          d.entry=result.entry; d.phase='active';
          if (result.operation_result === 'existing') {
            // Confirm fields individually; a difference requires explicit retry.
            for (const [key,value] of Object.entries(d.fields)) {
              const normalize = x => x == null || x === '' || (key === 'kind' && x === 'unknown') ? null : x;
              if (normalize(d.entry[key]) === normalize(value)) delete d.pending[key];
              else d.pending[key]=value;
            }
            if (Object.keys(d.pending).length) throw new Error('Запись найдена, но некоторые поля отличаются. Проверьте черновик; повтор сохранит ваши поля');
            if (d.entry.ended_at !== null) {this.draft=null;this.notify();break;}
          }
          this.notify(); continue;
        }
        const fields={...d.pending};
        if(Object.keys(fields).length) {
          const result=await send(`/api/entries/${d.id}`,'PATCH',{expected_revision:d.entry.revision,...fields});
          d.entry=result.entry; for(const [k,v] of Object.entries(fields)) if(d.pending[k]===v) delete d.pending[k]; this.notify(); continue;
        }
        if(d.switch) {
          const command=d.switch;
          if(!command.payload) {command.payload={expected_id:d.id,expected_revision:d.entry.revision,switch_at:command.switch_at,new_entry_id:command.new_entry_id,closing_patch:{},preset:{}};this.notify();}
          const result=await send('/api/entries/switch','POST',command.payload);
          if(!result.new_entry || result.new_entry.id!==command.new_entry_id) throw new Error('Не удалось подтвердить переключение');
          this.draft={id:command.new_entry_id,phase:'active',entry:result.new_entry,fields:{},pending:{},finish:null};this.notify();continue;
        }
        if(d.finish) {
          const result=await send(`/api/entries/${d.id}/finish`,'POST',{expected_revision:d.entry.revision,clicked_ended_at:d.finish});
          if(!result.entry?.ended_at) throw new Error('Не удалось подтвердить окончание');
          this.draft=null; this.notify(); break;
        }
        break;
      }
    } catch(e) { if(this.draft) {this.draft.error=e.message; this.draft.status=e.status; this.draft.serverActive=e.payload?.active_entry||null; this.notify();} }
    finally {this.running=false;this.onChange();}
  }
  retry() {if(this.draft) {delete this.draft.error;this.notify();this.flush();}}
  discard() {this.draft=null;this.notify();}
}
