import test from 'node:test';
import assert from 'node:assert/strict';
import {historyDates,matchingHistory} from './historyView.ts';
test('Local history presets use calendar dates and Monday week boundaries',()=>{
 const now=new Date(2026,10,3,0,5);
 assert.deepEqual(historyDates('today','','',now),{from:'2026-11-03',to:'2026-11-03',error:''});
 assert.equal(historyDates('week','','',now).from,'2026-11-02');
 assert.equal(historyDates('week','','',now).to,'2026-11-08');
 assert.deepEqual(historyDates('week','','',new Date(2026,11,31)),{from:'2026-12-28',to:'2027-01-03',error:''});
 assert.equal(historyDates('month','','',now).from,'2026-11-01');
 assert.equal(historyDates('year','','',now).from,'2026-01-01');
});
test('History validates custom ranges and includes both boundaries without mutating records',()=>{
 const record=(id,date,currency='PHP')=>({id,date,currency,createdAt:'2026-11-01T00:00:00Z',type:'savings-withdrawal',amountMinor:100});
 const records=[record('a','2026-11-01'),record('b','2026-11-03'),record('c','2026-11-03','USD')];
 const before=JSON.stringify(records),range=historyDates('custom','2026-11-01','2026-11-03');
 assert.deepEqual(matchingHistory(records,range,'PHP').map(r=>r.id),['b','a']);
 assert.deepEqual(matchingHistory(records,historyDates('all')).map(r=>r.id),['c','b','a']);
 assert.ok(historyDates('custom','2026-02-30','2026-11-03').error);
 assert.equal(matchingHistory(records,historyDates('custom','2026-11-04','2026-11-03')).length,0);
 assert.equal(JSON.stringify(records),before);
});
