import * as T from 'three';
import {buildCoinPile} from './coin_pile.js';
/** Instance-owned materials, transforms and coin buffers; source GLB stays opaque. */
export function createSavingsSurface(model,{mode:initialMode='savings'}={}){
 const body=model.getObjectByName('Body'),originals=new Map();
 body.traverse(n=>{if(n.isMesh){originals.set(n,n.material);n.material=Array.isArray(n.material)?n.material.map(m=>m.clone()):n.material.clone();}});
 // Soft Gaussian opacity around individual facial features, blended into the same
 // body material. No extra mesh, oval panel, hard edge or cutout.
 const faceUniform={value:1};
 for(const mesh of originals.keys())for(const m of (Array.isArray(mesh.material)?mesh.material:[mesh.material])){
  m.onBeforeCompile=shader=>{
   shader.uniforms.buckySavingsMode=faceUniform;
   shader.vertexShader=shader.vertexShader.replace('#include <common>','#include <common>\nvarying vec3 buckyLocal;').replace('#include <begin_vertex>','#include <begin_vertex>\nbuckyLocal=position;');
   shader.fragmentShader=shader.fragmentShader.replace('#include <common>',`#include <common>
    varying vec3 buckyLocal; uniform float buckySavingsMode;
    float softFeature(vec2 p,vec2 center,vec2 size){vec2 q=(p-center)/size;return exp(-dot(q,q)*2.0);}`);
   shader.fragmentShader=shader.fragmentShader.replace('#include <color_fragment>',`#include <color_fragment>
    vec2 face=buckyLocal.xy;
    float frost=max(softFeature(face,vec2(0.,1.23),vec2(.38,.25)),
      max(softFeature(face,vec2(-.66,1.25),vec2(.26,.22)),softFeature(face,vec2(.66,1.25),vec2(.26,.22))));
    frost=max(frost,.65*max(softFeature(face,vec2(-.45,1.52),vec2(.30,.30)),softFeature(face,vec2(.45,1.52),vec2(.30,.30))));
    float front=smoothstep(.5,.86,buckyLocal.z);
    diffuseColor.a=mix(diffuseColor.a,.88,frost*front*buckySavingsMode);`);
  };m.customProgramCacheKey=()=> 'bucky-soft-local-frost-v1';
 }
 const group=new T.Group();group.name='InternalSavingsCoins';body.add(group);
 let geometry,material,coins=null,positions=[];
 function ensureCoins(){if(coins)return;
 const profile=[[0,-.027],[.112,-.027],[.126,-.022],[.132,-.012],[.132,.012],[.126,.022],[.112,.027],[.103,.027],[.100,.019],[0,.019]].map(([x,y])=>new T.Vector2(x,y));
 geometry=new T.LatheGeometry(profile,24);material=new T.MeshStandardMaterial({color:0xffc02e,metalness:.65,roughness:.27,emissive:0x6b3500,emissiveIntensity:.23});
 positions=buildCoinPile();
 coins=new T.InstancedMesh(geometry,material,positions.length);coins.name='Beveled internal gold coins';coins.instanceMatrix.setUsage(T.DynamicDrawUsage);coins.frustumCulled=false;group.add(coins);for(let i=0;i<positions.length;i++)coins.setColorAt(i,new T.Color().setHSL(.115+positions[i].tint*.015,.83,.48+positions[i].tint*.10));

 }
 const dummy=new T.Object3D();let mode='savings',progress=-1;
 function setMode(value){if(!['normal','savings'].includes(value))throw new RangeError('Unknown Bucky mode');mode=value;if(mode==='savings')ensureCoins();faceUniform.value=value==='savings'?1:0;
  for(const [mesh,original]of originals){const mats=Array.isArray(mesh.material)?mesh.material:[mesh.material],base=Array.isArray(original)?original:[original];mats.forEach((m,i)=>{m.transparent=value==='savings';m.opacity=value==='savings'?.22:base[i].opacity;m.depthWrite=value!=='savings';m.side=value==='savings'?T.FrontSide:base[i].side;m.needsUpdate=true;});}
  group.visible=mode==='savings'&&progress>0;const current=progress;progress=-1;update(Math.max(0,current));
 }
 function update(value){if(!Number.isFinite(value)||value<0||value>100)throw new RangeError('Invalid savings percentage');if(value===progress)return;progress=value;group.visible=mode==='savings'&&value>0;
  if(!coins)return;
  const budget=positions.length*value/100;coins.count=Math.min(positions.length,Math.ceil(budget));
  for(let i=0;i<coins.count;i++){const p=positions[i],s=Math.cbrt(Math.min(1,Math.max(0,budget-i)));dummy.position.set(p.x,p.y-p.half*(1-s),p.z);dummy.rotation.set(p.rx,p.ry,p.rz);dummy.scale.setScalar(s);dummy.updateMatrix();coins.setMatrixAt(i,dummy.matrix);}coins.instanceMatrix.needsUpdate=true;
 }
 setMode(initialMode);update(0);
 function dispose(){group.removeFromParent();coins?.dispose();geometry?.dispose();material?.dispose();for(const [mesh,original]of originals){for(const m of (Array.isArray(mesh.material)?mesh.material:[mesh.material]))m.dispose();mesh.material=original;}originals.clear();}
 return {update,setMode,dispose,body,materials:[...originals.keys()].flatMap(n=>Array.isArray(n.material)?n.material:[n.material]),coins:[group],get mesh(){return coins},get layout(){return positions},get mode(){return mode},get progress(){return progress},get capacity(){return positions.length},get visibleVolume(){return positions.length*progress/100},presentation:'internal-instanced-coins',hasPermanentOpening:false};
}
