// Rendering (HOME-SCREEN §6): ONE instanced draw call. A micro-shard (4-tri
// tetra, no textures/shadows) samples the GPGPU position texture in the vertex
// shader and colours by velocity + active hue + fog. Tier 2 adds a single cheap
// composite pass (fake bloom + film grain + vignette). Motion lives in the
// matter — the camera barely moves.

import * as THREE from 'three';

const FOG_NEAR = 46;
const FOG_FAR = 98;

export interface RenderColors {
  hue: THREE.Color; // active signature hue
  ambient: THREE.Color; // drift colour between cards
  hueBlend: number; // 0 ambient .. 1 hue
  lum: number; // star-luminance boost 0..1
  alpha: number; // global fade-in
  transition: number; // dissolve-through 0..1
  transColor: THREE.Color; // clicked card hue
  collapse: THREE.Vector3; // dissolve target point
}

/** Micro-shard: a tiny tetrahedron (4 verts / 4 tris). */
function shardGeometry(size: number, count: number): THREE.InstancedBufferGeometry {
  const geo = new THREE.InstancedBufferGeometry();
  const t = 1.0;
  const verts = new Float32Array([
    0, t, 0,
    -t, -t * 0.6, t,
    t, -t * 0.6, t,
    0, -t * 0.6, -t,
  ]);
  geo.setAttribute('position', new THREE.BufferAttribute(verts, 3));
  geo.setIndex([0, 1, 2, 0, 2, 3, 0, 3, 1, 1, 3, 2]);

  const refs = new Float32Array(count * 2);
  for (let i = 0; i < count; i++) {
    refs[i * 2] = ((i % size) + 0.5) / size;
    refs[i * 2 + 1] = (Math.floor(i / size) + 0.5) / size;
  }
  geo.setAttribute('aReference', new THREE.InstancedBufferAttribute(refs, 2));
  geo.instanceCount = count;
  return geo;
}

export class FieldRenderer {
  private readonly scene = new THREE.Scene();
  private readonly mesh: THREE.Mesh;
  private readonly mat: THREE.ShaderMaterial;
  private readonly geo: THREE.InstancedBufferGeometry;
  private readonly bg: THREE.Color;

  // Tier-2 post
  private post: THREE.WebGLRenderTarget | null = null;
  private postMat: THREE.ShaderMaterial | null = null;
  private postScene: THREE.Scene | null = null;
  private postCam: THREE.OrthographicCamera | null = null;
  private time = 0;

  constructor(size: number, count: number, bgColor: string, additive: boolean, tier2: boolean) {
    this.bg = new THREE.Color(bgColor);
    this.geo = shardGeometry(size, count);

    this.mat = new THREE.ShaderMaterial({
      uniforms: {
        uPos: { value: null },
        uVel: { value: null },
        uScale: { value: tier2 ? 0.11 : 0.14 },
        uHue: { value: new THREE.Color('#ffffff') },
        uAmbient: { value: new THREE.Color('#7a86c8') },
        uHueBlend: { value: 0 },
        uLum: { value: 0 },
        uAlpha: { value: 0 },
        uTransition: { value: 0 },
        uTransColor: { value: new THREE.Color('#ffffff') },
        uCollapse: { value: new THREE.Vector3(0, 0, 40) },
        uFogColor: { value: this.bg.clone() },
      },
      transparent: !additive,
      blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
      depthTest: true,
      depthWrite: false,
      vertexShader: /* glsl */ `
        #define FOG_NEAR ${FOG_NEAR.toFixed(1)}
        #define FOG_FAR ${FOG_FAR.toFixed(1)}
        attribute vec2 aReference;
        uniform sampler2D uPos, uVel;
        uniform float uScale, uTransition;
        uniform vec3 uCollapse;
        varying float vSpeed;
        varying float vFog;
        void main(){
          vec4 P = texture2D(uPos, aReference);
          vec3 vel = texture2D(uVel, aReference).xyz;
          vSpeed = length(vel);
          vec3 world = P.xyz + position * uScale;
          world = mix(world, uCollapse, uTransition);
          vec4 mv = modelViewMatrix * vec4(world, 1.0);
          vFog = clamp((-mv.z - FOG_NEAR) / (FOG_FAR - FOG_NEAR), 0.0, 1.0);
          gl_Position = projectionMatrix * mv;
        }
      `,
      fragmentShader: /* glsl */ `
        precision highp float;
        uniform vec3 uHue, uAmbient, uTransColor, uFogColor;
        uniform float uHueBlend, uLum, uAlpha, uTransition;
        varying float vSpeed;
        varying float vFog;
        void main(){
          vec3 col = mix(uAmbient, uHue, uHueBlend);
          col *= (0.55 + min(vSpeed, 20.0) * 0.03) * (0.8 + uLum * 0.7);
          col = mix(col, uTransColor, uTransition);
          col *= (1.0 - vFog * 0.85);
          gl_FragColor = vec4(col * uAlpha, uAlpha);
        }
      `,
    });

    this.mesh = new THREE.Mesh(this.geo, this.mat);
    this.mesh.frustumCulled = false;
    this.scene.add(this.mesh);

    if (tier2) this.buildPost();
  }

