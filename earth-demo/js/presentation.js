// Presentation adjustments layered on the unmodified MIT-licensed upstream demo.
import * as THREE from 'three';
import './presentation-base.js?v=20261103-light-globe';
import {createCountryRegions} from './country-regions.js';
import {entryFrame} from '../../entry-motion.mjs?v=20261027-transparent-entry';
import {createRegionMorph,globeFloatShader} from './region-morph.js?v=20261105-particle-polish';
import {createSignalParticles,particleStyleShader} from './signal-particles.js?v=20261105-particle-polish';

const earth = window.__earth;
const scene = earth.parent;
const camera = window.__camera;
const controls = window.__controls;
const params = window.__params;
const isDashboardEmbed = new URLSearchParams(location.search).get('embed') === 'dashboard';
let resumeSpinAt = 0;
const autoSpinSpeed = 0.011;
let spinPausedByUser = false;
let isInteracting = false;
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
let entryStartedAt = null;

Object.assign(params, {
  timePreset: 'night', sunAzimuthDeg: 150, sunElevationDeg: 54,
  sunAutoRotate: false, dayBoost: 0.65, nightBoost: 3.1,
  normalStrength: 0.42, duskStrength: 0.12, transitionWidth: 0.7,
  earthSpin: true, earthSpinSpeed: autoSpinSpeed,
  cloudOpacity: 0.0, cloudSpeed: 1.05,
  starsVisible: false, shieldVisible: false, flightVisible: false,
  markersVisible: false, atmosphereVisible: false, earthChinaLineOpacity: 0,
});
controls.enablePan = false;
controls.minDistance = 4.4;
controls.maxDistance = 12;
controls.enableDamping = true;
controls.dampingFactor = 0.045;
controls.rotateSpeed = 0.65;
controls.zoomSpeed = 0.65;

function coordinates(lat, lon, radius = 2.012) {
  const phi = THREE.MathUtils.degToRad(90 - lat);
  const theta = THREE.MathUtils.degToRad(lon + 180);
  return new THREE.Vector3(-radius * Math.sin(phi) * Math.cos(theta),
    radius * Math.cos(phi), radius * Math.sin(phi) * Math.sin(theta));
}
function updateSpinButton() {
  document.getElementById('rotate').textContent = params.earthSpin ? '暂停旋转' : '自动旋转';
  document.getElementById('rotate').setAttribute('aria-pressed', String(params.earthSpin));
}
// Show the upper slice of a taller virtual viewport without flattening the sphere.
const capViewHeight=1000;
const targetHeight=isDashboardEmbed ? .07 : .14;
if(isDashboardEmbed){
 const updateCapView=()=>{
  camera.fov=37;
  controls.rotateSpeed=.65*innerHeight/760;
  camera.setViewOffset(innerWidth,capViewHeight,0,0,innerWidth,innerHeight);
 };
 updateCapView();
 addEventListener('resize',updateCapView);
}
function resetView() {
  spinPausedByUser = false;
  resumeSpinAt = 0;
  params.earthSpin = true;
  updateSpinButton();
  earth.rotation.set(0, 0, 0);
  // Clear any remaining orbit momentum before establishing the reference view.
  controls.enableDamping = false;
  controls.update();
  camera.position.copy(coordinates(isDashboardEmbed ? 3 : 15, isDashboardEmbed ? -14.5 : -30, isDashboardEmbed ? 6.7 : innerWidth < 650 ? 8.5 : 6.35));
  controls.target.set(0, targetHeight, 0);
  controls.update();
  controls.enableDamping = true;
}
resetView();
if (isDashboardEmbed) {
  document.querySelector('#app canvas').addEventListener('dblclick', () => {
    if (regionMorph.active) {
      focusRegion('Global');
      parent.postMessage({type:'earth:reset'}, location.origin);
      return;
    }
    focusFlight = null;coastVelocity=0;
    resetView();
    parent.postMessage({type:'earth:reset'}, location.origin);
  });
}

// One camera-relative key light: upper left, grazing across the hemisphere.
// Camera-relative lighting preserves the composition while the globe is dragged.
// Keep the upper-left terrain readable up to the diagonal presentation cut.
const keyLightView = new THREE.Vector3(-0.42, 0.90, 0.08).normalize();
const keyLightWorld = new THREE.Vector3();
function updateKeyLight() {
  keyLightWorld.copy(keyLightView).applyQuaternion(camera.quaternion).normalize();
  params.sunAzimuthDeg = THREE.MathUtils.radToDeg(Math.atan2(keyLightWorld.x, keyLightWorld.z));
  params.sunElevationDeg = THREE.MathUtils.radToDeg(Math.asin(keyLightWorld.y));
  earth.material.uniforms.sunDirection?.value.copy(keyLightWorld);
  atmosphere.material.uniforms.keyLight.value.copy(keyLightWorld);
}

