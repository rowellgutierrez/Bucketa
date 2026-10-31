/** Fixed-seed, offline-style placement. Built once, never shuffled during progress. */
export function buildCoinPile(){
 let seed=1407;const rand=()=>{seed=(seed*1664525+1013904223)>>>0;return seed/4294967296;};
 const positions=[];
 for(let i=0;i<700;i++){
  let best=null;
  for(let attempt=0;attempt<28;attempt++){
   const angle=rand()*Math.PI*2,r=Math.sqrt(rand())*.91;
   const x=Math.cos(angle)*r*1.09,z=Math.sin(angle)*r*.70;
   const rx=(rand()-.5)*.50,rz=(rand()-.5)*.50,ry=rand()*Math.PI*2;
   const half=.027+.132*(Math.abs(Math.sin(rx))+Math.abs(Math.sin(rz)));
   let bottom=.355;
   // Conservative projected coin footprints provide support without a physics solver.
   for(const p of positions){const distance=Math.hypot(x-p.x,z-p.z);if(distance<.246)bottom=Math.max(bottom,p.y+p.half-.012);}
   const y=bottom+half,radial=Math.hypot(x/1.09,z/.70);
   // Preserve wall clearance at the rounded base and open rim.
   const allowable=.78+Math.min(1,Math.max(0,(y-.38)/.40))*.30;
   if(Math.hypot(x/allowable,z/(allowable*.66))>.88||y+half>2.38-.10*radial)continue;
   const score=y+.33*radial+(rand()-.5)*.065;
   if(!best||score<best.score)best={x,y,z,rx,ry,rz,half,score,tint:rand()};
  }
  if(best)positions.push(best);
 }
 return positions;
}
