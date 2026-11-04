import test from 'node:test';
import assert from 'node:assert/strict';
import {analyzeBuckyFinances,answerBuckyQuestion,buildBuckyModelSummary,isRecordQuestion} from './buckyAgent.ts';
import {localDateKey,timestampLocalDate} from './localDate.ts';
import {getBuckyPageProfile,publishBuckyPageProfile} from './buckyProfileContext.ts';
const stamp='2026-11-01T00:00:00+08:00';
const profile={id:'biz',name:'QA Store',kind:'business',currency:'PHP',createdAt:stamp,updatedAt:stamp};
const transaction=(id,date,amountMinor,extra={})=>({id,profileId:'biz',bucketId:null,type:'income',amountMinor,currency:'PHP',date,description:'QA private source text',category:null,origin:'manual',relatedId:null,createdAt:stamp,updatedAt:stamp,...extra});

test('Local dates near midnight govern daily answers and sale timestamps, not UTC day',()=>{
 const previous=process.env.TZ;process.env.TZ='Asia/Manila';
 try{const now=new Date('2026-10-31T16:15:00Z');assert.equal(localDateKey(now),'2026-11-01');assert.equal(timestampLocalDate('2026-10-31T16:05:00Z'),'2026-11-01');assert.equal(timestampLocalDate('2026-10-31'),'2026-10-31');
 const analysis=analyzeBuckyFinances({profile,buckets:[],products:[],employees:[],now,transactions:[transaction('old','2026-10-31',50000),transaction('today','2026-11-01',15000),transaction('foreign','2026-11-01',999999,{profileId:'other',currency:'USD'})],sales:[{id:'sale',profileId:'biz',currency:'PHP',totalMinor:9000,items:[],createdAt:'2026-10-31T16:05:00Z'}]});
 const answer=answerBuckyQuestion('How much did we earn today?',analysis);assert.ok(answer.answer.includes('2026-11-01'));assert.ok(answer.facts.some(f=>f.value.includes('150.00')));assert.ok(answer.facts.some(f=>f.value.includes('90.00')));assert.equal(JSON.stringify(answer).includes('999'),false);
 const context=buildBuckyModelSummary(analysis,'How much did we earn today?').queryContext;assert.deepEqual(context.facts,answer.facts);assert.equal(context.localDate,'2026-11-01');assert.equal(JSON.stringify(context).includes('QA private source text'),false);
 const limited=buildBuckyModelSummary(analysis,'Show expenses last week').queryContext;assert.equal(limited.limited,true);assert.deepEqual(limited.facts,[]);
 }finally{if(previous===undefined)delete process.env.TZ;else process.env.TZ=previous;}
});
test('Bestseller and employee answers carry only requested scoped evidence',()=>{
 const analysis=analyzeBuckyFinances({profile,buckets:[],products:[],now:new Date(2026,10,3,12),employees:[{id:'worker',profileId:'biz',name:'QA Worker',status:'active'}],transactions:[transaction('salary','2026-11-01',25000,{type:'expense',category:'Salaries',description:'Salary payment — QA Worker',relatedId:'worker'})],sales:[{id:'sale',profileId:'biz',currency:'PHP',totalMinor:600,createdAt:stamp,items:[{productId:'burger',name:'Burger',quantity:3,lineTotalMinor:600}]}]});
 const best=buildBuckyModelSummary(analysis,'What is my best-selling product?').queryContext;assert.ok(best.answer.includes('Burger'));assert.ok(best.facts.some(f=>f.value.includes('3 sold')));
 const payment=buildBuckyModelSummary(analysis,'How much did I pay QA Worker this month?').queryContext;assert.ok(payment.answer.includes('250.00'));assert.equal(payment.limited,false);assert.equal(isRecordQuestion('How much did we make today?'),true);
});
test('Page selection ownership prevents an old page cleanup from clearing the new context',()=>{const old=publishBuckyPageProfile('php');const current=publishBuckyPageProfile('usd');old();assert.equal(getBuckyPageProfile(),'usd');current();assert.equal(getBuckyPageProfile(),'');});
