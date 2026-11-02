import test from 'node:test';
import assert from 'node:assert/strict';
import {analyzeProduct,validateProductDraft} from './productAnalysisApi.ts';
const draft={name:'Shirt',category:'Clothing',color:'Navy',description:'Collar'};
const image={imageBase64:'unit-test-image',mediaType:'image/png'};
test('product client validates mock responses and sends no financial fields',async()=>{
 let payload;
 const result=await analyzeProduct(image,'mock','',async(path,init)=>{assert.equal(path,'/api/products/analyze');payload=JSON.parse(init.body);return new Response(JSON.stringify({mode:'mock',model:null,draft}));});
 assert.deepEqual(result.draft,draft);
 assert.deepEqual(Object.keys(payload).sort(),['imageBase64','mediaType','mode']);
 assert.equal(validateProductDraft({...draft,price:100}),false);
 await assert.rejects(analyzeProduct(image,'mock','',async()=>new Response(JSON.stringify({mode:'live',model:'muse-spark-1.3',draft}))),/Invalid/);
});
test('live token is required before transport and backend failures stay errors',async()=>{
 let calls=0;const fake=async()=>{calls++;return new Response('{}',{status:503});};
 await assert.rejects(analyzeProduct(image,'live','',fake),/token/);assert.equal(calls,0);
 await assert.rejects(analyzeProduct(image,'mock','',fake),/draft has been kept/);
 assert.equal(calls,1);
});
