import test from 'node:test';
import assert from 'node:assert/strict';
import {createAppServer} from '../server.mjs';
import {PRODUCT_ANALYSIS_SCHEMA,validateProductAnalysis,mockProductAnalysis} from '../productAnalysis.mjs';
import {buildMetaProductRequest,sendMetaProduct} from '../metaClient.mjs';
const imageBase64=Buffer.from([137,80,78,71,13,10,26,10,0]).toString('base64');
const image={imageBase64,mediaType:'image/png'};
const draft={name:'Polo shirt',category:'Clothing',color:'Navy',description:'Visible collar and button placket'};
test('product schema permits only editable visual fields',()=>{
 assert.equal(PRODUCT_ANALYSIS_SCHEMA.additionalProperties,false);
 assert.deepEqual(validateProductAnalysis(draft),draft);
 for(const invalid of [{...draft,price:100},{...draft,stock:3},{name:'Shirt'},{...draft,color:5},{...draft,name:''},{...draft,description:'a'.repeat(1001)}]) assert.throws(()=>validateProductAnalysis(invalid));
 assert.equal(validateProductAnalysis({name:null,category:null,color:null,description:null}).name,null);
 assert.match(mockProductAnalysis().description,/Fictional mock/);
});
test('product image uses existing Muse Responses transport with dedicated schema',async()=>{
 const request=buildMetaProductRequest({...image,apiKey:'unit-test-placeholder'});
 assert.equal(request.body.model,'muse-spark-1.3');
 assert.equal(request.body.text.format.name,'bucketa_product_analysis');
 assert.equal(request.body.text.format.strict,true);
 assert.equal(request.body.input[0].content[1].image_url,'data:image/png;base64,'+imageBase64);
 assert.match(request.body.input[0].content[0].text,/Never infer price/);
 const fake=async()=>({status:200,text:async()=>JSON.stringify({output_text:JSON.stringify(draft)})});
 assert.deepEqual(await sendMetaProduct(request,fake),draft);
 await assert.rejects(sendMetaProduct(request,async()=>({status:200,text:async()=>JSON.stringify({output_text:JSON.stringify({...draft,stock:20})})})));
});
test('dedicated HTTP route validates images, labels mock mode and blocks live without gates',async()=>{
 let upstream=0;
 const server=createAppServer({liveMetaEnabled:false,modelApiKeyConfigured:false},{fetchImpl:async()=>{upstream++;throw Error('No external request allowed');}});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const url='http://127.0.0.1:'+server.address().port+'/api/products/analyze';
 const post=payload=>fetch(url,{method:'POST',headers:{'Content-Type':'application/json','Connection':'close'},body:JSON.stringify(payload)});
 try {
 const response=await post({...image,mode:'mock'});assert.equal(response.status,200);
 const body=await response.json();assert.equal(body.mode,'mock');assert.equal(body.model,null);assert.deepEqual(body.draft,mockProductAnalysis());
 assert.equal((await post({...image,mode:'unknown'})).status,400);
 assert.equal((await post({...image,mode:'mock',mediaType:'image/jpeg'})).status,400);
 assert.equal((await post({...image,mode:'live'})).status,403);
 assert.equal((await post(null)).status,400);
 assert.equal(upstream,0);
 }finally{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
});
