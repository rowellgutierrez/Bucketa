import test from 'node:test';
import assert from 'node:assert/strict';
import { productsRepo, completeSale, salesRepo } from '../data/db.ts';
import { addToCart, buildSaleItems, buildSale } from './pos.ts';
// In-memory IndexedDB scheduling double. No browser or persistent storage.
const data = { products: new Map(), sales: new Map() };
let queue = Promise.resolve();
function transaction(names) {
  const stores = Array.isArray(names) ? names : [names];
  const tx = { pending: 0, failed: false, ready: false };
  let release;
  const previous = queue;
  queue = new Promise(resolve => { release = resolve; });
  let snapshot;
  function finish() { if (tx.ready && !tx.pending && !tx.failed) { tx.oncomplete?.(); release(); } }
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
const product = (id, profileId='biz') => ({id,profileId,name:id,sku:null,barcode:'BKT-TEST1234',category:null,priceMinor:100,costMinor:null,currency:'PHP',stock:3,status:'active',createdAt:'2026-11-02',updatedAt:'2026-11-02'});
test('repository serializes barcode conflicts and preserves checkout idempotency', async () => {
 const results = await Promise.allSettled([productsRepo.create(product('a')),productsRepo.create(product('b'))]);
 assert.equal(results.filter(r=>r.status==='fulfilled').length,1);
 assert.equal(data.products.size,1);
 await productsRepo.create(product('foreign','other'));
 const first = await productsRepo.getById('a');
 assert.ok(first);
 await assert.rejects(productsRepo.create({...product('invalid'),barcode:'4006381333932'}),/checksum/);
 const cart = addToCart([],first);
 assert.equal((await productsRepo.getById('a')).stock,3);
 const sale = {...buildSale({id:'sale-one',profileId:'biz',currency:'PHP',items:buildSaleItems(cart,[first]),amountReceivedMinor:100,createdAt:'2026-11-02'}),updatedAt:'2026-11-02'};
 assert.equal(await completeSale(sale),'completed');
 assert.equal(await completeSale(sale),'already-completed');
 assert.equal((await productsRepo.getById('a')).stock,2);
 assert.equal((await productsRepo.getById('foreign')).stock,3);
 assert.equal((await salesRepo.getById('sale-one')).totalMinor,100);
 await productsRepo.create({...product('second'),barcode:'BKT-SECOND1234'});
 await assert.rejects(productsRepo.update('second',{barcode:' bkt-test1234 '}),/already assigned/);
 assert.equal((await productsRepo.getById('second')).barcode,'BKT-SECOND1234');
 await assert.rejects(productsRepo.update('a',{barcode:'4006381333932'}),/checksum/);
 assert.equal((await productsRepo.getById('a')).barcode,'BKT-TEST1234');
 await productsRepo.create({...product('legacy'),barcode:null});
 await productsRepo.update('legacy',{stock:4});
 assert.equal((await productsRepo.getById('legacy')).stock,4);
 await productsRepo.update('a',{description:'Editable description',color:'Navy'});
 assert.equal((await productsRepo.getById('a')).stock,2);
 assert.equal((await productsRepo.getById('a')).color,'Navy');
});
