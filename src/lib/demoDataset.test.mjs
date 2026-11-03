import test from 'node:test';
import assert from 'node:assert/strict';
import {createDemoDataset,validateDemoDataset,isApprovedTestProfile} from './demoDataset.ts';
import {replaceFictionalWorkspace,planDemoUpdate} from '../data/demoWorkspace.ts';

test('Demo is deterministic, validates relationships and matches requested volumes',()=>{
 const first=createDemoDataset(),second=createDemoDataset();assert.deepEqual(first,second);
 assert.deepEqual(Object.fromEntries(Object.entries(first.data).map(([k,v])=>[k,v.length])),{profiles:5,buckets:26,transactions:591,products:80,employees:16,sales:200});
 assert.equal(first.data.transactions.filter(t=>first.data.employees.some(e=>e.id===t.relatedId)).length,48);
 assert.equal(first.data.profiles.filter(p=>p.kind==='business').length,4);
 assert.equal(first.data.buckets.filter(b=>b.profileId.endsWith(':personal')).length,10);
 validateDemoDataset(first.data,first.openingStock);
 for(const sale of first.data.sales)assert.ok(sale.createdAt.slice(0,10)>='2026-10-01'&&sale.createdAt.slice(0,10)<='2026-11-03');
});
test('Demo rejects inconsistent inventory, currency and duplicate IDs',()=>{
 const {data,openingStock}=createDemoDataset();data.products[0].stock++;assert.throws(()=>validateDemoDataset(data,openingStock),/Inventory/);data.products[0].stock--;
 data.transactions[0].currency='USD';assert.throws(()=>validateDemoDataset(data,openingStock),/currency/);data.transactions[0].currency='PHP';
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

test('Revised demo has three positive businesses, one underperformer, and unchanged expenses/POS',()=>{
 const current=createDemoDataset().data,old=createDemoDataset('original').data;
 const net=p=>current.transactions.filter(t=>t.profileId===p.id).reduce((sum,t)=>sum+(t.type==='income'?t.amountMinor:t.type==='expense'?-t.amountMinor:0),0);
 const businesses=current.profiles.filter(p=>p.kind==='business');assert.equal(businesses.filter(p=>net(p)>0).length,3);assert.equal(businesses.filter(p=>net(p)<0).length,1);
 assert.deepEqual(current.transactions.filter(t=>t.type==='expense'&&!current.employees.some(e=>e.id===t.relatedId)),old.transactions.filter(t=>t.type==='expense'&&!old.employees.some(e=>e.id===t.relatedId)));
 assert.deepEqual(current.products,old.products);assert.deepEqual(current.sales,old.sales);
 const employee=current.employees.find(e=>e.name==='Clara Dela Cruz');assert.ok(employee);assert.equal(current.employees.some(e=>e.name==='Mara Santos'),false);
 const payments=current.transactions.filter(t=>t.relatedId===employee.id);assert.equal(payments.length,3);assert.ok(payments.every(t=>t.description.includes(employee.name)&&!t.description.includes('Mara Santos')));
});
test('Demo update preserves IDs/counts, refuses edits and is repeat-safe',()=>{
 const old=createDemoDataset('original').data;
 const backup={format:'bucketa-local-backup-v1',schema:1,exportedAt:'',stores:{...structuredClone(old),settings:[{id:'preferences',defaultCurrency:'PHP'}]}};
 const {patch,ids}=planDemoUpdate(backup);assert.equal(ids.size,106);assert.equal(patch.employees.length,1);assert.equal(patch.transactions.length,105);
 for(const [store,rows] of Object.entries(patch)){const replacement=new Map(rows.map(row=>[row.id,row]));backup.stores[store]=backup.stores[store].map(row=>replacement.get(row.id)??row);assert.equal(backup.stores[store].length,old[store].length);}
 assert.equal(planDemoUpdate(backup).ids.size,0);assert.deepEqual(backup.stores.settings,[{id:'preferences',defaultCurrency:'PHP'}]);
 backup.stores.transactions[0].amountMinor++;assert.throws(()=>planDemoUpdate(backup),/edited/);
 const extra={...structuredClone(old),settings:[]};extra.transactions.push({...extra.transactions[0],id:'user-added'});assert.throws(()=>planDemoUpdate({...backup,stores:extra}),/edited/);
});
