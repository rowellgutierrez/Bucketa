import type {Profile,Bucket,Transaction,Product,Employee,Sale} from '../data/types.ts';
import {validateProfile,validateBucket,validateTransaction,validateProduct,validateEmployee,validateSale} from '../data/validation.ts';
import {buildSale} from './pos.ts';
import {buildCompensationTransaction} from './employees.ts';

/**
 * Fictional USD judge demo dataset — September 1 to November 4, 2026.
 *
 * Two businesses and one personal profile, all in USD, with consistent
 * deterministic IDs (DEMO_PREFIX), valid schema records, reconciled
 * inventory (opening stock − sold = stock), and employee payments
 * linked by relatedId. Clearly fictional; never real user data.
 * Initialization is explicit and idempotent (see demoWorkspace.ts):
 * it only adds these prefixed records and never overwrites, deletes,
 * or modifies any existing record.
 */
export const DEMO_PREFIX='demo-2026-v1:';
export const DEMO_START='2026-09-01';
export const DEMO_END='2026-11-04';
export interface DemoDataset {profiles:Profile[];buckets:Bucket[];transactions:Transaction[];products:Product[];employees:Employee[];sales:Sale[]}
export function isApprovedTestProfile(profile:Profile){return /^QA(?:\s|$)/i.test(profile.name.trim())||['test store','iphone'].includes(profile.name.trim().toLowerCase());}

const DAY_MS=86_400_000;
const startMs=Date.UTC(2026,8,1);
const day=(offset:number)=>new Date(startMs+offset*DAY_MS).toISOString().slice(0,10);
const stamp=(offset:number,hour='09')=>day(offset)+'T'+hour+':00:00.000Z';

interface BusinessSpec {
  key:string; name:string;
  products:{name:string;price:number;cost:number;stock:number;category:string}[];
  employees:{name:string;role:string;rate:number;frequency:'monthly'|'hourly'}[];
  salesCount:number; incomeLabel:string;
}
const BUSINESSES:BusinessSpec[]=[
  { key:'harbor', name:'Harbor Mini Market', incomeLabel:'Wholesale neighborhood order', salesCount:72,
    products:[
      {name:'Rice 1 kg',price:349,cost:210,stock:42,category:'Groceries'},
      {name:'Canned tuna',price:189,cost:110,stock:35,category:'Groceries'},
      {name:'Instant noodles',price:99,cost:55,stock:58,category:'Groceries'},
      {name:'Bottled water 1 L',price:79,cost:35,stock:64,category:'Drinks'},
      {name:'Cooking oil 1 L',price:499,cost:320,stock:18,category:'Groceries'},
      {name:'Coffee sachets (10 pack)',price:599,cost:360,stock:24,category:'Drinks'},
      {name:'Fresh eggs (12 pack)',price:429,cost:280,stock:2,category:'Groceries'},
      {name:'Milk 1 L',price:259,cost:170,stock:0,category:'Groceries'},
      {name:'Laundry soap',price:449,cost:260,stock:21,category:'Household'},
      {name:'Sugar 500 g',price:149,cost:85,stock:33,category:'Groceries'},
      {name:'Soy sauce',price:179,cost:95,stock:27,category:'Groceries'},
      {name:'Biscuits',price:129,cost:70,stock:47,category:'Snacks'},
    ],
    employees:[
      {name:'Maya Chen',role:'Cashier',rate:110000,frequency:'monthly'},
      {name:'Diego Alvarez',role:'Stock assistant',rate:105000,frequency:'monthly'},
      {name:'Priya Nair',role:'Shift lead',rate:125000,frequency:'monthly'},
    ] },
  { key:'cafe', name:'Corner Café', incomeLabel:'Catering order deposit', salesCount:60,
    products:[
      {name:'Espresso',price:350,cost:90,stock:80,category:'Drinks'},
      {name:'Cappuccino',price:475,cost:130,stock:72,category:'Drinks'},
      {name:'Café latte',price:495,cost:140,stock:66,category:'Drinks'},
      {name:'Cold brew',price:525,cost:150,stock:38,category:'Drinks'},
      {name:'Butter croissant',price:325,cost:120,stock:14,category:'Bakery'},
      {name:'Blueberry muffin',price:375,cost:135,stock:3,category:'Bakery'},
      {name:'Banana bread slice',price:295,cost:100,stock:22,category:'Bakery'},
      {name:'Chicken sandwich',price:850,cost:340,stock:16,category:'Meals'},
      {name:'Coffee beans 250 g',price:1299,cost:700,stock:9,category:'Retail'},
      {name:'Hot chocolate',price:450,cost:150,stock:29,category:'Drinks'},
    ],
    employees:[
      {name:'Sofia Reyes',role:'Barista',rate:105000,frequency:'monthly'},
      {name:'James Okafor',role:'Baker',rate:115000,frequency:'monthly'},
      {name:'Lena Fischer',role:'Server',rate:100000,frequency:'monthly'},
    ] },
];