// A single land mask generates an even particle field across whole continents.
// Country identities and border channels are deliberately never rendered.
const cutUniforms = {
  presentationCenter: {value:new THREE.Vector2()}, presentationRadius:{value:1},landMask:{value:null},
  entryTerrain:{value:isDashboardEmbed?0:1},entryRed:{value:isDashboardEmbed?0:1}
};
const cutShader = `
 uniform vec2 presentationCenter; uniform float presentationRadius;
 uniform float entryTerrain; uniform float entryRed;
 vec2 globeScreenPosition(){return (gl_FragCoord.xy-presentationCenter)/presentationRadius;}
 float presentationDaylight(vec2 p){return 0.0;}
 float lowerHemisphereVisibility(vec2 p){return 1.0;}
 vec3 globePalette(vec2 p){
   float t=smoothstep(-0.8,1.0,p.x*.65-p.y*.7);
   vec3 cyan=vec3(.0,.8,1.),blue=vec3(.005,.22,1.),violet=vec3(.4,.025,1.),rose=vec3(1.,.0,.30);
   return t<.45?mix(cyan,blue,t/.45):t<.68?mix(blue,violet,(t-.45)/.23):mix(violet,rose,(t-.68)/.32);
 }
`;
async function loadDashboardLandMask() {
 const image=await new THREE.ImageLoader().loadAsync(new URL('../data/world/dashboard-land-mask.png',import.meta.url).href);
 const canvas=document.createElement('canvas');
 canvas.width=image.width;
 canvas.height=image.height;
 const context=canvas.getContext('2d',{willReadFrequently:true});
 // Keep the CPU sampling and GPU texture in the same south-to-north order.
 context.setTransform(1,0,0,-1,0,image.height);
 context.drawImage(image,0,0);
 const {data,width,height}=context.getImageData(0,0,image.width,image.height);
 const texture=new THREE.DataTexture(new Uint8Array(data.buffer),width,height,THREE.RGBAFormat);
 texture.wrapS=THREE.RepeatWrapping;
 texture.magFilter=THREE.LinearFilter;
 texture.minFilter=THREE.LinearFilter;
 texture.needsUpdate=true;
 return texture;
}
const [atlas]=await Promise.all([
 isDashboardEmbed ? loadDashboardLandMask().catch(()=>createCountryRegions()) : createCountryRegions(),
 window.__earthTexturesReady,
]);
const nightMap = earth.material.uniforms.nightTexture?.value.image;
earth.material = new THREE.ShaderMaterial({uniforms:cutUniforms,transparent:isDashboardEmbed,
 vertexShader:`varying vec3 vNormal; varying vec2 vUv; void main(){vUv=uv;vNormal=normalize(normalMatrix*normal);gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.);}`,
 fragmentShader:cutShader+`varying vec3 vNormal; varying vec2 vUv; uniform sampler2D landMask;void main(){
 vec2 p=globeScreenPosition();float rim=pow(1.-max(vNormal.z,0.),3.);
 float land=smoothstep(.025,.14,texture2D(landMask,vUv).r);
 // Deep navy globe with a subtle cool upper highlight, separate from the
 // unchanged cyan / rose outer atmosphere.
 float cap=smoothstep(-.7,.85,p.y);
 vec3 col=vec3(.0012,.0025,.009)+vec3(.014,.030,.10)*(rim*.30+.09+land*.10)*(.4+.6*cap);
 if (${isDashboardEmbed ? 'true' : 'false'}) {
   float capAlpha=smoothstep(.56,.99,p.y);
   float edge=smoothstep(.945,1.0,length(p));
   col=mix(vec3(.001,.012,.068),vec3(.011,.36,.76),edge*edge);
   gl_FragColor=vec4(col,max(capAlpha,land*.09)*entryTerrain);
 } else gl_FragColor=vec4(col*entryTerrain,1.);
 #include <tonemapping_fragment>
 #include <colorspace_fragment>
 }`});
