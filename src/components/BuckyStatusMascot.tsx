import {useCallback,useEffect,useRef,useSyncExternalStore} from 'react';
import BuckyMascot,{type BuckyHandle} from './BuckyMascot';
import {buckyAnimation,getBuckyPresentation,subscribeBuckyPresentation,type BuckyPhase} from '../lib/buckyPresentation';
/** Plays existing clips only. One-shot reactions return to Idle in the existing controller. */
export default function BuckyStatusMascot({profileId,paused=false,warning=false,label='Bucky, your financial intelligence companion'}:{profileId?:string;paused?:boolean;warning?:boolean;label?:string}){
 const view=useSyncExternalStore(subscribeBuckyPresentation,getBuckyPresentation,getBuckyPresentation);
 const handle=useRef<BuckyHandle>(null);
 const matches=!profileId||!view.profileId||profileId===view.profileId;
 const phase:BuckyPhase=matches&&view.phase!=='idle'?view.phase:warning?'warning':'idle';
 const animation=buckyAnimation(phase);
 const apply=useCallback(()=>{const mascot=handle.current;if(!mascot?.isReady())return;if(mascot.getAnimationNames().includes(animation.clip))mascot.play(animation.clip,{loop:animation.loop});if(animation.talking)mascot.startTalking();else mascot.stopTalking();},[animation.clip,animation.loop,animation.talking,matches?view.eventId:undefined,profileId]);
 useEffect(()=>{apply();},[apply]);
 return <BuckyMascot ref={handle} paused={paused} onReady={apply} label={label+' — '+phase} />;
}
