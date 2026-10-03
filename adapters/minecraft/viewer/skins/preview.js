/* Asset preview with the exact player model used by the live observer. */
window.AnimaViewerStart=({THREE,Viewer})=>{
  const names=['Sheldon','Sherlock','Deadpool','HuYifei'],textures=new Map();
  const renderer=new THREE.WebGLRenderer({antialias:true});renderer.setSize(innerWidth,innerHeight*.75);document.body.appendChild(renderer.domElement);
  const viewer=new Viewer(renderer);viewer.scene.background=new THREE.Color('#d5dccb');
  viewer.camera.position.set(0,2.4,-8);viewer.camera.lookAt(0,1.2,0);
  const floor=new THREE.Mesh(new THREE.PlaneGeometry(16,12),new THREE.MeshLambertMaterial({color:'#8ea18c'}));floor.rotation.x=-Math.PI/2;viewer.scene.add(floor);
  for(let i=0;i<names.length;i++)viewer.updateEntity({id:i,name:'player',username:names[i],height:1.8,width:.6,pos:{x:(i-1.5)*2.4,y:0,z:0},yaw:0});
  Promise.all(names.map(name=>new Promise((resolve,reject)=>new THREE.TextureLoader().load(name+'.png',texture=>{
    texture.flipY=false;texture.magFilter=texture.minFilter=THREE.NearestFilter;textures.set(name,texture);resolve(texture);
  },undefined,reject)))).then(()=>document.getElementById('status').textContent='四套本地原创皮肤已加载。').catch(()=>document.getElementById('status').textContent='纹理加载失败，请刷新后检查服务。');
  let frame;
  function draw(){frame=requestAnimationFrame(draw);names.forEach((name,i)=>{
    const texture=textures.get(name);
    if(texture)viewer.entities.entities[i]?.traverse(child=>{if(child.isSkinnedMesh&&child.material.map!==texture){child.material.map=texture;child.material.needsUpdate=true;}});
  });viewer.update();renderer.render(viewer.scene,viewer.camera);}draw();
  addEventListener('resize',()=>{renderer.setSize(innerWidth,innerHeight*.75);viewer.camera.aspect=innerWidth/(innerHeight*.75);viewer.camera.updateProjectionMatrix();});
  addEventListener('pagehide',()=>{cancelAnimationFrame(frame);viewer.world.workers.forEach(w=>w.terminate());textures.forEach(t=>t.dispose());renderer.dispose();},{once:true});
};
