import * as THREE from 'three';

const morphDuration = 1200;

export const globeFloatShader = `
uniform vec3 globeSignalUp;
float globeSignalAge(vec3 p,float tone,float time){
  float phase=dot(p,vec3(2.7,5.1,3.3))+tone*6.28;
  return fract(time*mix(.16,.24,tone)+phase*.618);
}
vec3 floatingGlobePosition(vec3 p,float tone,float time,float strength){
  float age=globeSignalAge(p,tone,time);
  return p+globeSignalUp*age*mix(.18,.08,tone)*strength;
}`;

// Demo geographic groupings. Product market membership can be supplied here.
const regionGroups = {
  'AMS&ANZ': { longitude: -120, matches: p => ['North America', 'South America'].includes(p.CONTINENT) || ['AUS', 'NZL'].includes(p.ADM0_A3) },
  'EU+': { longitude: 20, matches: p => p.CONTINENT === 'Europe' && p.ADM0_A3 !== 'RUS', bounds: [-30, 65, -85, -30] },
  METAP: { longitude: 30, matches: p => p.CONTINENT === 'Africa' || p.SUBREGION === 'Western Asia' || p.ADM0_A3 === 'PAK' },
  NEA: { longitude: 110, matches: p => p.SUBREGION === 'Eastern Asia' },
  'SEA&CCA': { longitude: 100, matches: p => ['South-Eastern Asia', 'Central Asia'].includes(p.SUBREGION) },
};
let countryData;
const shapeCache = new Map();

async function regionShape(region) {
  if (shapeCache.has(region)) return shapeCache.get(region);
  countryData ??= fetch(new URL('../data/world/countries-50m.geojson', import.meta.url))
    .then(response => {
      if (!response.ok) throw new Error('Regional map could not be loaded');
      return response.json();
    }).catch(error => { countryData = null; throw error; });
  const { features } = await countryData;
  const definition = regionGroups[region];
  if (!definition) throw new Error('Unknown region');
  const polygons = [];
  for (const feature of features.filter(feature => definition.matches(feature.properties))) {
    const geometry = feature.geometry;
    if (!geometry) continue;
    const parts = geometry.type === 'Polygon' ? [geometry.coordinates] : geometry.coordinates;
    for (const rings of parts) {
      const projected = rings.map(ring => {
        let previous = definition.longitude;
        return ring.map(([longitude, latitude]) => {
          let x = longitude;
          while (x - previous > 180) x -= 360;
          while (x - previous < -180) x += 360;
          previous = x;
          return [x, -latitude];
        });
      });
      const exterior = projected[0];
      const centreX = exterior.reduce((sum, point) => sum + point[0], 0) / exterior.length;
      const centreY = exterior.reduce((sum, point) => sum + point[1], 0) / exterior.length;
      const bounds = definition.bounds;
      if (!bounds || (centreX >= bounds[0] && centreX <= bounds[1] && centreY >= bounds[2] && centreY <= bounds[3])) polygons.push(projected);
    }
  }
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const rings of polygons) for (const ring of rings) for (const [x, y] of ring) {
    minX = Math.min(minX, x); maxX = Math.max(maxX, x);
    minY = Math.min(minY, y); maxY = Math.max(maxY, y);
  }
  const latitudeScale = Math.cos((minY + maxY) * Math.PI / 360);
  const aspect = (maxX - minX) * latitudeScale / (maxY - minY);
  const canvas = document.createElement('canvas');
  canvas.width = 900;
  canvas.height = Math.max(240, Math.round(900 / aspect));
  const context = canvas.getContext('2d', { willReadFrequently: true });
  context.fillStyle = '#fff';
  for (const rings of polygons) {
    context.beginPath();
    for (const ring of rings) {
      ring.forEach(([x, y], index) => {
        const px = 4 + (x - minX) / (maxX - minX) * (canvas.width - 8);
        const py = 4 + (y - minY) / (maxY - minY) * (canvas.height - 8);
        if (index === 0) context.moveTo(px, py);
        else context.lineTo(px, py);
      });
      context.closePath();
    }
    context.fill('evenodd');
  }
  const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
  const fill = [], coast = [];
  const alpha = (x, y) => pixels[(y * canvas.width + x) * 4 + 3] || 0;
  for (let y = 4; y < canvas.height - 4; y += 2) {
    for (let x = 4; x < canvas.width - 4; x += 2) {
      if (alpha(x, y) < 180) continue;
      const point = [(x / canvas.width - .5), (.5 - y / canvas.height)];
      fill.push(point);
      if (alpha(x - 3, y) < 180 || alpha(x + 3, y) < 180 ||
          alpha(x, y - 3) < 180 || alpha(x, y + 3) < 180) coast.push(point);
    }
  }
  if (!fill.length) throw new Error('Regional map is empty');
  // A padded silhouette masks atmospheric dots around both the land and coast.
  const maskPadding=48;
  const maskCanvas=document.createElement('canvas');
  maskCanvas.width=canvas.width+maskPadding*2;
  maskCanvas.height=canvas.height+maskPadding*2;
  const maskContext=maskCanvas.getContext('2d');
  maskContext.filter='blur(18px)';
  maskContext.drawImage(canvas,maskPadding,maskPadding);
  maskContext.filter='none';
  maskContext.drawImage(canvas,maskPadding,maskPadding);
  const maskTexture=new THREE.CanvasTexture(maskCanvas);
  maskTexture.minFilter=THREE.LinearFilter;
  const shape = { fill, coast: coast.length ? coast : fill, aspect,maskTexture,maskPadding,
    rasterWidth:canvas.width,rasterHeight:canvas.height };
  shapeCache.set(region, shape);
  return shape;
}