  private buildPost(): void {
    this.post = new THREE.WebGLRenderTarget(2, 2, {
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      depthBuffer: false,
      generateMipmaps: false,
    });
    this.postCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    this.postScene = new THREE.Scene();
    this.postMat = new THREE.ShaderMaterial({
      uniforms: {
        uScene: { value: this.post.texture },
        uRes: { value: new THREE.Vector2(2, 2) },
        uTime: { value: 0 },
      },
      vertexShader: /* glsl */ `
        varying vec2 vUv;
        void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }
      `,
      fragmentShader: /* glsl */ `
        precision highp float;
        uniform sampler2D uScene; uniform vec2 uRes; uniform float uTime;
        varying vec2 vUv;
        float hash(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
        void main(){
          vec3 base = texture2D(uScene, vUv).rgb;
          vec2 px = 1.6 / uRes;
          vec3 bloom = texture2D(uScene, vUv + vec2(px.x, px.y)).rgb
                     + texture2D(uScene, vUv + vec2(-px.x, px.y)).rgb
                     + texture2D(uScene, vUv + vec2(px.x, -px.y)).rgb
                     + texture2D(uScene, vUv + vec2(-px.x, -px.y)).rgb;
          bloom = max(bloom * 0.25 - 0.24, 0.0) * 1.7;
          vec3 col = base + bloom;
          col += (hash(vUv * uRes + uTime) - 0.5) * 0.045;   // film grain
          float d = distance(vUv, vec2(0.5));
          col *= 1.0 - d * d * 0.55;                          // vignette
          gl_FragColor = vec4(col, 1.0);
        }
      `,
    });
    this.postScene.add(new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.postMat));
  }

  resize(w: number, h: number, dpr: number): void {
    if (this.post && this.postMat) {
      const pw = Math.max(2, Math.floor(w * dpr));
      const ph = Math.max(2, Math.floor(h * dpr));
      this.post.setSize(pw, ph);
      (this.postMat.uniforms['uRes']!.value as THREE.Vector2).set(pw, ph);
    }
  }

  setColors(c: RenderColors): void {
    const u = this.mat.uniforms;
    (u['uHue']!.value as THREE.Color).copy(c.hue);
    (u['uAmbient']!.value as THREE.Color).copy(c.ambient);
    u['uHueBlend']!.value = c.hueBlend;
    u['uLum']!.value = c.lum;
    u['uAlpha']!.value = c.alpha;
    u['uTransition']!.value = c.transition;
    (u['uTransColor']!.value as THREE.Color).copy(c.transColor);
    (u['uCollapse']!.value as THREE.Vector3).copy(c.collapse);
  }

  render(
    renderer: THREE.WebGLRenderer,
    camera: THREE.Camera,
    position: THREE.Texture,
    velocity: THREE.Texture,
    dt: number,
  ): void {
    this.time += dt;
    this.mat.uniforms['uPos']!.value = position;
    this.mat.uniforms['uVel']!.value = velocity;

    if (this.post && this.postMat && this.postScene && this.postCam) {
      renderer.setRenderTarget(this.post);
      renderer.setClearColor(this.bg, 1);
      renderer.clear();
      renderer.render(this.scene, camera);
      this.postMat.uniforms['uTime']!.value = this.time;
      renderer.setRenderTarget(null);
      renderer.render(this.postScene, this.postCam);
    } else {
      renderer.setRenderTarget(null);
      renderer.setClearColor(this.bg, 1);
      renderer.clear();
      renderer.render(this.scene, camera);
    }
  }

  dispose(): void {
    this.geo.dispose();
    this.mat.dispose();
    this.post?.dispose();
    this.postMat?.dispose();
    this.postScene?.traverse((o) => {
      if (o instanceof THREE.Mesh) o.geometry.dispose();
    });
  }
}
