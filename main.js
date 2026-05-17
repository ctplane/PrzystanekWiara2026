import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';

/* ============================================================
   PRZYSTANEK WIARA · IMMERSIVE SKY  (v2 — clearly 3D, debuggable)
   ============================================================ */

window.addEventListener('error', e => console.error('[sky:error]', e.message, e.error?.stack));

/* Accessibility preferences — initialised below; declared up-front so other
   modules (e.g. building scheduler) can check `a11yPrefs.pauseAnims`. */
let a11yPrefs = { pauseAnims: false };

const CFG = {
    skyTop:    new THREE.Color(0x4a8cd6),   // deeper blue at zenith — reads as sky
    skyMid:    new THREE.Color(0x9ec9f2),
    skyBottom: new THREE.Color(0xffeac4),   // warm horizon glow
    sunColor:  new THREE.Color(0xffe2a0),
    fogColor:  new THREE.Color(0xc8def5),

    lowerCount: 260,    // denser — acts as visible "cloud floor" when looking down
    midCount:   140,
    upperCount: 90,
    floorCount: 140,    // additional very-dense cloud carpet directly below the camera
    particleCount: 1400,

    mouseLerp:  0.045,
    scrollLerp: 0.06,

    // first-person look range (radians)
    yawRange:   Math.PI * 0.55,    // ~99° each way
    pitchRange: Math.PI * 0.38,    // ~68° each way — enough to see sun up, clouds down

    // Sky is the main theme — building appears occasionally, not constantly.
    buildingMinDelay: 22000,
    buildingMaxDelay: 55000,
    buildingFadeIn:    2400,
    buildingHold:      5000,
    buildingFadeOut:   2800,

    bloomStrength:  0.45,
    bloomRadius:    0.6,
    bloomThreshold: 0.92,    // only the sun core blooms, not the whole sky
};

const container = document.getElementById('canvas-container');

/* SCENE -------------------------------------------------- */
const scene = new THREE.Scene();
scene.background = CFG.fogColor.clone();           // guarantees a painted canvas
scene.fog = new THREE.FogExp2(CFG.fogColor.getHex(), 0.00035);  // much lighter — clouds visible

const camera = new THREE.PerspectiveCamera(64, window.innerWidth / window.innerHeight, 1, 8000);
camera.position.set(0, 80, 200);

const renderer = new THREE.WebGLRenderer({
    antialias: true,
    powerPreference: 'high-performance',
    alpha: false,
    preserveDrawingBuffer: false,
});
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.setClearColor(CFG.fogColor, 1);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.NoToneMapping;
renderer.toneMappingExposure = 1.0;
container.appendChild(renderer.domElement);
console.log('[sky] renderer ready', renderer.domElement.width, 'x', renderer.domElement.height);

/* SKY DOME ----------------------------------------------- */
const skyMat = new THREE.ShaderMaterial({
    side: THREE.BackSide,
    depthWrite: false,
    uniforms: {
        top:    { value: CFG.skyTop },
        mid:    { value: CFG.skyMid },
        bottom: { value: CFG.skyBottom },
        sunDir: { value: new THREE.Vector3(0.18, 0.86, -0.48).normalize() },   // matches new sun pos (high up)
        sunCol: { value: CFG.sunColor },
    },
    vertexShader: /* glsl */`
        varying vec3 vW;
        void main(){ vW = normalize((modelMatrix * vec4(position,1.0)).xyz);
            gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }
    `,
    fragmentShader: /* glsl */`
        varying vec3 vW;
        uniform vec3 top, mid, bottom, sunDir, sunCol;
        void main(){
            float h = clamp(vW.y * 0.5 + 0.5, 0.0, 1.0);
            vec3 c = mix(bottom, mid, smoothstep(0.30, 0.55, h));
            c = mix(c, top, smoothstep(0.58, 0.95, h));
            float sd = max(dot(normalize(vW), normalize(sunDir)), 0.0);
            c += sunCol * (pow(sd, 5.0) * 0.6 + pow(sd, 90.0) * 1.4);
            gl_FragColor = vec4(c, 1.0);
        }
    `,
});
const sky = new THREE.Mesh(new THREE.SphereGeometry(5000, 32, 16), skyMat);
scene.add(sky);

