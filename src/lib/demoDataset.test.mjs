import test from 'node:test';
import assert from 'node:assert/strict';
import {createDemoDataset,validateDemoDataset,isApprovedTestProfile,DEMO_PREFIX} from './demoDataset.ts';
import {replaceFictionalWorkspace,planDemoUpdate,planJudgeDemoInitialization} from '../data/demoWorkspace.ts';

test('Judge demo is deterministic USD Sep-Nov 2026 with Harbor, Cafe and Alex',()=>{
 const first=createDemoDataset(),second=createDemoDataset();assert.deepEqual(first,second);
 assert.deepEqual(first.data.profiles.map(p=>p.name),['Harbor Mini Market','Corner Café','Alex Morgan']);
 assert.ok(first.data.profiles.every(p=>p.currency==='USD'));
 assert.equal(first.data.profiles.filter(p=>p.kind==='business').length,2);
 assert.equal(first.data.profiles.filter(p=>p.kind==='personal').length,1);
 assert.equal(first.data.products.length,22);
 assert.equal(first.data.employees.length,6);
 assert.equal(first.data.sales.length,132);
 for(const t of first.data.transactions){assert.equal(t.currency,'USD');assert.ok(t.date>='2026-09-01'&&t.date<='2026-11-04',t.date);}
 for(const sale of first.data.sales){assert.equal(sale.currency,'USD');assert.ok(sale.createdAt.slice(0,10)>='2026-09-01'&&sale.createdAt.slice(0,10)<='2026-11-04');}
 validateDemoDataset(first.data,first.openingStock);
 // Low inventory exists for the judge question.
 assert.ok(first.data.products.some(p=>p.stock<=2));
 // Salary payments: 6 employees x 3 monthly + 2 first-employee bonuses.
 assert.equal(first.data.transactions.filter(t=>first.data.employees.some(e=>e.id===t.relatedId)).length,20);
 // Personal savings goals.
 const personal=first.data.profiles.find(p=>p.kind==='personal');
 const goals=first.data.buckets.filter(b=>b.profileId===personal.id&&b.kind==='savings');
 assert.deepEqual(goals.map(g=>g.name).sort(),['Emergency fund','Laptop savings']);
 assert.ok(goals.every(g=>g.targetMinor>0));
 assert.ok(first.data.transactions.some(t=>t.profileId===personal.id&&t.type==='savings-deposit'));
 assert.ok(first.data.transactions.some(t=>t.profileId===personal.id&&t.type==='savings-withdrawal'));
 // Each business has Sep, Oct and Nov activity.
 for(const biz of first.data.profiles.filter(p=>p.kind==='business')){
   for(const month of ['2026-09','2026-10','2026-11']){
     assert.ok(first.data.transactions.some(t=>t.profileId===biz.id&&t.date.startsWith(month)),biz.name+' '+month);
     assert.ok(first.data.sales.some(s=>s.profileId===biz.id&&s.createdAt.startsWith(month)),biz.name+' sales '+month);
   }
 }
 // Corner Cafe October POS total equals the sum of its October sale totals.
 const cafe=first.data.profiles.find(p=>p.name==='Corner Café');
 const october=first.data.sales.filter(s=>s.profileId===cafe.id&&s.createdAt.startsWith('2026-10'));
 assert.ok(october.length>0);
 assert.equal(october.reduce((sum,s)=>sum+s.totalMinor,0),october.reduce((sum,s)=>sum+s.items.reduce((a,i)=>a+i.lineTotalMinor,0),0));
});

test('Judge demo rejects inconsistent inventory, non-USD currency and duplicate IDs',()=>{
 const {data,openingStock}=createDemoDataset();data.products[0].stock++;assert.throws(()=>validateDemoDataset(data,openingStock),/Inventory/);data.products[0].stock--;
 data.transactions[0].currency='PHP';assert.throws(()=>validateDemoDataset(data,openingStock),/USD|currency/);data.transactions[0].currency='USD';
 data.transactions[0].id=data.products[0].id;assert.throws(()=>validateDemoDataset(data,openingStock),/Duplicate/);
});

