import test from 'node:test';
import assert from 'node:assert/strict';
import {openBuckyConversation,openBuckyVoice,BUCKY_OPEN_EVENT,getBuckyDraft,setBuckyDraft,subscribeBuckyDraft} from './buckyConversation.ts';
test('Home hands off a trimmed question and exact profile with unique request IDs',()=>{
 const previous=globalThis.window;globalThis.window=new EventTarget();const requests=[];
 window.addEventListener(BUCKY_OPEN_EVENT,event=>requests.push(event.detail));
 try{openBuckyConversation('  Show my expenses  ','business-usd');openBuckyConversation('','personal');
 assert.equal(requests[0].question,'Show my expenses');assert.equal(requests[0].profileId,'business-usd');
 assert.equal(requests[1].question,'');assert.notEqual(requests[0].id,requests[1].id);
 }finally{globalThis.window=previous;}
});

 test('Home and dock share one unsent draft without persistent storage',()=>{
  let updates=0;const stop=subscribeBuckyDraft(()=>updates++);
  setBuckyDraft('Unsent financial question');assert.equal(getBuckyDraft(),'Unsent financial question');
  setBuckyDraft('Unsent financial question');assert.equal(updates,1);
  setBuckyDraft('');assert.equal(getBuckyDraft(),'');assert.equal(updates,2);stop();
 });

test('Home voice handoff selects the exact profile without submitting a question or financial action',()=>{
 const previous=globalThis.window;globalThis.window=new EventTarget();let request;
 window.addEventListener(BUCKY_OPEN_EVENT,event=>request=event.detail);
 try{openBuckyVoice('qa-usd');assert.equal(request.mode,'voice');assert.equal(request.profileId,'qa-usd');assert.equal(request.question,'');assert.ok(request.id);}finally{globalThis.window=previous;}
});