/* LIGHTS ------------------------------------------------- */
scene.add(new THREE.AmbientLight(0xffffff, 0.9));
scene.add(new THREE.HemisphereLight(0xfff6e0, 0xbcd7ff, 0.6));
const sunLight = new THREE.DirectionalLight(CFG.sunColor.getHex(), 1.4);
sunLight.position.set(1800, 1400, -2200);
scene.add(sunLight);

/* SUN (visible object) ----------------------------------- */
const sunTex = makeSunTexture();
const sun = new THREE.Sprite(new THREE.SpriteMaterial({
    map: sunTex, color: 0xffffff, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
}));
sun.scale.set(2200, 2200, 1);
sun.position.set(450, 2200, -1800);    // raised — sits high above so looking up reveals it
scene.add(sun);

const sunCore = new THREE.Mesh(
    new THREE.SphereGeometry(110, 24, 24),
    new THREE.MeshBasicMaterial({ color: 0xfffae4 })
);
sunCore.position.copy(sun.position);
scene.add(sunCore);

/* CLOUDS ------------------------------------------------- */
const cloudTextures = makeCloudTextures();

function buildCloudLayer({ count, yRange, zRange, scaleRange, opacity, color, parallax }) {
    const group = new THREE.Group();
    group.userData.parallax = parallax;
    for (let i = 0; i < count; i++) {
        const tex = cloudTextures[i % cloudTextures.length];
        const mat = new THREE.SpriteMaterial({
            map: tex, color, transparent: true, opacity,
            depthWrite: false, blending: THREE.NormalBlending, fog: true,
        });
        const s = new THREE.Sprite(mat);
        const scale = scaleRange[0] + Math.random() * (scaleRange[1] - scaleRange[0]);
        s.scale.set(scale, scale * (0.42 + Math.random() * 0.22), 1);
        s.position.set(
            (Math.random() - 0.5) * 4200,
            yRange[0] + Math.random() * (yRange[1] - yRange[0]),
            zRange[0] + Math.random() * (zRange[1] - zRange[0])
        );
        s.material.rotation = (Math.random() - 0.5) * 0.45;
        s.userData = {
            driftSpeed: (Math.random() * 0.35 + 0.05) * (Math.random() < 0.5 ? -1 : 1),
            bobSpeed:   0.0003 + Math.random() * 0.0008,
            bobAmount:  1 + Math.random() * 5,
            baseY:      s.position.y,
        };
        group.add(s);
    }
    scene.add(group);
    return group;
}

// Lower ocean — deep, wave-like, far below
const cloudsLower = buildCloudLayer({
    count: CFG.lowerCount,
    yRange: [-260, -80],
    zRange: [-3000, -500],
    scaleRange: [520, 950],
    opacity: 1.0,
    color: 0xffffff,
    parallax: 0.18,
});

// Cloud floor — dense, uniform "white dust" carpet that surrounds the camera
// so looking DOWN always reveals a clear cloud layer.
const cloudsFloor = buildCloudLayer({
    count: CFG.floorCount,
    yRange: [-220, -140],
    zRange: [-1400, -50],          // wraps below + behind + in front of the camera
    scaleRange: [600, 1100],
    opacity: 1.0,
    color: 0xffffff,
    parallax: 0.1,
});
// Spread some of the floor clouds laterally and behind the camera too
cloudsFloor.children.forEach((c, i) => {
    if (i % 3 === 0) {
        c.position.z = 200 + Math.random() * 1200;   // behind camera
    }
    c.position.x = (Math.random() - 0.5) * 4800;
});

// Mid — luminous, semi-transparent, around eye level
const cloudsMid = buildCloudLayer({
    count: CFG.midCount,
    yRange: [20, 280],
    zRange: [-2400, -400],
    scaleRange: [360, 700],
    opacity: 0.95,
    color: 0xffffff,
    parallax: 0.5,
});

// Upper haze — high, luminous, warm
const cloudsUpper = buildCloudLayer({
    count: CFG.upperCount,
    yRange: [300, 620],
    zRange: [-2200, -350],
    scaleRange: [260, 480],
    opacity: 0.7,
    color: 0xfff2d0,
    parallax: 0.85,
});

