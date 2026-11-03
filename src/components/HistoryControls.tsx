import {useEffect,useId,useState} from 'react';
import type {Transaction} from '../data/types';
import {HISTORY_PERIODS,historyDates,matchingHistory,type HistoryPeriod} from '../lib/historyView';
export function useHistoryView(records:readonly Transaction[],scopeKey:string,initial:{from:string;to:string}={from:'',to:''}){
 const [period,setPeriod]=useState<HistoryPeriod>(initial.from||initial.to?'custom':'all');
 const [from,setFrom]=useState(initial.from),[to,setTo]=useState(initial.to),[currency,setCurrency]=useState('');
 const range=historyDates(period,from,to);
 const currencies=[...new Set(records.map(record=>record.currency))].sort();
 const activeCurrency=currencies.includes(currency)?currency:'';
 const matches=matchingHistory(records,range,activeCurrency);
 const key=JSON.stringify([scopeKey,period,range.from,range.to,activeCurrency]);
 const [page,setPage]=useState({key,limit:20});
 useEffect(()=>setPage({key,limit:20}),[key]);
 const limit=page.key===key?page.limit:20;
 return{period,setPeriod,from,setFrom,to,setTo,currency:activeCurrency,setCurrency,currencies,error:range.error,matches,visible:matches.slice(0,limit),hasMore:matches.length>limit,more:()=>setPage({key,limit:limit+20})};
}
type HistoryView=ReturnType<typeof useHistoryView>;
export default function HistoryControls({view}:{view:HistoryView}){
 const id=useId();
 return <div className="history-controls" role="group" aria-label="Filter history">
  <div className="field"><label htmlFor={id+'period'}>History dates</label><select className="input" id={id+'period'} value={view.period} onChange={e=>view.setPeriod(e.target.value as HistoryPeriod)}>{HISTORY_PERIODS.map(p=><option key={p.value} value={p.value}>{p.label}</option>)}</select></div>
  {view.period==='custom'&&<><div className="field"><label htmlFor={id+'from'}>From date</label><input className="input" type="date" id={id+'from'} value={view.from} onInput={e=>view.setFrom(e.currentTarget.value)} onBlur={e=>view.setFrom(e.currentTarget.value)} onChange={e=>view.setFrom(e.target.value)} aria-invalid={!!view.error}/></div><div className="field"><label htmlFor={id+'to'}>To date</label><input className="input" type="date" id={id+'to'} value={view.to} onInput={e=>view.setTo(e.currentTarget.value)} onBlur={e=>view.setTo(e.currentTarget.value)} onChange={e=>view.setTo(e.target.value)} aria-invalid={!!view.error}/></div></>}
  <div className="field"><label htmlFor={id+'currency'}>History currency</label><select className="input" id={id+'currency'} value={view.currency} onChange={e=>view.setCurrency(e.target.value)}><option value="">All recorded currencies</option>{view.currencies.map(currency=><option key={currency}>{currency}</option>)}</select></div>
  {view.error&&<p className="alert-error" role="alert">{view.error}</p>}
 </div>;
}
export function HistoryMore({view}:{view:HistoryView}){return view.hasMore?<div className="history-more"><span className="muted">Showing {view.visible.length} of {view.matches.length}</span><button className="btn ghost" type="button" onClick={view.more}>See more</button></div>:null;}
