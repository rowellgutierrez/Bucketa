import {openDb} from './db.ts';
import type {Profile,StoreName} from './types';
import {createDemoDataset,DEMO_PREFIX,isApprovedTestProfile,type DemoDataset} from '../lib/demoDataset.ts';
export const BACKUP_STORES:StoreName[]=['profiles','buckets','transactions','products','employees','sales','settings'];
type Row={id:string;profileId?:string;bucketId?:string|null;relatedId?:string|null;items?:{productId:string}[]};
export interface LocalBackup {format:'bucketa-local-backup-v1';schema:1;exportedAt:string;stores:Record<StoreName,Row[]>}
export function backupText(backup:LocalBackup){return JSON.stringify(backup,null,2);}
export function sameStores(a:LocalBackup,b:LocalBackup){return JSON.stringify(a.stores)===JSON.stringify(b.stores);}
export function parseBackup(text:string):LocalBackup{
 const parsed=JSON.parse(text) as LocalBackup;
 if(parsed.format!=='bucketa-local-backup-v1'||parsed.schema!==1||!parsed.stores||!BACKUP_STORES.every(store=>Array.isArray(parsed.stores[store])&&parsed.stores[store].every(row=>typeof row.id==='string')))throw Error('This is not a compatible Bucketa backup.');
 return parsed;
}
export async function readLocalBackup():Promise<LocalBackup>{
 const db=await openDb();return new Promise((resolve,reject)=>{
  const tx=db.transaction(BACKUP_STORES,'readonly'),stores={} as LocalBackup['stores'];
  tx.onabort=tx.onerror=()=>reject(Error('Could not read the local records. Nothing changed.'));
  tx.oncomplete=()=>resolve({format:'bucketa-local-backup-v1',schema:1,exportedAt:new Date().toISOString(),stores});
  BACKUP_STORES.forEach(name=>{const request=tx.objectStore(name).getAll();request.onsuccess=()=>{stores[name]=request.result;};});
 });
}
function validateScope(backup:LocalBackup,ids:Set<string>){
 const profiles=backup.stores.profiles as unknown as Profile[];
 if(!ids.size||[...ids].some(id=>!profiles.some(p=>p.id===id&&isApprovedTestProfile(p))))throw Error('Replacement is limited to explicitly identified fictional test profiles.');
 const owned=new Set<string>();for(const name of BACKUP_STORES)for(const row of backup.stores[name])if(ids.has(row.id)||ids.has(row.profileId??''))owned.add(row.id);
 for(const name of BACKUP_STORES)for(const row of backup.stores[name])if(!owned.has(row.id)&&((row.bucketId&&owned.has(row.bucketId))||(row.relatedId&&owned.has(row.relatedId))||row.items?.some(item=>owned.has(item.productId))))throw Error('A record outside the selected test profiles references them. Replacement stopped.');
}
async function atomicChange(expected:LocalBackup,remove:(row:Row,store:StoreName)=>boolean,insert:Partial<Record<StoreName,Row[]>>){
 const db=await openDb();return new Promise<void>((resolve,reject)=>{
  const tx=db.transaction(BACKUP_STORES,'readwrite'),current={} as LocalBackup['stores'];let pending=BACKUP_STORES.length,failure:unknown;
  tx.oncomplete=()=>resolve();tx.onabort=tx.onerror=()=>reject(failure??Error('The replacement did not commit. Existing records were preserved.'));
  BACKUP_STORES.forEach(name=>{const request=tx.objectStore(name).getAll();request.onsuccess=()=>{current[name]=request.result;if(--pending)return;try{
   if(!sameStores(expected,{...expected,stores:current}))throw Error('Local records changed after the backup. Download and verify a fresh backup first.');
   for(const store of BACKUP_STORES){if(store==='settings')continue;for(const row of current[store])if(remove(row,store))tx.objectStore(store).delete(row.id);for(const row of insert[store]??[])tx.objectStore(store).add(row);}
  }catch(error){failure=error;tx.abort();}};});
 });
}
export async function replaceFictionalWorkspace(backup:LocalBackup,profileIds:string[]){
 const ids=new Set(profileIds);validateScope(backup,ids);
 if(backup.stores.profiles.some(row=>row.id.startsWith(DEMO_PREFIX)))throw Error('This demo dataset is already installed. No records were changed.');
 const {data}=createDemoDataset();
 await atomicChange(backup,row=>ids.has(row.id)||ids.has(row.profileId??''),data as unknown as Record<keyof DemoDataset,Row[]>);
 return Object.fromEntries(Object.entries(data).map(([store,records])=>[store,records.length]));
}
/** Recovery refuses to overwrite edits made after seeding or unrelated data. */
export async function restoreFictionalWorkspace(backup:LocalBackup){
 const current=await readLocalBackup();
 const candidates=[createDemoDataset().data,createDemoDataset('original').data];
 const data=candidates.find(dataset=>Object.keys(dataset).every(store=>JSON.stringify([...current.stores[store as keyof DemoDataset]].filter(row=>row.id.startsWith(DEMO_PREFIX)).sort((a,b)=>a.id.localeCompare(b.id)))===JSON.stringify([...(dataset[store as keyof DemoDataset] as unknown as Row[])].sort((a,b)=>a.id.localeCompare(b.id)))))??candidates[0];
 const stable=(records:Row[])=>JSON.stringify([...records].sort((a,b)=>a.id.localeCompare(b.id)));
 for(const store of Object.keys(data) as (keyof DemoDataset)[])if(stable(current.stores[store].filter(row=>row.id.startsWith(DEMO_PREFIX)))!==stable(data[store] as unknown as Row[]))throw Error('Demo records were edited or are incomplete. Recovery stopped to protect those changes.');
 const profiles=backup.stores.profiles as unknown as Profile[];
 const ids=new Set(profiles.filter(p=>isApprovedTestProfile(p)&&!current.stores.profiles.some(row=>row.id===p.id)).map(p=>p.id));validateScope(backup,ids);
 const insert:Partial<Record<StoreName,Row[]>>={};
 for(const store of BACKUP_STORES){if(store==='settings')continue;const keep=current.stores[store].filter(row=>!row.id.startsWith(DEMO_PREFIX));const original=backup.stores[store].filter(row=>!ids.has(row.id)&&!ids.has(row.profileId??''));if(stable(keep)!==stable(original))throw Error('Unrelated records changed since this backup. Recovery stopped.');insert[store]=backup.stores[store].filter(row=>ids.has(row.id)||ids.has(row.profileId??''));}
 await atomicChange(current,row=>row.id.startsWith(DEMO_PREFIX),insert);
}