/* PARTICLES ---------------------------------------------- */
const particleGeo = new THREE.BufferGeometry();
const pPos = new Float32Array(CFG.particleCount * 3);
const pSeed = new Float32Array(CFG.particleCount);
for (let i = 0; i < CFG.particleCount; i++) {
    pPos[i*3]   = (Math.random() - 0.5) * 3000;
    pPos[i*3+1] = 100 + Math.random() * 600;
    pPos[i*3+2] = -300 - Math.random() * 2400;
    pSeed[i] = Math.random() * Math.PI * 2;
}
particleGeo.setAttribute('position', new THREE.BufferAttribute(pPos, 3));
particleGeo.setAttribute('seed', new THREE.BufferAttribute(pSeed, 1));
const particles = new THREE.Points(particleGeo, new THREE.PointsMaterial({
    size: 3.0, map: makeDotTexture(), color: 0xffffff, transparent: true, opacity: 0.6,
    blending: THREE.AdditiveBlending, depthWrite: false, sizeAttenuation: true,
}));
scene.add(particles);

/* BUILDING — fixed full-width CSS layer (#building-bg) that fades in OCCASIONALLY.
   Cloud sky is the main theme — the photo just visits the screen as a brief
   memory and fades away. Timing: hidden ~25-45 s, visible ~6 s (incl. fade). */
const BUILDING_VISIBLE_MS = 6000;   // total time .visible class is on (CSS handles fade)
const BUILDING_HIDDEN_MIN = 25000;
const BUILDING_HIDDEN_MAX = 45000;

function scheduleBuildingAppearance(delayOverride) {
    const delay = delayOverride ?? (BUILDING_HIDDEN_MIN + Math.random() * (BUILDING_HIDDEN_MAX - BUILDING_HIDDEN_MIN));
    setTimeout(() => {
        // Respect the user's "pause animations" preference
        if (a11yPrefs && a11yPrefs.pauseAnims) {
            scheduleBuildingAppearance();
            return;
        }
        const el = document.getElementById('building-bg');
        if (!el) return;
        el.classList.add('visible');
        setTimeout(() => {
            el.classList.remove('visible');
            scheduleBuildingAppearance();
        }, BUILDING_VISIBLE_MS);
    }, delay);
}
// First appearance ~10 s after load — gives the user a moment to admire the sky first
scheduleBuildingAppearance(10000);

function updateBuilding() { /* no-op — fade handled by CSS transition */ }

/* POST-PROCESSING ---------------------------------------- */
const composer = new EffectComposer(renderer);
composer.addPass(new RenderPass(scene, camera));
composer.addPass(new UnrealBloomPass(
    new THREE.Vector2(window.innerWidth, window.innerHeight),
    CFG.bloomStrength, CFG.bloomRadius, CFG.bloomThreshold
));
composer.addPass(new ShaderPass({
    uniforms: { tDiffuse: { value: null }, warm: { value: 0.05 }, vignette: { value: 0.32 } },
    vertexShader: /* glsl */`
        varying vec2 vUv;
        void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }
    `,
    fragmentShader: /* glsl */`
        uniform sampler2D tDiffuse; uniform float warm, vignette; varying vec2 vUv;
        void main(){
            vec4 c = texture2D(tDiffuse, vUv);
            c.rgb += vec3(warm, warm * 0.55, -warm * 0.15) * 0.5;
            float d = distance(vUv, vec2(0.5));
            float v = smoothstep(0.95, 0.40, d);
            c.rgb *= mix(1.0 - vignette, 1.0, v);
            gl_FragColor = c;
        }
    `,
}));

/* INPUT -------------------------------------------------- */
const targetMouse = { x: 0, y: 0 };
const smoothMouse = { x: 0, y: 0 };
window.addEventListener('mousemove', (e) => {
    targetMouse.x = (e.clientX / window.innerWidth)  * 2 - 1;
    targetMouse.y = (e.clientY / window.innerHeight) * 2 - 1;
});
window.addEventListener('touchmove', (e) => {
    if (e.touches.length) {
        targetMouse.x = (e.touches[0].clientX / window.innerWidth)  * 2 - 1;
        targetMouse.y = (e.touches[0].clientY / window.innerHeight) * 2 - 1;
    }
}, { passive: true });

