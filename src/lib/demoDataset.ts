import type {Profile,Bucket,Transaction,Product,Employee,Sale} from '../data/types.ts';
import {validateProfile,validateBucket,validateTransaction,validateProduct,validateEmployee,validateSale} from '../data/validation.ts';
import {buildSale} from './pos.ts';
import {buildCompensationTransaction} from './employees.ts';
export const DEMO_PREFIX='demo-2026-v1:';
export interface DemoDataset {profiles:Profile[];buckets:Bucket[];transactions:Transaction[];products:Product[];employees:Employee[];sales:Sale[]}
export function isApprovedTestProfile(profile:Profile){return /^QA(?:\s|$)/i.test(profile.name.trim())||['test store','iphone'].includes(profile.name.trim().toLowerCase());}
const day=(n:number)=>new Date(Date.UTC(2026,9,n)).toISOString().slice(0,10);
const stamp=(n:number,hour='09')=>day(n)+'T'+hour+':00:00+08:00';
export function createDemoDataset(revision: 'original' | 'current' = 'current'):{data:DemoDataset;openingStock:Record<string,number>}{
 const data:DemoDataset={profiles:[],buckets:[],transactions:[],products:[],employees:[],sales:[]};
 const openingStock:Record<string,number>={};
 const add=(profile:Profile,n:number,type:Transaction['type'],amountMinor:number,description:string,category:string|null,bucketId:string|null=null,extra:Partial<Transaction>={})=>{
  const record:Transaction={id:DEMO_PREFIX+'txn-'+data.transactions.length,profileId:profile.id,bucketId,type,amountMinor,currency:profile.currency,date:day(n),description,category,origin:'manual',relatedId:null,createdAt:stamp(n),updatedAt:stamp(n),...extra};data.transactions.push(record);return record;
 };
 const shops=['Luna Sari-Sari Store','Kanto Food Truck','Bayan Mini Grocery','Harbor Coffee Shop'];
 const names=[['Rice 1 kg','Sardines','Instant noodles','Bottled water','Laundry soap','Canned tuna','Cooking oil','Coffee sachets','Biscuits','Milk powder','Sugar 500 g','Soy sauce','Vinegar','Corned beef','Crackers','Shampoo sachets','Toothpaste','Juice drink','Chocolate bar','Seasonal snack'],['Chicken rice bowl','Pork rice bowl','Vegetable bowl','Beef wrap','Fish tacos','Fries','Soup cup','Iced tea','Lemonade','Bottled water','Chicken sandwich','Cheese burger','Rice side','Extra sauce','Salad bowl','Noodle bowl','Fruit cup','Brownie','Cookie','Seasonal wrap'],['Jasmine rice','Brown rice','Fresh eggs 6 pack','Bread loaf','Fresh milk','Cheddar cheese','Apples 4 pack','Bananas 1 kg','Tomatoes 500 g','Potatoes 1 kg','Onions 500 g','Frozen chicken','Pasta 500 g','Pasta sauce','Orange juice','Mineral water','Dish soap','Paper towels','Yogurt cup','Seasonal cereal'],['Espresso','Americano','Cappuccino','Cafe latte','Flat white','Mocha','Cold brew','Iced latte','Caramel latte','Matcha latte','Chai tea','Hot chocolate','Butter croissant','Blueberry muffin','Banana bread','Chocolate cookie','Bagel','Bottled water','Coffee beans 250 g','Seasonal blend']];
 for(let shop=0;shop<4;shop++){
  const profile:Profile={id:DEMO_PREFIX+'business-'+shop,kind:'business',name:shops[shop],currency:shop===3?'USD':'PHP',createdAt:stamp(1),updatedAt:stamp(34)};data.profiles.push(profile);
  const buckets=['Emergency reserve','Operating budget','Supplier budget','Equipment allocation'].map((name,index):Bucket=>({id:DEMO_PREFIX+`bucket-${shop}-${index}`,profileId:profile.id,name,kind:index===0?'savings':index===3?'allocated':'budget',currency:profile.currency,targetMinor:index===0?(shop===3?150000:3000000):null,createdAt:stamp(1),updatedAt:stamp(34)}));data.buckets.push(...buckets);
  const products=names[shop].map((name,index):Product=>({id:DEMO_PREFIX+`product-${shop}-${index}`,profileId:profile.id,name,sku:`D${shop}-${String(index+1).padStart(3,'0')}`,barcode:`BKT-DEMO-${shop}-${String(index+1).padStart(3,'0')}`,description:'Fictional demonstration catalog item.',color:null,category:shop===3?(index<12?'Drinks':'Bakery & retail'):shop===1?(index<7?'Meals':'Sides & drinks'):index<12?'Groceries':'Household',priceMinor:shop===3?250+index*25:shop===1?6500+index*350:1500+index*225,costMinor:null,currency:profile.currency,stock:index===0?2:index===1?0:35+index*4,status:index===19?'archived':'active',createdAt:stamp(1),updatedAt:stamp(34)}));data.products.push(...products);
  const sold=new Map<string,number>();
  for(let saleIndex=0;saleIndex<50;saleIndex++){
   const n=1+Math.floor(saleIndex*34/50);
   const items=[products[saleIndex%19],products[(saleIndex+7)%19]].map((product,index)=>{const quantity=1+(saleIndex+index)%3;sold.set(product.id,(sold.get(product.id)??0)+quantity);return{productId:product.id,name:product.name,sku:product.sku,unitPriceMinor:product.priceMinor,quantity,lineTotalMinor:quantity*product.priceMinor};});
   const total=items.reduce((sum,item)=>sum+item.lineTotalMinor,0),createdAt=stamp(n,String(10+saleIndex%8));
   data.sales.push({...buildSale({id:DEMO_PREFIX+`sale-${shop}-${saleIndex}`,profileId:profile.id,currency:profile.currency,items,amountReceivedMinor:Math.ceil(total/100)*100,createdAt}),updatedAt:createdAt});
  }
  for(const product of products)openingStock[product.id]=product.stock+(sold.get(product.id)??0);
  for(let n=1;n<=34;n++){
   const unit=shop===3?100:1000;
   add(profile,n,'income',Math.round((50+(n*7+shop*11)%90)*unit*(revision==='current'&&shop<3?1.7:1)),shop===1?'Catering order deposit':shop===3?'Office coffee delivery':'Wholesale neighborhood order','Wholesale & services');
   add(profile,n,'expense',(15+(n*3)%25)*unit,shop===1?'Fresh market ingredients':'Supplier restock invoice','Supplies',buckets[2].id,n%7===0?{origin:'scanner-confirmed',relatedId:DEMO_PREFIX+`receipt-${shop}-${n}`} : {});
   add(profile,n,'expense',(8+(n+shop*4)%20)*unit,n%4===0?'Equipment maintenance':n%3===0?'Electricity and water':'Delivery and operating supplies',n%4===0?'Equipment':n%3===0?'Utilities':'Operations',buckets[n%4===0?3:1].id);
  }
  for(let index=0;index<4;index++)add(profile,4+index*8,'savings-deposit',(shop===3?15000:150000)*(shop+1),`Deposit to ${buckets[0].name}`,null,buckets[0].id);
  add(profile,33,'savings-withdrawal',shop===3?5000:50000,`Withdrawal from ${buckets[0].name}`,null,buckets[0].id);
  for(let employeeIndex=0;employeeIndex<4;employeeIndex++){
   const employee:Employee={id:DEMO_PREFIX+`employee-${shop}-${employeeIndex}`,profileId:profile.id,name:[[revision==='original'?'Mara Santos':'Clara Dela Cruz','Leo Reyes','Nina Cruz','Ben Flores'],['Carlo Ramos','Ana Torres','Luis Garcia','Rosa Lim'],['Ella Mendoza','Noel Aquino','Mia Castillo','Ivan Tan'],['Alex Parker','Jamie Quinn','Morgan Lee','Taylor Reed']][shop][employeeIndex],role:['Cashier','Stock assistant','Shift lead','Store assistant'][employeeIndex],status:'active',salaryFrequency:shop===3?'hourly':'daily',salaryRateMinor:shop===3?1200:60000,currency:profile.currency,startDate:'2026-10-01',createdAt:stamp(1),updatedAt:stamp(34)};data.employees.push(employee);
   for(let payment=0;payment<3;payment++)data.transactions.push(buildCompensationTransaction({id:DEMO_PREFIX+`payment-${shop}-${employeeIndex}-${payment}`,employee,type:payment<2?'salary':employeeIndex%2?'advance':'bonus',amountMinor:payment<2?(shop===3?48000:300000):(shop===3?5000:50000),currency:profile.currency,date:day(payment<2?15+payment*15:34),note:payment<2?(shop===3?'USD 12 × 40 hours':'PHP 600 × 5 days'):'Reviewed discretionary payment',timestamp:stamp(payment<2?15+payment*15:34)}));
  }
 }
 const personal:Profile={id:DEMO_PREFIX+'personal',kind:'personal',name:'Sofia',currency:'PHP',createdAt:stamp(1),updatedAt:stamp(34)};data.profiles.push(personal);
 for(const n of [15,30])add(personal,n,'income',4500000,'Monthly salary installment','Salary');
 for(let n=1;n<=34;n++){add(personal,n,'expense',12000+(n*1731)%40000,n%2?'Market groceries':'Meals and household supplies','Household');add(personal,n,'expense',5000+(n*811)%14000,n%3?'Commute and transport':'Mobile and internet','Transport & bills');}
 const goals=['Emergency reserve','New laptop','Family vacation','Home repairs','Healthcare fund','Education fund','Holiday gifts','Bicycle','Skills course','Moving fund'];
 const targets=[5000000,600000,300000,200000,500000,400000,150000,350000,120000,300000],ratios=[.15,.35,.6,1,1.2,0,.85,.4,.7,.25];
 goals.forEach((name,index)=>{const bucket:Bucket={id:DEMO_PREFIX+'personal-goal-'+index,profileId:personal.id,name,kind:'savings',currency:'PHP',targetMinor:targets[index],createdAt:stamp(1),updatedAt:stamp(34)};data.buckets.push(bucket);const final=Math.round(targets[index]*ratios[index]);if(!final)return;const withdrawal=10000,gross=final+withdrawal,part=Math.floor(gross/4);for(let i=0;i<4;i++)add(personal,5+i*8,'savings-deposit',i===3?gross-part*3:part,`Deposit to ${name}`,null,bucket.id);add(personal,33,'savings-withdrawal',withdrawal,`Withdrawal from ${name}`,null,bucket.id);});
 validateDemoDataset(data,openingStock);return{data,openingStock};
}
export function validateDemoDataset(data:DemoDataset,openingStock:Record<string,number>){
 const validators={profiles:validateProfile,buckets:validateBucket,transactions:validateTransaction,products:validateProduct,employees:validateEmployee,sales:validateSale};
 const ids=new Set<string>();for(const [store,records] of Object.entries(data))for(const record of records){if(ids.has(record.id))throw Error('Duplicate demo ID');ids.add(record.id);(validators[store as keyof typeof validators] as (r:unknown)=>unknown)(record);}
 const profiles=new Map(data.profiles.map(p=>[p.id,p])),buckets=new Map(data.buckets.map(b=>[b.id,b])),products=new Map(data.products.map(p=>[p.id,p])),employees=new Map(data.employees.map(e=>[e.id,e]));
 for(const record of [...data.buckets,...data.products,...data.transactions,...data.sales,...data.employees]){const profile=profiles.get(record.profileId);if(!profile||record.currency!==profile.currency)throw Error('Demo profile/currency mismatch');}
 const balances=new Map<string,number>();
 for(const t of [...data.transactions].sort((a,b)=>a.date.localeCompare(b.date)||a.createdAt.localeCompare(b.createdAt)||a.id.localeCompare(b.id))){if(t.date<'2026-10-01'||t.date.slice(0,10)>'2026-11-03')throw Error('Invalid demo date');if(t.bucketId){const b=buckets.get(t.bucketId);if(!b||b.profileId!==t.profileId||b.currency!==t.currency)throw Error('Invalid demo bucket');if(t.type==='savings-deposit'||t.type==='savings-withdrawal'){const balance=(balances.get(b.id)??0)+(t.type==='savings-deposit'?t.amountMinor:-t.amountMinor);if(balance<0)throw Error('Demo savings overdraft');balances.set(b.id,balance);}}if(t.relatedId&&t.category&&['Salaries','Bonuses','Advances'].includes(t.category)&&employees.get(t.relatedId)?.profileId!==t.profileId)throw Error('Invalid employee payment');}
 const sold=new Map<string,number>();for(const sale of data.sales)for(const item of sale.items){const product=products.get(item.productId);if(!product||product.profileId!==sale.profileId||product.currency!==sale.currency||product.priceMinor!==item.unitPriceMinor)throw Error('Invalid sale linkage');sold.set(product.id,(sold.get(product.id)??0)+item.quantity);}
 for(const product of data.products)if(openingStock[product.id]-(sold.get(product.id)??0)!==product.stock)throw Error('Inventory does not reconcile');
}
