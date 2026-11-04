import assert from "node:assert/strict";
import test from "node:test";
import type { Bucket, Employee, Product, Profile, Sale, Transaction } from "../data/types.ts";
import { validateBucket, validateEmployee } from "../data/validation.ts";
import { bestSellingProducts, buildBucketRecord, buildEmployeeRecord, consumePosCartHandoff, earnedOnDate, interpretAppAction, resolveBuckyRecordProfile, isGeneralBuckyConversation, queuePosCartHandoff, resolveNamedProfile, type AppActionContext } from "./buckyAppActions.ts";

const stamp = "2026-11-01T00:00:00.000Z";
const business: Profile = { id: "biz1", kind: "business", name: "Sari Store", currency: "PHP", createdAt: stamp, updatedAt: stamp };
const personal: Profile = { id: "p1", kind: "personal", name: "My Money", currency: "PHP", createdAt: stamp, updatedAt: stamp };
const hakdog: Product = { id: "prod1", profileId: "biz1", name: "Hakdog", sku: null, category: null, priceMinor: 8500, costMinor: null, currency: "PHP", stock: 20, status: "active", createdAt: stamp, updatedAt: stamp };
const burger: Product = { id: "prod2", profileId: "biz1", name: "Burger", sku: null, category: null, priceMinor: 5000, costMinor: null, currency: "PHP", stock: 3, status: "active", createdAt: stamp, updatedAt: stamp };
let seq = 0;
function ctx(over: Partial<AppActionContext> = {}): AppActionContext {
  return { profile: business, products: [hakdog, burger], employees: [], buckets: [], today: "2026-11-01", createId: () => `bucky:app-${++seq}`, ...over };
}

test("add employee proposes a valid record and requires a business profile", () => {
  const result = interpretAppAction("Add employee Roger.", ctx());
  assert.equal(result.status, "proposal");
  if (result.status === "proposal" && result.action.kind === "create-employee") {
    assert.equal(result.action.name, "Roger");
    assert.equal(validateEmployee(buildEmployeeRecord(result.action, stamp)).name, "Roger");
  } else assert.fail("expected employee proposal");
  assert.equal(interpretAppAction("Add employee Roger.", ctx({ profile: personal })).status, "clarification");
});

test("named business employee command parses name and monthly PHP salary", () => {
  const bibingka: Profile = { id: "biz2", kind: "business", name: "Bibingka", currency: "PHP", createdAt: stamp, updatedAt: stamp };
  const resolved = resolveNamedProfile("add an employee record under my Bibingka business", [business, bibingka]);
  assert.equal(resolved.status, "matched");
  const result = interpretAppAction("Hey Bucky, add an employee record under my Bibingka business. His name is Michael Anzures, and his monthly salary is PHP 15,000.", ctx({ profile: bibingka }));
  assert.equal(result.status, "proposal");
  if (result.status === "proposal" && result.action.kind === "create-employee") {
    assert.equal(result.action.name, "Michael Anzures");
    assert.equal(result.action.profileId, "biz2");
    assert.equal(result.action.salaryRateMinor, 1500000);
    assert.equal(result.action.salaryFrequency, "monthly");
    const record = buildEmployeeRecord(result.action, stamp);
    assert.equal(validateEmployee(record).salaryRateMinor, 1500000);
    assert.equal(record.profileId, "biz2");
  } else assert.fail("expected employee proposal");
});

test("named profile resolution never guesses missing or ambiguous businesses", () => {
  assert.equal(resolveNamedProfile("summarize my Bibingka business", [business]).status, "named-missing");
  const dupA: Profile = { ...business, id: "dup1", name: "Store" };
  const dupB: Profile = { ...business, id: "dup2", name: "Store" };
  assert.equal(resolveNamedProfile("add employee Roger under my Store business", [dupA, dupB]).status, "ambiguous");
  assert.equal(resolveNamedProfile("add employee Roger", [business]).status, "none");
  // Salary in a different currency is a clarification, never a conversion.
  const usd: Profile = { ...business, id: "biz-usd", currency: "USD" };
  assert.equal(interpretAppAction("Add employee Roger, monthly salary PHP 15,000", ctx({ profile: usd })).status, "clarification");
});

test("increase stock resolves the product and computes the new level", () => {
  const result = interpretAppAction("Increase Hakdog stock by 10.", ctx());
  assert.equal(result.status, "proposal");
  if (result.status === "proposal" && result.action.kind === "adjust-stock") {
    assert.equal(result.action.productId, "prod1");
    assert.equal(result.action.newStock, 30);
  } else assert.fail("expected stock proposal");
  assert.equal(interpretAppAction("Increase Unknown stock by 10.", ctx()).status, "clarification");
});