let targetScroll = 0, smoothScroll = 0;
function recomputeScrollTarget() {
    const max = Math.max(1, document.documentElement.scrollHeight - window.innerHeight);
    targetScroll = window.scrollY / max;
}
window.addEventListener('scroll', recomputeScrollTarget, { passive: true });
recomputeScrollTarget();

const driftHint = document.getElementById('drift-hint');
function dismissHint() {
    if (driftHint) driftHint.classList.add('hidden');
}
window.addEventListener('mousemove', dismissHint, { once: true });
window.addEventListener('scroll', dismissHint, { once: true });

/* RESIZE ------------------------------------------------- */
window.addEventListener('resize', () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
    composer.setSize(window.innerWidth, window.innerHeight);
    recomputeScrollTarget();
});

/* ANIMATION ---------------------------------------------- */
const clock = new THREE.Clock();
let frame = 0;

function animate() {
    requestAnimationFrame(animate);
    const t = clock.getElapsedTime();
    const now = performance.now();

    smoothMouse.x += (targetMouse.x - smoothMouse.x) * CFG.mouseLerp;
    smoothMouse.y += (targetMouse.y - smoothMouse.y) * CFG.mouseLerp;
    smoothScroll  += (targetScroll  - smoothScroll)  * CFG.scrollLerp;

    /* --- 360° first-person look --- */
    // mouse X → yaw (right = look right)
    // mouse Y → pitch (up = look up toward sun, down = look down at cloud floor)
    const yaw   =  smoothMouse.x * CFG.yawRange;
    const pitch = -smoothMouse.y * CFG.pitchRange;

    // Camera position drifts forward with scroll; gentle bob for the "floating" feel
    const flight = 1600;
    camera.position.x = 0;
    camera.position.y = 90 + Math.sin(t * 0.32) * 5;
    camera.position.z = 200 - smoothScroll * flight;

    // Build look direction from yaw/pitch and aim the camera at a point one unit out along it
    const cp = Math.cos(pitch), sp = Math.sin(pitch);
    const cy = Math.cos(yaw),   sy = Math.sin(yaw);
    const lookDir = new THREE.Vector3(sy * cp, sp, -cy * cp);
    const lookTarget = camera.position.clone().add(lookDir);
    camera.up.set(0, 1, 0);
    camera.lookAt(lookTarget);

    animateLayer(cloudsFloor, t, 0.4);
    animateLayer(cloudsLower, t, 0.6);
    animateLayer(cloudsMid,   t, 1.0);
    animateLayer(cloudsUpper, t, 1.4);

    const pa = particles.geometry.attributes.position.array;
    const sa = particles.geometry.attributes.seed.array;
    for (let i = 0; i < CFG.particleCount; i++) {
        pa[i*3]   += Math.sin(t * 0.25 + sa[i]) * 0.05;
        pa[i*3+1] += Math.cos(t * 0.18 + sa[i] * 1.3) * 0.035;
    }
    particles.geometry.attributes.position.needsUpdate = true;

    updateBuilding(now);
    renderer.render(scene, camera);     // direct render, no post-processing — keeps colours saturated

    if (frame === 0) console.log('[sky] first frame rendered');
    frame++;
}

function animateLayer(group, t, speedMul) {
    const list = group.children;
    for (let i = 0; i < list.length; i++) {
        const c = list[i];
        c.position.x += c.userData.driftSpeed * speedMul * 0.7;
        c.position.y = c.userData.baseY + Math.sin(t * c.userData.bobSpeed * 60 + i) * c.userData.bobAmount;
        if (c.position.x > 2200)  c.position.x = -2200;
        if (c.position.x < -2200) c.position.x =  2200;
    }
}

animate();
console.log('[sky] init complete');

/* ============================================================
   ACCESSIBILITY TOOLS — narzędzia ułatwiające dostępność
   Toggles body classes; CSS handles the visual response.
   State persists in localStorage so user preference survives reload.
   ============================================================ */
