import {useEffect,useMemo,useState,useSyncExternalStore} from 'react';
import BuckyStatusMascot from './BuckyStatusMascot';
import {getBuckyPresentation,subscribeBuckyPresentation} from '../lib/buckyPresentation';
import {analyzeBuckyFinances} from '../lib/buckyAgent';
import {openBuckyConversation,getBuckyDraft,setBuckyDraft,subscribeBuckyDraft} from '../lib/buckyConversation';
import type {Bucket,Employee,Product,Profile,Sale,Transaction} from '../data/types';
export default function HomeBucky({profiles,buckets,transactions,products,sales,employees,preferredProfileId}:{profiles:Profile[];buckets:Bucket[];transactions:Transaction[];products:Product[];sales:Sale[];employees:Employee[];preferredProfileId?:string}) {
 const question = useSyncExternalStore(subscribeBuckyDraft,getBuckyDraft,getBuckyDraft);
 const [localHour,setLocalHour]=useState(()=>new Date().getHours());
 useEffect(()=>{const refresh=()=>setLocalHour(new Date().getHours());const timer=window.setInterval(refresh,60000);window.addEventListener('focus',refresh);return()=>{window.clearInterval(timer);window.removeEventListener('focus',refresh);};},[]);
 const setQuestion = setBuckyDraft;
 const presentation=useSyncExternalStore(subscribeBuckyPresentation,getBuckyPresentation,getBuckyPresentation);
 const profile=profiles.find(p=>p.id===preferredProfileId)??profiles.find(p=>p.kind==='personal')??profiles[0];
 const analysis=useMemo(()=>{if(!profile)return null;try{return analyzeBuckyFinances({profile,buckets,transactions,products,sales,employees});}catch{return null;}},[profile,buckets,transactions,products,sales,employees]);
 const insights=analysis?.insights.slice(0,2)??[];
 return <section className="panel home-bucky" data-time-of-day={localHour>=6&&localHour<18?'day':'night'} aria-labelledby="home-bucky-title">
 <div className="home-bucky-intro"><div aria-hidden={presentation.open} className={presentation.open?"home-bucky-avatar home-bucky-avatar--parked":"home-bucky-avatar"}><BuckyStatusMascot profileId={profile?.id} paused={presentation.open} warning={!!analysis?.lowStock.length} /></div><div><h2 id="home-bucky-title">Bucky Financial Intelligence</h2><p className="muted">{profile? profile.name:'Your personal and business finances, together.'}</p>{analysis?.lowStock.length ? <p className="home-bucky-warning">{analysis.lowStock.length} product{analysis.lowStock.length===1?'':'s'} low on recorded stock</p> : null}{!presentation.open && presentation.profileId===profile?.id && presentation.label && !['idle','error','warning'].includes(presentation.phase) && <p className="home-bucky-result" role="status">{presentation.label}</p>}</div></div>
 {insights.length>0 && <ul className="home-bucky-insights">{insights.map(insight=><li key={insight.id}><strong>{insight.title}</strong><p>{insight.detail}</p></li>)}</ul>}
 <form className="home-bucky-question" onSubmit={event=>{event.preventDefault();if(question.trim()){openBuckyConversation(question,profile?.id);setQuestion('');}}}><label className="sr-only" htmlFor="home-bucky-question">Ask Bucky</label><input id="home-bucky-question" className="input" placeholder="Ask about your finances…" value={question} onChange={event=>setQuestion(event.target.value)} /><button className="btn" disabled={!question.trim()} type="submit">Ask Bucky</button></form>
 <button className="btn ghost" type="button" onClick={()=>openBuckyConversation('',profile?.id)}>Open conversation</button>
 </section>;
}
