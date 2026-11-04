import type { PreparedScannerImage } from './scannerApi';
export interface ProductDraft {name:string|null;category:string|null;color:string|null;description:string|null}
export interface ProductAnalysis {mode:'mock'|'live';model:string|null;draft:ProductDraft}
export function validateProductDraft(value: unknown): value is ProductDraft {
 if(!value || typeof value !== 'object' || Array.isArray(value)) return false;
 const record = value as Record<string,unknown>;
 const fields = ['name','category','color','description'];
 return Object.keys(record).length===4 && fields.every(key=>record[key]===null || (typeof record[key]==='string' && !!(record[key] as string).trim() && (record[key] as string).length<=(key==='description'?1000:120)));
}
export async function analyzeProduct(image:PreparedScannerImage, mode:'mock'|'live', fetchImpl:typeof fetch=fetch):Promise<ProductAnalysis> {
 if(mode!=='mock' && mode!=='live') throw new Error('Choose mock or live product analysis.');
 const controller = new AbortController(); const timer=setTimeout(()=>controller.abort(),35000);
 try {
 const response=await fetchImpl('/api/products/analyze',{method:'POST',signal:controller.signal,headers:{'Content-Type':'application/json'},body:JSON.stringify({mode,imageBase64:image.imageBase64,mediaType:image.mediaType})});
 if(!response.ok) throw new Error('Product analysis is unavailable or was not authorized. Your draft has been kept; you can enter details manually.');
 const result:unknown=await response.json();
 if(!result || typeof result!=='object') throw new Error('Invalid product analysis response.');
 const data=result as ProductAnalysis;
 if(data.mode!==mode || (mode==='live'?data.model!=='muse-spark-1.3':data.model!==null) || !validateProductDraft(data.draft)) throw new Error('Invalid product analysis response.');
 return data;
 } catch(error) { if(error instanceof Error && error.name!=='AbortError' && !(error instanceof TypeError)) throw error; throw new Error('Product analysis could not be reached. Your draft has been kept.'); }
 finally {clearTimeout(timer);}
}