cutUniforms.landMask.value=atlas;
earth.material.needsUpdate=true;
const {data,width,height}=atlas.image;
// Keep geographic outlines from the land mask. The existing night texture
// adds density around settled areas, while inland land still gets sparse dots.
const lightCanvas=document.createElement('canvas');
lightCanvas.width=720;
lightCanvas.height=360;
const lightContext=lightCanvas.getContext('2d',{willReadFrequently:true});
if(nightMap?.naturalWidth)lightContext.drawImage(nightMap,0,0,720,360);
const nightPixels=lightContext.getImageData(0,0,720,360).data;
function isLand(x,y){
 const wrappedX=(x+width)%width;
 return data[(Math.max(0,Math.min(height-1,y))*width+wrappedX)*4]>=10;
}
function particleDensity(lat,lon,x,y,position){
 const lightX=Math.min(719,Math.floor((lon+180)*2));
 const lightY=Math.min(359,Math.floor((90-lat)*2));
 const lightIndex=(lightY*720+lightX)*4;
 const light=THREE.MathUtils.smoothstep(nightPixels[lightIndex],18,110);
 const coastX=Math.round(width/180);
 const coastY=Math.round(height/90);
 const coastal=!isLand(x-coastX,y)||!isLand(x+coastX,y)||
   !isLand(x,y-coastY)||!isLand(x,y+coastY);
 // A sphere-space field creates patches of different sizes without a seam.
 const {x:px,y:py,z:pz}=position;
 const broad=Math.sin(15*px+9*py+2*Math.sin(8*pz))*Math.cos(11*pz-7*py);
 const detail=Math.sin(32*px-21*pz)*Math.cos(27*py+15*pz);
 const patches=THREE.MathUtils.smoothstep(broad*.68+detail*.32,-.18,.63);
 const density=Math.max(light,patches*(coastal ? 1 : .85));
 return density;
}
const positions=[];
const particleTones=[];
let particleSeed=11931;
function particleRandom(){particleSeed=(Math.imul(particleSeed,1664525)+1013904223)>>>0;return particleSeed/4294967296;}
const cellSize=.052,cells=new Map();
const pointSpacings=[];
const cellKey=(x,y,z)=>`${x},${y},${z}`;
for(let i=0;i<190000;i++){
 const lat=THREE.MathUtils.radToDeg(Math.asin(2*particleRandom()-1));
 const lon=particleRandom()*360-180;
 if(lat< -79 || lat>84)continue;
 const x=Math.min(width-1,Math.floor((lon+180)/360*width));
 const y=Math.min(height-1,Math.floor((lat+90)/180*height));
 if(!isLand(x,y))continue;
 const pos=coordinates(lat,lon,2.006);
 const density=particleDensity(lat,lon,x,y,pos);
 if(particleRandom()>.045+.95*density*density)continue;
 const spacing=THREE.MathUtils.lerp(cellSize,.019,density);
 const tone=THREE.MathUtils.clamp(.24+density*.55+particleRandom()*.25,0,1);
 const cx=Math.floor(pos.x/cellSize),cy=Math.floor(pos.y/cellSize),cz=Math.floor(pos.z/cellSize);
 let separated=true;
 for(let dx=-1;dx<=1 && separated;dx++)for(let dy=-1;dy<=1 && separated;dy++)for(let dz=-1;dz<=1 && separated;dz++){
  const neighbours=cells.get(cellKey(cx+dx,cy+dy,cz+dz));
  if(!neighbours)continue;
  for(const index of neighbours){
   const separation=(spacing+pointSpacings[index/3])*.5;
   if((pos.x-positions[index])**2+(pos.y-positions[index+1])**2+(pos.z-positions[index+2])**2<separation*separation){separated=false;break;}
  }
 }
 if(!separated)continue;
 const key=cellKey(cx,cy,cz),bucket=cells.get(key)||[];
 bucket.push(positions.length);cells.set(key,bucket);
 pointSpacings.push(spacing);particleTones.push(tone);positions.push(pos.x,pos.y,pos.z);
}
cells.clear();
const geometry=new THREE.BufferGeometry();
geometry.setAttribute('position',new THREE.Float32BufferAttribute(positions,3));
geometry.setAttribute('particleTone',new THREE.Float32BufferAttribute(particleTones,1));
const hoverAmounts=new Float32Array(positions.length/3);
const hoverAttribute=new THREE.BufferAttribute(hoverAmounts,1).setUsage(THREE.DynamicDrawUsage);
geometry.setAttribute('hoverAmount',hoverAttribute);
const particles=new THREE.Points(geometry,new THREE.ShaderMaterial({
 uniforms:cutUniforms,transparent:true,depthWrite:false,depthTest:false,toneMapped:false,
 vertexShader:`attribute float hoverAmount; attribute float particleTone;
 attribute vec3 morphSource; attribute vec3 morphTarget; attribute vec3 morphScatter;
 attribute float morphDelay; attribute float morphTone;
 uniform float morphEnabled; uniform float morphProgress; uniform float morphShape;
 uniform float particleTime; uniform float particleFloatStrength;
 varying float vTone; varying float vHover; varying float facing; varying float vShape; varying float vFloat;
 varying float vSignalLife; varying float vGlobalEmission;
 ${globeFloatShader}
 void main(){vec3 floated=floatingGlobePosition(position,particleTone,particleTime,particleFloatStrength);
 vec4 p=modelViewMatrix*vec4(floated,1.);vHover=hoverAmount;vTone=mix(particleTone,morphTone,morphShape);vShape=morphShape;
 vFloat=clamp(length(floated-position)/.6,0.,1.)*(1.-morphShape);
 vSignalLife=globeSignalAge(position,particleTone,particleTime);
 vGlobalEmission=particleFloatStrength*(1.-morphShape);
 facing=dot(normalize(normalMatrix*normalize(position)),normalize(-p.xyz));
 float depthScale=clamp(6.5/-p.z,.8,1.15);
 float baseSize=(mix(1.,1.9,particleTone)+mix(4.3,7.8,particleTone)*hoverAmount)*depthScale*mix(1.,1.9,hoverAmount);
 if(morphEnabled>.5){
   float t=smoothstep(0.,1.,clamp((morphProgress-morphDelay)/(1.-morphDelay),0.,1.));
   vec3 world=mix(morphSource,morphTarget,t)+morphScatter*sin(3.14159265*t)*(1.-t*.4);
   p=viewMatrix*vec4(world,1.);
   facing=mix(facing,1.,morphShape);
 }
 gl_Position=projectionMatrix*p;
 gl_PointSize=mix(baseSize,mix(1.,1.9,vTone)+hoverAmount*5.,morphShape)*float(${Math.min(devicePixelRatio,2).toFixed(1)})*mix(1.,1.4,vFloat);
 }`,
 fragmentShader:cutShader+`varying float vTone; varying float vHover; varying float facing; varying float vShape; varying float vFloat;
 varying float vSignalLife; varying float vGlobalEmission;
 ${particleStyleShader}
 void main(){if(facing<.015)discard;
 vec2 pointOffset=gl_PointCoord-.5;
 float haloRadius=length(pointOffset);
 float r=haloRadius*mix(1.,1.9,vHover);
 float edge=mix(.5,.49,vHover);
 float featherStart=mix(.30,.26,vHover);
 float alpha=(1.-smoothstep(featherStart,edge,r))*smoothstep(.015,.15,facing)*entryRed*.86;
 vec2 point=globeScreenPosition();
 float cap=mix(smoothstep(${isDashboardEmbed ? ".06,.93" : "-.85,.65"},point.y),.9,vShape);
 vec3 core=particleColor(vTone)*mix(.75,1.,cap);
 float hoverLight=smoothstep(0.,.85,vHover);
 float highlight=hoverLight*(1.-smoothstep(.23,.49,r));
 core=mix(core,vec3(.60,.80,1.),highlight);
 float idleOpacity=mix(.28,1.,vTone)*(${isDashboardEmbed ? ".27+.73*cap" : ".44+.56*cap"});
 float coreOpacity=alpha*mix(idleOpacity,1.,hoverLight);
 float haloOpacity=.23*hoverLight*(1.-smoothstep(.08,.5,haloRadius))
   *smoothstep(.015,.15,facing)*entryRed;
 float opacity=coreOpacity+haloOpacity*(1.-coreOpacity);
 vec3 color=mix(particleColor(vTone),core,coreOpacity/max(opacity,.001));
 // The surface and emitted signals share their profile and blue palette.
 float clarity=smoothstep(.34,.84,vTone);
 float idleEdge=particleProfile(pointOffset,vTone);
 float idleVisibility=mix(.19,.96,clarity)*mix(.57,1.,cap);
 vec3 idleColor=particleColor(vTone);
 float idleWeight=1.-smoothstep(0.,.34,vHover);
 float idleAlpha=idleEdge*idleVisibility*smoothstep(.015,.15,facing)*entryRed;
 float signalFade=particleLifetime(vSignalLife);
 gl_FragColor=vec4(mix(color,idleColor,idleWeight),mix(opacity,idleAlpha,idleWeight)*mix(1.,.9,vShape)*mix(1.,.65,vFloat)*mix(1.,signalFade,vGlobalEmission));
 #include <colorspace_fragment>
 }`
}));
particles.name='continent-particles';earth.add(particles);
const regionMorph=createRegionMorph(particles,camera,reducedMotion,(region,transitioning)=>{
  if(region==='Global'&&!transitioning){
    controls.enabled=true;
    resumeSpinAt=performance.now()+300;
  }
  if(isDashboardEmbed)parent.postMessage({type:'earth:region-view',region:region==='Global'&&transitioning?'transition':region,transitioning},location.origin);
});
addEventListener('resize',()=>regionMorph.resize());
const signalParticles=createSignalParticles(scene,particles,camera,regionMorph,reducedMotion);
const contextParticles=new THREE.Points(geometry,new THREE.ShaderMaterial({
  uniforms:{contextOpacity:{value:0},particleTime:cutUniforms.particleTime,particleFloatStrength:cutUniforms.particleFloatStrength,globeSignalUp:cutUniforms.globeSignalUp,
    regionMask:cutUniforms.regionMask,regionMaskRect:cutUniforms.regionMaskRect,regionViewport:cutUniforms.regionViewport},transparent:true,depthWrite:false,depthTest:false,toneMapped:false,
  vertexShader:`attribute float particleTone; varying float tone; varying float facing;
    uniform float particleTime; uniform float particleFloatStrength;
    ${globeFloatShader}
    void main(){vec3 floated=floatingGlobePosition(position,particleTone,particleTime,particleFloatStrength);
    vec4 p=modelViewMatrix*vec4(floated,1.);tone=particleTone;
    facing=dot(normalize(normalMatrix*normalize(position)),normalize(-p.xyz));
    gl_Position=projectionMatrix*p;
    gl_PointSize=mix(1.,1.9,particleTone)*float(${Math.min(devicePixelRatio,2).toFixed(1)})*clamp(6.5/-p.z,.8,1.15);}`,
  fragmentShader:`uniform float contextOpacity; varying float tone; varying float facing;
    uniform sampler2D regionMask; uniform vec4 regionMaskRect; uniform vec2 regionViewport;
    ${particleStyleShader}
    void main(){
    vec2 uv=(gl_FragCoord.xy/regionViewport-regionMaskRect.xy)/regionMaskRect.zw;
    float clearance=1.;
    if(all(greaterThanEqual(uv,vec2(0.)))&&all(lessThanEqual(uv,vec2(1.))))clearance=1.-smoothstep(.005,.08,texture2D(regionMask,uv).a);
    float dotAlpha=particleProfile(gl_PointCoord-.5,tone);
    gl_FragColor=vec4(particleColor(tone),dotAlpha*contextOpacity*mix(.25,1.,tone)*smoothstep(.01,.18,facing)*clearance);
    #include <colorspace_fragment>
    }`,
}));
contextParticles.name='dim-global-context';earth.add(contextParticles);
for (const child of scene.children) {
  if (child.isAmbientLight) child.intensity = 0.035;
  if (child.isDirectionalLight) { child.intensity = 3.2; child.color.set('#e2ebff'); }
}

