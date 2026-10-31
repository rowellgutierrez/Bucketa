import type {Object3D} from 'three';
import type {GLTF} from 'three/addons/loaders/GLTFLoader.js';
export type BuckyMode='normal'|'savings';
export type BuckyAccessory='none'|'halloween';
export type FinancialEvent='deposit'|'withdrawal'|'goalCompleted'|'income'|'expense'|'posSale'|'receiptScanning'|'scannerReview'|'error'|'taskCompleted';
export interface FinancialOptions {confirmed?:boolean;progress?:number;goalId?:string;eventId?:string}
export interface BuckyOptions {mode?:BuckyMode;progress?:number;accessory?:BuckyAccessory;reducedMotion?:boolean}
export interface BuckyState {goalId:string;current:number;target:number;completed:boolean;mode:BuckyMode;accessory:BuckyAccessory;clip:string;paused:boolean;speed:number;talking:boolean;coinCapacity:number}
export class BuckyController {
 constructor(gltf:GLTF,options?:BuckyOptions);
 readonly model:Object3D;
 getAnimationNames():string[];
 setMode(mode:BuckyMode):void;setAccessory(theme:BuckyAccessory):void;setEmotion(emotion:string|null):void;
 play(name:string,options?:{loop?:boolean}):void;setGesture(name:string|null):void;
 startTalking():void;stopTalking():void;pause():void;resume():void;setSpeed(value:number):void;setReducedMotion(value:boolean):void;
 setSavingsProgress(value:number,options?:{confirmed?:boolean}):number;setSavingsGoal(id:string,value?:number):void;
 handleFinancialEvent(event:FinancialEvent,options?:FinancialOptions):boolean;
 update(dt:number):void;getState():BuckyState;dispose():void;
}
export function disposeModel(model:Object3D):void;
