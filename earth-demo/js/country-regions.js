// Country polygons: Natural Earth Admin 0, 1:50m (public domain).
// Rasterize geographic polygons once into a data atlas. RGB stores each
// country's own red/burgundy tone; alpha stores its exact border coverage.
import * as THREE from 'three';

const PALETTE = [
  [205,10,65], [122,7,38], [246,22,85],
  [158,10,56], [224,12,53], [101,8,42],
];
const COUNTRY_TONES = {
  FRA:2, DEU:0, ESP:1, PRT:4, ITA:4, GBR:3, BEL:5, NLD:1,
  POL:4, CZE:1, AUT:3, CHE:5, UKR:0, ROU:2, TUR:3, RUS:5,
  IRN:0, IRQ:3, SAU:1, EGY:4, IND:0, CHN:3, JPN:2, KOR:4,
};
function paletteIndex(code) {
  if (COUNTRY_TONES[code] !== undefined) return COUNTRY_TONES[code];
  let hash = 7;
  for (const character of code) hash = (hash * 31 + character.charCodeAt(0)) >>> 0;
  return hash % PALETTE.length;
}
function unwrapRing(ring, referenceLongitude) {
  let previous;
  const points = ring.map(([longitude, latitude]) => {
    let adjusted = longitude;
    if (previous !== undefined) {
      while (adjusted - previous > 180) adjusted -= 360;
      while (adjusted - previous < -180) adjusted += 360;
    }
    previous = adjusted;
    return [adjusted,latitude];
  });
  const centre = points.reduce((total, point) => total + point[0],0) / points.length;
  const shift = referenceLongitude === undefined ? 0 : Math.round((referenceLongitude - centre) / 360) * 360;
  return {points:points.map(([x,y])=>[x+shift,y]), centre:centre+shift};
}
function polygonPath(rings,width,height,shift) {
  const exterior = unwrapRing(rings[0]);
  const unwrapped = [exterior, ...rings.slice(1).map(ring=>unwrapRing(ring,exterior.centre))];
  const path = new Path2D();
  for (const {points} of unwrapped) {
    points.forEach(([longitude,latitude],index)=>{
      const x = (longitude + 180) / 360 * width + shift;
      const y = (90 - latitude) / 180 * height;
      if (index === 0) path.moveTo(x,y); else path.lineTo(x,y);
    });
    path.closePath();
  }
  return path;
}
export async function createCountryRegions() {
  const response = await fetch(new URL('../data/world/countries-50m.geojson',import.meta.url));
  if (!response.ok) throw new Error(`Country polygons could not be loaded (${response.status})`);
  const data = await response.json();
  if (!Array.isArray(data.features) || !data.features.length) throw new Error('Country polygon dataset is empty');
  const width=4096,height=2048;
  const fillCanvas = document.createElement('canvas'); fillCanvas.width=width;fillCanvas.height=height;
  const borderCanvas = document.createElement('canvas');borderCanvas.width=width;borderCanvas.height=height;
  const fill = fillCanvas.getContext('2d',{willReadFrequently:true});
  const border = borderCanvas.getContext('2d',{willReadFrequently:true});
  border.strokeStyle='#ffffff';border.lineWidth=1.25;border.lineJoin='round';border.lineCap='round';
  for (const feature of data.features) {
    if (!feature.geometry) continue;
    const code = feature.properties.ADM0_A3 || feature.properties.ISO_A3 || feature.properties.ADMIN;
    const colour = PALETTE[paletteIndex(code)];
    fill.fillStyle=`rgb(${colour.join(',')})`;
    const polygons=feature.geometry.type==='Polygon'?[feature.geometry.coordinates]:feature.geometry.type==='MultiPolygon'?feature.geometry.coordinates:[];
    for (const rings of polygons) {
      for (const shift of [-width,0,width]) {
        const path=polygonPath(rings,width,height,shift);
        fill.fill(path,'evenodd');border.stroke(path);
      }
    }
  }
  const colours=fill.getImageData(0,0,width,height).data;
  const borders=border.getImageData(0,0,width,height).data;
  const pixels=new Uint8Array(width*height*4);
  // Typed-array textures start at the bottom row; flip the raster explicitly.
  for(let y=0;y<height;y++) for(let x=0;x<width;x++) {
    const source=(y*width+x)*4,target=((height-1-y)*width+x)*4;
    pixels[target]=colours[source];pixels[target+1]=colours[source+1];pixels[target+2]=colours[source+2];
    pixels[target+3]=borders[source+3];
  }
  const texture=new THREE.DataTexture(pixels,width,height,THREE.RGBAFormat);
  texture.name='geographic-country-colours-and-borders';
  texture.wrapS=THREE.RepeatWrapping;texture.wrapT=THREE.ClampToEdgeWrapping;
  texture.magFilter=THREE.LinearFilter;texture.minFilter=THREE.LinearMipmapLinearFilter;
  texture.generateMipmaps=true;texture.needsUpdate=true;
  return texture;
}