// Give the clouds the same cut as the terrain. A screen overlay would also dim
// markers and hide the lower-left lit wedge, so shade the layers themselves.
const clouds = scene.children.find(child => child.material?.isMeshPhongMaterial && child.material.map);
if (clouds) {
  clouds.material.onBeforeCompile = shader => {
    Object.assign(shader.uniforms, cutUniforms);
    shader.fragmentShader = cutShader + shader.fragmentShader;
    shader.fragmentShader = shader.fragmentShader.replace('#include <opaque_fragment>', `
      vec2 screenPoint = globeScreenPosition();
      float cloudDaylight = presentationDaylight(screenPoint);
      outgoingLight *= mix(0.045 * lowerHemisphereVisibility(screenPoint), 0.70, cloudDaylight) * entryTerrain;
      #include <opaque_fragment>
    `);
  };
  clouds.material.needsUpdate = true;
}

// Integrate density along the actual view ray through a thin atmospheric shell.
// Exponential falloff removes the painted outer band. The same key light shades
// the atmosphere and surface; the unlit lower rim contributes no visible blue.
const atmosphere = new THREE.Mesh(new THREE.SphereGeometry(2.72, 96, 96), new THREE.ShaderMaterial({
  uniforms: { presentationCenter:cutUniforms.presentationCenter,presentationRadius:cutUniforms.presentationRadius,keyLight: { value: new THREE.Vector3() }, strength: { value: 1 }, entryGlow: {value:isDashboardEmbed ? 0 : 1} },
  vertexShader: /* glsl */ `
    varying vec3 vWorld;
    void main() { vec4 p = modelMatrix * vec4(position,1.0);
      vWorld = p.xyz; gl_Position = projectionMatrix * viewMatrix * p; }
  `,
  fragmentShader: /* glsl */ `
    uniform vec2 presentationCenter;
    uniform float presentationRadius;
    uniform vec3 keyLight;
    uniform float strength;
    uniform float entryGlow;
    varying vec3 vWorld;
    vec2 hitSphere(vec3 origin, vec3 ray, float radius) {
      float b = dot(origin,ray);
      float d = b*b - dot(origin,origin) + radius*radius;
      if (d < 0.0) return vec2(1e5,-1e5);
      float h = sqrt(d); return vec2(-b-h,-b+h);
    }
    void main() {
      vec3 ray = normalize(vWorld-cameraPosition);
      vec2 shell = hitSphere(cameraPosition,ray,2.72);
      vec2 planet = hitSphere(cameraPosition,ray,2.0);
      float nearT = max(0.0,shell.x);
      float farT = shell.y;
      if (planet.x > 0.0 && planet.x < farT) farT = planet.x;
      if (farT <= nearT) discard;
      float stepSize = (farT-nearT)/24.0;
      float scattering = 0.0;
      for (int i=0; i<24; i++) {
        vec3 p = cameraPosition + ray*(nearT+(float(i)+0.5)*stepSize);
        float height = max(0.0,length(p)-2.0);
        float density = exp(-height/0.068);
        float sunlight = 0.72;
        scattering += density*sunlight*stepSize;
      }
      // Let the blue haze breathe outside the silhouette while limiting the
      // blue veil over the terrain. Blend at the limb to avoid a cut-out edge.
      float impact = length(cross(cameraPosition,ray));
      float exterior = smoothstep(1.94,2.045,impact);
      float opacity = (1.0-exp(-scattering*3.50))*strength*entryGlow;
      opacity *= mix(0.13,1.0,exterior);
      // Saturated blue at the upper limb, with the existing soft outer falloff.
      vec3 viewPoint=(viewMatrix*vec4(vWorld,1.)).xyz;
      vec3 normalView=normalize(mat3(viewMatrix)*normalize(vWorld));
      float tint=smoothstep(-.8,1.,normalView.x*.65-normalView.y*.7);
      vec3 glowColor=tint<.45?mix(vec3(0.,1.,1.),vec3(.01,.2,1.),tint/.45):mix(vec3(.01,.2,1.),vec3(1.,0.,.30),(tint-.45)/.55);
      if (${isDashboardEmbed ? 'true' : 'false'}) {
        vec2 p=(gl_FragCoord.xy-presentationCenter)/presentationRadius;
        float upper=smoothstep(.35,.94,p.y);
        float rim=exp(-abs(impact-2.0)*33.0);
        glowColor=mix(vec3(.015,.20,.94),vec3(.04,.65,1.),rim*upper);
        opacity=(opacity*.90+rim*entryGlow*.36)*upper;
      }
      gl_FragColor=vec4(glowColor,min(opacity*1.45,1.0));
    }
  `,
  transparent: true, side: THREE.BackSide, depthWrite: false, depthTest: false,
  // Keep additive RGB while composing coverage correctly over the dashboard.
  // Ordinary additive alpha is squared by SRC_ALPHA and creates a hard halo
  // when the transparent canvas is composited over a non-black background.
  blending: isDashboardEmbed ? THREE.CustomBlending : THREE.AdditiveBlending,
  blendEquation: THREE.AddEquation,
  blendSrc: THREE.SrcAlphaFactor,
  blendDst: THREE.OneFactor,
  blendEquationAlpha: THREE.AddEquation,
  blendSrcAlpha: THREE.OneFactor,
  blendDstAlpha: THREE.OneMinusSrcAlphaFactor,
}));
atmosphere.name = 'directional-atmosphere';
atmosphere.renderOrder = 4;
scene.add(atmosphere);
updateKeyLight();

