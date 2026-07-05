// The twelve kinetic signatures (HOME-SCREEN §3). Each is a ~20-line analytic
// force program — a motion-verb, never a literal object. The velocity shader
// blends two of them (sigA→sigB) by a uniform so scrolling re-choreographs the
// field. Index order matches shared/registry GAMES so scroll position maps to a
// game directly. Ambient drift (index 12) = pure curl, no attractor.
//
// Hue is NOT baked here — library.ts owns the HUES map and feeds the active
// color as a uniform, so this stays a pure motion vocabulary (Tier-0 pages
// never import it).

import type { GameId } from '@shared/types';

/** registry order → signature index (0..11). Ambient is 12. */
export const SIGNATURE_INDEX: Record<GameId, number> = {
  flap: 0,
  stack: 1,
  'merge-drop': 2,
  sling: 3,
  helix: 4,
  bricks: 5,
  hole: 6,
  plinko: 7,
  knock: 8,
  rope: 9,
  draw: 10,
  swerve: 11,
};

export const AMBIENT_SIGNATURE = 12;

/** Human labels — used by the DEV Playwright test hook (gate 8.1). */
export const SIGNATURE_NAMES: Record<number, string> = {
  0: 'pulse',
  1: 'accrete',
  2: 'coalesce',
  3: 'tense-release',
  4: 'wind-descend',
  5: 'ricochet',
  6: 'devour',
  7: 'cascade',
  8: 'topple',
  9: 'sway-sever',
  10: 'trace',
  11: 'slipstream',
  12: 'ambient',
};

// ---------------------------------------------------------------------------
// GLSL — simplex noise + curl. Ashima 3D simplex (public domain), GLSL ES 1.00.
// ---------------------------------------------------------------------------
export const GLSL_NOISE = /* glsl */ `
vec3 mod289(vec3 x){return x-floor(x*(1.0/289.0))*289.0;}
vec4 mod289(vec4 x){return x-floor(x*(1.0/289.0))*289.0;}
vec4 permute(vec4 x){return mod289(((x*34.0)+1.0)*x);}
vec4 taylorInvSqrt(vec4 r){return 1.79284291400159-0.85373472095314*r;}
float snoise(vec3 v){
  const vec2 C=vec2(1.0/6.0,1.0/3.0); const vec4 D=vec4(0.0,0.5,1.0,2.0);
  vec3 i=floor(v+dot(v,C.yyy)); vec3 x0=v-i+dot(i,C.xxx);
  vec3 g=step(x0.yzx,x0.xyz); vec3 l=1.0-g; vec3 i1=min(g.xyz,l.zxy); vec3 i2=max(g.xyz,l.zxy);
  vec3 x1=x0-i1+C.xxx; vec3 x2=x0-i2+C.yyy; vec3 x3=x0-D.yyy;
  i=mod289(i);
  vec4 p=permute(permute(permute(i.z+vec4(0.0,i1.z,i2.z,1.0))+i.y+vec4(0.0,i1.y,i2.y,1.0))+i.x+vec4(0.0,i1.x,i2.x,1.0));
  float n_=0.142857142857; vec3 ns=n_*D.wyz-D.xzx;
  vec4 j=p-49.0*floor(p*ns.z*ns.z);
  vec4 x_=floor(j*ns.z); vec4 y_=floor(j-7.0*x_);
  vec4 x=x_*ns.x+ns.yyyy; vec4 y=y_*ns.x+ns.yyyy; vec4 h=1.0-abs(x)-abs(y);
  vec4 b0=vec4(x.xy,y.xy); vec4 b1=vec4(x.zw,y.zw);
  vec4 s0=floor(b0)*2.0+1.0; vec4 s1=floor(b1)*2.0+1.0; vec4 sh=-step(h,vec4(0.0));
  vec4 a0=b0.xzyw+s0.xzyw*sh.xxyy; vec4 a1=b1.xzyw+s1.xzyw*sh.zzww;
  vec3 p0=vec3(a0.xy,h.x); vec3 p1=vec3(a0.zw,h.y); vec3 p2=vec3(a1.xy,h.z); vec3 p3=vec3(a1.zw,h.w);
  vec4 norm=taylorInvSqrt(vec4(dot(p0,p0),dot(p1,p1),dot(p2,p2),dot(p3,p3)));
  p0*=norm.x; p1*=norm.y; p2*=norm.z; p3*=norm.w;
  vec4 m=max(0.6-vec4(dot(x0,x0),dot(x1,x1),dot(x2,x2),dot(x3,x3)),0.0); m=m*m;
  return 42.0*dot(m*m,vec4(dot(p0,x0),dot(p1,x1),dot(p2,x2),dot(p3,x3)));
}
vec3 snoiseVec3(vec3 x){return vec3(snoise(x),snoise(x+vec3(137.1,0.0,0.0)),snoise(x+vec3(0.0,241.7,0.0)));}
vec3 curlNoise(vec3 p){
  const float e=0.35;
  vec3 dx=vec3(e,0.0,0.0),dy=vec3(0.0,e,0.0),dz=vec3(0.0,0.0,e);
  vec3 px0=snoiseVec3(p-dx),px1=snoiseVec3(p+dx);
  vec3 py0=snoiseVec3(p-dy),py1=snoiseVec3(p+dy);
  vec3 pz0=snoiseVec3(p-dz),pz1=snoiseVec3(p+dz);
  float x=py1.z-py0.z-pz1.y+pz0.y;
  float y=pz1.x-pz0.x-px1.z+px0.z;
  float z=px1.y-px0.y-py1.x+py0.x;
  return normalize(vec3(x,y,z)/(2.0*e)+1e-5);
}
`;

