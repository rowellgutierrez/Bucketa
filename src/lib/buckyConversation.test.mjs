import test from 'node:test';
import assert from 'node:assert/strict';
import {openBuckyConversation,openBuckyVoice,BUCKY_OPEN_EVENT,getBuckyDraft,setBuckyDraft,subscribeBuckyDraft,scopedBuckyHistory,createBuckySubmissionGate} from './buckyConversation.ts';
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

test('Model history never includes another profile or unscoped legacy messages',()=>{
 const messages=[{profileId:'php',role:'user',text:'PHP private question'},{profileId:'usd',role:'bucky',text:'USD response'},{role:'bucky',text:'Unknown context'}];
 assert.deepEqual(scopedBuckyHistory(messages,'usd'),[{role:'bucky',text:'USD response'}]);assert.deepEqual(scopedBuckyHistory(messages,'missing'),[]);
});

test('Accepted composer clears once while submitted text stays available for history',()=>{
 const gate=createBuckySubmissionGate();setBuckyDraft('  Explain bookkeeping for beginners.  ');let changes=0;const stop=subscribeBuckyDraft(()=>changes++);
 const accepted=gate.accept(getBuckyDraft());assert.equal(accepted.question,'Explain bookkeeping for beginners.');assert.equal(getBuckyDraft(),'');assert.equal(changes,1);assert.equal(gate.accept(accepted.question),null);accepted.finish();accepted.finish();assert.equal(changes,1);assert.equal(gate.accept(accepted.question),null);stop();
});
test('Unsent and newer drafts survive async completion, stale sends and handoffs',()=>{
 const gate=createBuckySubmissionGate();setBuckyDraft('First message');const accepted=gate.accept('First message');setBuckyDraft('Unsent next question');assert.equal(gate.accept('Unsent next question'),null);accepted.finish();assert.equal(getBuckyDraft(),'Unsent next question');assert.equal(gate.accept('First message'),null);
 const handoff=gate.accept('Submitted from Home',false);assert.ok(handoff);assert.equal(getBuckyDraft(),'Unsent next question');handoff.finish();assert.equal(getBuckyDraft(),'Unsent next question');setBuckyDraft('');
});

test('General model history contains only general turns, never financial-profile messages',()=>{
 const history=scopedBuckyHistory([{role:'user',text:'Hi Bucky'},{role:'bucky',text:'Hello'},{profileId:'sofia',role:'bucky',text:'Private financial figures'}],'');assert.equal(history.length,2);assert.equal(JSON.stringify(history).includes('Private'),false);
});