// Track the projected sphere in drawing-buffer pixels for both surface layers.
const projectedCenter = new THREE.Vector3();
function updatePresentationFrame() {
  projectedCenter.set(0,0,0).project(camera);
  const distance = camera.position.length();
  const focal = (camera.view?.enabled ? camera.view.fullHeight : innerHeight)*0.5/Math.tan(THREE.MathUtils.degToRad(camera.fov)*0.5);
  const radius = focal*2/Math.sqrt(Math.max(0.01,distance*distance-4));
  const pixelRatio = Math.min(devicePixelRatio, 2);
  cutUniforms.presentationCenter.value.set(
    (1 + projectedCenter.x) * innerWidth * 0.5 * pixelRatio,
    (1 + projectedCenter.y) * innerHeight * 0.5 * pixelRatio,
  );
  cutUniforms.presentationRadius.value = radius * pixelRatio;
}
updatePresentationFrame();

// Fixed geographic anchor points. The planet's own depth buffer occludes the
// back side; an extra horizon fade prevents billboard halos leaking at the limb.
const regions = [
  { id: 'AMS', lat: 40.7, lon: -74.0, size: 0.068 },
  { id: 'EU', lat: 48.2, lon: 16.4, size: 0.062 },
  { id: 'METAP', lat: 39.9, lon: 32.9, size: 0.068 },
  { id: 'NEA', lat: 37.6, lon: 127.0, size: 0.058 },
  { id: 'SEA', lat: 1.3, lon: 103.8, size: 0.055 },
];
const group = new THREE.Group();
group.name = 'regional-light-points';
earth.add(group);
group.visible=false;
function markerTexture(halo = false) {
  const canvas = document.createElement('canvas'); canvas.width = canvas.height = 128;
  const c = canvas.getContext('2d');
  if (halo) {
    const g = c.createRadialGradient(64,64,0,64,64,64);
    g.addColorStop(0,'rgba(255,36,28,0.95)');
    g.addColorStop(0.18,'rgba(255,28,22,0.75)');
    g.addColorStop(0.44,'rgba(255,25,20,0.25)');
    g.addColorStop(1,'rgba(255,25,20,0)');
    c.fillStyle=g; c.fillRect(0,0,128,128);
  } else {
    const core = c.createRadialGradient(56,54,4,64,64,32);
    core.addColorStop(0,'#ff6c5f'); core.addColorStop(1,'#ef2929');
    c.fillStyle=core; c.beginPath(); c.arc(64,64,31,0,Math.PI*2); c.fill();
    c.strokeStyle='#ffded6'; c.lineWidth=4;
    c.beginPath(); c.arc(64,64,32,0,Math.PI*2); c.stroke();
  }
  const texture = new THREE.CanvasTexture(canvas);
  // Canvas colours are authored in sRGB; decode them before display conversion
  // so the red LIVE markers retain their colour instead of turning pastel pink.
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}
const pointDisc = markerTexture();
const pointGlow = markerTexture(true);
const lights = regions.map(region => {
  const anchor = new THREE.Group(); anchor.position.copy(coordinates(region.lat, region.lon, 2.04));
  anchor.name = region.id; group.add(anchor);
  const dot = new THREE.Sprite(new THREE.SpriteMaterial({map: pointDisc,
    color: '#ffffff', transparent: true, opacity:isDashboardEmbed?0:1, depthWrite: false, toneMapped: false}));
  dot.scale.setScalar(region.size * 2.0);
  dot.renderOrder = 6;
  anchor.add(dot);
  const halo = new THREE.Sprite(new THREE.SpriteMaterial({map: pointGlow,
    color: '#ffffff', transparent: true, opacity:isDashboardEmbed?0:0.90, depthWrite: false, toneMapped: false}));
  halo.renderOrder = 5;
  halo.scale.setScalar(region.size * 6.0); anchor.add(halo);
  return {region, anchor, dot, halo};
});
const world = new THREE.Vector3();
const view = new THREE.Vector3();
const center = new THREE.Vector3();
const earthCenter = new THREE.Vector3();
const projectedMarker = new THREE.Vector3();
const panelNames = {AMS:'AMS&ANZ',EU:'EU+',METAP:'METAP',NEA:'NEA',SEA:'SEA&CCA'};
const focusLocations=Object.fromEntries(regions.map(({id,lat,lon})=>[panelNames[id],[lat-36,lon]]));
let focusFlight = null;
function focusRegion(region) {
  if(isDashboardEmbed){
    focusFlight=null;coastVelocity=0;lastPointer=null;
    if(region==='Global')spinPausedByUser=false;
    params.earthSpin=false;resumeSpinAt=Infinity;
    controls.enableDamping=false;controls.update();controls.enableDamping=true;
    controls.enabled=false;
    updateSpinButton();
    if(region==='Global'&&!regionMorph.active){controls.enabled=true;resumeSpinAt=performance.now()+850;}
    regionMorph.select(region).catch(()=>{
      controls.enabled=true;resumeSpinAt=performance.now()+850;
      parent.postMessage({type:'earth:morph-failed'},location.origin);
    });
    return;
  }
  if (region === 'Global') { focusFlight = null;coastVelocity=0;resetView(); return; }
  const location = focusLocations[region];
  if (!location) return;
  params.earthSpin = false;
  resumeSpinAt = Infinity;
  updateSpinButton();
  controls.enableDamping = false; controls.update();
  const start = camera.position.clone().normalize();
  // The globe has its own spin, so target the region's current world direction.
  const destination = coordinates(location[0], location[1], 1).applyQuaternion(earth.quaternion).normalize();
  focusFlight = {start, rotation: new THREE.Quaternion().setFromUnitVectors(start, destination),
    radius: camera.position.length(), endRadius:isDashboardEmbed?6.7:camera.position.length(), began: performance.now()};
}
function updateFocusFlight() {
  if (!focusFlight) return;
  const t = Math.min(1, (performance.now() - focusFlight.began) / 1100);
  const eased = t * t * (3 - 2 * t);
  const q = new THREE.Quaternion().slerp(focusFlight.rotation, eased);
  camera.position.copy(focusFlight.start).applyQuaternion(q).multiplyScalar(THREE.MathUtils.lerp(focusFlight.radius,focusFlight.endRadius,eased));
  controls.target.set(0, targetHeight, 0); controls.update();
  if (t === 1) { focusFlight = null; controls.enableDamping = true; resumeSpinAt = performance.now() + 1600; }
}
if (isDashboardEmbed) {
  window.addEventListener('message', event => {
    if (event.origin !== location.origin || event.source !== parent) return;
    if (event.data?.type === 'earth:focus-region') focusRegion(event.data.region);
    if(event.data?.type==='earth:layout'&&Number.isFinite(event.data.height))regionMorph.setAvailableHeight(event.data.height);
    if(event.data?.type==='earth:appearance'){params.cloudOpacity=event.data.clouds?.045:0;spinPausedByUser=!event.data.spin;params.earthSpin=event.data.spin&&!regionMorph.active;resumeSpinAt=event.data.spin&&!regionMorph.active?0:Infinity;updateSpinButton();}
  });
}
// Direct drag with a short inertial coast, then a gentle automatic restart.
const globeCanvas=document.querySelector('#app canvas');
globeCanvas.style.cursor='grab';
const hoverPointer=new THREE.Vector2(-1e5,-1e5),hoverSmoothed=hoverPointer.clone();
let hoverActive=false,lastHoverTime=performance.now();
const hoverProjection=new THREE.Matrix4();
const hoverWorldPosition=new THREE.Vector3();
function setHoverPointer(event){
 const rect=globeCanvas.getBoundingClientRect();
 hoverPointer.set((event.clientX-rect.left)/rect.width*innerWidth,(event.clientY-rect.top)/rect.height*innerHeight);
 if(!hoverActive)hoverSmoothed.copy(hoverPointer);
 hoverActive=true;
}
globeCanvas.addEventListener('pointerenter',setHoverPointer);
globeCanvas.addEventListener('pointerleave',()=>{hoverActive=false;});
window.addEventListener('blur',()=>{hoverActive=false;});
function updateParticleHover(){
 const now=performance.now(),dt=Math.min(.05,(now-lastHoverTime)/1000);lastHoverTime=now;
 hoverSmoothed.lerp(hoverPointer,1-Math.exp(-dt/.035));
 particles.updateWorldMatrix(true,false);
 hoverProjection.multiplyMatrices(camera.projectionMatrix,camera.matrixWorldInverse);
 const e=hoverProjection.elements;
 const radius=cutUniforms.presentationRadius.value/Math.min(devicePixelRatio,2)*.18;
 const inverseRadiusSquared=1/(radius*radius);
 const enter=1-Math.exp(-dt/.075),leave=1-Math.exp(-dt/.32);
 for(let i=0;i<hoverAmounts.length;i++){
  let target=0;
  if(hoverActive&&!regionMorph.transitioning){
    const {x,y,z}=regionMorph.getWorldPosition(i,hoverWorldPosition);
    const w=e[3]*x+e[7]*y+e[11]*z+e[15];
    const sx=((e[0]*x+e[4]*y+e[8]*z+e[12])/w+1)*innerWidth*.5;
    const sy=(1-(e[1]*x+e[5]*y+e[9]*z+e[13])/w)*innerHeight*.5;
    const distanceSquared=(sx-hoverSmoothed.x)**2+(sy-hoverSmoothed.y)**2;
    target=Math.exp(-distanceSquared*inverseRadiusSquared*2.6);
  }
  hoverAmounts[i]=reducedMotion?target:hoverAmounts[i]+(target-hoverAmounts[i])*(target>hoverAmounts[i]?enter:leave);
 }
 hoverAttribute.needsUpdate=true;
}
let lastPointer=null,dragVelocity=0,coastVelocity=0,lastMotionTime=performance.now();
globeCanvas.addEventListener('pointerdown',event=>{setHoverPointer(event);lastPointer={x:event.clientX,time:event.timeStamp};dragVelocity=0;coastVelocity=0;globeCanvas.style.cursor='grabbing';});
globeCanvas.addEventListener('pointermove',event=>{
 setHoverPointer(event);
 if(!lastPointer || !isInteracting)return;
 const dt=Math.max(.008,(event.timeStamp-lastPointer.time)/1000);
 const velocity=(event.clientX-lastPointer.x)/(isDashboardEmbed?800:innerWidth)*3.5/dt;
 dragVelocity=THREE.MathUtils.clamp(dragVelocity*.55+velocity*.45,-1.2,1.2);
 lastPointer={x:event.clientX,time:event.timeStamp};
});
globeCanvas.addEventListener('pointerup',event=>{
 coastVelocity=lastPointer && event.timeStamp-lastPointer.time<100?dragVelocity:0;
 lastPointer=null;globeCanvas.style.cursor='grab';
});
globeCanvas.addEventListener('pointercancel',()=>{hoverActive=false;lastPointer=null;coastVelocity=0;globeCanvas.style.cursor='grab';});
function updateMomentum(){
 const now=performance.now(),dt=Math.min(.05,(now-lastMotionTime)/1000);lastMotionTime=now;
 if(reducedMotion||isInteracting||focusFlight||regionMorph.active){coastVelocity=0;return;}
 const decay=Math.exp(-2.8*dt);
 earth.rotation.y+=coastVelocity*(1-decay)/2.8;coastVelocity*=decay;
 if(Math.abs(coastVelocity)<.001)coastVelocity=0;
 if(params.earthSpin)params.earthSpinSpeed=autoSpinSpeed*THREE.MathUtils.smoothstep((now-resumeSpinAt)/750,0,1);
}