(function setupA11y() {
    const trigger  = document.getElementById('a11y-trigger');
    const panel    = document.getElementById('a11y-panel');
    if (!trigger || !panel) return;
    const closeBtn = panel.querySelector('.a11y-close');
    const STORAGE_KEY = 'pw_a11y_v1';

    /* Mutually exclusive font size buckets */
    const FONT_CLASSES = ['a11y-font-75', 'a11y-font-125', 'a11y-font-150'];
    /* Visual filter buckets — only one at a time (high-contrast / grayscale / negative) */
    const FILTER_CLASSES = ['a11y-high-contrast', 'a11y-grayscale', 'a11y-negative'];

    /* --- state --- */
    function loadState() {
        try { return JSON.parse(localStorage.getItem(STORAGE_KEY)) || {}; }
        catch { return {}; }
    }
    function saveState(s) {
        try { localStorage.setItem(STORAGE_KEY, JSON.stringify(s)); } catch {}
    }
    let state = loadState();

    function applyState() {
        const body = document.body;
        FONT_CLASSES.forEach(c => body.classList.remove(c));
        if (state.font && FONT_CLASSES.includes('a11y-font-' + state.font)) {
            body.classList.add('a11y-font-' + state.font);
        }
        ['high-contrast','grayscale','negative','readable-font','highlight-links','big-cursor','pause-anims'].forEach(k => {
            body.classList.toggle('a11y-' + k, !!state[k]);
        });
        document.querySelectorAll('[data-a11y-toggle]').forEach(btn => {
            const key = btn.dataset.a11yToggle;
            btn.setAttribute('aria-pressed', state[key] ? 'true' : 'false');
        });
        // Expose to other modules (building scheduler)
        a11yPrefs = {
            pauseAnims: !!state['pause-anims'],
        };
    }

    /* --- open / close --- */
    function openPanel() {
        panel.hidden = false;
        requestAnimationFrame(() => panel.classList.add('open'));
        trigger.setAttribute('aria-expanded', 'true');
        /* move focus to first interactive element for keyboard users */
        const firstBtn = panel.querySelector('button');
        if (firstBtn) firstBtn.focus();
    }
    function closePanel() {
        panel.classList.remove('open');
        trigger.setAttribute('aria-expanded', 'false');
        setTimeout(() => { panel.hidden = true; }, 300);
        trigger.focus();
    }
    trigger.addEventListener('click', () => {
        if (panel.hidden) openPanel(); else closePanel();
    });
    closeBtn?.addEventListener('click', closePanel);

    /* Esc closes panel; Tab inside panel kept natural (no trap — panel is non-modal) */
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && !panel.hidden) closePanel();
    });
    /* Click outside panel closes */
    document.addEventListener('click', (e) => {
        if (panel.hidden) return;
        if (panel.contains(e.target) || trigger.contains(e.target)) return;
        closePanel();
    });

    /* --- font size buttons --- */
    panel.querySelectorAll('[data-a11y]').forEach(btn => {
        btn.addEventListener('click', () => {
            const action = btn.dataset.a11y;
            const order = ['75', null, '125', '150']; // null = default
            const cur = state.font ?? null;
            const idx = order.indexOf(cur);
            if (action === 'font-inc') {
                if (idx < order.length - 1) state.font = order[idx + 1];
            } else if (action === 'font-dec') {
                if (idx > 0) state.font = order[idx - 1];
            } else if (action === 'font-reset') {
                state.font = null;
            } else if (action === 'reset') {
                state = {};
            }
            saveState(state);
            applyState();
        });
    });

    /* --- toggles (high contrast, grayscale, negative, etc.) --- */
    panel.querySelectorAll('[data-a11y-toggle]').forEach(btn => {
        btn.addEventListener('click', () => {
            const key = btn.dataset.a11yToggle;
            const next = !state[key];
            /* Only one visual filter at a time */
            if (next && FILTER_CLASSES.includes('a11y-' + key)) {
                ['high-contrast','grayscale','negative'].forEach(k => { if (k !== key) state[k] = false; });
            }
            state[key] = next;
            saveState(state);
            applyState();
        });
    });

    /* --- init --- */
    applyState();
})();