test("create savings bucket proposes a valid bucket without touching contributions", () => {
  const result = interpretAppAction("Create a savings bucket for my motorcycle.", ctx());
  assert.equal(result.status, "proposal");
  if (result.status === "proposal" && result.action.kind === "create-bucket") {
    assert.equal(result.action.name, "Motorcycle");
    assert.equal(validateBucket(buildBucketRecord(result.action, stamp)).kind, "savings");
  } else assert.fail("expected bucket proposal");
  assert.equal(interpretAppAction("Add ₱500 to my iPhone savings.", ctx()).status, "not-action");
});

test("POS cart proposals parse number words, respect stock, and never hijack records", () => {
  const result = interpretAppAction("Add two burgers to the POS cart.", ctx());
  assert.equal(result.status, "proposal");
  if (result.status === "proposal" && result.action.kind === "pos-cart-add") {
    assert.equal(result.action.productId, "prod2");
    assert.equal(result.action.quantity, 2);
  } else assert.fail("expected cart proposal");
  assert.equal(interpretAppAction("Record ₱500 expense for groceries", ctx()).status, "not-action");
});

test("best sellers and earned-today are computed from real records only", () => {
  const sale: Sale = { id: "s1", profileId: "biz1", items: [{ productId: "prod1", name: "Hakdog", sku: null, unitPriceMinor: 8500, quantity: 4, lineTotalMinor: 34000 }, { productId: "prod2", name: "Burger", sku: null, unitPriceMinor: 5000, quantity: 2, lineTotalMinor: 10000 }], totalMinor: 44000, currency: "PHP", createdAt: "2026-11-01T08:00:00.000Z", updatedAt: stamp };
  const best = bestSellingProducts([sale], "biz1");
  assert.equal(best[0].name, "Hakdog");
  assert.equal(best[0].quantity, 4);
  const txn: Transaction = { id: "t1", profileId: "biz1", bucketId: null, type: "income", amountMinor: 100000, currency: "PHP", date: "2026-11-01", description: "Sales", category: null, origin: "manual", relatedId: null, createdAt: stamp, updatedAt: stamp };
  assert.deepEqual(earnedOnDate([txn], [sale], "biz1", "2026-11-01"), [{ date: "2026-11-01", currency: "PHP", incomeMinor: 100000, posRevenueMinor: 44000 }]);
  assert.deepEqual(earnedOnDate([txn], [sale], "biz1", "2026-11-02"), []);
});

test("POS handoff is single-use, profile-scoped, and expires", () => {
  const map = new Map<string, string>();
  const storage = { getItem: (k: string) => map.get(k) ?? null, setItem: (k: string, v: string) => { map.set(k, v); }, removeItem: (k: string) => { map.delete(k); } };
  queuePosCartHandoff(storage, { profileId: "biz1", items: [{ productId: "prod1", quantity: 2 }], createdAt: 1000 });
  assert.equal(consumePosCartHandoff(storage, "other", 2000), null);
  queuePosCartHandoff(storage, { profileId: "biz1", items: [{ productId: "prod1", quantity: 2 }], createdAt: 1000 });
  assert.equal(consumePosCartHandoff(storage, "biz1", 2000)?.items[0].quantity, 2);
  assert.equal(consumePosCartHandoff(storage, "biz1", 2000), null);
});

test('Wrong-profile POS read preserves the handoff until its owner consumes it',()=>{
 const values=new Map<string,string>();const storage={getItem:(key:string)=>values.get(key)??null,setItem:(key:string,value:string)=>{values.set(key,value);},removeItem:(key:string)=>{values.delete(key);}};
 queuePosCartHandoff(storage,{profileId:'biz1',items:[{productId:'p',quantity:2}],createdAt:1000});assert.equal(consumePosCartHandoff(storage,'other',2000),null);assert.equal(consumePosCartHandoff(storage,'biz1',2000)?.items[0].quantity,2);assert.equal(consumePosCartHandoff(storage,'biz1',2000),null);
});

test('Advisory stock and employee questions cannot enter the app action registry',()=>{
 for(const q of ['Should I increase Burger stock by 10?','Should I add an employee named Roger?','How many employees did I add?'])assert.equal(interpretAppAction(q,ctx()).status,'not-action',q);
});