controls.addEventListener('start', () => {
  focusFlight = null; controls.enableDamping = true;
  isInteracting = true; params.earthSpin = false; resumeSpinAt = Infinity;
  updateSpinButton();
});
function resumeAfterInteraction() {
  if (!isInteracting) return;
  isInteracting = false;
  resumeSpinAt = performance.now() + 850;
}
controls.addEventListener('end', resumeAfterInteraction);
globeCanvas.addEventListener('lostpointercapture', resumeAfterInteraction);
function updateAutoSpin() {
  if (!params.earthSpin && !spinPausedByUser && !isInteracting && !focusFlight && !regionMorph.active && performance.now() >= resumeSpinAt) {
    params.earthSpin = true; updateSpinButton();
  }
}

let lastRegionLayoutTime = -Infinity;
function animateLights() {
  const entryElapsed = isDashboardEmbed ? (entryStartedAt === null ? -1 : performance.now()-entryStartedAt) : Infinity;
  const entry = entryFrame(entryElapsed,reducedMotion && entryStartedAt !== null);
  regionMorph.update(performance.now());
  const shapeFade=1-cutUniforms.morphShape.value*.82;
  contextParticles.material.uniforms.contextOpacity.value=entry.red*cutUniforms.morphShape.value*.065;
  cutUniforms.entryTerrain.value=entry.terrain*shapeFade; cutUniforms.entryRed.value=entry.red;
  atmosphere.material.uniforms.entryGlow.value=entry.glow*shapeFade;
  updateAutoSpin();
  updateMomentum();
  updateFocusFlight();
  updateKeyLight();
  updatePresentationFrame();
  updateParticleHover();
  signalParticles.update(performance.now());
  earth.getWorldPosition(earthCenter);
  const layout = [];
  for (const light of lights) {
    light.anchor.getWorldPosition(world);
    center.copy(world).sub(earthCenter).normalize();
    view.copy(camera.position).sub(world).normalize();
    const visibility = THREE.MathUtils.smoothstep(center.dot(view), 0.06, 0.22);
    light.anchor.visible = visibility > 0;
    projectedMarker.copy(world).project(camera);
    const markerY = (projectedMarker.y - projectedCenter.y) * innerHeight * 0.5
      * Math.min(devicePixelRatio, 2) / cutUniforms.presentationRadius.value;
    const lowerFade = 1 - 0.85 * THREE.MathUtils.smoothstep(-markerY, 0.15, 0.90);
    light.dot.material.opacity = visibility * lowerFade * entry.markers;
    light.halo.material.opacity = visibility * lowerFade * 0.90 * entry.markers;
    const name = panelNames[light.region.id];
    if (name) layout.push({region:name,
      x:(projectedMarker.x + 1) * innerWidth * 0.5,
      y:(1 - projectedMarker.y) * innerHeight * 0.5,
      visibility:Math.min(1, visibility * 2)});
  }
  const now = performance.now();
  if (isDashboardEmbed && now - lastRegionLayoutTime > 33) {
    parent.postMessage({type:'earth:regions',points:layout,entryElapsed,shapeAnchor:regionMorph.labelAnchor},location.origin);
    lastRegionLayoutTime = now;
  }
  requestAnimationFrame(animateLights);
}
requestAnimationFrame(animateLights);