export function createDemoDataset(_revision: 'original' | 'current' = 'current'):{data:DemoDataset;openingStock:Record<string,number>}{
  void _revision; // Single current revision; kept for caller compatibility.
  const data:DemoDataset={profiles:[],buckets:[],transactions:[],products:[],employees:[],sales:[]};
  const openingStock:Record<string,number>={};
  const add=(profile:Profile,offset:number,type:Transaction['type'],amountMinor:number,description:string,category:string|null,bucketId:string|null=null,extra:Partial<Transaction>={})=>{
    const record:Transaction={id:DEMO_PREFIX+'txn-'+data.transactions.length,profileId:profile.id,bucketId,type,amountMinor,currency:'USD',date:day(offset),description,category,origin:'manual',relatedId:null,createdAt:stamp(offset),updatedAt:stamp(offset),...extra};
    data.transactions.push(record);return record;
  };

  BUSINESSES.forEach((spec,shop)=>{
    const profile:Profile={id:DEMO_PREFIX+'business-'+shop,kind:'business',name:spec.name,currency:'USD',createdAt:stamp(0),updatedAt:stamp(64)};
    data.profiles.push(profile);
    const bucketNames:[string,Bucket['kind'],number|null][]=[
      ['Emergency reserve','savings',500000],
      ['Operating budget','budget',null],
      ['Supplier budget','budget',null],
      ['Equipment allocation','allocated',null],
    ];
    const buckets=bucketNames.map(([name,kind,targetMinor],index):Bucket=>({id:DEMO_PREFIX+`bucket-${spec.key}-${index}`,profileId:profile.id,name,kind,currency:'USD',targetMinor,createdAt:stamp(0),updatedAt:stamp(64)}));
    data.buckets.push(...buckets);
    const products=spec.products.map((p,index):Product=>({id:DEMO_PREFIX+`product-${spec.key}-${index}`,profileId:profile.id,name:p.name,sku:`DEMO-${spec.key.toUpperCase()}-${String(index+1).padStart(3,'0')}`,barcode:`BKT-DEMO-${spec.key.toUpperCase()}-${String(index+1).padStart(3,'0')}`,description:'Fictional demonstration catalog item.',color:null,category:p.category,priceMinor:p.price,costMinor:p.cost,currency:'USD',stock:p.stock,status:'active',createdAt:stamp(0),updatedAt:stamp(64)}));
    data.products.push(...products);
    const sold=new Map<string,number>();
    for(let i=0;i<spec.salesCount;i++){
      const offset=Math.floor(i*64/spec.salesCount);
      const first=products[i%products.length];
      const second=products[(i+3)%products.length];
      const picks=first.id===second.id?[first]:[first,second];
      const items=picks.map((product,j)=>{const quantity=1+((i+j)%3);sold.set(product.id,(sold.get(product.id)??0)+quantity);return{productId:product.id,name:product.name,sku:product.sku,unitPriceMinor:product.priceMinor,quantity,lineTotalMinor:quantity*product.priceMinor};});
      const total=items.reduce((sum,item)=>sum+item.lineTotalMinor,0);
      const createdAt=stamp(offset,String(10+(i%8)).padStart(2,'0'));
      data.sales.push({...buildSale({id:DEMO_PREFIX+`sale-${spec.key}-${i}`,profileId:profile.id,currency:'USD',items,amountReceivedMinor:Math.ceil(total/100)*100,createdAt}),updatedAt:createdAt});
    }
    for(const product of products)openingStock[product.id]=product.stock+(sold.get(product.id)??0);
    // Operating income and expenses across September–November.
    for(let w=0;w<9;w++) add(profile,3+w*7,'income',(shop===0?260000:240000)+((w*137+shop*61)%40)*100,spec.incomeLabel,'Wholesale & services');
    for(let d=0;d<22;d++) add(profile,1+d*3,'expense',(shop===0?32000:28000)+((d*89+shop*37)%60)*100,'Supplier restock invoice','Supplies',buckets[2].id);
    for(const m of [0,31,61]) add(profile,m,'expense',shop===0?90000:75000,'Monthly rent','Rent',buckets[1].id);
    for(const m of [4,35,63]) add(profile,m,'expense',8600+shop*1200,'Electricity and water','Utilities',buckets[1].id);
    for(const m of [6,37]) add(profile,m,'expense',24000+shop*3500,'Equipment maintenance','Equipment',buckets[3].id);
    for(const m of [8,39,62]) add(profile,m,'savings-deposit',25000,'Deposit to Emergency reserve',null,buckets[0].id);
    // Employees and monthly salary history (Sep 15, Oct 15, Nov 1) plus an October bonus for the first employee.
    spec.employees.forEach((e,employeeIndex)=>{
      const employee:Employee={id:DEMO_PREFIX+`employee-${spec.key}-${employeeIndex}`,profileId:profile.id,name:e.name,role:e.role,status:'active',salaryFrequency:e.frequency,salaryRateMinor:e.rate,currency:'USD',startDate:DEMO_START,createdAt:stamp(0),updatedAt:stamp(64)};
      data.employees.push(employee);
      [14,45,61].forEach((offset,payment)=>{
        data.transactions.push(buildCompensationTransaction({id:DEMO_PREFIX+`payment-${spec.key}-${employeeIndex}-${payment}`,employee,type:'salary',amountMinor:e.rate,currency:'USD',date:day(offset),note:'Monthly salary',timestamp:stamp(offset)}));
      });
      if(employeeIndex===0) data.transactions.push(buildCompensationTransaction({id:DEMO_PREFIX+`payment-${spec.key}-0-bonus`,employee,type:'bonus',amountMinor:15000,currency:'USD',date:day(60),note:'Reviewed October bonus',timestamp:stamp(60)}));
    });
  });

  // Personal Finance — Alex Morgan (USD).
  const personal:Profile={id:DEMO_PREFIX+'personal',kind:'personal',name:'Alex Morgan',currency:'USD',createdAt:stamp(0),updatedAt:stamp(64)};
  data.profiles.push(personal);
  const emergency:Bucket={id:DEMO_PREFIX+'personal-emergency',profileId:personal.id,name:'Emergency fund',kind:'savings',currency:'USD',targetMinor:500000,createdAt:stamp(0),updatedAt:stamp(64)};
  const laptop:Bucket={id:DEMO_PREFIX+'personal-laptop',profileId:personal.id,name:'Laptop savings',kind:'savings',currency:'USD',targetMinor:180000,createdAt:stamp(0),updatedAt:stamp(64)};
  const household:Bucket={id:DEMO_PREFIX+'personal-household',profileId:personal.id,name:'Household budget',kind:'budget',currency:'USD',targetMinor:null,createdAt:stamp(0),updatedAt:stamp(64)};
  data.buckets.push(emergency,laptop,household);
  for(const offset of [4,35,61]) add(personal,offset,'income',320000,'Monthly salary','Salary');
  for(const offset of [19,50]) add(personal,offset,'income',45000,'Freelance project payment','Freelance');
  for(const offset of [0,31,61]) add(personal,offset,'expense',110000,'Rent','Housing',household.id);
  for(let w=0;w<9;w++){ add(personal,2+w*7,'expense',8200+(w*317)%3600,'Groceries','Household',household.id); add(personal,3+w*7,'expense',2400+(w*211)%1800,'Transport','Transport & bills',household.id); }
  for(const offset of [9,40,63]) add(personal,offset,'savings-deposit',30000,'Deposit to Emergency fund',null,emergency.id);
  add(personal,54,'savings-withdrawal',10000,'Withdrawal from Emergency fund',null,emergency.id);
  for(const offset of [11,42,64]) add(personal,offset,'savings-deposit',25000,'Deposit to Laptop savings',null,laptop.id);

  validateDemoDataset(data,openingStock);
  return{data,openingStock};
}

