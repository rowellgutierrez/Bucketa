import * as T from 'three';
/** Each factory returns an owned group. Extend this registry for future items. */
export const accessoryFactories = Object.freeze({halloween:makeWitchHat});
function makeWitchHat(){
 const hat=new T.Group();hat.name='HalloweenWitchHat';hat.position.set(-.72,2.58,.48);hat.rotation.z=.12;
 const purple=new T.MeshStandardMaterial({color:0x48286e,roughness:.72});
 const brim=new T.Mesh(new T.SphereGeometry(.53,32,12),purple);brim.scale.set(1,.10,.83);hat.add(brim);
 const coneGeo=new T.CylinderGeometry(.012,.335,.77,32,12);
 const p=coneGeo.attributes.position;for(let i=0;i<p.count;i++){const u=(p.getY(i)+.385)/.77;p.setX(i,p.getX(i)-.25*u*u);p.setZ(i,p.getZ(i)+.06*u*u);}coneGeo.computeVertexNormals();
 const cone=new T.Mesh(coneGeo,purple);cone.position.y=.405;hat.add(cone);
 const band=new T.Mesh(new T.CylinderGeometry(.275,.326,.13,32),new T.MeshStandardMaterial({color:0xf39a42,roughness:.6}));band.position.y=.115;band.position.x=-.012;hat.add(band);
 const buckle=new T.Mesh(new T.TorusGeometry(.065,.016,8,4),new T.MeshStandardMaterial({color:0xffda72,metalness:.4,roughness:.3}));buckle.position.set(-.01,.12,.315);buckle.rotation.z=Math.PI/4;hat.add(buckle);
 return hat;
}
export function createAccessories(model){
 const root=model.getObjectByName('Bucky');if(!root)throw Error('Bucky root missing');let active=null,theme='none';
 function disposeActive(){if(!active)return;const geometries=new Set(),materials=new Set();active.traverse(n=>{if(n.isMesh){geometries.add(n.geometry);for(const m of (Array.isArray(n.material)?n.material:[n.material]))materials.add(m);}});active.removeFromParent();geometries.forEach(g=>g.dispose());materials.forEach(m=>m.dispose());active=null;}
 function setAccessory(value){if(value!=='none'&&!Object.hasOwn(accessoryFactories,value))throw new RangeError('Unknown accessory');if(value===theme)return;disposeActive();theme=value;if(value!=='none'){active=accessoryFactories[value]();root.add(active);}}
 return {setAccessory,get theme(){return theme},get object(){return active},dispose(){disposeActive();theme='none';}};
}
