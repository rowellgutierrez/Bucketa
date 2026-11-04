import test from 'node:test';
import assert from 'node:assert/strict';
import {profilesRepo,productsRepo,employeesRepo,bucketsRepo,transactionsRepo,incrementProductStock,createTransactionConfirmed,completeSale} from './db.ts';
import {buildSale} from '../lib/pos.ts';
// In-memory IndexedDB scheduling double. No browser or persistent storage.
const data=Object.fromEntries(['profiles','products','sales','transactions','employees','buckets','settings'].map(name=>[name,new Map()]));
let failCommit=false;
let queue = Promise.resolve();
function transaction(names) {
  const stores = Array.isArray(names) ? names : [names];
  const tx = { pending: 0, failed: false, ready: false };
  let release;
  const previous = queue;
  queue = new Promise(resolve => { release = resolve; });
  let snapshot;
  function finish() { if (tx.ready && !tx.pending && !tx.failed) { if(failCommit){failCommit=false;tx.abort();return;}tx.oncomplete?.(); release(); } }
  tx.abort = () => { if(tx.failed) return; tx.failed = true; for(const name of stores) data[name] = new Map(snapshot[name]); tx.onabort?.(); release(); };
  tx.objectStore = name => {
    const request = run => {
      const req = {}; tx.pending++;
      previous.then(() => queueMicrotask(() => {
        if (tx.failed) return;
        try { req.result = run(); req.onsuccess?.(); }
        catch { req.onerror?.(); if(!tx.failed) tx.abort(); }
        tx.pending--; queueMicrotask(finish);
      }));
      return req;
    };
    return {
      getAll: () => request(() => structuredClone([...data[name].values()])),
      get: id => request(() => structuredClone(data[name].get(id))),
      add: record => request(() => { if(data[name].has(record.id)) throw Error('duplicate'); data[name].set(record.id, structuredClone(record)); return record.id; }),
      put: record => request(() => {data[name].set(record.id, structuredClone(record)); return record.id;})
    };
  };
  previous.then(() => {snapshot = Object.fromEntries(stores.map(name => [name, structuredClone(data[name])])); tx.ready = true; queueMicrotask(finish);});
  return tx;
}
globalThis.indexedDB = { open() {const req = {}; queueMicrotask(() => {req.result = {transaction}; req.onsuccess?.();}); return req;} };

const stamp='2026-11-03T00:00:00Z';
const owner=(id='biz',currency='PHP')=>({id,name:id,kind:'business',currency,createdAt:stamp,updatedAt:stamp});
const product=(id='item')=>({id,profileId:'biz',name:id,sku:null,barcode:null,category:null,currency:'PHP',priceMinor:100,costMinor:null,stock:10,status:'active',createdAt:stamp,updatedAt:stamp});
const record=(id,extra={})=>({id,profileId:'biz',bucketId:null,type:'expense',amountMinor:100,currency:'PHP',date:'2026-11-03',description:'Fictional test',category:null,origin:'manual',relatedId:null,createdAt:stamp,updatedAt:stamp,...extra});
const stock=(actionId,delta,extra={})=>incrementProductStock({id:'item',profileId:'biz',currency:'PHP',delta,actionId,...extra});

test('Atomic increments serialize concurrent snapshots, receipts and POS deductions',async()=>{
 await profilesRepo.create(owner());await productsRepo.create(product());
 await Promise.all([stock('one',2),stock('two',3)]);assert.equal((await productsRepo.getById('item')).stock,15);
 await Promise.all([stock('same',4),stock('same',4)]);assert.equal((await productsRepo.getById('item')).stock,19);
 await assert.rejects(stock('same',5),/different arguments/);
 const sale=buildSale({id:'sale',profileId:'biz',currency:'PHP',createdAt:stamp,items:[{productId:'item',name:'item',sku:null,unitPriceMinor:100,quantity:2,lineTotalMinor:200}],amountReceivedMinor:200});
 await Promise.all([completeSale(sale),stock('after-sale',5)]);assert.equal((await productsRepo.getById('item')).stock,22);
 assert.equal(await completeSale(sale),'already-completed');assert.equal((await productsRepo.getById('item')).stock,22);
});
test('Invalid deltas, ownership, currency, archive and deleted profiles are rejected',async()=>{
 for(const delta of [-1,0,1.5,Number.MAX_SAFE_INTEGER])await assert.rejects(stock('bad-'+delta,delta));
 await assert.rejects(stock('foreign',1,{profileId:'other'}));await assert.rejects(stock('usd',1,{currency:'USD'}));
 await productsRepo.update('item',{status:'archived'});await assert.rejects(stock('archived',1));await productsRepo.update('item',{status:'active'});
 const saved=data.profiles.get('biz');data.profiles.delete('biz');await assert.rejects(stock('deleted',1));data.profiles.set('biz',saved);
 assert.equal((await productsRepo.getById('item')).stock,22);
});
test('Bookkeeping validates references atomically and duplicate confirmation writes once',async()=>{
 await profilesRepo.create(owner('other'));
 await bucketsRepo.create({id:'goal',profileId:'biz',name:'Savings',kind:'savings',currency:'PHP',targetMinor:10000,createdAt:stamp,updatedAt:stamp});
 await employeesRepo.create({id:'employee',profileId:'biz',name:'QA Worker',status:'active',role:null,salaryRateMinor:null,salaryFrequency:'monthly',currency:'PHP',startDate:null,createdAt:stamp,updatedAt:stamp});
 const salary=record('salary',{category:'Salaries',relatedId:'employee'});
 const writes=await Promise.allSettled([createTransactionConfirmed(salary),createTransactionConfirmed(salary)]);assert.equal(writes.filter(v=>v.status==='fulfilled').length,1);assert.equal(data.transactions.size,1);
 await assert.rejects(createTransactionConfirmed(record('foreign-goal',{profileId:'other',bucketId:'goal'})));
 await assert.rejects(createTransactionConfirmed(record('usd-record',{currency:'USD'})));
 data.employees.delete('employee');await assert.rejects(createTransactionConfirmed(record('deleted-employee',{category:'Advances',relatedId:'employee'})));
 data.buckets.delete('goal');await assert.rejects(createTransactionConfirmed(record('deleted-bucket',{type:'savings-deposit',bucketId:'goal'})));
 const saved=data.profiles.get('biz');data.profiles.delete('biz');await assert.rejects(createTransactionConfirmed(record('deleted-owner')));data.profiles.set('biz',saved);
 assert.equal(data.transactions.size,1);
});
test('Commit aborts roll back and generic repositories never report early success',async()=>{
 failCommit=true;await assert.rejects(employeesRepo.create({id:'abort-employee',profileId:'biz',name:'QA Abort',status:'active',salaryFrequency:'monthly',salaryRateMinor:null,createdAt:stamp,updatedAt:stamp}));assert.equal(data.employees.has('abort-employee'),false);
 failCommit=true;await assert.rejects(stock('abort-stock',2));assert.equal((await productsRepo.getById('item')).stock,22);assert.equal(data.settings.has('stock-adjustment:abort-stock'),false);
 failCommit=true;await assert.rejects(createTransactionConfirmed(record('abort-record')));assert.equal(data.transactions.has('abort-record'),false);
 await assert.rejects(transactionsRepo.create(record('missing-ref',{bucketId:'deleted'})));
});
