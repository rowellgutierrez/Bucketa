import type {Transaction} from '../data/types.ts';
import {isValidCalendarDate} from './recordForm.ts';
export type HistoryPeriod='today'|'week'|'month'|'year'|'all'|'custom';
export const HISTORY_PERIODS:{value:HistoryPeriod;label:string}[]=[{value:'today',label:'Today'},{value:'week',label:'This week'},{value:'month',label:'This month'},{value:'year',label:'This year'},{value:'all',label:'All time'},{value:'custom',label:'Custom range'}];
function localDay(date:Date){return `${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,'0')}-${String(date.getDate()).padStart(2,'0')}`;}
export function historyDates(period:HistoryPeriod,from='',to='',now=new Date()):{from:string;to:string;error:string} {
 if(period==='all')return{from:'',to:'',error:''};
 if(period==='custom'){
  if((from&&!isValidCalendarDate(from))||(to&&!isValidCalendarDate(to)))return{from,to,error:'Enter valid calendar dates.'};
  if(from&&to&&from>to)return{from,to,error:'From date must be on or before To date.'};
  return{from,to,error:''};
 }
 const start=new Date(now.getFullYear(),now.getMonth(),now.getDate());
 const end=new Date(start);
 if(period==='week'){start.setDate(start.getDate()-(start.getDay()+6)%7);end.setTime(start.getTime());end.setDate(end.getDate()+6);}
 if(period==='month'){start.setDate(1);end.setMonth(start.getMonth()+1,0);}
 if(period==='year'){start.setMonth(0,1);end.setMonth(11,31);}
 return{from:localDay(start),to:localDay(end),error:''};
}
export function matchingHistory(records:readonly Transaction[],range:{from:string;to:string;error:string},currency=''):Transaction[]{
 if(range.error)return[];
 return records.filter(record=>(!currency||record.currency===currency)&&(!range.from||record.date.slice(0,10)>=range.from)&&(!range.to||record.date.slice(0,10)<=range.to)).sort((a,b)=>b.date.localeCompare(a.date)||b.createdAt.localeCompare(a.createdAt)||b.id.localeCompare(a.id));
}