// ---------------------------------------------------------------------------
// GLSL — the signature force field. Expects #defines FX FY FZ PI.
//   s    active signature index
//   p    particle position
//   v    particle velocity
//   id   particle index (float)
//   seed hashed 0..1 per particle
//   t    time (seconds)
//   curl ambient curl-noise sample (passed in — GLSL fns can't see caller locals)
// Returns an acceleration. Each branch is identifiable from motion alone.
// ---------------------------------------------------------------------------
export const GLSL_SIGNATURES = /* glsl */ `
vec3 sigForce(int s, vec3 p, vec3 v, float id, float seed, float t, vec3 curl){
  // 0 — flap · PULSE: sink always, rhythmic amber upbeats lift the whole field.
  if(s==0){
    vec3 f=curl*3.0; f.y-=7.0;
    float beat=pow(0.5+0.5*sin(t*2.3),9.0);
    f.y+=beat*90.0;
    return f;
  }
  // 1 — stack · ACCRETE: shards settle layer on layer into a rising swaying column.
  if(s==1){
    float layer=mod(id,42.0);
    float sway=sin(t*0.8+layer*0.25)*2.6;
    vec2 axis=vec2(sway,cos(t*0.6+layer*0.2)*1.8);
    vec3 f=vec3(0.0);
    f.x=(axis.x-p.x)*4.5;
    f.z=(axis.y-p.z)*4.5;
    f.y=((-FY+2.0)+layer*1.5 - p.y)*3.2;
    float shear=step(0.93,seed);            // a few layers shear off + dissolve
    f+=curl*shear*14.0;
    return f;
  }
  // 2 — merge-drop · COALESCE: pull into one violet mass, then burst back to dust.
  if(s==2){
    float ph=fract(t*0.18);
    vec3 c=vec3(sin(t*0.5)*5.0,cos(t*0.4)*3.0,0.0);
    vec3 to=c-p; float d=length(to)+0.01;
    vec3 f=to/d*9.0;
    float burst=smoothstep(0.86,0.94,ph)-smoothstep(0.94,1.0,ph);
    f-=to/d*burst*120.0;
    return f;
  }
  // 3 — sling · TENSE/RELEASE: draw into a taut band, tremble, snap forward, scatter.
  if(s==3){
    float ph=fract(t*0.22);
    float pull=smoothstep(0.0,0.5,ph);
    vec3 band=vec3(mix(2.0,-16.0,pull),p.y,0.0);
    vec3 f=(band-p)*6.0;
    float tremble=step(0.44,ph)*step(ph,0.55);
    f+=curl*tremble*24.0;
    float snap=smoothstep(0.55,0.6,ph)-smoothstep(0.62,0.95,ph);
    f.x+=snap*520.0; f.z+=(seed-0.5)*snap*90.0;
    return f;
  }
  // 4 — helix · WIND/DESCEND: double spiral round an axis; cascade down its groove.
  if(s==4){
    float strand=mod(id,2.0);
    float a=t*1.15+id*0.05+strand*PI;
    float yy=mod(p.y - t*9.0 + FY, 2.0*FY)-FY;
    vec3 tgt=vec3(cos(a)*10.0,yy,sin(a)*10.0);
    return (tgt-p)*3.2;
  }
  // 5 — bricks · RICOCHET: angular billiard runs on 45° diagonals inside the box.
  if(s==5){
    float ang=floor(seed*4.0)*(PI*0.5)+0.7854;
    vec2 dir=vec2(cos(ang),sin(ang));
    vec3 f=vec3((dir*17.0 - v.xy)*2.2, -p.z*2.5);
    return f;
  }
  // 6 — hole · DEVOUR: slow whirlpool, faster near the hungry centre; torus bob out.
  if(s==6){
    vec2 r=p.xy; float d=length(r)+0.4;
    vec2 tang=vec2(-r.y,r.x)/d;
    vec3 f=vec3(tang*(26.0/d) - r/d*6.0, 0.0);
    f.z+=sin(d*0.5-t*2.0)*4.0;
    f.xy+=r/d*smoothstep(3.5,0.0,d)*46.0;   // re-emerge at rim
    return f;
  }
  // 7 — plinko · CASCADE: golden waterfall splits round a peg grid, pools in bins.
  if(s==7){
    vec3 f=vec3(0.0,-11.0,-p.z*2.0);
    f.x+=sin(p.y*0.85)*cos(p.x*0.8+floor(p.y*0.4))*9.0;
    float floorY=-FY+3.0;
    float pooled=step(p.y,floorY);
    f.x+=(floor(p.x/5.0)*5.0+2.5 - p.x)*pooled*7.0;
    f.y+=(floorY-p.y)*pooled*5.0;
    return f;
  }
  // 8 — knock · TOPPLE: dense standing wall; a shockwave rolls through, then re-braces.
  if(s==8){
    float gx=mod(id,32.0); float col=floor(id/32.0);
    vec3 tgt=vec3((gx-15.5)*1.5,(mod(col,22.0))*1.5-6.0,(seed-0.5)*2.0);
    vec3 f=(tgt-p)*4.2;
    float wave=mod(t*13.0,2.0*FX+18.0)-FX-9.0;
    float hit=exp(-pow(p.x-wave,2.0)*0.09);
    f+=vec3(1.4,1.7,(seed-0.5)*2.0)*hit*80.0;
    return f;
  }
  // 9 — rope · SWAY/SEVER: hanging catenary threads swing in phase; one whips free.
  if(s==9){
    float thread=floor(id/72.0);
    float seg=fract(id/72.0);
    float baseX=(mod(thread,16.0)-7.5)*3.2;
    float swing=sin(t*1.3+thread*0.22)*(1.5+seg*6.5);
    vec3 tgt=vec3(baseX+swing*seg, FY-2.0-seg*(FY*1.2), (seed-0.5)*2.0);
    vec3 f=(tgt-p)*4.0;
    float cutId=floor(fract(t*0.05)*16.0);
    if(abs(thread-cutId)<0.5) f+=vec3(sin(t*22.0)*34.0,-24.0,0.0)*seg;
    return f;
  }
  // 10 — draw · TRACE: single-file flow reveals a self-drawing luminous ribbon.
  if(s==10){
    float prog=fract(t*0.06);
    float u=seed;
    float lit=smoothstep(u-0.04,u,prog);
    vec3 tgt=vec3(sin(u*12.566)*16.0,cos(u*18.849)*10.0,sin(u*25.13)*3.0);
    return (tgt-p)*mix(0.6,6.0,lit);
  }
  // 11 — swerve · SLIPSTREAM: a fast laminar current weaves S-curves, sheds vortices.
  if(s==11){
    float wob=sin(p.x*0.2-t*3.0)*8.0;
    vec3 f=vec3(16.0,(wob+ (seed-0.5)*6.0 - p.y)*3.0,(sin(p.x*0.15-t)*4.0 - p.z)*2.0);
    f+=curl*smoothstep(6.0,8.0,abs(wob))*9.0;
    return f;
  }
  return vec3(0.0); // ambient — pure curl, handled by caller
}
`;