/* ============================================================
   FLOOR ACCORDION + GALLERY LIGHTBOX (UI interactivity)
   ============================================================ */
document.addEventListener('click', (e) => {
    // Brand → smooth scroll back to the top
    if (e.target.closest('.brand')) {
        e.preventDefault();
        closeLightbox();
        window.scrollTo({ top: 0, behavior: 'smooth' });
        return;
    }
    const head = e.target.closest('.floor-card .floor-head');
    if (head) {
        const card = head.closest('.floor-card');
        card.classList.toggle('open');
        return;
    }
    const thumb = e.target.closest('.gallery-tile');
    if (thumb) {
        openLightbox(thumb.dataset.full || thumb.querySelector('img')?.src);
    }
    if (e.target.closest('.lightbox') && !e.target.closest('.lightbox-img')) {
        closeLightbox();
    }
});

document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeLightbox();
});

function openLightbox(src) {
    if (!src) return;
    let box = document.querySelector('.lightbox');
    if (!box) {
        box = document.createElement('div');
        box.className = 'lightbox';
        box.innerHTML = '<button class="lightbox-close" aria-label="Zamknij">×</button><img class="lightbox-img" alt="">';
        document.body.appendChild(box);
        box.querySelector('.lightbox-close').addEventListener('click', closeLightbox);
    }
    box.querySelector('.lightbox-img').src = src;
    requestAnimationFrame(() => box.classList.add('open'));
}
function closeLightbox() {
    const box = document.querySelector('.lightbox');
    if (box) box.classList.remove('open');
}

/* ============================================================
   PROCEDURAL TEXTURES
   ============================================================ */
function makeCloudTextures() {
    const out = [];
    for (let v = 0; v < 4; v++) {
        const size = 256;
        const c = document.createElement('canvas');
        c.width = c.height = size;
        const ctx = c.getContext('2d');
        const blobs = 24 + Math.floor(Math.random() * 14);
        for (let i = 0; i < blobs; i++) {
            const r = 30 + Math.random() * 80;
            const x = size/2 + (Math.random() - 0.5) * size * 0.65;
            const y = size/2 + (Math.random() - 0.5) * size * 0.4;
            const g = ctx.createRadialGradient(x, y, 0, x, y, r);
            const a = 0.12 + Math.random() * 0.14;
            g.addColorStop(0,   `rgba(255,255,255,${a})`);
            g.addColorStop(0.55,`rgba(255,255,255,${a * 0.5})`);
            g.addColorStop(1,   `rgba(255,255,255,0)`);
            ctx.fillStyle = g;
            ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill();
        }
        const tex = new THREE.CanvasTexture(c);
        tex.colorSpace = THREE.SRGBColorSpace;
        tex.minFilter = THREE.LinearFilter;
        tex.magFilter = THREE.LinearFilter;
        out.push(tex);
    }
    return out;
}
function makeSunTexture() {
    const size = 512;
    const c = document.createElement('canvas');
    c.width = c.height = size;
    const ctx = c.getContext('2d');
    const cx = size/2;
    const g = ctx.createRadialGradient(cx, cx, 0, cx, cx, cx);
    g.addColorStop(0.00, 'rgba(255,250,225,1.0)');
    g.addColorStop(0.06, 'rgba(255,242,200,0.95)');
    g.addColorStop(0.18, 'rgba(255,225,170,0.55)');
    g.addColorStop(0.40, 'rgba(255,210,150,0.18)');
    g.addColorStop(0.70, 'rgba(255,200,140,0.06)');
    g.addColorStop(1.00, 'rgba(255,200,140,0.0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, size, size);
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    return tex;
}
function makeDotTexture() {
    const size = 64;
    const c = document.createElement('canvas');
    c.width = c.height = size;
    const ctx = c.getContext('2d');
    const g = ctx.createRadialGradient(size/2, size/2, 0, size/2, size/2, size/2);
    g.addColorStop(0, 'rgba(255,255,255,1)');
    g.addColorStop(0.5, 'rgba(255,255,255,0.45)');
    g.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, size, size);
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    return tex;
}
