// Shared timing for the WebGL globe and the surrounding dashboard.
export const clamp01 = value => Math.max(0, Math.min(1, value));
export const smoothProgress = (elapsed,start,duration) => {
  const t = clamp01((elapsed-start)/duration);
  return t*t*(3-2*t);
};
export const counterProgress = (elapsed,start,duration,reducedMotion=false) => {
  if (reducedMotion) return 1;
  const t = clamp01((elapsed-start)/duration);
  return 1-Math.pow(1-t,3);
};
export function entryFrame(elapsed,reducedMotion=false) {
  if (reducedMotion) return {terrain:1,red:1,glow:1,markers:1,total:1,totalReveal:1,panels:1,globe:1,arrow:1,placeholder:0,complete:true};
  return {
    globe:smoothProgress(elapsed,0,1700),
    arrow:smoothProgress(elapsed,1700,600),
    terrain:smoothProgress(elapsed,70,1450),
    red:smoothProgress(elapsed,140,1700),
    glow:smoothProgress(elapsed,100,1700),
    markers:smoothProgress(elapsed,450,1100),
    total:counterProgress(elapsed,250,1800),
    totalReveal:smoothProgress(elapsed,250,500),
    panels:smoothProgress(elapsed,180,1450),
    placeholder:1-smoothProgress(elapsed,0,350),
    complete:elapsed>=2600,
  };
}
