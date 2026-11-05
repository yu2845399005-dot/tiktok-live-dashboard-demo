import * as THREE from 'three';

export const particleStyleShader = `
  vec3 particleColor(float tone){
    return mix(vec3(.09,.28,.53),vec3(.42,.70,.93),smoothstep(.25,.95,tone));
  }
  float particleProfile(vec2 point,float tone){
    float radius=length(point);
    float diamond=abs(point.x)+abs(point.y);
    float distance=mix(radius,diamond,mix(.32,.57,tone));
    float core=1.-smoothstep(.18,.48,distance);
    float halo=1.-smoothstep(.08,.5,radius);
    return core*.9+halo*.1;
  }
  float particleLifetime(float age){
    return smoothstep(0.,.1,age)*(1.-smoothstep(.58,.98,age));
  }
`;

export function createSignalParticles(scene, surface, camera, morph, reducedMotion) {
  const count=1600;
  const positions=new Float32Array(count*3);
  const seeds=new Float32Array(count*3);
  const indices=new Uint32Array(count);
  const sourceCount=surface.geometry.attributes.position.count;
  let randomSeed=14821;
  const random=()=>{
    randomSeed=(Math.imul(randomSeed,1664525)+1013904223)>>>0;
    return randomSeed/4294967296;
  };
  for(let i=0;i<count;i++){
    // Regional samples at multiples of five belong to the coast contour.
    indices[i]=Math.floor(random()*Math.ceil(sourceCount/5))*5%sourceCount;
    seeds.set([random(),random(),random()],i*3);
  }
  const geometry=new THREE.BufferGeometry();
  const positionAttribute=new THREE.BufferAttribute(positions,3).setUsage(THREE.DynamicDrawUsage);
  geometry.setAttribute('position',positionAttribute);
  geometry.setAttribute('signalSeed',new THREE.BufferAttribute(seeds,3));
  const shared=surface.material.uniforms;
  const uniforms={
    particleTime:shared.particleTime,
    morphShape:shared.morphShape,
    entryRed:shared.entryRed,
    regionMask:shared.regionMask,
    regionMaskRect:shared.regionMaskRect,
    regionViewport:shared.regionViewport,
    signalUp:{value:new THREE.Vector3()},
    signalRight:{value:new THREE.Vector3()},
    signalOpacity:{value:0},
  };
  const material=new THREE.ShaderMaterial({
    uniforms,transparent:true,depthWrite:false,depthTest:false,toneMapped:false,
    vertexShader:`
      attribute vec3 signalSeed;
      uniform float particleTime; uniform float morphShape;
      uniform vec3 signalUp; uniform vec3 signalRight;
      varying float life; varying float brightness; varying float facing;
      void main(){
        life=fract(particleTime*mix(.16,.24,signalSeed.y)+signalSeed.x);
        float height=mix(.16+.20*signalSeed.y,.40+.30*signalSeed.y,morphShape);
        float sideways=sin(life*4.+signalSeed.z*6.283)*.045*life;
        vec3 world=position+signalUp*height*life+signalRight*sideways;
        facing=mix(dot(normalize(position),normalize(cameraPosition-position)),1.,morphShape);
        brightness=mix(.55,1.,signalSeed.z);
        gl_Position=projectionMatrix*viewMatrix*vec4(world,1.);
        gl_PointSize=mix(1.05,1.8,signalSeed.z)*float(${Math.min(devicePixelRatio,2).toFixed(1)});
      }`,
    fragmentShader:`
      uniform float morphShape; uniform float entryRed; uniform float signalOpacity;
      uniform sampler2D regionMask; uniform vec4 regionMaskRect; uniform vec2 regionViewport;
      varying float life; varying float brightness; varying float facing;
      ${particleStyleShader}
      void main(){
        if(facing<.02)discard;
        vec2 uv=(gl_FragCoord.xy/regionViewport-regionMaskRect.xy)/regionMaskRect.zw;
        float clearance=1.;
        if(morphShape>.1&&all(greaterThanEqual(uv,vec2(0.)))&&all(lessThanEqual(uv,vec2(1.))))
          clearance=1.-smoothstep(.005,.08,texture2D(regionMask,uv).a);
        float dotAlpha=particleProfile(gl_PointCoord-.5,brightness);
        float alpha=dotAlpha*particleLifetime(life)*brightness*signalOpacity*entryRed*clearance
          *smoothstep(.02,.18,facing)*mix(.22,.48,morphShape);
        gl_FragColor=vec4(particleColor(brightness),alpha);
        #include <colorspace_fragment>
      }`,
  });
  const points=new THREE.Points(geometry,material);
  points.name='upward-live-signals';
  points.frustumCulled=false;
  points.visible=!reducedMotion;
  scene.add(points);
  const position=new THREE.Vector3();
  let previous=performance.now();
  return {
    update(now){
      if(reducedMotion)return;
      const elapsed=Math.min(.05,(now-previous)/1000);
      previous=now;
      const targetOpacity=morph.transitioning?0:1;
      uniforms.signalOpacity.value+=(targetOpacity-uniforms.signalOpacity.value)*(1-Math.exp(-elapsed/.18));
      if(uniforms.signalOpacity.value<.005)return;
      surface.updateWorldMatrix(true,false);
      for(let i=0;i<count;i++)morph.getWorldPosition(indices[i],position).toArray(positions,i*3);
      positionAttribute.needsUpdate=true;
      uniforms.signalUp.value.setFromMatrixColumn(camera.matrixWorld,1);
      uniforms.signalRight.value.setFromMatrixColumn(camera.matrixWorld,0);
    },
  };
}
