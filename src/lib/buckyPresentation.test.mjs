import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {getBuckyPresentation,subscribeBuckyPresentation,setBuckyPhase,setBuckyOpen,recordBuckyEvent,buckyAnimation} from './buckyPresentation.ts';
const event={id:'qa-action',status:'awaiting',title:'Record expense',detail:'PHP 5.00',profileId:'qa-business',profileName:'QA Business',currency:'PHP'};
test('Presentation starts idle and never invents a completed event on opening',()=>{
 assert.equal(getBuckyPresentation().events.length,0);setBuckyOpen(true);assert.equal(getBuckyPresentation().events.length,0);assert.equal(getBuckyPresentation().phase,'idle');
});
test('Proposed, saving, saved, and duplicate results retain one actual record identity',()=>{
 recordBuckyEvent(event);assert.equal(getBuckyPresentation().events.at(-1).status,'awaiting');
 recordBuckyEvent({...event,status:'saving'});assert.equal(getBuckyPresentation().events.at(-1).status,'saving');
 recordBuckyEvent({...event,status:'saved'});assert.equal(getBuckyPresentation().events.at(-1).status,'saving');
 recordBuckyEvent({...event,status:'saved',recordId:'committed-record'});assert.equal(getBuckyPresentation().events.at(-1).recordId,'committed-record');
 const count=getBuckyPresentation().events.length;recordBuckyEvent({...event,status:'saved',recordId:'committed-record'});assert.equal(getBuckyPresentation().events.length,count);
 recordBuckyEvent({...event,status:'failed',detail:'View refresh failed'});assert.equal(getBuckyPresentation().events.at(-1).status,'saved');
 assert.equal(getBuckyPresentation().events.at(-1).currency,'PHP');assert.equal(getBuckyPresentation().events.at(-1).profileId,'qa-business');
});
test('Cancelled and unsupported requests never acquire a saved record ID',()=>{
 recordBuckyEvent({...event,id:'cancelled',status:'cancelled'});recordBuckyEvent({...event,id:'unsupported',status:'unsupported'});
 assert.equal(getBuckyPresentation().events.at(-1).recordId,undefined);assert.equal(getBuckyPresentation().phase,'error');
 setBuckyPhase('speaking','Speaking','qa-business');setBuckyOpen(false);assert.equal(getBuckyPresentation().phase,'idle');
});
test('Every mapped reaction exists in the official model; result clips are one-shot',()=>{
 const data=readFileSync(new URL('../assets/bucky.glb',import.meta.url));const json=JSON.parse(data.subarray(20,20+data.readUInt32LE(12)).toString());const clips=new Set(json.animations.map(a=>a.name));
 for(const phase of ['idle','listening','processing','speaking','success','error','cancelled','review','warning'])assert.ok(clips.has(buckyAnimation(phase).clip),phase);
 assert.equal(buckyAnimation('success').loop,false);assert.equal(buckyAnimation('error').loop,false);assert.equal(buckyAnimation('listening').loop,true);assert.equal(buckyAnimation('speaking').talking,true);assert.equal(buckyAnimation('idle').talking,false);
});
test('Presentation subscribers cannot turn an already committed result into a write failure',()=>{
 const remove=subscribeBuckyPresentation(()=>{throw Error('UI unmounted');});assert.doesNotThrow(()=>recordBuckyEvent({...event,id:'saved-during-unmount',status:'saved',recordId:'committed-2'}));remove();
});