export function validateDemoDataset(data:DemoDataset,openingStock:Record<string,number>){
  const validators={profiles:validateProfile,buckets:validateBucket,transactions:validateTransaction,products:validateProduct,employees:validateEmployee,sales:validateSale};
  const ids=new Set<string>();for(const [store,records] of Object.entries(data))for(const record of records){if(ids.has(record.id))throw Error('Duplicate demo ID');ids.add(record.id);(validators[store as keyof typeof validators] as (r:unknown)=>unknown)(record);}
  for(const profile of data.profiles)if(profile.currency!=='USD')throw Error('Demo dataset must use USD exclusively');
  const profiles=new Map(data.profiles.map(p=>[p.id,p])),buckets=new Map(data.buckets.map(b=>[b.id,b])),products=new Map(data.products.map(p=>[p.id,p])),employees=new Map(data.employees.map(e=>[e.id,e]));
  for(const record of [...data.buckets,...data.products,...data.transactions,...data.sales,...data.employees]){const profile=profiles.get(record.profileId);if(!profile||record.currency!=='USD'||profile.currency!=='USD')throw Error('Demo profile/currency mismatch');}
  const balances=new Map<string,number>();
  for(const t of [...data.transactions].sort((a,b)=>a.date.localeCompare(b.date)||a.createdAt.localeCompare(b.createdAt)||a.id.localeCompare(b.id))){if(t.date<DEMO_START||t.date.slice(0,10)>DEMO_END)throw Error('Invalid demo date');if(t.bucketId){const b=buckets.get(t.bucketId);if(!b||b.profileId!==t.profileId||b.currency!==t.currency)throw Error('Invalid demo bucket');if(t.type==='savings-deposit'||t.type==='savings-withdrawal'){const balance=(balances.get(b.id)??0)+(t.type==='savings-deposit'?t.amountMinor:-t.amountMinor);if(balance<0)throw Error('Demo savings overdraft');balances.set(b.id,balance);}}if(t.relatedId&&t.category&&['Salaries','Bonuses','Advances'].includes(t.category)&&employees.get(t.relatedId)?.profileId!==t.profileId)throw Error('Invalid employee payment');}
  for(const sale of data.sales){if(sale.createdAt.slice(0,10)<DEMO_START||sale.createdAt.slice(0,10)>DEMO_END)throw Error('Invalid demo sale date');}
  const sold=new Map<string,number>();for(const sale of data.sales)for(const item of sale.items){const product=products.get(item.productId);if(!product||product.profileId!==sale.profileId||product.currency!==sale.currency||product.priceMinor!==item.unitPriceMinor)throw Error('Invalid sale linkage');sold.set(product.id,(sold.get(product.id)??0)+item.quantity);}
  for(const product of data.products)if(openingStock[product.id]-(sold.get(product.id)??0)!==product.stock)throw Error('Inventory does not reconcile');
}