document.getElementById('rotate').addEventListener('click', (event) => {
  spinPausedByUser = params.earthSpin;
  params.earthSpin = !spinPausedByUser;
  resumeSpinAt = 0;
  updateSpinButton();
});
document.getElementById('reset').addEventListener('click', resetView);
document.getElementById('glow').addEventListener('input', event => {
  atmosphere.material.uniforms.strength.value = Number(event.target.value);
});
document.getElementById('points').addEventListener('click', event => {
  group.visible = !group.visible;
  event.currentTarget.setAttribute('aria-pressed', String(group.visible));
});
document.getElementById('fullscreen').addEventListener('click', async () => {
  try {
    if (document.fullscreenElement) await document.exitFullscreen();
    else await document.documentElement.requestFullscreen();
  } catch { /* Fullscreen can be unavailable in embedded previews. */ }
});
document.addEventListener('keydown', event => {
  if (event.key.toLowerCase() === 'h') document.body.classList.toggle('clean');
});
document.title = 'Global Earth · 地球演示';
if (isDashboardEmbed) {
  await window.__earthTexturesReady;
  // Warm shader programs and upload textures before the timed reveal begins.
  // The already-rendered first frame is genuinely black, even on a cold load.
  window.__renderer.render(scene,camera);
  await new Promise(resolve=>requestAnimationFrame(resolve));
}
entryStartedAt = performance.now();
document.body.classList.add('ready');

if (isDashboardEmbed) parent.postMessage({type:'earth:ready'}, location.origin);