const smooth = value => { const t = THREE.MathUtils.clamp(value, 0, 1); return t * t * (3 - 2 * t); };

export function createRegionMorph(particles, camera, reducedMotion, onChange) {
  const embedded = new URLSearchParams(location.search).get('embed') === 'dashboard';
  const geometry = particles.geometry;
  const count = geometry.attributes.position.count;
  const source = new Float32Array(count * 3), target = new Float32Array(count * 3);
  const scatter = new Float32Array(count * 3), delays = new Float32Array(count), tones = new Float32Array(count);
  let seed = 7819;
  const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; };
  for (let i = 0; i < count; i++) delays[i] = random() * .18;
  for (const [name, array, size] of [['morphSource', source, 3], ['morphTarget', target, 3], ['morphScatter', scatter, 3], ['morphDelay', delays, 1], ['morphTone', tones, 1]]) {
    geometry.setAttribute(name, new THREE.BufferAttribute(array, size).setUsage(THREE.DynamicDrawUsage));
  }
  const uniforms = particles.material.uniforms;
  const emptyMask=new THREE.DataTexture(new Uint8Array(4),1,1);
  emptyMask.needsUpdate=true;
  Object.assign(uniforms, { morphEnabled: { value: 0 }, morphProgress: { value: 1 }, morphShape: { value: 0 },
    particleTime:{value:performance.now()/1000},particleFloatStrength:{value:reducedMotion?0:1},
    globeSignalUp:{value:new THREE.Vector3(0,1,0)},
    regionMask:{value:emptyMask},regionMaskRect:{value:new THREE.Vector4(0,0,1,1)},
    regionViewport:{value:new THREE.Vector2(innerWidth*Math.min(devicePixelRatio,2),innerHeight*Math.min(devicePixelRatio,2))} });
  particles.frustumCulled = false;
  const vector = new THREE.Vector3(), right = new THREE.Vector3(), up = new THREE.Vector3(), forward = new THREE.Vector3();
  let active = false, transitioning = false, selected = 'Global', requestId = 0;
  let began = 0, fromShape = 0, toShape = 0, samples = null;
  let availableHeight = innerHeight;
  let labelAnchor = null;
  const inverseGlobe=new THREE.Matrix4();

  function globePosition(index, output, time) {
    output.fromBufferAttribute(geometry.attributes.position, index);
    if (reducedMotion) return output.applyMatrix4(particles.matrixWorld);
    const { x, y, z } = output;
    const tone = geometry.attributes.particleTone.getX(index);
    const phase = x * 2.7 + y * 5.1 + z * 3.3 + tone * 6.28;
    const cycle=time*(.16+.08*tone)+phase*.618;
    const age=cycle-Math.floor(cycle);
    return output.addScaledVector(uniforms.globeSignalUp.value,age*(.18-.10*tone)).applyMatrix4(particles.matrixWorld);
  }

  function positionAt(index, output) {
    if (!active) return globePosition(index,output,uniforms.particleTime.value);
    const weight = smooth((uniforms.morphProgress.value - delays[index]) / (1 - delays[index]));
    const offset = Math.sin(Math.PI * weight) * (1 - weight * .4);
    const i = index * 3;
    return output.set(
      source[i] + (target[i] - source[i]) * weight + scatter[i] * offset,
      source[i + 1] + (target[i + 1] - source[i + 1]) * weight + scatter[i + 1] * offset,
      source[i + 2] + (target[i + 2] - source[i + 2]) * weight + scatter[i + 2] * offset,
    );
  }

  function capture() {
    particles.updateWorldMatrix(true, false);
    // Capture the rendered path before changing either buffer, including mid-flight switches.
    const snapshot = new Float32Array(source.length);
    for (let i = 0; i < count; i++) positionAt(i, vector).toArray(snapshot, i * 3);
    source.set(snapshot);
    geometry.attributes.morphSource.needsUpdate = true;
  }

  function buildTarget() {
    if (!samples) {
      labelAnchor = null;
      const arrivalTime=(performance.now()+(reducedMotion?0:morphDuration))/1000;
      for (let i = 0; i < count; i++) globePosition(i,vector,arrivalTime).toArray(target, i * 3);
    } else {
      const { shape, points } = samples;
      const width = Math.min(470, innerWidth * .58, availableHeight * .61 * shape.aspect);
      const height = width / shape.aspect;
      const paddingX=width*shape.maskPadding/shape.rasterWidth;
      const paddingY=height*shape.maskPadding/shape.rasterHeight;
      const centreX=innerWidth*.5-(embedded?65:0),centreY=availableHeight*.495;
      uniforms.regionMask.value=shape.maskTexture;
      uniforms.regionMaskRect.value.set((centreX-width*.5-paddingX)/innerWidth,
        1-(centreY+height*.5+paddingY)/innerHeight,
        (width+paddingX*2)/innerWidth,(height+paddingY*2)/innerHeight);
      uniforms.regionViewport.value.set(innerWidth*Math.min(devicePixelRatio,2),innerHeight*Math.min(devicePixelRatio,2));
      const anchor = points.reduce((best, point) => point[0] > best[0] ? point : best, points[0]);
      labelAnchor = {x:innerWidth*.5-(embedded?65:0)+anchor[0]*width,y:availableHeight*.495-anchor[1]*height};
      const distance = camera.position.length();
      const clip = new THREE.Vector3(0, 0, -distance).applyMatrix4(camera.projectionMatrix).z;
      for (let i = 0; i < count; i++) {
        const [x, y, depth] = points[i];
        vector.set((x * width - (embedded ? 65 : 0)) / innerWidth * 2,
          1 - availableHeight / innerHeight * .99 + y * height / innerHeight * 2, clip + depth * .0002)
          .unproject(camera).toArray(target, i * 3);
      }
    }
    geometry.attributes.morphTarget.needsUpdate = true;
  }

  function start(region, shape) {
    capture();
    camera.updateMatrixWorld();
    right.setFromMatrixColumn(camera.matrixWorld, 0);
    up.setFromMatrixColumn(camera.matrixWorld, 1);
    forward.setFromMatrixColumn(camera.matrixWorld, 2);
    fromShape = uniforms.morphShape.value;
    toShape = region === 'Global' ? 0 : 1;
    samples = null;
    if (shape) {
      const points = [];
      for (let i = 0; i < count; i++) {
        const edge = i % 5 === 0;
        const pool = edge ? shape.coast : shape.fill;
        const point = pool[Math.floor(random() * pool.length)];
        points.push([point[0] + (random() - .5) / 900, point[1] + (random() - .5) / 900, random() - .5]);
        tones[i] = edge ? .8 + random() * .2 : .28 + random() * .6;
      }
      samples = { shape, points };
    }
    for (let i = 0; i < count; i++) {
      vector.copy(right).multiplyScalar((random() - .5) * .85)
        .addScaledVector(up, (random() - .5) * .65)
        .addScaledVector(forward, (random() - .5) * .45).toArray(scatter, i * 3);
    }
    geometry.attributes.morphScatter.needsUpdate = true;
    geometry.attributes.morphTone.needsUpdate = true;
    buildTarget();
    began = performance.now();
    selected = region;
    active = true;
    transitioning = true;
    uniforms.morphEnabled.value = 1;
    uniforms.morphProgress.value = 0;
    onChange(region, true);
  }

  return {
    get active() { return active; },
    get transitioning() { return transitioning; },
    get region() { return selected; },
    get labelAnchor() { return labelAnchor; },
    getWorldPosition: positionAt,
    async select(region) {
      const id = ++requestId;
      if (region === 'Global') {
        if (active) start(region, null);
        return;
      }
      const shape = await regionShape(region);
      if (id === requestId) start(region, shape);
    },
    update(now) {
      uniforms.particleTime.value=now/1000;
      particles.updateWorldMatrix(true,false);
      inverseGlobe.copy(particles.matrixWorld).invert();
      uniforms.globeSignalUp.value.setFromMatrixColumn(camera.matrixWorld,1).transformDirection(inverseGlobe);
      if (!transitioning) return;
      const progress = reducedMotion ? 1 : Math.min(1, (now - began) / morphDuration);
      uniforms.morphProgress.value = progress;
      uniforms.morphShape.value = THREE.MathUtils.lerp(fromShape, toShape, smooth(progress));
      if (progress === 1) {
        transitioning = false;
        active = selected !== 'Global';
        uniforms.morphEnabled.value = active ? 1 : 0;
        onChange(selected, false);
      }
    },
    resize() { if (active) { capture(); buildTarget(); began = performance.now(); uniforms.morphProgress.value = 0; fromShape = uniforms.morphShape.value; transitioning = true; } },
    setAvailableHeight(height) {
      availableHeight = THREE.MathUtils.clamp(height, 260, innerHeight);
      this.resize();
    },
  };
}
