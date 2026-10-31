import * as T from 'three';
import {createSavingsSurface} from './runtime/savings_surface.js';
import {createAccessories} from './runtime/accessories.js';
import {SavingsController,FINANCIAL_EVENTS,requiresConfirmation} from './runtime/savings.js';
/** Owns one independently loaded GLTF scene. No DOM, renderer or global state. */
export class BuckyController {
 constructor(gltf,{mode='normal',progress=0,accessory='none',reducedMotion=false}={}){
  SavingsController.validate(progress);if(!['normal','savings'].includes(mode))throw new RangeError('Unknown mode');if(!['none','halloween'].includes(accessory))throw new RangeError('Unknown accessory');
  this.model=gltf.scene;this.clips=new Map(gltf.animations.map(c=>[c.name,c]));this.bindings=new Map();this.interpolants=new WeakMap();this.pose=new Map();this.previous=null;this.fadeAge=1;this.age=0;this.speed=1;this.paused=false;this.disposed=false;this.talking=false;this.gesture=null;this.blinkClock=0;this.blinkTime=-1;this.reducedMotion=reducedMotion;this.events=new Set();
  for(const clip of this.clips.values())for(const tr of clip.tracks){if(this.bindings.has(tr.name))continue;const p=T.PropertyBinding.parseTrackName(tr.name),node=T.PropertyBinding.findNode(this.model,p.nodeName);if(!node)throw Error('Missing animated node '+p.nodeName);const prop=p.propertyName,rest=prop==='morphTargetInfluences'?[...node[prop]]:node[prop].toArray();this.bindings.set(tr.name,{node,prop,rest});}
  this.surface=createSavingsSurface(this.model,{mode});this.accessories=createAccessories(this.model);this.accessories.setAccessory(accessory);
  this.savings=new SavingsController({onComplete:()=>this.play('Celebration',{loop:false})});this.savings.setGoal('default',progress);this.savings.update(1);this.surface.update(progress);this.play('Idle');this.update(0);
 }
 assertLive(){if(this.disposed)throw Error('Bucky controller is disposed');}
 getAnimationNames(){return [...this.clips.keys()];}
 setMode(mode){this.assertLive();this.surface.setMode(mode);}
 setAccessory(theme){this.assertLive();this.accessories.setAccessory(theme);}
 setEmotion(emotion){this.play(!emotion||emotion==='none'?'Idle':emotion.startsWith('Emotion_')?emotion:'Emotion_'+emotion);}
 play(name,{loop=true}={}){this.assertLive();if(!this.clips.has(name))throw new RangeError('Unknown clip: '+name);this.previous=new Map([...this.pose].map(([k,v])=>[k,v.slice()]));this.fadeAge=0;this.clip=this.clips.get(name);this.loop=loop&&name!=='Walking';this.age=0;}
 setGesture(name){this.assertLive();if(name&&!this.clips.has(name))throw new RangeError('Unknown gesture');this.gesture=name;this.gestureTime=0;}
 startTalking(){this.assertLive();this.talking=true;this.talkTime=0;}
 stopTalking(){this.assertLive();this.talking=false;}
 pause(){this.assertLive();this.paused=true;}
 resume(){this.assertLive();this.paused=false;}
 setSpeed(value){this.assertLive();if(!Number.isFinite(value)||value<0||value>3)throw new RangeError('Speed must be 0..3');this.speed=value;}
 setReducedMotion(value){this.assertLive();this.reducedMotion=Boolean(value);this.savings.duration=value?0:.65;if(value){this.savings.update(0);this.surface.update(this.savings.current);}}
 setSavingsProgress(value,options={}){this.assertLive();this.savings.duration=this.reducedMotion?0:.65;return this.savings.setSavingsProgress(value,options);}
 setSavingsGoal(id,value){this.assertLive();this.savings.setGoal(id,value);this.play('Idle');this.stopTalking();this.setGesture(null);}
 handleFinancialEvent(event,{confirmed=false,progress,goalId,eventId}={}){
  this.assertLive();if(!Object.hasOwn(FINANCIAL_EVENTS,event))throw new RangeError('Unknown financial event');
  if(requiresConfirmation(event)&&confirmed!==true)return false;
  if(eventId!==undefined&&(typeof eventId!=='string'||!eventId))throw new TypeError('Event id must be nonempty');if(eventId&&this.events.has(eventId))return false;
  if(['deposit','withdrawal'].includes(event)&&progress===undefined)throw new TypeError('Progress required');if(event==='goalCompleted'&&progress!==100)throw new RangeError('Completion requires 100');if(progress!==undefined)SavingsController.validate(progress);
  if(goalId!==undefined&&(typeof goalId!=='string'||!goalId.trim()))throw new TypeError('Goal id required');
  if(goalId&&goalId!==this.savings.goalId)this.setSavingsGoal(goalId);
  const wasComplete=this.savings.snapshot().completed;
  if(progress!==undefined)this.setSavingsProgress(progress,{confirmed});
  const newlyComplete=!wasComplete&&this.savings.snapshot().completed;
  if(eventId)this.events.add(eventId);
  if(!newlyComplete&&!(event==='goalCompleted'&&wasComplete))this.play(FINANCIAL_EVENTS[event],{loop:['Thinking','Listening'].includes(FINANCIAL_EVENTS[event])});return true;
 }
 sample(clip,time){const result=new Map();for(const tr of clip.tracks){if(!this.interpolants.has(tr))this.interpolants.set(tr,tr.createInterpolant());result.set(tr.name,Array.from(this.interpolants.get(tr).evaluate(Math.max(0,Math.min(time,clip.duration)))));}return result;}
 update(dt){if(this.disposed)return;if(!Number.isFinite(dt)||dt<0)throw new RangeError('Invalid elapsed time');
  this.savings.update(dt);this.surface.update(this.savings.current);
  const step=this.paused||this.reducedMotion?0:dt*this.speed;this.age+=step;this.fadeAge+=step;this.blinkClock+=step;this.talkTime=(this.talkTime||0)+step;this.gestureTime=(this.gestureTime||0)+step;
  const result=new Map([...this.bindings].map(([k,b])=>[k,b.rest.slice()]));
  if(!this.reducedMotion){
   for(const [k,v]of this.sample(this.clip,this.loop?this.age%this.clip.duration:Math.min(this.age,this.clip.duration)))result.set(k,v);
   if(this.gesture){const c=this.clips.get(this.gesture);for(const [k,v]of this.sample(c,this.gestureTime%c.duration))if(/^(ArmUpper_|ArmFore_|Hand_)/.test(this.bindings.get(k).node.name))result.set(k,v);}
   if(this.talking){const c=this.clips.get('TalkBasic');for(const [k,v]of this.sample(c,this.talkTime%c.duration))if(this.bindings.get(k).prop==='morphTargetInfluences')result.set(k,v);}
   if(this.blinkTime>=0)this.blinkTime+=step;else if(this.blinkClock>=4){this.blinkClock=0;this.blinkTime=0;}
   if(this.blinkTime>=0){const c=this.clips.get('Blink');if(this.blinkTime>c.duration)this.blinkTime=-1;else for(const [k,v]of this.sample(c,this.blinkTime)){const b=this.bindings.get(k);if(b.prop==='scale')result.set(k,result.get(k).map((x,i)=>x*(b.rest[i]?v[i]/b.rest[i]:1)));}}
  }
  const weight=this.reducedMotion?1:Math.min(1,this.fadeAge/.25);
  for(const [k,value]of result){const b=this.bindings.get(k),before=this.previous?.get(k)||b.rest;let v=value;if(weight<1)v=b.prop==='quaternion'?new T.Quaternion().fromArray(before).slerp(new T.Quaternion().fromArray(value),weight).toArray():value.map((x,i)=>T.MathUtils.lerp(before[i],x,weight));result.set(k,v);if(b.prop==='morphTargetInfluences')b.node[b.prop].splice(0,v.length,...v);else b.node[b.prop].fromArray(v);}
  this.pose=result;this.model.updateMatrixWorld(true);
 }
 getState(){return {...this.savings.snapshot(),mode:this.surface.mode,accessory:this.accessories.theme,clip:this.clip.name,paused:this.paused,speed:this.speed,talking:this.talking,coinCapacity:this.surface.capacity};}
 dispose(){if(this.disposed)return;this.disposed=true;this.accessories.dispose();this.surface.dispose();disposeModel(this.model);this.bindings.clear();this.clips.clear();this.events.clear();}
}
export function disposeModel(model){const geometries=new Set(),materials=new Set(),textures=new Set(),skeletons=new Set();model.traverse(n=>{if(n.geometry)geometries.add(n.geometry);if(n.skeleton)skeletons.add(n.skeleton);for(const m of (n.material?(Array.isArray(n.material)?n.material:[n.material]):[])){materials.add(m);for(const value of Object.values(m))if(value?.isTexture)textures.add(value);}});textures.forEach(t=>t.dispose());materials.forEach(m=>m.dispose());geometries.forEach(g=>g.dispose());skeletons.forEach(s=>s.dispose());model.removeFromParent();}