const kanto:Profile={...business,id:'kanto',name:'Kanto Food Truck'};
const sofia:Profile={...personal,id:'sofia',name:'Sofia'};
test('Phase 2A general conversation never invents a business reference',()=>{
 for(const q of ['Hi Bucky! Explain in two sentences how you can help a small business owner manage their finances.','What can you do?','Explain bookkeeping for beginners.']){assert.equal(resolveNamedProfile(q,[kanto,sofia]).status,'none',q);assert.equal(isGeneralBuckyConversation(q),true,q);assert.equal(interpretAppAction(q,ctx()).status,'not-action',q);}
});
test('Phase 2A exact named analysis, ambiguity and full name boundaries stay safe',()=>{
 assert.equal(resolveNamedProfile('Analyze Kanto Food Truck sales.',[kanto,sofia]).profile?.id,'kanto');
 assert.equal(resolveNamedProfile('How much did Sofia save?',[kanto,sofia]).profile?.id,'sofia');
 assert.equal(resolveNamedProfile('Compare my businesses.',[kanto,sofia]).status,'none');
 assert.equal(resolveNamedProfile('What about Xsofia?',[sofia]).status,'none');
 assert.equal(resolveNamedProfile('Analyze Kanto Food Truck sales.',[kanto,{...kanto,id:'duplicate'}]).status,'ambiguous');
 const special={...kanto,name:'Kanto (Main)'};assert.equal(resolveNamedProfile('Analyze Kanto (Main) sales.',[special]).status,'matched');
});
test('Phase 2A named actions retain safe target and correct employee fields',()=>{
 const food={...burger,profileId:'kanto',name:'Chicken Rice Bowl',stock:20};const context=ctx({profile:kanto,products:[food]});
 const stock=interpretAppAction('Increase Chicken Rice Bowl stock by 10 under Kanto Food Truck.',context);assert.equal(stock.status,'proposal');if(stock.status==='proposal'){assert.equal(stock.action.profileId,'kanto');assert.equal(stock.action.kind,'adjust-stock');}
 assert.equal(interpretAppAction('Should I increase Chicken Rice Bowl stock by 10?',context).status,'not-action');
 const text='Add Michael as an employee under Kanto Food Truck with a monthly salary of ₱15,000.';assert.equal(resolveNamedProfile(text,[kanto,sofia]).profile?.id,'kanto');const employee=interpretAppAction(text,context);assert.equal(employee.status,'proposal');if(employee.status==='proposal'&&employee.action.kind==='create-employee'){assert.equal(employee.action.name,'Michael');assert.equal(employee.action.profileId,'kanto');assert.equal(employee.action.salaryRateMinor,1500000);assert.equal(employee.action.salaryFrequency,'monthly');assert.equal(employee.action.role,null);}else assert.fail('employee proposal required');
});
test('Phase 2A genuinely explicit unknown businesses stop rather than falling back',()=>{
 for(const q of ['Increase Chicken Rice Bowl stock by 10 under Missing Store.','Add employee Michael under my Missing Store business.','Record ₱500 expense under business named Ghost.','Record ₱500 expense in Ghost business.','Add employee Sofia under Missing Store.']){assert.equal(resolveNamedProfile(q,[kanto,sofia]).status,'named-missing',q);}
});

test('Financial scope uses explicit names, unique entities or page context; never a default Sofia',()=>{
 const profiles=[kanto,sofia];const records={products:[{...burger,profileId:'kanto'}],employees:[],buckets:[{id:'goal',profileId:'sofia',name:'iPhone',kind:'savings',currency:'PHP',targetMinor:5000,createdAt:stamp,updatedAt:stamp}]};
 assert.equal(resolveBuckyRecordProfile('How much did Sofia save?',profiles,records).profile?.id,'sofia');assert.equal(resolveBuckyRecordProfile('Increase Burger stock by 10',profiles,records).profile?.id,'kanto');assert.equal(resolveBuckyRecordProfile('Add ₱500 to my iPhone savings',profiles,records).profile?.id,'sofia');assert.equal(resolveBuckyRecordProfile('Show my expenses',profiles,records).status,'none');assert.equal(resolveBuckyRecordProfile('Show my expenses',profiles,{...records,pageProfileId:'kanto'}).profile?.id,'kanto');assert.equal(resolveBuckyRecordProfile('Compare my businesses',[kanto,{...kanto,id:'second',name:'Second Store'},sofia],records).status,'ambiguous');
});