test('Replacement refuses unknown scope and repeated installation before opening storage',async()=>{
 assert.equal(isApprovedTestProfile({name:'Family business'}),false);
 const qa={id:'qa',name:'QA Fictional',kind:'business',currency:'PHP'};
 const stores={profiles:[qa],buckets:[],transactions:[],products:[],employees:[],sales:[],settings:[]};
 const backup={format:'bucketa-local-backup-v1',schema:1,exportedAt:'',stores};
 await assert.rejects(replaceFictionalWorkspace(backup,['unknown']),/identified fictional/);
 stores.profiles.push(createDemoDataset().data.profiles[0]);
 await assert.rejects(replaceFictionalWorkspace(backup,['qa']),/already installed/);
});

test('Judge demo initialization plan is safe, idempotent and preserves existing records',()=>{
 const userProfile={id:'user-1',name:'My Real Shop',kind:'business',currency:'PHP'};
 const userTxn={id:'user-txn-1',profileId:'user-1'};
 const empty={format:'bucketa-local-backup-v1',schema:1,exportedAt:'',stores:{profiles:[userProfile],buckets:[],transactions:[userTxn],products:[],employees:[],sales:[],settings:[]}};
 const plan=planJudgeDemoInitialization(empty);
 assert.equal(plan.status,'ready');
 assert.ok(plan.data.profiles.every(p=>p.id.startsWith(DEMO_PREFIX)));
 // Applying the plan only adds demo rows; the user rows stay identical.
 const applied={...empty,stores:{profiles:[...empty.stores.profiles,...plan.data.profiles],buckets:plan.data.buckets,transactions:[...empty.stores.transactions,...plan.data.transactions],products:plan.data.products,employees:plan.data.employees,sales:plan.data.sales,settings:[]}};
 assert.equal(planJudgeDemoInitialization(applied).status,'already-installed');
 assert.deepEqual(applied.stores.profiles[0],userProfile);
 assert.deepEqual(applied.stores.transactions[0],userTxn);
 // Current demo installed exactly is a no-op update.
 const current=createDemoDataset().data;
 const backup={format:'bucketa-local-backup-v1',schema:1,exportedAt:'',stores:{...structuredClone(current),settings:[{id:'preferences',defaultCurrency:'PHP'}]}};
 assert.equal(planDemoUpdate(backup).ids.size,0);
});

test('Partial judge demo (profiles only, records missing) is repaired without duplicates',()=>{
 const full=createDemoDataset().data;
 // Demo profiles exist but every financial record is missing — the
 // failure mode where the workspace looked empty despite "installed".
 const partial={format:'bucketa-local-backup-v1',schema:1,exportedAt:'',stores:{profiles:[...structuredClone(full.profiles),{id:'user-1',name:'My Real Shop',kind:'business',currency:'PHP'}],buckets:[],transactions:[{id:'user-txn-1',profileId:'user-1',currency:'PHP'}],products:[],employees:[],sales:[],settings:[]}};
 const plan=planJudgeDemoInitialization(partial);
 assert.equal(plan.status,'repair');
 assert.equal(plan.data.profiles.length,0);
 assert.equal(plan.data.transactions.length,full.transactions.length);
 assert.ok(plan.data.transactions.length>0 && plan.data.sales.length===full.sales.length);
 assert.ok(plan.data.transactions.every(t=>t.currency==='USD'));
 // Applying the repair (adding only missing IDs) completes the demo,
 // keeps the user's PHP records untouched, and re-planning is a no-op.
 const repaired={...partial,stores:{profiles:partial.stores.profiles,buckets:plan.data.buckets,transactions:[...partial.stores.transactions,...plan.data.transactions],products:plan.data.products,employees:plan.data.employees,sales:plan.data.sales,settings:[]}};
 assert.equal(planJudgeDemoInitialization(repaired).status,'already-installed');
 assert.equal(repaired.stores.transactions[0].id,'user-txn-1');
 assert.equal(repaired.stores.transactions.filter(t=>t.id.startsWith(DEMO_PREFIX)).length,full.transactions.length);
});
