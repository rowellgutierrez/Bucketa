/** Session-only presentation state. Never writes financial data or calls a model. */
export type BuckyPhase = 'idle'|'listening'|'processing'|'speaking'|'success'|'error'|'cancelled'|'review'|'warning';
export type BuckyActionStatus = 'awaiting'|'saving'|'saved'|'cancelled'|'failed'|'unsupported';
export interface BuckyActionEvent {id:string;status:BuckyActionStatus;title:string;detail:string;profileId:string;profileName:string;currency?:string;recordId?:string}
export interface BuckyPresentation {open:boolean;phase:BuckyPhase;label:string;profileId?:string;eventId?:string;events:readonly BuckyActionEvent[]}
let snapshot:BuckyPresentation={open:false,phase:'idle',label:'',events:[]};
const listeners=new Set<()=>void>();
// Presentation listeners must never break a successful financial save.
const emit=()=>{for(const listener of listeners){try{listener();}catch{ /* UI subscriber unavailable. */ }}};
export const getBuckyPresentation=()=>snapshot;
export function subscribeBuckyPresentation(listener:()=>void):()=>void{listeners.add(listener);return()=>{listeners.delete(listener);};}
let inline=false;
export function getBuckyInline(){return inline;}
export function setBuckyInline(value:boolean){if(inline===value)return;inline=value;emit();}
export function setBuckyOpen(open:boolean):void{
 if(snapshot.open===open)return;
 const transient=['listening','speaking','processing'].includes(snapshot.phase);
 snapshot={...snapshot,open,...(!open&&transient?{phase:'idle' as const,label:''}:{})};emit();
}
export function setBuckyPhase(phase:BuckyPhase,label:string,profileId?:string):void{
 if(snapshot.phase===phase&&snapshot.label===label&&snapshot.profileId===profileId)return;
 snapshot={...snapshot,phase,label,profileId};emit();
}
export function recordBuckyEvent(event:BuckyActionEvent):void{
 if(event.status==='saved'&&!event.recordId)return;
 const existing=snapshot.events.find(item=>item.id===event.id);
 // A committed result cannot later be downgraded by a failed UI refresh.
 if(existing?.status==='saved'&&(event.status!=='saved'||event.recordId!==existing.recordId))return;
 if(existing?.status==='cancelled'&&event.status!=='saved'&&event.status!=='cancelled')return;
 if(existing?.status==='failed'&&event.status==='awaiting')return;
 if(existing&&JSON.stringify(existing)===JSON.stringify(event))return;
 const events=[...snapshot.events.filter(item=>item.id!==event.id),Object.freeze({...event})].slice(-12);
 const phase:BuckyPhase=event.status==='saved'?'success':event.status==='cancelled'?'cancelled':event.status==='failed'||event.status==='unsupported'?'error':event.status==='saving'?'processing':'review';
 snapshot={...snapshot,events,phase,label:event.status==='awaiting'?'Awaiting confirmation':event.status==='saving'?'Saving':event.title+' · '+event.profileName,profileId:event.profileId,eventId:event.id+':'+event.status};emit();
}
export function buckyAnimation(phase:BuckyPhase):{clip:string;loop:boolean;talking:boolean}{
 const clip=phase==='listening'?'Listening':phase==='processing'?'Thinking':phase==='speaking'?'SpeakingCalm':phase==='success'?'Celebration':phase==='error'||phase==='warning'?'Emotion_Concerned':phase==='cancelled'?'FinishConversation':'Breathing';
 return{clip,loop:['idle','listening','processing','speaking','review'].includes(phase),talking:phase==='speaking'};
}
export const ACTION_STATUS_LABELS:Record<BuckyActionStatus,string>={awaiting:'Awaiting confirmation',saving:'Saving',saved:'Saved',cancelled:'Cancelled',failed:'Failed — not saved',unsupported:'Not answered — no changes'};
