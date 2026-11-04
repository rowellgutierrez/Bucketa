import {useEffect} from 'react';
let profileId='';let owner:symbol|undefined;const listeners=new Set<()=>void>();
export const getBuckyPageProfile=()=>profileId;
export function subscribeBuckyPageProfile(listener:()=>void){listeners.add(listener);return()=>{listeners.delete(listener);};}
/** Page selection only; never writes records or changes a pending proposal. */
export function publishBuckyPageProfile(id:string){const token=Symbol();owner=token;profileId=id;listeners.forEach(listener=>listener());return()=>{if(owner===token){owner=undefined;profileId='';listeners.forEach(listener=>listener());}};}
export function useBuckyPageProfile(id:string){useEffect(()=>publishBuckyPageProfile(id),[id]);}
