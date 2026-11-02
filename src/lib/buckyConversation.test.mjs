import test from 'node:test';
import assert from 'node:assert/strict';
import {openBuckyConversation,BUCKY_OPEN_EVENT,getBuckyDraft,setBuckyDraft,subscribeBuckyDraft} from './buckyConversation.ts';
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