/** Pure update plan. Refuses edited, partial or augmented demo workspaces. */
export function planDemoUpdate(backup:LocalBackup){
 const current=createDemoDataset().data,original=createDemoDataset('original').data;
 const stable=(rows:Row[])=>JSON.stringify([...rows].sort((a,b)=>a.id.localeCompare(b.id)));
 const stores=Object.keys(current) as (keyof DemoDataset)[];
 const matches=(dataset:DemoDataset)=>stores.every(store=>stable(backup.stores[store].filter(row=>row.id.startsWith(DEMO_PREFIX)||row.profileId?.startsWith(DEMO_PREFIX)))===stable(dataset[store] as unknown as Row[]));
 if(matches(current))return {patch:{} as Partial<Record<StoreName,Row[]>>,ids:new Set<string>()};
 if(!matches(original))throw Error('Demo records were edited, added or are incomplete. Update stopped; no records changed. Keep your backup for individual review.');
 const patch:Partial<Record<StoreName,Row[]>>={},ids=new Set<string>();
 for(const store of stores){const previous=new Map((original[store] as unknown as Row[]).map(row=>[row.id,JSON.stringify(row)]));const changes=(current[store] as unknown as Row[]).filter(row=>previous.get(row.id)!==JSON.stringify(row));if(changes.length){patch[store]=changes;changes.forEach(row=>ids.add(row.id));}}
 for(const store of BACKUP_STORES)for(const row of backup.stores[store])if(!row.id.startsWith(DEMO_PREFIX)&&!row.profileId?.startsWith(DEMO_PREFIX)&&((row.relatedId&&ids.has(row.relatedId))||(row.bucketId&&ids.has(row.bucketId))||row.items?.some(item=>ids.has(item.productId))))throw Error('Unrelated records reference this demo. Update stopped.');
 return {patch,ids};
}
export async function updateFictionalDemo(backup:LocalBackup){
 const {patch,ids}=planDemoUpdate(backup);if(!ids.size)return 0;
 await atomicChange(backup,row=>ids.has(row.id),patch);return ids.size;
}

/**
 * Pure plan for the judge demo initialization. Idempotent: when every
 * demo record already exists, the plan is already-installed and carries
 * no writes. When no demo records exist, it carries the full USD
 * dataset. When a workspace is PARTIALLY installed (e.g. demo profiles
 * created by an older/incomplete load but their financial records are
 * missing), it carries only the demo records whose IDs are absent —
 * so re-running initialization repairs the workspace, adds the missing
 * income/expense/sales/salary records, never duplicates a record, and
 * never overwrites existing rows (demo or user).
 */
export function planJudgeDemoInitialization(backup:LocalBackup){
 const expected=createDemoDataset().data;
 const stores=Object.keys(expected) as (keyof DemoDataset)[];
 const missing={} as DemoDataset;let present=0,missingCount=0;
 for(const store of stores){
  const existingIds=new Set(backup.stores[store].map(row=>row.id));
  const rows=(expected[store] as unknown as Row[]).filter(row=>!existingIds.has(row.id));
  present+=(expected[store] as unknown as Row[]).length-rows.length;missingCount+=rows.length;
  missing[store]=rows as never;
 }
 if(missingCount===0)return {status:'already-installed' as const,data:null as DemoDataset|null};
 if(present===0 && !backup.stores.profiles.some(row=>row.id.startsWith(DEMO_PREFIX)))return {status:'ready' as const,data:expected};
 return {status:'repair' as const,data:missing};
}

/**
 * Explicit, safe, idempotent judge demo initialization.
 * Reads the current workspace, refuses to duplicate the demo, and
 * atomically adds only demo-prefixed records. Existing user records
 * are preserved untouched (remove predicate always false).
 */
export async function initializeJudgeDemoWorkspace(){
 const current=await readLocalBackup();
 const plan=planJudgeDemoInitialization(current);
 if(plan.status==='already-installed'||!plan.data){
  return {status:'already-installed' as const,counts:Object.fromEntries(Object.entries(createDemoDataset().data).map(([store])=>[store,current.stores[store as keyof DemoDataset].filter(row=>row.id.startsWith(DEMO_PREFIX)).length])) as Record<string,number>};
 }
 await atomicChange(current,()=>false,plan.data as unknown as Record<keyof DemoDataset,Row[]>);
 return {status:plan.status==='repair'?'repaired' as const:'installed' as const,counts:Object.fromEntries(Object.entries(plan.data).map(([store,records])=>[store,(records as unknown[]).length])) as Record<string,number>};
}
