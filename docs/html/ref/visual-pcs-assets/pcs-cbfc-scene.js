(() => {
  const host=document.getElementById('cb-world'), panel=document.getElementById('lab-cbfc');
  const T=window.THREE;
  let renderer, scene, camera, controls, packet, start, direction, frame;
  function home(){
    camera.position.set(0,8,19);
    controls.target.set(0,0,0);
    controls.update();
  }
  function block(x,y,z,w,h,d,color){
    const geometry=new T.BoxGeometry(w,h,d);
    const mesh=new T.Mesh(geometry,new T.MeshLambertMaterial({color}));
    mesh.position.set(x,y,z);
    mesh.add(new T.LineSegments(new T.EdgesGeometry(geometry),new T.LineBasicMaterial({color:0xabcddd})));
    scene.add(mesh);
    return mesh;
  }
  function paint(){
    if(panel.hidden || !renderer)return;
    renderer.render(scene,camera);
  }
  function resize(){
    if(!host.clientWidth || !renderer)return;
    camera.aspect=host.clientWidth/host.clientHeight;
    camera.zoom=Math.min(1,camera.aspect/2);
    camera.updateProjectionMatrix();
    renderer.setSize(host.clientWidth,host.clientHeight);
    paint();
  }
  function init(){
    if(panel.hidden || renderer)return;
    try{renderer=new T.WebGLRenderer({antialias:true});}catch(e){
      host.textContent='A → B　发送通道　｜　B → A　反馈通道';return;
    }
    renderer.setPixelRatio(Math.min(devicePixelRatio,2));
    renderer.setClearColor(0x162639);
    host.append(renderer.domElement);
    scene=new T.Scene();
    camera=new T.PerspectiveCamera(34,1,.1,150);
    controls=new T.OrbitControls(camera,renderer.domElement);
    controls.minDistance=8;controls.maxDistance=50;
    controls.addEventListener('change',paint);
    scene.add(new T.HemisphereLight(0xffffff,0x7893ac,1.15));
    const light=new T.DirectionalLight(0xffffff,.8);light.position.set(-4,8,9);scene.add(light);
    for(const side of [-1,1]){
      const color=side<0?0x387faf:0x329979;
      block(side*7,0,0,3,2,4.8,color);
      for(let i=0;i<4;i++)block(side*7,1.2,-1.35+i*.9,2.5,.3,.5,color);
      const z=side*1.4;
      block(0,-.25,z,11,.22,.42,color);
      scene.add(new T.ArrowHelper(new T.Vector3(-side,0,0),new T.Vector3(0,.05,z),3,color,1,.8));
    }
    packet=block(0,.45,0,1.1,.65,.8,0xffc456);packet.visible=false;
    home();resize();
    new ResizeObserver(resize).observe(host);
    document.getElementById('cb-camera').onclick=()=>{home();paint();};
  }
  function animate(now){
    if(panel.hidden)return;
    const t=Math.min(1,(now-start)/1100);
    packet.position.set(direction*(t*11-5.5),.42,-direction*1.4);
    paint();
    if(t<1)frame=requestAnimationFrame(animate);
  }
  document.getElementById('cb-token').addEventListener('cb-transfer',e=>{
    init();if(!packet)return;
    cancelAnimationFrame(frame);direction=e.detail;packet.visible=!!direction;
    if(direction){start=performance.now();animate(start);}else paint();
  });
  new MutationObserver(()=>{if(panel.hidden)cancelAnimationFrame(frame);else{init();resize();}}).observe(panel,{attributes:true,attributeFilter:['hidden']});
  init();
})();
