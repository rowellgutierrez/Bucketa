import './Bucky3D.css';
import {forwardRef,useEffect,useImperativeHandle,useRef,useState,type CSSProperties} from 'react';
import * as THREE from 'three';
import {GLTFLoader} from 'three/addons/loaders/GLTFLoader.js';
import {BuckyController,disposeModel,type BuckyMode,type BuckyAccessory,type FinancialEvent,type FinancialOptions,type BuckyState} from './BuckyController.js';
/** Model bundled from `src/assets/bucky.glb` via Vite's asset pipeline (emitted under `dist/assets` with a hashed filename). */
export const BUCKY_MODEL_URL =
  new URL('../../assets/bucky.glb', import.meta.url).href;
export interface BuckyProps {
 modelUrl?:string;mode?:BuckyMode;progress?:number;goalId?:string;emotion?:string;animation?:string;
 talking?:boolean;paused?:boolean;speed?:number;accessory?:BuckyAccessory;reducedMotion?:boolean;
 className?:string;style?:CSSProperties;label?:string;onReady?:(controller:BuckyController)=>void;onError?:(error:Error)=>void;
}
export interface BuckyHandle {
 isReady:()=>boolean;pause:()=>void;resume:()=>void;setSpeed:(value:number)=>void;setGesture:(name:string|null)=>void;getAnimationNames:()=>string[];
 play:(clip:string,options?:{loop?:boolean})=>void;startTalking:()=>void;stopTalking:()=>void;
 handleFinancialEvent:(event:FinancialEvent,options?:FinancialOptions)=>boolean;
 getState:()=>BuckyState|null;
}
/** Separate loader/controller/renderer per mounted instance. No global animation state. */
export const Bucky3D=forwardRef<BuckyHandle,BuckyProps>(function Bucky3D(props,ref){
 const modelUrl=props.modelUrl??BUCKY_MODEL_URL;
 const host=useRef<HTMLDivElement>(null),controller=useRef<BuckyController|null>(null),latest=useRef(props);latest.current=props;
 const [status,setStatus]=useState<'loading'|'ready'|'error'>('loading');
 useImperativeHandle(ref,()=>({isReady:()=>controller.current!==null,pause:()=>controller.current?.pause(),resume:()=>controller.current?.resume(),setSpeed:value=>controller.current?.setSpeed(value),setGesture:name=>controller.current?.setGesture(name),getAnimationNames:()=>controller.current?.getAnimationNames()??[],play:(clip,options)=>controller.current?.play(clip,options),startTalking:()=>controller.current?.startTalking(),stopTalking:()=>controller.current?.stopTalking(),handleFinancialEvent:(event,options)=>controller.current?.handleFinancialEvent(event,options)??false,getState:()=>controller.current?.getState()??null}),[]);
 useEffect(()=>{
  const element=host.current!;let disposed=false,frame=0,last=0,visible=true;let renderer:THREE.WebGLRenderer|undefined;let resize:ResizeObserver|undefined,intersection:IntersectionObserver|undefined;
  const scene=new THREE.Scene(),camera=new THREE.PerspectiveCamera(32,1,.05,100);camera.position.set(0,1.8,7.4);camera.lookAt(0,1.65,0);
  const media=matchMedia('(prefers-reduced-motion: reduce)');
  const motion=()=>controller.current?.setReducedMotion(latest.current.reducedMotion??media.matches);
  const error=(cause:unknown)=>{if(disposed)return;const e=cause instanceof Error?cause:new Error(String(cause));setStatus('error');latest.current.onError?.(e);};
  setStatus('loading');
  try{
   renderer=new THREE.WebGLRenderer({antialias:true,alpha:true});renderer.setPixelRatio(Math.min(devicePixelRatio,2));renderer.outputColorSpace=THREE.SRGBColorSpace;renderer.toneMapping=THREE.ACESFilmicToneMapping;renderer.toneMappingExposure=1.2;element.appendChild(renderer.domElement);renderer.domElement.style.cssText='width:100%;height:100%;display:block';
   scene.add(new THREE.HemisphereLight(0xdceeff,0x8b9aab,2));for(const [x,y,z,power]of [[-3,5,4,2.75],[4,3,2,1.5],[0,5,-3,2.25]]){const light=new THREE.DirectionalLight(0xffffff,power);light.position.set(x,y,z);scene.add(light);}
   resize=new ResizeObserver(()=>{const {width,height}=element.getBoundingClientRect();if(width>0&&height>0){renderer!.setSize(width,height,false);camera.aspect=width/height;camera.updateProjectionMatrix();}});resize.observe(element);
   intersection=new IntersectionObserver(entries=>{visible=entries[0].isIntersecting;});intersection.observe(element);media.addEventListener('change',motion);
   new GLTFLoader().loadAsync(modelUrl).then(gltf=>{
    if(disposed){disposeModel(gltf.scene);return;}
    const p=latest.current;let c:BuckyController;
    try{c=new BuckyController(gltf,{mode:p.mode??'normal',progress:p.progress??0,accessory:p.accessory??'none',reducedMotion:p.reducedMotion??media.matches});controller.current=c;scene.add(c.model);c.setSavingsGoal(p.goalId??'default',p.progress??0);if(p.animation)c.play(p.animation);else c.setEmotion(p.emotion??'none');if(p.talking)c.startTalking();c.setSpeed(p.speed??1);if(p.paused)c.pause();setStatus('ready');p.onReady?.(c);}catch(e){if(controller.current)controller.current.dispose();else disposeModel(gltf.scene);controller.current=null;error(e);return;}
    const tick=(now:number)=>{if(disposed)return;frame=requestAnimationFrame(tick);const dt=Math.min(.05,Math.max(0,(now-last)/1000));last=now;if(!visible||document.hidden)return;c.update(dt);renderer!.render(scene,camera);};frame=requestAnimationFrame(tick);
   }).catch(error);
  }catch(e){error(e);}
  return ()=>{disposed=true;cancelAnimationFrame(frame);resize?.disconnect();intersection?.disconnect();media.removeEventListener('change',motion);controller.current?.dispose();controller.current=null;renderer?.dispose();renderer?.forceContextLoss();renderer?.domElement.remove();scene.clear();};
 },[modelUrl]);
 useEffect(()=>{controller.current?.setMode(props.mode??'normal');},[props.mode]);
 useEffect(()=>{const c=controller.current;if(c)c.setSavingsGoal(props.goalId??'default',props.progress??0);},[props.goalId]);
 useEffect(()=>{controller.current?.setSavingsProgress(props.progress??0);},[props.progress]);
 useEffect(()=>{controller.current?.setAccessory(props.accessory??'none');},[props.accessory]);
 useEffect(()=>{const c=controller.current;if(c){if(props.animation)c.play(props.animation);else c.setEmotion(props.emotion??'none');}},[props.emotion,props.animation]);
 useEffect(()=>{const c=controller.current;if(c)props.talking?c.startTalking():c.stopTalking();},[props.talking]);
 useEffect(()=>{const c=controller.current;if(c)props.paused?c.pause():c.resume();},[props.paused]);
 useEffect(()=>{controller.current?.setSpeed(props.speed??1);},[props.speed]);
 useEffect(()=>{controller.current?.setReducedMotion(props.reducedMotion??matchMedia('(prefers-reduced-motion: reduce)').matches);},[props.reducedMotion]);
 return <div className={['bucky3d',props.className].filter(Boolean).join(' ')} style={props.style} role="img" aria-label={props.label??'Bucky animated mascot'}><div ref={host} className="bucky3d__canvas"/>{status!=='ready'&&<span role="status" className="sr-only">{status==='error'?'Bucky preview unavailable.':'Loading Bucky…'}</span>}</div>;
});
