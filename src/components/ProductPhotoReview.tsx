import {useEffect,useRef,useState} from 'react';
import ScannerCamera from './ScannerCamera';
import {prepareScannerImage, fetchScannerHealth, isLiveScannerAvailable, type PreparedScannerImage} from '../lib/scannerApi';
import {analyzeProduct, type ProductAnalysis, type ProductDraft} from '../lib/productAnalysisApi';

/** Analysis never writes inventory. Applying the reviewed draft opens the normal product form. */
export default function ProductPhotoReview({onApply,onClose}:{onApply:(draft:ProductDraft)=>void;onClose:()=>void}) {
 const [image,setImage]=useState<PreparedScannerImage|null>(null);
 const [preview,setPreview]=useState(''); const [camera,setCamera]=useState(false);
 const [result,setResult]=useState<ProductAnalysis|null>(null); const [draft,setDraft]=useState<ProductDraft>({name:null,category:null,color:null,description:null});
 const [mode,setMode]=useState<'mock'|'live'>('mock');const [token,setToken]=useState(''); const [liveAvailable,setLiveAvailable]=useState(false);
 const [busy,setBusy]=useState(false);const [error,setError]=useState('');const [confirmed,setConfirmed]=useState(false);
 const generation=useRef(0);
 useEffect(()=>{let mounted=true; void fetchScannerHealth().then(health=>{if(mounted)setLiveAvailable(isLiveScannerAvailable(import.meta.env.DEV,health));}).catch(()=>{});return()=>{mounted=false;generation.current++;};},[]);
 useEffect(()=>{if(!image){setPreview('');return;}const url=URL.createObjectURL(image.blob);setPreview(url);return()=>URL.revokeObjectURL(url);},[image]);
 async function choose(file:File) {const id=++generation.current;setBusy(true);setError('');try{const prepared=await prepareScannerImage(file);if(id!==generation.current)return;setImage(prepared);setResult(null);setConfirmed(false);}catch(err){if(id===generation.current)setError(err instanceof Error?err.message:'Unable to read photo.');}finally{if(id===generation.current)setBusy(false);}}
 async function analyze() {if(!image)return; const id=++generation.current;setBusy(true);setError('');setConfirmed(false);try{const next=await analyzeProduct(image,mode,token);if(id!==generation.current)return;setResult(next);setDraft(next.draft);}catch(err){if(id===generation.current)setError(err instanceof Error?err.message:'Analysis failed. Your draft is kept.');}finally{if(id===generation.current)setBusy(false);}}
 return <section className="card product-photo-review" aria-labelledby="product-photo-heading">
 <h2 id="product-photo-heading">Product photo registration</h2>
 <p className="muted">Review suggested details, then enter your price and stock before saving. Photos cannot determine price, stock, size, brand, or authenticity.</p>
 <div className="row-actions"><button className="btn ghost" type="button" disabled={busy} onClick={()=>setCamera(true)}>Take photo</button><label className="field">Upload product image<input type="file" accept="image/jpeg,image/png,image/webp,image/gif" disabled={busy} onChange={e=>{const file=e.target.files?.[0];if(file)void choose(file);e.target.value='';}} /></label></div>
 {camera && <ScannerCamera onUsePhoto={file=>{setCamera(false);void choose(file);}} onClose={()=>setCamera(false)} />}
 {preview && <img className="product-photo-preview" src={preview} alt="Product being reviewed" />}
 <div className="field"><label htmlFor="product-analysis-mode">Analysis mode</label><select id="product-analysis-mode" className="input" value={mode} disabled={busy} onChange={e=>{setMode(e.target.value as 'mock'|'live');setConfirmed(false);}}><option value="mock">Mock demo — fictional draft, no AI request</option>{liveAvailable && <option value="live">Muse Spark 1.3 — gated live analysis</option>}</select></div>
 {mode==='live' && <div className="field"><label htmlFor="product-live-token">Live test token</label><input id="product-live-token" type="password" className="input" autoComplete="off" value={token} onChange={e=>setToken(e.target.value)} /><p className="field-hint">Live compatibility is not yet verified. Sends this product photo to Meta only when you select Analyze.</p></div>}
 <button className="btn" type="button" disabled={!image || busy || (mode==='live'&&!token.trim())} onClick={()=>void analyze()}>{busy?'Preparing / analyzing…':mode==='mock'?'Generate mock draft':'Analyze with Muse Spark'}</button>
 {error && <p className="alert-error" role="alert">{error}</p>}
 {result && <p className="notice" role="status">{result.mode==='mock'?'MOCK DEMO: fictional details, not extracted from your photo.':'Muse Spark draft: all details require your review.'}</p>}
 {(['name','category','color','description'] as const).map(field=><div className="field" key={field}><label htmlFor={'photo-draft-'+field}>{field==='color'?'Color / visible attributes':field[0].toUpperCase()+field.slice(1)}</label><input id={'photo-draft-'+field} className="input" maxLength={field==='description'?1000:120} value={draft[field]??''} disabled={busy} onChange={e=>{setDraft({...draft,[field]:e.target.value||null});setConfirmed(false);}} /></div>)}
 <label className="check-row"><input type="checkbox" checked={confirmed} disabled={busy} onChange={e=>setConfirmed(e.target.checked)} />I reviewed these details. Continue to price and stock; nothing is saved yet.</label>
 <div className="row-actions"><button className="btn" type="button" disabled={busy || !confirmed || !draft.name?.trim()} onClick={()=>onApply(draft)}>Use reviewed details</button><button className="btn ghost" type="button" onClick={onClose}>Close photo review</button></div>
 </section>;
}
