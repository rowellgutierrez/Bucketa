/** UI-only handoff to the single app-wide conversation. No storage or writes. */
export interface BuckyConversationRequest { id: string; question: string; profileId?: string; mode?:'voice' }
export const BUCKY_OPEN_EVENT = 'bucketa:open-conversation';
export function openBuckyConversation(question = '', profileId?: string): void {
 window.dispatchEvent(new CustomEvent<BuckyConversationRequest>(BUCKY_OPEN_EVENT,{detail:{id:crypto.randomUUID(),question:question.trim(),profileId}}));
}
export function openBuckyVoice(profileId?:string):void{
 window.dispatchEvent(new CustomEvent<BuckyConversationRequest>(BUCKY_OPEN_EVENT,{detail:{id:crypto.randomUUID(),question:'',profileId,mode:'voice'}}));
}

// One in-memory composer draft shared by Home and the persistent dock.
let draft = '';
const draftListeners = new Set<() => void>();
export function getBuckyDraft(): string { return draft; }
export function setBuckyDraft(value: string): void {
 if(value === draft) return;
 draft = value; for(const listener of draftListeners) listener();
}
export function subscribeBuckyDraft(listener: () => void): () => void {
 draftListeners.add(listener); return () => {draftListeners.delete(listener);};
}
