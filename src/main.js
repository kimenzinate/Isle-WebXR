import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { VRButton } from 'three/addons/webxr/VRButton.js';
import { USDLoader } from 'three/addons/loaders/USDLoader.js';

const canvas = document.querySelector('#scene');
const statusEl = document.querySelector('#status');
const loadingEl = document.querySelector('#loading');

const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.15;
renderer.xr.enabled = true;

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x92bde5);
const camera = new THREE.PerspectiveCamera(58, window.innerWidth / window.innerHeight, 0.01, 100);
camera.position.set(0, 0, 0.0);
scene.add(camera);

// Reuse the same OrbitControls behaviour that made the original Heaven Isle
// panorama draggable. Horizontal orbit stays enabled on Heaven/Voice only;
// polar angle is locked to 90° so the whole interface can never tilt vertically.
const controls = new OrbitControls(camera, renderer.domElement);
controls.target.set(0, 0, -1.10);
controls.enableDamping = true;
controls.dampingFactor = 0.06;
controls.enablePan = false;
controls.enableZoom = false;
controls.minPolarAngle = Math.PI / 2;
controls.maxPolarAngle = Math.PI / 2;
controls.enableRotate = false;
controls.update();

let orbitDragStartX = 0;
let orbitDragStartY = 0;
let orbitPointerDown = false;
let suppressNextSceneClick = false;
let objectDragState = null;
let objectDragMoved = false;

function resetDesktopOrbit() {
  if (renderer.xr.isPresenting) return;
  camera.position.set(0, 0, 0);
  controls.target.set(0, 0, -1.10);
  camera.up.set(0, 1, 0);
  controls.update();
}

function setDesktopOrbitEnabled(enabled) {
  if (renderer.xr.isPresenting) return;
  controls.enabled = true;
  controls.enableRotate = !!enabled;
  controls.enablePan = false;
  controls.enableZoom = false;
  controls.minPolarAngle = Math.PI / 2;
  controls.maxPolarAngle = Math.PI / 2;
  renderer.domElement.style.cursor = enabled ? 'grab' : 'default';
}

const sessionInit = { optionalFeatures: ['local-floor', 'hand-tracking'] };
const vrButton = VRButton.createButton(renderer, sessionInit);
// Prevent the default "VR NOT SUPPORTED" badge from ever flashing on desktop.
vrButton.style.display = 'none';
document.body.appendChild(vrButton);
if (navigator.xr?.isSessionSupported) {
  navigator.xr.isSessionSupported('immersive-vr').then((supported) => {
    if (supported) {
      document.body.classList.add('xr-supported');
      vrButton.style.display = '';
    }
  }).catch(() => {});
}

const worldRoot = new THREE.Group();
const stageRoot = new THREE.Group();
// Desktop/web uses a centred head-relative coordinate system: camera Y=0.
// Existing scene coordinates were authored around 1.60m eye height, so only the
// stage root is translated for desktop. This is a translation, not a rotation.
const DESKTOP_STAGE_Y_OFFSET = -1.60;
stageRoot.position.y = DESKTOP_STAGE_Y_OFFSET;
scene.add(worldRoot, stageRoot);

scene.add(new THREE.HemisphereLight(0xffffff, 0x8aa4bd, 2.1));
const keyLight = new THREE.DirectionalLight(0xffffff, 2.2);
keyLight.position.set(-2.5, 4.2, 2.4);
scene.add(keyLight);
const fillLight = new THREE.DirectionalLight(0xffe9cf, 1.3);
fillLight.position.set(3, 2.2, 1);
scene.add(fillLight);

const textureLoader = new THREE.TextureLoader();
const usdLoader = new USDLoader();
const clock = new THREE.Clock();
const raycaster = new THREE.Raycaster();
const pointer = new THREE.Vector2();
const interactables = [];
const animated = [];

// Swift uses inward-facing 360 spheres for both Heaven Isle and Voice Isle.
// On desktop we rotate only this panorama, keeping all UI/spatial content front-facing.
let panoramaSphere = null;
let panoramaTexture = null;
let panoramaBaseYaw = 0;
let panoramaYaw = 0;
let panoramaPitch = 0;

// Stage intro captions follow the Swift Memory Catch timing: hold 2.2s, fade 0.4s.
let heavenIntroUntil = 0;
let voiceIntroUntil = 0;
const INTRO_HOLD_MS = 2200;
const INTRO_FADE_MS = 400;
const activeMedia = new Set();

let voiceAudioContext = null;
const voiceAudioNodes = new WeakMap();

function boostVoiceAudio(audio, gainValue = 1.6) {
  try {
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtx) {
      audio.volume = 1;
      return null;
    }
    if (!voiceAudioContext) voiceAudioContext = new AudioCtx();
    if (voiceAudioNodes.has(audio)) return voiceAudioNodes.get(audio);

    const source = voiceAudioContext.createMediaElementSource(audio);
    const gain = voiceAudioContext.createGain();
    gain.gain.value = gainValue;
    source.connect(gain);
    gain.connect(voiceAudioContext.destination);
    const nodes = { source, gain };
    voiceAudioNodes.set(audio, nodes);
    return nodes;
  } catch (e) {
    // If Web Audio is unavailable/blocked, keep the element at maximum native volume.
    audio.volume = 1;
    return null;
  }
}

async function resumeVoiceAudioContext() {
  if (voiceAudioContext?.state === 'suspended') {
    try { await voiceAudioContext.resume(); } catch (e) {}
  }
}
const cachedTextures = new Map();
const cachedUiImages = new Map();
let islandModel = null;
let jungfrauModel = null;
let currentStage = 'tutorial';
let stageBeforeExit = 'heaven';
let tutorialIndex = 0;
let selectedMemory = null;
let selectedVoice = null;
let reflectionComfort = null;
let reflectionFeeling = null;
let randomMode = false;
let randomMemories = [];
let tutorialTimer = null;

const FONT_SERIF = '"Playfair Display", Georgia, serif';
const FONT_SANS = '-apple-system, BlinkMacSystemFont, "SF Pro Display", "Segoe UI", Arial, sans-serif';
const TUTORIAL_FRAME_PX = { width: 1920, height: 1080 };
const TUTORIAL_FRAME_M = { width: 1.64, height: 0.9225 };
const TUTORIAL_SCALE = 1.00; // Figma-based panel drawing, with overall world size reduced to match reference
const TUTORIAL_CENTER = [0, 1.60, -1.08]; // restore popup to the visual centre while keeping room for the floating Back button
const tutorialAssets = new Map();

// Fixed floating controls: visual scale follows the original Swift/Figma control.
// Icon 30, text ~28, gap 12, padding 20. The world-space scale is calibrated
// for the original head-relative z ~= -0.92 so the controls stay legible.
const CONTROL_M_PER_PX = 0.00078;
const CONTROL_ICON_PX = 24;
const CONTROL_FONT_PX = 24;
const CONTROL_GAP_PX = 10;
const CONTROL_PAD_X_PX = 18;
const CONTROL_PAD_Y_PX = 18;
const CONTROL_RADIUS_PX = 18;
const HOME_Y_OFFSET = 0.13;

const MEMORY = [
  {
    id: 1, title: 'Our Boracay Holiday', type: 'photo', asset: './assets/images/boracay.jpg',
    description: 'We sailed on a yacht, discovered delicious food and spent time on Boracay’s beautiful white-sand beaches. Every day felt special, and I would love for us to return together one day.'
  },
  {
    id: 2, title: 'Recent Family Photo', type: 'photo', asset: './assets/images/family.jpg',
    description: 'We took this photo at a café shortly before I moved to the UK. Dad later had fun decorating it with AI, which somehow made the memory even more endearing.'
  },
  {
    id: 3, title: 'Childhood Island Trip', type: 'photo', asset: './assets/images/childhood.jpg',
    description: 'I made this photo diary in primary school after taking time away for a family experience trip. My parents look so young, and our little family looks wonderfully sweet together.'
  },
  {
    id: 4, title: 'Paris with Mum', type: 'video', asset: './assets/video/paris.mp4',
    description: 'Mum and I spent part of the summer together in Paris. It was incredibly hot, but seeing how much she enjoyed the trip made me so happy. We only recently said goodbye, but I already miss her.'
  },
  {
    id: 6, title: 'Jungfrau Keyring', type: 'object', asset: './assets/models/jungfrau.usdz',
    description: 'Mum and I travelled to Grindelwald and made our way up to Jungfraujoch. Seeing snow in the middle of summer made the trip feel especially magical.'
  },
  {
    id: 5, title: 'A Portrait of Mum and Dad', type: 'video', asset: './assets/video/parents.mp4',
    description: 'After I started working, I treated Mum and Dad to a professional studio portrait session. It still amazes me how affectionate they are after all these years.'
  }
];

const VOICES = [
  { id: 2, title: 'Mum Singing\nin the Car', label: 'Mum', asset: './assets/audio/song.m4a', orbPx: 196, titlePx: 31, description: 'Mum used to sing this song in the car. She’s not exactly in tune, but she loves singing — and hearing it always makes me smile.' },
  { id: 1, title: 'A Call with Dad', label: 'Home', asset: './assets/audio/dad.m4a', orbPx: 220, titlePx: 31, description: 'When I was working far from home, Dad reminded me to eat properly and look after my health. Hearing his voice gave me strength.' },
  { id: 4, title: 'Dad’s Promise\nto Mum', label: 'Best friend', asset: './assets/audio/promise.m4a', orbPx: 130, titlePx: 22, description: 'Dad made this promise to Mum, and he actually kept it. Hearing it again makes me happy, knowing that he meant what he said.' },
  { id: 5, title: 'Mum Singing\nHappy Birthday', label: 'Dad', asset: './assets/audio/birthday.mp3', orbPx: 220, titlePx: 32, labelWidthPx: 200, description: 'Mum sang Happy Birthday to Dad while I was living far away. Next year, I want to celebrate his birthday with them in person.' },
  { id: 3, title: 'Mum’s Scary\nStory', label: 'At grandparents’ house', asset: './assets/audio/story.m4a', orbPx: 141, titlePx: 26, labelWidthPx: 300, description: 'Mum told me a scary story so dramatically and hilariously that we ended up laughing the whole time.' }
];

const TUTORIAL_STEPS = [
  'intro',
  'islandName',
  'welcome',
  'gestures',
  'catchMemory',
  'comfortThings',
  'customiseIsland',
  'portal'
];

const MEMORY_LAYOUT = {
  // Rebalanced from Swift/Figma for WebXR readability:
  // smaller islands, more breathing room, slightly farther depth.
  1: { // Boracay — left-middle
    position: [-0.67, 1.50, -1.22],
    islandSize: 0.34,
    cardW: 0.205,
    cardH: 0.154,
    cardY: 0.106,
    yaw: 0.08
  },
  2: { // Recent Family — hero, upper-centre
    position: [0.01, 1.78, -1.24],
    islandSize: 0.42,
    cardW: 0.295,
    cardH: 0.221,
    cardY: 0.132,
    yaw: -0.04
  },
  3: { // Childhood — small, lower-left
    position: [-0.39, 1.17, -1.18],
    islandSize: 0.21,
    cardW: 0.124,
    cardH: 0.093,
    cardY: 0.060,
    yaw: -0.08
  },
  4: { // Paris — second-largest, lower-right
    position: [0.55, 1.22, -1.22],
    islandSize: 0.39,
    cardW: 0.228,
    cardH: 0.172,
    cardY: 0.114,
    yaw: 0.07
  },
  5: { // Parents portrait — smallest, upper-right
    position: [0.69, 1.62, -1.24],
    islandSize: 0.20,
    cardW: 0.097,
    cardH: 0.073,
    cardY: 0.052,
    yaw: 0.10
  },
  6: { // Jungfrau object — quiet secondary, centre-lower
    position: [0.02, 1.39, -1.24],
    islandSize: 0.19,
    objectSize: 0.108,
    cardY: 0.058,
    yaw: 0.00
  }
};

const NOTE_LAYOUT = [
  // Same dispersed composition, but reduced note sizes so the memories breathe more.
  { position: [-0.225, 1.415, -1.00], width: 0.135, height: 0.090, amp: 0.010, speed: 0.31, rotation:  0.035 },
  { position: [-0.365, 1.825, -1.03], width: 0.255, height: 0.170, amp: 0.014, speed: 0.29, rotation: -0.045 },
  { position: [-0.690, 1.280, -1.02], width: 0.190, height: 0.127, amp: 0.011, speed: 0.30, rotation:  0.055 },
  { position: [ 0.470, 1.825, -1.05], width: 0.185, height: 0.123, amp: 0.012, speed: 0.28, rotation: -0.035 },
  { position: [ 0.330, 1.555, -1.03], width: 0.155, height: 0.104, amp: 0.010, speed: 0.295, rotation: 0.045 },
  { position: [ 0.740, 1.405, -1.04], width: 0.150, height: 0.100, amp: 0.011, speed: 0.29, rotation: -0.025 }
];

const ISLAND_TILT_RAD = 0.46; // Swift addIslandClone(): exact X-axis tilt
const X_AXIS = new THREE.Vector3(1, 0, 0);
const Y_AXIS = new THREE.Vector3(0, 1, 0);

function applySwiftIslandOrientation(island, yaw = 0) {
  // Swift: qx(0.46) * qy(yaw).
  // The PI term only preserves the USD model's front-facing direction in Three.js.
  const qx = new THREE.Quaternion().setFromAxisAngle(X_AXIS, ISLAND_TILT_RAD);
  const qy = new THREE.Quaternion().setFromAxisAngle(Y_AXIS, Math.PI + yaw);
  island.quaternion.copy(qx).multiply(qy);
}

const VOICE_POSITIONS = [
  // Exact ImmersiveView.swift head-relative positions + the legacy 1.60 stage coordinate offset.
  [-0.58, 1.80, -1.10], // Mum Singing in the Car
  [-0.05, 1.96, -1.18], // A Call with Dad
  [ 0.54, 1.81, -1.08], // Dad's Promise to Mum
  [ 0.37, 1.38, -1.05], // Mum Singing Happy Birthday
  [-0.36, 1.35, -1.05]  // Mum's Scary Story
];

function setStatus(text) { statusEl.textContent = text; }

function clearStage() {
  renderer.domElement.style.cursor = 'default';
  if (tutorialTimer) { clearTimeout(tutorialTimer); tutorialTimer = null; }
  activeMedia.forEach(media => {
    try { media.pause?.(); } catch (_) {}
  });
  activeMedia.clear();
  interactables.length = 0;
  animated.length = 0;
  while (stageRoot.children.length) stageRoot.remove(stageRoot.children[0]);
}

function cacheTexture(path) {
  if (!cachedTextures.has(path)) {
    const t = textureLoader.load(path);
    t.colorSpace = THREE.SRGBColorSpace;
    t.anisotropy = renderer.capabilities.getMaxAnisotropy();
    cachedTextures.set(path, t);
  }
  return cachedTextures.get(path);
}

function roundedRect(ctx, x, y, w, h, r) {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

function wrapText(ctx, text, maxWidth) {
  const paragraphs = String(text).split('\n');
  const lines = [];
  for (const paragraph of paragraphs) {
    const words = paragraph.split(/\s+/);
    let line = '';
    for (const word of words) {
      const test = line ? `${line} ${word}` : word;
      if (ctx.measureText(test).width > maxWidth && line) {
        lines.push(line); line = word;
      } else line = test;
    }
    if (line) lines.push(line);
  }
  return lines;
}

function fontString({ size, weight = 700, family = 'serif', italic = false }) {
  const stack = family === 'sans' ? FONT_SANS : FONT_SERIF;
  return `${italic ? 'italic ' : ''}${weight} ${size}px ${stack}`;
}

function makeCanvasTexture({
  width = 1024, height = 512, title = '', body = '',
  bg = 'rgba(244,249,255,0.88)', fg = '#1d3044', accent = '#5a84ad',
  titleSize = 62, bodySize = 32, radius = 52, align = 'center', panel = true,
  titleFont = 'serif', bodyFont = 'sans', titleWeight = 700, bodyWeight = 500,
  titleItalic = false, bodyItalic = false
} = {}) {
  const c = document.createElement('canvas');
  c.width = width; c.height = height;
  const ctx = c.getContext('2d');
  ctx.clearRect(0, 0, width, height);
  if (panel) {
    ctx.fillStyle = bg;
    roundedRect(ctx, 8, 8, width - 16, height - 16, radius);
    ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,.78)';
    ctx.lineWidth = 4;
    ctx.stroke();
  }
  ctx.fillStyle = fg;
  ctx.textAlign = align;
  ctx.textBaseline = 'top';
  ctx.font = fontString({ size: titleSize, weight: titleWeight, family: titleFont, italic: titleItalic });
  const titleLines = wrapText(ctx, title, width - 120);
  let y = body ? 72 : Math.max(60, height / 2 - titleLines.length * titleSize * 0.62);
  for (const line of titleLines) {
    ctx.fillText(line, align === 'center' ? width / 2 : 64, y);
    y += titleSize * 1.06;
  }
  if (body) {
    y += 22;
    ctx.fillStyle = accent;
    ctx.font = fontString({ size: bodySize, weight: bodyWeight, family: bodyFont, italic: bodyItalic });
    const bodyLines = wrapText(ctx, body, width - 130);
    for (const line of bodyLines.slice(0, 9)) {
      ctx.fillText(line, align === 'center' ? width / 2 : 64, y);
      y += bodySize * 1.35;
    }
  }
  const texture = new THREE.CanvasTexture(c);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = renderer.capabilities.getMaxAnisotropy();
  return texture;
}

function getUiImage(src, onLoad) {
  let img = cachedUiImages.get(src);
  if (!img) {
    img = new Image();
    img.decoding = 'async';
    img.src = src;
    cachedUiImages.set(src, img);
  }
  if (img.complete && img.naturalWidth > 0) {
    onLoad(img);
  } else {
    img.addEventListener('load', () => onLoad(img), { once: true });
  }
}

function makeFixedControlFaceTexture(label, iconPath, { aspect = 3.4 } = {}) {
  const c = document.createElement('canvas');
  c.width = 1024;
  c.height = Math.round(c.width / aspect);
  const ctx = c.getContext('2d');
  const texture = new THREE.CanvasTexture(c);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = renderer.capabilities.getMaxAnisotropy();

  const draw = (iconImg = null) => {
    const w = c.width;
    const h = c.height;
    ctx.clearRect(0, 0, w, h);

    const iconSize = Math.round(h * 0.43);
    const gap = Math.round(h * 0.14);
    const radius = Math.round(h * 0.29);

    ctx.save();
    ctx.shadowColor = 'rgba(0,0,0,0.18)';
    ctx.shadowBlur = Math.round(h * 0.22);
    ctx.shadowOffsetY = Math.round(h * 0.03);
    ctx.fillStyle = 'rgba(140,130,121,0.30)';
    roundedRect(ctx, 12, 12, w - 24, h - 24, radius);
    ctx.fill();
    ctx.restore();

    ctx.strokeStyle = 'rgba(255,255,255,0.15)';
    ctx.lineWidth = Math.max(2, Math.round(h * 0.014));
    roundedRect(ctx, 12, 12, w - 24, h - 24, radius);
    ctx.stroke();

    ctx.font = `900 ${Math.round(h * 0.34)}px Inter, "Arial Black", system-ui, sans-serif`;
    ctx.fillStyle = '#EDE7DF';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';

    const textW = ctx.measureText(label).width;
    const totalW = (iconImg ? iconSize + gap : 0) + textW;
    const startX = (w - totalW) / 2;
    const centerY = h / 2;

    if (iconImg) {
      ctx.save();
      ctx.globalAlpha = 0.98;
      ctx.drawImage(iconImg, startX, centerY - iconSize / 2, iconSize, iconSize);
      ctx.restore();
    }
    ctx.fillText(label, startX + (iconImg ? iconSize + gap : 0), centerY + 2);

    texture.needsUpdate = true;
  };

  draw();
  if (iconPath) getUiImage(iconPath, (img) => draw(img));
  return texture;
}

function makePlane({ width = 1, height = 0.5, texture = null, opacity = 1, position = [0,1.6,-2], rotation = [0,0,0], action = null, name = '' } = {}) {
  const material = new THREE.MeshBasicMaterial({ map: texture, transparent: opacity < 1 || !!texture, opacity, side: THREE.DoubleSide, depthWrite: opacity >= 1 });
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(width, height), material);
  mesh.position.set(...position);
  mesh.rotation.set(...rotation);
  mesh.name = name;
  if (action) {
    mesh.userData.action = action;
    interactables.push(mesh);
  }
  stageRoot.add(mesh);
  return mesh;
}

function makeTextPanel(opts = {}) {
  const texture = makeCanvasTexture(opts.canvas || {});
  return makePlane({ ...opts, texture });
}

function makeButtonTexture(label, { bg = 'rgba(245,250,255,.90)', fg = '#1c334a' } = {}) {
  const c = document.createElement('canvas');
  c.width = 700;
  c.height = 240;
  const ctx = c.getContext('2d');
  ctx.clearRect(0, 0, c.width, c.height);

  ctx.fillStyle = bg;
  roundedRect(ctx, 8, 8, c.width - 16, c.height - 16, 90);
  ctx.fill();

  // Preserve the original button edge while centering the label exactly,
  // matching SwiftUI Text inside the fixed-height button frame.
  ctx.strokeStyle = 'rgba(255,255,255,.78)';
  ctx.lineWidth = 4;
  roundedRect(ctx, 8, 8, c.width - 16, c.height - 16, 90);
  ctx.stroke();

  ctx.font = fontString({ size: 64, weight: 700, family: 'sans' });
  ctx.fillStyle = fg;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(label, c.width / 2, c.height / 2);

  const texture = new THREE.CanvasTexture(c);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = renderer.capabilities.getMaxAnisotropy();
  return texture;
}

function makeTransparentTextTexture(label, { fg = '#EDE7DF', fontSize = 56 } = {}) {
  const c = document.createElement('canvas');
  c.width = 900;
  c.height = 220;
  const ctx = c.getContext('2d');
  ctx.clearRect(0, 0, c.width, c.height);
  ctx.font = fontString({ size: fontSize, weight: 900, family: 'sans' });
  ctx.fillStyle = fg;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(label, c.width / 2, c.height / 2 + 2);
  const texture = new THREE.CanvasTexture(c);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = renderer.capabilities.getMaxAnisotropy();
  texture.needsUpdate = true;
  return texture;
}

function makeControlTextTexture(label) {
  const scale = 4;
  const measureCanvas = document.createElement('canvas');
  const measureCtx = measureCanvas.getContext('2d');
  measureCtx.font = `700 ${CONTROL_FONT_PX}px "Playfair Display", Georgia, serif`;
  const measured = Math.ceil(measureCtx.measureText(label).width);
  const widthPx = measured + 8;
  const heightPx = 42;

  const c = document.createElement('canvas');
  c.width = widthPx * scale;
  c.height = heightPx * scale;
  const ctx = c.getContext('2d');
  ctx.scale(scale, scale);
  ctx.clearRect(0, 0, widthPx, heightPx);
  ctx.font = `700 ${CONTROL_FONT_PX}px "Playfair Display", Georgia, serif`;
  ctx.fillStyle = '#EDE7DF';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(label, widthPx / 2, heightPx / 2 + 1);

  const texture = new THREE.CanvasTexture(c);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = renderer.capabilities.getMaxAnisotropy();
  texture.needsUpdate = true;
  return { texture, widthPx, heightPx };
}

function roundedRectShape(width, height, radius) {
  const x = -width / 2;
  const y = -height / 2;
  const r = Math.min(radius, width / 2, height / 2);
  const shape = new THREE.Shape();
  shape.moveTo(x + r, y);
  shape.lineTo(x + width - r, y);
  shape.quadraticCurveTo(x + width, y, x + width, y + r);
  shape.lineTo(x + width, y + height - r);
  shape.quadraticCurveTo(x + width, y + height, x + width - r, y + height);
  shape.lineTo(x + r, y + height);
  shape.quadraticCurveTo(x, y + height, x, y + height - r);
  shape.lineTo(x, y + r);
  shape.quadraticCurveTo(x, y, x + r, y);
  return shape;
}


function makeRoundedTextureMesh(texture, width, height, radius, position, action = null) {
  const shape = roundedRectShape(width, height, radius);
  const geometry = new THREE.ShapeGeometry(shape, 24);
  const pos = geometry.attributes.position;
  const uv = geometry.attributes.uv;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const y = pos.getY(i);
    uv.setXY(i, x / width + 0.5, y / height + 0.5);
  }
  uv.needsUpdate = true;
  const mesh = new THREE.Mesh(
    geometry,
    new THREE.MeshBasicMaterial({
      map: texture,
      transparent: true,
      side: THREE.DoubleSide,
      depthWrite: false
    })
  );
  mesh.position.set(...position);
  if (action) {
    mesh.userData.action = action;
    interactables.push(mesh);
  }
  stageRoot.add(mesh);
  return mesh;
}

function makeGlassMediaCard(texture, position, action = null) {
  const group = new THREE.Group();
  group.position.set(...position);
  const width = 1.26;
  const height = 0.92;
  const radius = 0.075;

  // Broad glow so the glass reads clearly against the panorama.
  const haloShape = roundedRectShape(width * 1.055, height * 1.07, radius * 1.15);
  const halo = new THREE.Mesh(
    new THREE.ShapeGeometry(haloShape, 32),
    new THREE.MeshBasicMaterial({
      color: 0xffffff,
      transparent: true,
      opacity: 0.12,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      side: THREE.DoubleSide
    })
  );
  halo.position.z = -0.010;
  group.add(halo);

  // Dark translucent frosted slab — intentionally stronger than the previous
  // version so it is visibly different from the old white card.
  const frameShape = roundedRectShape(width, height, radius);
  const frame = new THREE.Mesh(
    new THREE.ShapeGeometry(frameShape, 32),
    new THREE.MeshBasicMaterial({
      color: 0x58626e,
      transparent: true,
      opacity: 0.42,
      depthWrite: false,
      side: THREE.DoubleSide
    })
  );
  frame.position.z = 0;
  group.add(frame);

  // White inner sheen.
  const sheen = new THREE.Mesh(
    new THREE.ShapeGeometry(frameShape, 32),
    new THREE.MeshBasicMaterial({
      color: 0xffffff,
      transparent: true,
      opacity: 0.08,
      depthWrite: false,
      side: THREE.DoubleSide
    })
  );
  sheen.scale.set(0.985, 0.985, 1);
  sheen.position.z = 0.002;
  group.add(sheen);

  // Inset media, matching the Figma 10px glass-frame padding.
  const mediaW = width - 0.036;
  const mediaH = height - 0.036;
  const mediaShape = roundedRectShape(mediaW, mediaH, radius * 0.88);
  const mediaGeo = new THREE.ShapeGeometry(mediaShape, 32);
  const pos = mediaGeo.attributes.position;
  const uv = mediaGeo.attributes.uv;
  for (let i = 0; i < pos.count; i++) {
    uv.setXY(i, pos.getX(i) / mediaW + 0.5, pos.getY(i) / mediaH + 0.5);
  }
  uv.needsUpdate = true;
  const media = new THREE.Mesh(
    mediaGeo,
    new THREE.MeshBasicMaterial({
      map: texture,
      transparent: true,
      side: THREE.DoubleSide,
      depthWrite: false
    })
  );
  media.position.z = 0.006;
  if (action) {
    media.userData.action = action;
    frame.userData.action = action;
    interactables.push(media, frame);
  }
  group.add(media);

  const edge = new THREE.LineLoop(
    new THREE.BufferGeometry().setFromPoints(
      frameShape.getPoints(64).map(pt => new THREE.Vector3(pt.x, pt.y, 0.010))
    ),
    new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.92 })
  );
  group.add(edge);

  stageRoot.add(group);
  return group;
}

function makeMemoryInfoTexture(memory, typeLabel) {
  const c = document.createElement('canvas');
  c.width = 1000;
  c.height = 1240;
  const ctx = c.getContext('2d');
  ctx.clearRect(0, 0, c.width, c.height);

  const left = 82;
  const right = c.width - 82;

  ctx.fillStyle = '#ffffff';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';
  ctx.font = `700 96px ${FONT_SERIF}`;
  const titleLines = wrapText(ctx, memory.title, right - left);
  let y = 86;
  for (const line of titleLines.slice(0, 2)) {
    ctx.fillText(line, left, y);
    y += 102;
  }

  y += 6;
  ctx.font = `500 40px "Inter", ${FONT_SANS}`;
  ctx.fillStyle = 'rgba(255,255,255,0.92)';
  ctx.fillText(typeLabel, left, y);
  y += 74;

  ctx.strokeStyle = 'rgba(255,255,255,0.25)';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(left, y);
  ctx.lineTo(right, y);
  ctx.stroke();
  y += 52;

  ctx.font = `500 48px "Inter", ${FONT_SANS}`;
  ctx.fillStyle = '#ffffff';
  const bodyLines = wrapText(ctx, memory.description, right - left);
  for (const line of bodyLines.slice(0, 10)) {
    ctx.fillText(line, left, y);
    y += 72;
  }

  const texture = new THREE.CanvasTexture(c);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = renderer.capabilities.getMaxAnisotropy();
  texture.needsUpdate = true;
  return texture;
}

function makeGlassInfoCard(memory, typeLabel, position) {
  const group = new THREE.Group();
  group.position.set(...position);
  const width = 0.74;
  const height = 0.92;
  const radius = 0.075;

  const haloShape = roundedRectShape(width * 1.035, height * 1.025, radius * 1.08);
  const halo = new THREE.Mesh(
    new THREE.ShapeGeometry(haloShape, 32),
    new THREE.MeshBasicMaterial({
      color: 0xffffff,
      transparent: true,
      opacity: 0.055,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      side: THREE.DoubleSide
    })
  );
  halo.position.z = -0.006;
  group.add(halo);

  const shape = roundedRectShape(width, height, radius);
  const panel = new THREE.Mesh(
    new THREE.ShapeGeometry(shape, 32),
    new THREE.MeshBasicMaterial({
      color: 0x202731,
      transparent: true,
      opacity: 0.62,
      depthWrite: false,
      side: THREE.DoubleSide
    })
  );
  group.add(panel);

  // Subtle frosted-white veil over the dark glass.
  const veil = new THREE.Mesh(
    new THREE.ShapeGeometry(shape, 32),
    new THREE.MeshBasicMaterial({
      color: 0xffffff,
      transparent: true,
      opacity: 0.055,
      depthWrite: false,
      side: THREE.DoubleSide
    })
  );
  veil.scale.set(0.985, 0.985, 1);
  veil.position.z = 0.002;
  group.add(veil);

  const edge = new THREE.LineLoop(
    new THREE.BufferGeometry().setFromPoints(
      shape.getPoints(64).map(pt => new THREE.Vector3(pt.x, pt.y, 0.006))
    ),
    new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.62 })
  );
  group.add(edge);

  const text = new THREE.Mesh(
    new THREE.PlaneGeometry(width * 0.91, height * 0.91),
    new THREE.MeshBasicMaterial({
      map: makeMemoryInfoTexture(memory, typeLabel),
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide
    })
  );
  text.position.z = 0.010;
  group.add(text);

  stageRoot.add(group);
  return group;
}

function makeFullscreenTextLink(label, position, action) {
  const c = document.createElement('canvas');
  c.width = 1040;
  c.height = 180;
  const ctx = c.getContext('2d');
  ctx.clearRect(0, 0, c.width, c.height);
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = '#ffffff';
  ctx.shadowColor = 'rgba(0,0,0,0.25)';
  ctx.shadowBlur = 10;
  ctx.font = `500 58px "Inter", ${FONT_SANS}`;
  ctx.fillText(label, c.width / 2, c.height / 2);

  const texture = new THREE.CanvasTexture(c);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = renderer.capabilities.getMaxAnisotropy();
  const mesh = makePlane({ width: 0.54, height: 0.094, position, texture, action, opacity: 1 });
  mesh.material.depthWrite = false;
  return mesh;
}

function makeFixedControlButton(label, iconPath, position, action, {
  depth = 0.0052,
  paddingX = CONTROL_PAD_X_PX,
  paddingY = CONTROL_PAD_Y_PX,
  radiusPx = CONTROL_RADIUS_PX
} = {}) {
  const textAsset = makeControlTextTexture(label);
  const heightPx = Math.max(CONTROL_ICON_PX, CONTROL_FONT_PX) + paddingY * 2;
  const widthPx = paddingX * 2 + CONTROL_ICON_PX + CONTROL_GAP_PX + textAsset.widthPx;

  const width = widthPx * CONTROL_M_PER_PX;
  const height = heightPx * CONTROL_M_PER_PX;
  const radius = radiusPx * CONTROL_M_PER_PX;
  const iconSize = CONTROL_ICON_PX * CONTROL_M_PER_PX;
  const gap = CONTROL_GAP_PX * CONTROL_M_PER_PX;
  const textWidth = textAsset.widthPx * CONTROL_M_PER_PX;
  const textHeight = textAsset.heightPx * CONTROL_M_PER_PX;

  const group = new THREE.Group();
  group.position.set(...position);

  const shape = roundedRectShape(width, height, radius);

  // Thin RealityKit-like depth body.
  const bodyGeo = new THREE.ExtrudeGeometry(shape, {
    depth,
    bevelEnabled: true,
    bevelThickness: Math.min(depth * 0.32, 0.0022),
    bevelSize: Math.min(0.0028, radius * 0.18),
    bevelSegments: 4,
    curveSegments: 16
  });
  bodyGeo.translate(0, 0, -depth - 0.0015);
  const body = new THREE.Mesh(bodyGeo, new THREE.MeshPhysicalMaterial({
    color: 0xded6cf,
    transparent: true,
    opacity: 0.18,
    roughness: 0.05,
    metalness: 0,
    transmission: 0.55,
    clearcoat: 1,
    clearcoatRoughness: 0.03,
    side: THREE.DoubleSide,
    depthWrite: false
  }));
  body.userData.action = action;
  interactables.push(body);
  group.add(body);

  // Rounded front face (same shape, no rectangular overlay).
  const face = new THREE.Mesh(new THREE.ShapeGeometry(shape, 16), new THREE.MeshBasicMaterial({
    color: 0xf2ede8,
    transparent: true,
    opacity: 0.16,
    side: THREE.DoubleSide,
    depthWrite: false
  }));
  face.position.z = 0.002;
  face.userData.action = action;
  interactables.push(face);
  group.add(face);

  const gloss = new THREE.Mesh(new THREE.ShapeGeometry(shape, 16), new THREE.MeshBasicMaterial({
    color: 0xffffff,
    transparent: true,
    opacity: 0.08,
    side: THREE.DoubleSide,
    depthWrite: false
  }));
  gloss.position.set(0, 0.002, 0.0034);
  gloss.scale.set(0.985, 0.90, 1);
  gloss.userData.action = action;
  interactables.push(gloss);
  group.add(gloss);

  const contentWidth = iconSize + gap + textWidth;
  const startX = -contentWidth / 2;

  const icon = new THREE.Mesh(
    new THREE.PlaneGeometry(iconSize, iconSize),
    new THREE.MeshBasicMaterial({
      map: cacheTexture(iconPath),
      transparent: true,
      side: THREE.DoubleSide,
      depthWrite: false
    })
  );
  icon.position.set(startX + iconSize / 2, 0, 0.004);
  icon.userData.action = action;
  interactables.push(icon);
  group.add(icon);

  const text = new THREE.Mesh(
    new THREE.PlaneGeometry(textWidth, textHeight),
    new THREE.MeshBasicMaterial({
      map: textAsset.texture,
      transparent: true,
      side: THREE.DoubleSide,
      depthWrite: false
    })
  );
  text.position.set(startX + iconSize + gap + textWidth / 2, 0, 0.0042);
  text.userData.action = action;
  interactables.push(text);
  group.add(text);

  stageRoot.add(group);
  return group;
}

function makeButton(label, position, action, { width = 0.34, height = 0.12, bg = 'rgba(245,250,255,.90)', fg = '#1c334a' } = {}) {
  const mesh = makeRoundedTextureMesh(
    makeButtonTexture(label, { bg, fg }),
    width,
    height,
    Math.min(width, height) * 0.48,
    position,
    action
  );
  mesh.renderOrder = 6;
  return mesh;
}

function makeImageCard(memory, layout) {
  const group = new THREE.Group();
  group.position.set(...layout.position);
  group.userData.action = () => openMemory(memory);

  // Each memory owns its own island, matching Swift addMemoryIslands().
  if (islandModel) {
    const island = centeredScaledClone(islandModel, layout.islandSize);
    applySwiftIslandOrientation(island, layout.yaw || 0);
    island.position.set(0, 0, 0);
    group.add(island);
  }

  if (memory.type === 'object' && jungfrauModel) {
    // Real USDZ object, planted into the island rather than shown as a flat card.
    const object = centeredScaledClone(jungfrauModel, layout.objectSize || 0.145);
    object.position.set(0, layout.cardY || 0.07, 0.045);
    object.rotation.y = -0.12;
    group.add(object);
  } else {
    let preview;
    if (memory.type === 'photo') preview = cacheTexture(memory.asset);
    else if (memory.type === 'video') preview = makeVideoPreviewTexture(memory.asset);
    else preview = cacheTexture('./assets/images/jungfrau-reflection.png');

    const card = new THREE.Mesh(
      new THREE.PlaneGeometry(layout.cardW || 0.18, layout.cardH || 0.13),
      new THREE.MeshBasicMaterial({
        map: preview,
        transparent: true,
        side: THREE.DoubleSide,
        depthWrite: false
      })
    );
    card.position.set(0, layout.cardY || 0.08, 0.055);
    group.add(card);
  }

  // No memory-name label on the open island view: this matches the Swift attachment.
  group.traverse(o => {
    o.userData.action = group.userData.action;
    if (o.isMesh) interactables.push(o);
  });
  stageRoot.add(group);
  return group;
}

function setIsleBackground(kind = 'heaven') {
  const path = kind === 'voice' ? './assets/images/island.jpg' : './assets/images/sky.jpg';

  if (panoramaSphere?.parent) panoramaSphere.parent.remove(panoramaSphere);
  panoramaSphere?.geometry?.dispose?.();
  panoramaSphere?.material?.dispose?.();
  panoramaTexture?.dispose?.();

  // Clone the cached source so each isle has an independent draggable UV offset.
  // The panorama itself moves; camera, controls, panels, orbs and portals remain front-facing.
  const texture = cacheTexture(path).clone();
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.ClampToEdgeWrapping;
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.offset.set(0, 0);
  texture.needsUpdate = true;
  panoramaTexture = texture;

  const radius = kind === 'voice' ? 19.8 : 20.0;
  const material = new THREE.MeshBasicMaterial({
    map: texture,
    side: THREE.BackSide,
    color: kind === 'voice' ? 0xcccccc : 0xffffff,
    depthWrite: false,
    depthTest: false,
    toneMapped: false
  });
  panoramaSphere = new THREE.Mesh(
    new THREE.SphereGeometry(radius, 96, 64),
    material
  );
  panoramaSphere.renderOrder = -1000;
  panoramaBaseYaw = kind === 'voice' ? -Math.PI / 2 : Math.PI;
  panoramaYaw = 0;
  panoramaPitch = 0;
  panoramaSphere.rotation.order = 'YXZ';
  panoramaSphere.rotation.set(0, panoramaBaseYaw, 0);
  if (panoramaTexture) panoramaTexture.offset.set(0, 0);
  resetDesktopOrbit();
  worldRoot.add(panoramaSphere);

  scene.background = new THREE.Color(kind === 'voice' ? 0x183d55 : 0x92bde5);
}

function makeStageIntroTexture(title, subtitle) {
  const c = document.createElement('canvas');
  c.width = 1200;
  c.height = 300;
  const ctx = c.getContext('2d');
  ctx.clearRect(0, 0, c.width, c.height);
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = '#ffffff';
  ctx.shadowColor = 'rgba(0,0,0,0.34)';
  ctx.shadowBlur = 24;
  ctx.shadowOffsetX = 0;
  ctx.shadowOffsetY = 2;

  ctx.font = '700 76px "Playfair Display", Georgia, serif';
  ctx.fillText(title, c.width / 2, 108);

  ctx.shadowBlur = 18;
  ctx.font = '500 36px "Inter", -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
  ctx.fillText(subtitle, c.width / 2, 205);

  const texture = new THREE.CanvasTexture(c);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = renderer.capabilities.getMaxAnisotropy();
  texture.needsUpdate = true;
  return texture;
}

function makeTransientStageIntro(title, subtitle, position, remainingMs) {
  if (remainingMs <= 0) return null;
  const intro = makePlane({
    width: 0.82,
    height: 0.205,
    position,
    texture: makeStageIntroTexture(title, subtitle),
    opacity: 1
  });
  // Render caption above spatial objects without adding a panel/background.
  intro.material.depthWrite = false;
  intro.renderOrder = 20;

  const fadeMs = Math.min(INTRO_FADE_MS, remainingMs);
  const holdMs = Math.max(0, remainingMs - fadeMs);
  animated.push({
    type: 'stageIntro',
    object: intro,
    startedAt: clock.getElapsedTime(),
    hold: holdMs / 1000,
    fade: Math.max(0.001, fadeMs / 1000)
  });
  return intro;
}

function makeVoiceLabelTexture(text, fontPx, designWidthPx, designHeightPx) {
  const scale = 3;
  const c = document.createElement('canvas');
  c.width = Math.max(2, Math.round(designWidthPx * scale));
  c.height = Math.max(2, Math.round(designHeightPx * scale));
  const ctx = c.getContext('2d');
  ctx.clearRect(0, 0, c.width, c.height);
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = '#ffffff';
  ctx.shadowColor = 'rgba(0,0,0,0.28)';
  ctx.shadowBlur = 8 * scale;
  ctx.font = `700 ${fontPx * scale}px "Inter", -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif`;

  const lines = String(text).split('\n');
  const lineHeight = fontPx * 1.10 * scale;
  const startY = c.height / 2 - ((lines.length - 1) * lineHeight) / 2;
  lines.forEach((line, i) => ctx.fillText(line, c.width / 2, startY + i * lineHeight));

  const texture = new THREE.CanvasTexture(c);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = renderer.capabilities.getMaxAnisotropy();
  texture.needsUpdate = true;
  return texture;
}


function makeVideoPreviewTexture(path) {
  const key = `preview:${path}`;
  if (cachedTextures.has(key)) return cachedTextures.get(key);

  const c = document.createElement('canvas');
  c.width = 960;
  c.height = 720;
  const ctx = c.getContext('2d');

  const drawFallback = () => {
    const g = ctx.createLinearGradient(0, 0, c.width, c.height);
    g.addColorStop(0, '#c8ddf1');
    g.addColorStop(1, '#8fb4d5');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, c.width, c.height);
  };

  const drawPlayBadge = () => {
    const r = 54;
    ctx.save();
    ctx.fillStyle = 'rgba(255,255,255,.90)';
    ctx.beginPath();
    ctx.arc(c.width / 2, c.height / 2, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#456987';
    ctx.beginPath();
    ctx.moveTo(c.width / 2 - 12, c.height / 2 - 23);
    ctx.lineTo(c.width / 2 - 12, c.height / 2 + 23);
    ctx.lineTo(c.width / 2 + 28, c.height / 2);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  };

  drawFallback();
  drawPlayBadge();

  const texture = new THREE.CanvasTexture(c);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;
  cachedTextures.set(key, texture);

  // Extract a real frame from the local MP4 and update this same texture.
  // This keeps the home card synchronous while the thumbnail loads asynchronously.
  const video = document.createElement('video');
  video.src = path;
  video.muted = true;
  video.defaultMuted = true;
  video.playsInline = true;
  video.preload = 'auto';
  video.crossOrigin = 'anonymous';
  video.setAttribute('playsinline', '');
  video.setAttribute('webkit-playsinline', '');

  const drawVideoFrame = () => {
    if (!video.videoWidth || !video.videoHeight) return;

    const srcAspect = video.videoWidth / video.videoHeight;
    const dstAspect = c.width / c.height;
    let sx = 0, sy = 0, sw = video.videoWidth, sh = video.videoHeight;

    // Cover-crop so portrait and landscape clips both fill the memory card cleanly.
    if (srcAspect > dstAspect) {
      sw = video.videoHeight * dstAspect;
      sx = (video.videoWidth - sw) / 2;
    } else {
      sh = video.videoWidth / dstAspect;
      sy = (video.videoHeight - sh) / 2;
    }

    ctx.clearRect(0, 0, c.width, c.height);
    ctx.drawImage(video, sx, sy, sw, sh, 0, 0, c.width, c.height);
    // Slight dark veil keeps the white play badge visible over bright footage.
    ctx.fillStyle = 'rgba(0,0,0,.06)';
    ctx.fillRect(0, 0, c.width, c.height);
    drawPlayBadge();
    texture.needsUpdate = true;
  };

  video.addEventListener('loadedmetadata', () => {
    const duration = Number.isFinite(video.duration) ? video.duration : 0;
    const previewTime = duration > 0.5 ? Math.min(Math.max(duration * 0.12, 0.25), duration - 0.15) : 0;
    try {
      video.currentTime = previewTime;
    } catch (_) {
      drawVideoFrame();
    }
  }, { once: true });

  video.addEventListener('seeked', drawVideoFrame, { once: true });
  video.addEventListener('loadeddata', () => {
    // Some browsers expose the first decoded frame before a seek completes.
    if (video.currentTime === 0) drawVideoFrame();
  }, { once: true });

  video.addEventListener('error', () => {
    // Keep the fallback instead of leaving a blank/black card.
    texture.needsUpdate = true;
  }, { once: true });

  video.load();
  return texture;
}

function makeOrb(voice, position, index) {
  // VoiceIsleView.swift uses a flat radial-gradient Circle (Voice.svg), not a 3D sphere.
  const group = new THREE.Group();
  group.position.set(...position);
  const pxToM = 0.00110;
  const orbSize = voice.orbPx * pxToM;
  const displayLabel = voice.label || voice.title;
  const designLabelWidth = voice.labelWidthPx || Math.max(voice.orbPx + 50, 230);
  const lineCount = String(displayLabel).split('\n').length;
  const designLabelHeight = Math.max(voice.titlePx * 1.35 * lineCount, voice.titlePx * 1.45);
  const labelWidth = designLabelWidth * pxToM;
  const labelHeight = designLabelHeight * pxToM;
  const gap = 29 * pxToM;

  const orb = new THREE.Mesh(
    new THREE.PlaneGeometry(orbSize, orbSize),
    new THREE.MeshBasicMaterial({
      map: cacheTexture('./assets/icons/voice.svg'),
      transparent: true,
      side: THREE.DoubleSide,
      depthWrite: false
    })
  );
  orb.position.set(0, 0, 0);
  group.add(orb);

  const label = new THREE.Mesh(
    new THREE.PlaneGeometry(labelWidth, labelHeight),
    new THREE.MeshBasicMaterial({
      map: makeVoiceLabelTexture(displayLabel, voice.titlePx, designLabelWidth, designLabelHeight),
      transparent: true,
      side: THREE.DoubleSide,
      depthWrite: false
    })
  );
  label.position.set(0, -(orbSize / 2 + gap + labelHeight / 2), 0.002);
  group.add(label);

  const action = () => openVoice(voice);
  group.userData.action = action;
  [orb, label].forEach(mesh => {
    mesh.userData.action = action;
    interactables.push(mesh);
  });
  stageRoot.add(group);
  return group;
}

function makePortal(label, position, action, hue = 0x92c8ff) {
  const group = new THREE.Group();
  group.position.set(...position);

  const asset = label === 'Heaven Isle'
    ? './assets/icons/heaven-portal.svg'
    : './assets/icons/voice-portal.svg';

  const width = 0.245;
  const height = width * (425 / 350);
  const portal = new THREE.Mesh(
    new THREE.PlaneGeometry(width, height),
    new THREE.MeshBasicMaterial({
      map: cacheTexture(asset),
      transparent: true,
      side: THREE.DoubleSide,
      depthWrite: false
    })
  );
  portal.userData.action = action;
  interactables.push(portal);
  group.add(portal);

  // Swift IslePortalView has a gentle float/breathe animation.
  animated.push({ type: 'portalFloat', object: group, baseY: position[1], amp: 0.010, speed: 0.31, phase: 0 });
  stageRoot.add(group);
  return group;
}

function makeBack() { return makeFixedControlButton('Back', './assets/icons/icon_back.svg', [0.86, 2.00, -0.92], goBack, { depth: 0.0076 }); }
function makeExit() { return makeFixedControlButton('Exit Island', './assets/icons/icon_exit.svg', [0.86, 2.00, -0.92], openExitPrompt); }


function tutorialScaledRect(rect) {
  const cx = TUTORIAL_FRAME_PX.width / 2;
  const cy = TUTORIAL_FRAME_PX.height / 2;
  return {
    x: cx + (rect.x - cx) * TUTORIAL_SCALE,
    y: cy + (rect.y - cy) * TUTORIAL_SCALE,
    w: rect.w * TUTORIAL_SCALE,
    h: rect.h * TUTORIAL_SCALE
  };
}

function drawText(ctx, text, x, y, {
  size, weight = 400, family = 'sans', color = '#000', align = 'left',
  italic = false, lineHeight = 1.2
}) {
  ctx.save();
  ctx.font = fontString({ size, weight, family, italic });
  ctx.fillStyle = color;
  ctx.textAlign = align;
  ctx.textBaseline = 'top';
  const lines = String(text).split('\n');
  lines.forEach((line, i) => ctx.fillText(line, x, y + i * size * lineHeight));
  ctx.restore();
}

function drawGlassPanel(ctx, x, y, w, h, radius = 50) {
  ctx.save();
  // Swift: ultraThinMaterial + warm 243/240/237 @ 0.60 + subtle white strokes/shadow.
  ctx.shadowColor = 'rgba(255,255,255,0.20)';
  ctx.shadowBlur = 50;
  ctx.fillStyle = 'rgba(243,240,237,0.78)';
  roundedRect(ctx, x, y, w, h, radius);
  ctx.fill();
  ctx.shadowBlur = 0;
  ctx.strokeStyle = 'rgba(255,255,255,0.25)';
  ctx.lineWidth = 10;
  roundedRect(ctx, x, y, w, h, radius);
  ctx.stroke();
  ctx.strokeStyle = 'rgba(255,255,255,0.12)';
  ctx.lineWidth = 0.5;
  roundedRect(ctx, x, y, w, h, radius);
  ctx.stroke();
  ctx.restore();
}

function drawCapsule(ctx, x, y, w, h, { fill, text, textColor }) {
  ctx.save();
  ctx.fillStyle = fill;
  roundedRect(ctx, x, y, w, h, h / 2);
  ctx.fill();

  // Swift GradientActionButton / SecondaryActionButton:
  // Text is centered inside a fixed 68pt-high frame.
  ctx.font = fontString({ size: 24, weight: 700, family: 'sans' });
  ctx.fillStyle = textColor;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, x + w / 2, y + h / 2);
  ctx.restore();
}

function drawTutorialImage(ctx, key, x, y, w, h) {
  const img = tutorialAssets.get(key);
  if (!img) return;
  ctx.drawImage(img, x, y, w, h);
}

function createTutorialCanvas(step) {
  const c = document.createElement('canvas');
  c.width = TUTORIAL_FRAME_PX.width;
  c.height = TUTORIAL_FRAME_PX.height;
  const ctx = c.getContext('2d');
  ctx.clearRect(0, 0, c.width, c.height);
  const hits = [];

  // Mirrors TutorialFlowView.currentStepView.scaleEffect(1.08).
  ctx.save();
  ctx.translate(c.width / 2, c.height / 2);
  ctx.scale(TUTORIAL_SCALE, TUTORIAL_SCALE);
  ctx.translate(-c.width / 2, -c.height / 2);

  if (step === 'islandName') {
    drawText(ctx, 'Heaven Isle', 960, 540 - 55, {
      size: 82, weight: 600, family: 'serif', color: '#ffffff', align: 'center', lineHeight: 1
    });
  }

  if (step === 'welcome') {
    const panelW = 720;
    const panelH = 434;
    const x = (1920 - panelW) / 2;
    const y = (1080 - panelH) / 2;
    drawGlassPanel(ctx, x, y, panelW, panelH, 50);
    const left = x + 60;
    let cy = y + 68;
    drawText(ctx, 'Welcome to Heaven Isle', left, cy, {
      size: 50, weight: 700, family: 'serif', color: '#000000'
    });
    cy += 60 + 20;
    drawText(ctx,
      'Look at a memory, then pinch to open it.\nFollow the portals to explore different parts\nof your island.',
      left, cy,
      { size: 22, weight: 500, family: 'sans', color: '#7A736C', lineHeight: 1.36 }
    );
    cy += 90 + 60;
    const totalButtonsW = 220 + 16 + 220;
    const bx = x + (panelW - totalButtonsW) / 2;
    drawCapsule(ctx, bx, cy, 220, 68, {
      fill: '#EDE7DF', text: 'Start Tutorial', textColor: '#8C8279'
    });
    drawCapsule(ctx, bx + 236, cy, 220, 68, {
      fill: 'rgba(255,255,255,0.20)', text: 'Start Exploring', textColor: '#434343'
    });
    hits.push({ ...tutorialScaledRect({ x: bx, y: cy, w: 220, h: 68 }), action: () => { tutorialIndex = 3; renderTutorial(); } });
    hits.push({ ...tutorialScaledRect({ x: bx + 236, y: cy, w: 220, h: 68 }), action: () => renderHeaven(true) });
  }

  if (step === 'gestures') {
    // Swift source: FigmaPopupContainer(width: 1320, horizontalPadding: 80),
    // HStack spacing 69, each GestureGuide fixed to 400pt height.
    // Final Figma reference node 832:8280 places the rendered panel at 1321×846.
    const panelW = 1321;
    const panelH = 846;
    const x = (1920 - panelW) / 2;
    const y = (1080 - panelH) / 2;
    drawGlassPanel(ctx, x, y, panelW, panelH, 50);

    // Exact Figma/Swift header positions.
    const left = x + 80;
    drawText(ctx, 'Tutorial', left, y + 68, {
      size: 50, weight: 700, family: 'serif', color: '#000'
    });
    drawText(ctx, 'Here are a few gestures to get you started.', left, y + 155, {
      size: 24, weight: 500, family: 'sans', color: '#7A736C'
    });

    // Gesture row: 3 × 341pt columns, 69pt gaps, 400pt height.
    const rowY = y + 249;
    const cols = [
      {
        x: left,
        title: 'Gaze',
        desc: 'Look at an item\nto bring it into focus.',
        asset: 'gaze',
        // The exported Gaze SVG intentionally overhangs its 341×287 Figma frame.
        imageX: 0, imageY: 95, imageW: 370, imageH: 305
      },
      {
        x: left + 410,
        title: 'Pinch',
        desc: 'Bring your thumb and index finger together\nto select or open it.',
        asset: 'pinch',
        imageX: 0, imageY: 113, imageW: 341, imageH: 287
      },
      {
        x: left + 820,
        title: 'Zoom',
        desc: 'Pinch with both hands,\nthen move them apart to zoom in.',
        asset: 'zoom',
        imageX: 0, imageY: 113, imageW: 341, imageH: 287
      }
    ];

    cols.forEach((item) => {
      const cx = item.x + 341 / 2;
      drawText(ctx, item.title, cx, rowY, {
        size: 30, weight: 500, family: 'sans', color: '#000', align: 'center'
      });
      drawText(ctx, item.desc, cx, rowY + 50, {
        size: 16, weight: 400, family: 'sans', color: '#434343',
        align: 'center', italic: true, lineHeight: 1.4
      });
      drawTutorialImage(
        ctx,
        item.asset,
        item.x + item.imageX,
        rowY + item.imageY,
        item.imageW,
        item.imageH
      );
    });

    // Figma node 832:8338: x 510.5, y 709, 300×69 within the panel.
    const bx = x + 510.5;
    const by = y + 709;
    drawCapsule(ctx, bx, by, 300, 69, {
      fill: '#EDE7DF', text: 'Next', textColor: '#8C8279'
    });
    hits.push({
      ...tutorialScaledRect({ x: bx, y: by, w: 300, h: 69 }),
      action: () => { tutorialIndex = 4; renderTutorial(); }
    });
  }

  const tutorialCards = {
    catchMemory: {
      panelW: 760, panelH: 752, padX: 70,
      heading: '1. Catch a memory', desc: 'Look at a memory, then pinch to open it.',
      image: 'tutorial-1', imageW: 356.636, imageH: 320, beforeImage: 40, afterImage: 40, button: 'Next'
    },
    comfortThings: {
      panelW: 790, panelH: 743, padX: 65,
      heading: '2. Explore your comfort things', desc: 'Open photos, videos and familiar voices.',
      image: 'tutorial-2', imageW: 622, imageH: 311, beforeImage: 40, afterImage: 40, button: 'Next'
    },
    customiseIsland: {
      panelW: 760, panelH: 807, padX: 70,
      heading: '3. Make the island yours', desc: 'Use the menu to add or remove comfort items\nand adjust the atmosphere.',
      image: 'tutorial-3', imageW: 469, imageH: 380, beforeImage: 40, afterImage: 40, button: 'Next'
    },
    portal: {
      panelW: 760, panelH: 822, padX: 70,
      heading: '4. Travel between islands', desc: 'Pinch a portal to move between spaces.',
      image: 'tutorial-4', imageW: 307, imageH: 372, beforeImage: 54, afterImage: 44, button: 'Enter Heaven Isle'
    }
  };

  if (tutorialCards[step]) {
    const cfg = tutorialCards[step];
    const x = (1920 - cfg.panelW) / 2;
    const y = (1080 - cfg.panelH) / 2;
    drawGlassPanel(ctx, x, y, cfg.panelW, cfg.panelH, 50);
    const left = x + cfg.padX;
    let cy = y + 68;
    drawText(ctx, 'Tutorial', left, cy, { size: 50, weight: 700, family: 'serif', color: '#000' });
    cy += 60 + 20;
    drawText(ctx, cfg.heading, left, cy, { size: 30, weight: 500, family: 'sans', color: '#000' });
    cy += 36 + 8;
    drawText(ctx, cfg.desc, left, cy, { size: 20, weight: 400, family: 'sans', color: '#434343', lineHeight: 1.2 });
    const descLines = cfg.desc.split('\n').length;
    cy += descLines * 24 + cfg.beforeImage;
    const ix = x + (cfg.panelW - cfg.imageW) / 2;
    drawTutorialImage(ctx, cfg.image, ix, cy, cfg.imageW, cfg.imageH);
    cy += cfg.imageH + cfg.afterImage;
    const bx = x + (cfg.panelW - 300) / 2;
    drawCapsule(ctx, bx, cy, 300, 68, { fill: '#EDE7DF', text: cfg.button, textColor: '#8C8279' });
    const nextAction = step === 'portal'
      ? () => renderHeaven(true)
      : () => { tutorialIndex += 1; renderTutorial(); };
    hits.push({ ...tutorialScaledRect({ x: bx, y: cy, w: 300, h: 68 }), action: nextAction });
  }

  ctx.restore();
  const texture = new THREE.CanvasTexture(c);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = renderer.capabilities.getMaxAnisotropy();
  return { texture, hits };
}

function addTutorialHitArea(rect) {
  const px = rect.x + rect.w / 2;
  const py = rect.y + rect.h / 2;
  const x = TUTORIAL_CENTER[0] + (px / TUTORIAL_FRAME_PX.width - 0.5) * TUTORIAL_FRAME_M.width;
  const y = TUTORIAL_CENTER[1] + (0.5 - py / TUTORIAL_FRAME_PX.height) * TUTORIAL_FRAME_M.height;
  const w = rect.w / TUTORIAL_FRAME_PX.width * TUTORIAL_FRAME_M.width;
  const h = rect.h / TUTORIAL_FRAME_PX.height * TUTORIAL_FRAME_M.height;
  const hit = new THREE.Mesh(
    new THREE.PlaneGeometry(w, h),
    new THREE.MeshBasicMaterial({ transparent: true, opacity: 0, depthWrite: false, side: THREE.DoubleSide })
  );
  hit.position.set(x, y, TUTORIAL_CENTER[2] + 0.006);
  hit.userData.action = rect.action;
  interactables.push(hit);
  stageRoot.add(hit);
}

function addTutorialBack() {
  if (tutorialIndex < 3) return;
  makeFixedControlButton('Back', './assets/icons/icon_back.svg', [0.86, 2.00, -0.92], () => {
    if (tutorialIndex === 3) tutorialIndex = 2;
    else tutorialIndex -= 1;
    renderTutorial();
  }, { depth: 0.0076 });
}

function applyTutorialEntrance(object) {
  object.scale.setScalar(0.97);
  const mats = [];
  object.traverse(o => {
    if (o.material) {
      const materialList = Array.isArray(o.material) ? o.material : [o.material];
      materialList.forEach(m => { m.transparent = true; m.opacity = 0; mats.push(m); });
    }
  });
  animated.push({ type: 'tutorialEnter', object, mats, startedAt: clock.getElapsedTime(), duration: 0.55 });
}

function renderTutorial() {
  clearStage();
  currentStage = 'tutorial';
  const step = TUTORIAL_STEPS[tutorialIndex] || 'intro';
  setStatus(step === 'intro' ? 'Opening' : step === 'islandName' ? 'Heaven Isle' : `Tutorial ${tutorialIndex + 1}/8`);

  // Swift introView: Image("Isle Logo").scaledToFit().frame(width: 300, height: 150), then scaleEffect(1.08).
  if (step === 'intro') {
    const logo = makePlane({
      width: .300 * TUTORIAL_SCALE,
      height: .140 * TUTORIAL_SCALE,
      position: TUTORIAL_CENTER,
      texture: cacheTexture('./assets/icons/isle-logo.svg')
    });
    applyTutorialEntrance(logo);
    tutorialTimer = setTimeout(() => { tutorialIndex = 1; renderTutorial(); }, 1300);
    return;
  }

  const { texture, hits } = createTutorialCanvas(step);
  const plane = new THREE.Mesh(
    new THREE.PlaneGeometry(TUTORIAL_FRAME_M.width, TUTORIAL_FRAME_M.height),
    new THREE.MeshBasicMaterial({ map: texture, transparent: true, depthWrite: false, side: THREE.DoubleSide })
  );
  plane.position.set(...TUTORIAL_CENTER);
  // Use the visible tutorial plane itself for hit testing.
  // This keeps the click/pinch target pixel-perfect with the rendered button
  // and prevents Start Tutorial from accidentally triggering Start Exploring.
  if (hits.length) {
    plane.userData.tutorialHits = hits;
    interactables.push(plane);
  }
  stageRoot.add(plane);
  applyTutorialEntrance(plane);
  addTutorialBack();

  if (step === 'islandName') {
    tutorialTimer = setTimeout(() => { tutorialIndex = 2; renderTutorial(); }, 1500);
  }
}

function renderHeaven(showMessage = false) {
  if (showMessage) heavenIntroUntil = performance.now() + INTRO_HOLD_MS + INTRO_FADE_MS;
  clearStage();
  currentStage = 'heaven';
  resetDesktopOrbit();
  setDesktopOrbitEnabled(true);
  randomMode = false;
  setIsleBackground('heaven');
  setStatus('Heaven Isle · Memory Catch');

  // Six memory-island clusters, each with its own position and scale from Swift/Figma.
  MEMORY.forEach((memory) => {
    const layout = MEMORY_LAYOUT[memory.id];
    if (layout) makeImageCard(memory, layout);
  });

  // Floating notes use the original Swift paper layout and varied sizes.
  NOTE_LAYOUT.forEach((cfg, i) => {
    const plane = makePlane({
      width: cfg.width,
      height: cfg.height,
      position: cfg.position,
      texture: cacheTexture(`./assets/images/note-${i + 1}.png`),
      action: () => openNote(i + 1),
      opacity: 1
    });
    plane.rotation.z = cfg.rotation;
    animated.push({
      type: 'float',
      object: plane,
      amp: cfg.amp,
      speed: cfg.speed,
      phase: i * 0.9,
      baseY: cfg.position[1]
    });
  });

  // The old giant centre island is intentionally removed. The Voice Isle portal occupies the lower centre.
  makePortal('Voice Isle', [0.00, 1.13, -1.05], () => renderVoiceIsle(true), 0xffb88f);

  makeFixedControlButton('Surprise Me!', './assets/icons/icon_surprise.svg', [-0.86, 1.20, -0.92], renderRandomMode);
  makeExit();
  makeFixedControlButton('settings', './assets/icons/icon_setting.svg', [-0.86, 2.00, -0.92], () => showToast('Settings are not connected in this web prototype yet.'));

  const heavenIntroRemaining = heavenIntroUntil - performance.now();
  if (heavenIntroRemaining > 0) {
    makeTransientStageIntro(
      'Memory Catch',
      'Pinch a memory to revisit a familiar moment.',
      [0, 1.60, -0.91],
      heavenIntroRemaining
    );
  }
}

function renderRandomMode() {
  clearStage();
  currentStage = 'heaven';
  randomMode = true;
  setStatus('Heaven Isle · Surprise Me');

  randomMemories = [...MEMORY].sort(() => Math.random() - .5);
  const slots = [1, 2, 3, 4, 6, 5];

  slots.forEach((memoryId, i) => {
    const layout = MEMORY_LAYOUT[memoryId];
    if (!layout) return;

    // Keep the same six island centres as normal mode, as in Swift.
    if (islandModel) {
      const island = centeredScaledClone(islandModel, layout.islandSize);
      island.position.set(...layout.position);
      applySwiftIslandOrientation(island, layout.yaw || 0);
      stageRoot.add(island);
    }

    const r = [0.085, 0.105, 0.065, 0.095, 0.070, 0.060][i];
    const bubble = new THREE.Mesh(
      new THREE.SphereGeometry(r, 36, 20),
      new THREE.MeshPhysicalMaterial({
        color: 0xe7f6ff,
        transparent: true,
        opacity: .38,
        roughness: .05,
        transmission: .35,
        clearcoat: 1,
        emissive: 0x7db7df,
        emissiveIntensity: .12
      })
    );
    bubble.position.set(
      layout.position[0],
      layout.position[1] + (layout.cardY || 0.08),
      layout.position[2] + 0.055
    );
    bubble.userData.action = () => openMemory(randomMemories[i]);
    interactables.push(bubble);
    stageRoot.add(bubble);
    animated.push({
      type: 'float',
      object: bubble,
      amp: .012,
      speed: .34 + i * .015,
      phase: i * .7,
      baseY: bubble.position.y
    });
  });

  makeFixedControlButton('Normal Mode', './assets/icons/icon_normal.svg', [-0.86, 1.20, -0.92], () => renderHeaven(false));
  makeExit();
}

function addIslandToStage() {
  if (islandModel) {
    const clone = centeredScaledClone(islandModel, 1.15);
    clone.position.set(0, .93 + HOME_Y_OFFSET, -2.55);
    clone.rotation.y = Math.PI;
    stageRoot.add(clone);
  } else {
    const fallback = makePlane({ width:1.20,height:.53,position:[0,.95 + HOME_Y_OFFSET,-2.62],texture:cacheTexture('./assets/images/island.jpg'),opacity:.98 });
    fallback.rotation.x = -.06;
  }
}

function setCinemaBlackout(enabled) {
  if (panoramaSphere) panoramaSphere.visible = !enabled;
  scene.background = new THREE.Color(enabled ? 0x000000 : 0x92bde5);
}

function openMemory(memory) {
  selectedMemory = memory;
  if (memory.type === 'photo') renderPhotoDetail(memory);
  else if (memory.type === 'video') renderVideoDetail(memory);
  else renderObjectDetail(memory);
}

function renderPhotoDetail(memory) {
  clearStage();
  currentStage = 'photoDetail';
  resetDesktopOrbit();
  setDesktopOrbitEnabled(false);
  setStatus(memory.title);
  makeBack();
  setCinemaBlackout(false);

  makeGlassMediaCard(cacheTexture(memory.asset), [-0.50, 1.60, -1.72], () => renderPhotoCinema(memory));
  makeGlassInfoCard(memory, 'Photo memory', [0.59, 1.60, -1.72]);
  makeFullscreenTextLink('View Full Screen', [-0.50, 1.055, -1.64], () => renderPhotoCinema(memory));
}

function renderPhotoCinema(memory) {
  clearStage();
  currentStage = 'photoCinema';
  resetDesktopOrbit();
  setDesktopOrbitEnabled(true);
  setStatus(`${memory.title} · Cinema`);
  makeBack();
  setCinemaBlackout(true);

  // Near-camera cinema layer: fills almost the entire browser height while
  // preserving the original 4:3 photo aspect ratio. Back stays in front.
  const backdrop = new THREE.Mesh(
    new THREE.PlaneGeometry(2.18, 1.22),
    new THREE.MeshBasicMaterial({ color: 0x030405, transparent: true, opacity: 0.98 })
  );
  backdrop.position.set(0, 1.60, -1.10);
  stageRoot.add(backdrop);

  makePlane({
    width: 1.40,
    height: 1.05,
    position: [0, 1.60, -1.04],
    texture: cacheTexture(memory.asset)
  });
}

function createVideo(path, loop = true) {
  const video = document.createElement('video');
  video.src = path;
  video.loop = loop;
  video.muted = false;
  video.defaultMuted = false;
  video.volume = 1;
  video.playsInline = true;
  video.preload = 'auto';
  video.setAttribute('playsinline', '');
  video.setAttribute('webkit-playsinline', '');
  video.load();
  activeMedia.add(video);
  return video;
}

async function startVideoPlayback(video) {
  try {
    video.muted = false;
    video.volume = 1;
    await video.play();
    return true;
  } catch (_) {
    // Some browsers can still block audio playback even when the screen was
    // opened from a spatial click. Keep the visual playback working and let
    // the next click on the video restore sound.
    try {
      video.muted = true;
      await video.play();
      showToast('Video is playing. Click once for sound.');
      return true;
    } catch (_) {
      showToast('Click the video to play.');
      return false;
    }
  }
}

function toggleVideoPlayback(video) {
  if (video.muted) {
    video.muted = false;
    video.volume = 1;
    if (video.paused) startVideoPlayback(video);
    return;
  }
  if (video.paused) startVideoPlayback(video);
  else video.pause();
}

function renderVideoDetail(memory) {
  clearStage();
  currentStage = 'videoDetail';
  resetDesktopOrbit();
  setDesktopOrbitEnabled(false);
  setStatus(memory.title);
  makeBack();
  setCinemaBlackout(false);

  makeGlassMediaCard(makeVideoPreviewTexture(memory.asset), [-0.50, 1.60, -1.72], () => renderVideoCinema(memory));
  makeGlassInfoCard(memory, 'Video memory', [0.59, 1.60, -1.72]);
  makeFullscreenTextLink('View Full Screen', [-0.50, 1.055, -1.64], () => renderVideoCinema(memory));
}

function renderVideoCinema(memory) {
  clearStage();
  currentStage = 'videoCinema';
  resetDesktopOrbit();
  setDesktopOrbitEnabled(true);
  setStatus(`${memory.title} · Cinema`);
  makeBack();
  setCinemaBlackout(true);

  const video = createVideo(memory.asset);
  const texture = new THREE.VideoTexture(video);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.generateMipmaps = false;

  // Both source MP4s are 16:9 files containing portrait footage with baked-in
  // black side bars. Crop those bars so the actual memory fills the screen height.
  let cropX = 0.625;
  if (memory.asset.includes('paris.mp4')) cropX = 0.392;
  if (memory.asset.includes('parents.mp4')) cropX = 0.625;
  texture.wrapS = THREE.ClampToEdgeWrapping;
  texture.repeat.set(cropX, 1);
  texture.offset.set((1 - cropX) / 2, 0);
  texture.needsUpdate = true;

  const contentAspect = (16 / 9) * cropX;
  const mediaHeight = 1.06;
  const mediaWidth = mediaHeight * contentAspect;

  const backdrop = new THREE.Mesh(
    new THREE.PlaneGeometry(2.18, 1.22),
    new THREE.MeshBasicMaterial({ color: 0x030405, transparent: true, opacity: 0.98 })
  );
  backdrop.position.set(0, 1.60, -1.10);
  stageRoot.add(backdrop);

  makePlane({
    width: mediaWidth,
    height: mediaHeight,
    position: [0, 1.60, -1.04],
    texture,
    action: () => toggleVideoPlayback(video)
  });

  startVideoPlayback(video);
}

function renderObjectDetail(memory) {
  clearStage(); currentStage = 'objectDetail';
  resetDesktopOrbit();
  setDesktopOrbitEnabled(false);
  setStatus(memory.title); makeBack();
  addObjectInspectLights([-0.44, 1.48, -2.20]);
  if (jungfrauModel) {
    const model = centeredScaledClone(jungfrauModel, .48); model.position.set(-.44,1.48,-2.20); model.rotation.set(.08,-.25,0); brightenModelMaterials(model); stageRoot.add(model);
    model.traverse(o => { if (o.isMesh) { o.userData.action = () => renderObjectExpanded(memory); interactables.push(o); } });
  } else makePlane({width:.62,height:.46,position:[-.44,1.55,-2.15],texture:cacheTexture('./assets/images/jungfrau-reflection.png'),action:() => renderObjectExpanded(memory)});
  makeTextPanel({ width:.80,height:.72,position:[.46,1.57,-2.18],canvas:{width:950,height:900,title:memory.title,body:memory.description,titleSize:54,bodySize:29,bg:'rgba(248,251,255,.91)',align:'left'} });
  makeButton('View Larger', [.46,1.10,-2.00], () => renderObjectExpanded(memory), { width:.40 });
}

function renderObjectExpanded(memory) {
  clearStage(); currentStage = 'objectExpanded';
  resetDesktopOrbit();
  setDesktopOrbitEnabled(false);
  setStatus(`${memory.title} · 3D`); makeBack();
  addObjectInspectLights([0, 1.50, -1.92]);
  if (jungfrauModel) {
    const model = centeredScaledClone(jungfrauModel, .82); model.position.set(0,1.50,-1.92); model.rotation.set(.10, -.12, 0); brightenModelMaterials(model); stageRoot.add(model);
    model.userData.dragRotate = true;
    model.traverse(o => { if (o.isMesh) { o.userData.dragTarget = model; interactables.push(o); } });
  } else makePlane({width:1.05,height:.78,position:[0,1.55,-2.05],texture:cacheTexture('./assets/images/jungfrau-reflection.png')});
}

function openNote(index) {
  clearStage(); currentStage = 'noteDetail'; setStatus(`Comfort note ${index}`); makeBack();
  makePlane({ width:1.12,height:.745,position:[0,1.55,-2.05],texture:cacheTexture(`./assets/images/note-${index}.png`) });
}

function renderVoiceIsle(showMessage = false) {
  if (showMessage) voiceIntroUntil = performance.now() + INTRO_HOLD_MS + INTRO_FADE_MS;
  clearStage();
  currentStage = 'voice';
  resetDesktopOrbit();
  setDesktopOrbitEnabled(true);
  randomMode = false;
  setIsleBackground('voice');
  setStatus('Voice Isle');

  VOICES.forEach((voice, i) => makeOrb(voice, VOICE_POSITIONS[i], i));

  // Swift uses the exact same portal position and 0.78 scale in both islands.
  makePortal('Heaven Isle', [0.00, 1.13, -1.05], () => renderHeaven(false), 0xffd6ad);
  makeExit();
  makeFixedControlButton(
    'settings',
    './assets/icons/icon_setting.svg',
    [-0.86, 2.00, -0.92],
    () => showToast('Settings are not connected in this web prototype yet.')
  );

  // Normal Mode / Surprise is intentionally absent on Voice Isle (Swift isEnabled: false).
  const voiceIntroRemaining = voiceIntroUntil - performance.now();
  if (voiceIntroRemaining > 0) {
    makeTransientStageIntro(
      'Voice Isle',
      'Pinch a voice to listen',
      [0, 1.63, -0.96],
      voiceIntroRemaining
    );
  }
}

const VOICE_WAVEFORM_BARS = [
  18, 28, 41, 57, 39, 62, 49, 36,
  54, 44, 31, 59, 33, 28, 39, 36,
  49, 31, 23, 33, 44, 31, 23, 39,
  46, 33, 39, 28, 23, 44, 33, 28,
  39, 36, 49, 31, 23, 33, 44, 31,
  23, 39, 46, 33, 39, 28, 23, 44
];

function makeVoiceDetailOrbTexture() {
  const size = 600;
  const c = document.createElement('canvas');
  c.width = size * 2;
  c.height = size * 2;
  const ctx = c.getContext('2d');
  ctx.scale(2, 2);
  ctx.clearRect(0, 0, size, size);

  const cx = size / 2;
  const cy = size / 2;
  const r = 228.5;
  const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, r);
  g.addColorStop(0.00, 'rgba(251,243,234,1)');
  g.addColorStop(0.25, 'rgba(141,225,255,1)');
  g.addColorStop(0.50, 'rgba(173,218,240,1)');
  g.addColorStop(1.00, 'rgba(173,194,240,0.05)');

  ctx.save();
  ctx.shadowColor = 'rgba(172,225,255,0.42)';
  ctx.shadowBlur = 45;
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.arc(cx, cy, 228.5, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();

  ctx.strokeStyle = 'rgba(255,255,255,0.50)';
  ctx.lineWidth = 2.46;
  ctx.beginPath();
  ctx.arc(cx, cy, 262.774 / 2, 0, Math.PI * 2);
  ctx.stroke();

  ctx.lineWidth = 1.64;
  ctx.beginPath();
  ctx.arc(cx, cy, 344.891 / 2, 0, Math.PI * 2);
  ctx.stroke();

  const texture = new THREE.CanvasTexture(c);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = renderer.capabilities.getMaxAnisotropy();
  texture.needsUpdate = true;
  return texture;
}

function formatVoiceRemaining(audio) {
  const duration = Number.isFinite(audio.duration) && audio.duration > 0 ? audio.duration : 0;
  if (!duration) return '--:--';
  const remaining = Math.max(duration - (audio.currentTime || 0), 0);
  const total = Math.max(Math.ceil(remaining), 0);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

function voiceProgress(audio) {
  const duration = Number.isFinite(audio.duration) && audio.duration > 0 ? audio.duration : 0;
  if (!duration) return 0;
  return Math.min(Math.max((audio.currentTime || 0) / duration, 0), 1);
}

function makeVoicePlayerTexture(audio) {
  const c = document.createElement('canvas');
  c.width = 1240;
  c.height = 180;
  const ctx = c.getContext('2d');
  const texture = new THREE.CanvasTexture(c);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = renderer.capabilities.getMaxAnisotropy();

  const layout = { buttonCenterPx: c.width / 2, buttonRadiusPx: 72 };

  const draw = () => {
    const progress = voiceProgress(audio);
    ctx.clearRect(0, 0, c.width, c.height);

    const by = 90;
    const br = 72;
    const midY = 90;
    const barW = 7.7;
    const gap = 7.6;
    const buttonGap = 18;
    const timeGap = 30;

    ctx.font = fontString({ size: 52, weight: 700, family: 'sans' });
    const timeText = formatVoiceRemaining(audio);
    const timeSlotWidth = Math.max(
      ctx.measureText('00:00').width,
      ctx.measureText('--:--').width,
      ctx.measureText(timeText).width
    );
    const waveformWidth = (VOICE_WAVEFORM_BARS.length - 1) * (barW + gap) + barW;
    const totalWidth = br * 2 + buttonGap + waveformWidth + timeGap + timeSlotWidth;
    const startX = (c.width - totalWidth) / 2;
    const bx = startX + br;
    const waveformX = startX + br * 2 + buttonGap;
    const waveformEnd = waveformX + waveformWidth;
    const timeX = waveformEnd + timeGap;
    layout.buttonCenterPx = bx;
    layout.buttonRadiusPx = br;

    ctx.fillStyle = '#ffffff';
    ctx.beginPath();
    ctx.arc(bx, by, br, 0, Math.PI * 2);
    ctx.fill();

    ctx.fillStyle = '#111111';
    if (audio.paused || audio.ended) {
      ctx.beginPath();
      ctx.moveTo(bx - 18, by - 28);
      ctx.lineTo(bx + 30, by);
      ctx.lineTo(bx - 18, by + 28);
      ctx.closePath();
      ctx.fill();
    } else {
      ctx.fillRect(bx - 23, by - 29, 17, 58);
      ctx.fillRect(bx + 7, by - 29, 17, 58);
    }

    VOICE_WAVEFORM_BARS.forEach((h, index) => {
      const threshold = index / Math.max(VOICE_WAVEFORM_BARS.length - 1, 1);
      ctx.fillStyle = threshold <= progress ? '#ffffff' : 'rgba(255,255,255,0.50)';
      const bh = h * 1.75;
      const x = waveformX + index * (barW + gap);
      const y = midY - bh / 2;
      const r = barW / 2;
      roundedRect(ctx, x, y, barW, bh, r);
      ctx.fill();
    });

    ctx.fillStyle = '#ffffff';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText(timeText, timeX, midY + 1);

    texture.needsUpdate = true;
  };

  draw();
  return { texture, draw, layout, canvasWidth: c.width };
}

function makeVoiceDescriptionTexture(voice) {
  // Figma 832:8809 is 1300px wide with 40px padding, 19px vertical gap,
  // 38px Inter Bold title and 24px Inter Medium body. Render at 2x here.
  const c = document.createElement('canvas');
  c.width = 2600;
  c.height = 408;
  const ctx = c.getContext('2d');
  ctx.clearRect(0, 0, c.width, c.height);

  // Glass panel: 10% black, 0.5px white border, 20px radius, soft white halo.
  ctx.save();
  ctx.shadowColor = 'rgba(255,255,255,0.20)';
  ctx.shadowBlur = 60;
  ctx.fillStyle = 'rgba(0,0,0,0.10)';
  roundedRect(ctx, 20, 20, c.width - 40, c.height - 40, 40);
  ctx.fill();
  ctx.restore();

  ctx.strokeStyle = 'rgba(255,255,255,0.50)';
  ctx.lineWidth = 2;
  roundedRect(ctx, 20, 20, c.width - 40, c.height - 40, 40);
  ctx.stroke();

  const heading = voice.label || voice.title.replace(/\n/g, ' ');
  ctx.fillStyle = '#ffffff';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';

  // 40px top padding at Figma size -> 80px on this 2x canvas.
  const topPadding = 80;
  const compactHeading = heading.length <= 4;
  const titleSize = compactHeading ? 68 : 76;
  const titleLineHeight = compactHeading ? 80 : 88;
  const gap = 38; // 19px Figma gap at 2x.
  const bodySize = 48;
  const bodyLineHeight = 58;

  ctx.font = fontString({ size: titleSize, weight: 700, family: 'sans' });
  ctx.fillText(heading, c.width / 2, topPadding);

  // Keep Figma-like side padding, but force a visually balanced two-line body.
  ctx.font = fontString({ size: bodySize, weight: 500, family: 'sans' });
  const bodyMaxWidth = c.width - 160; // 40px each side at 2x.
  const words = String(voice.description).trim().split(/\s+/);
  let bodyLines = [];
  if (words.length > 3) {
    let best = null;
    for (let i = 1; i < words.length; i++) {
      const a = words.slice(0, i).join(' ');
      const b = words.slice(i).join(' ');
      const wa = ctx.measureText(a).width;
      const wb = ctx.measureText(b).width;
      if (wa <= bodyMaxWidth && wb <= bodyMaxWidth) {
        const score = Math.abs(wa - wb);
        if (!best || score < best.score) best = { a, b, score };
      }
    }
    if (best) bodyLines = [best.a, best.b];
  }
  if (!bodyLines.length) bodyLines = wrapText(ctx, voice.description, bodyMaxWidth).slice(0, 2);

  const bodyY = topPadding + titleLineHeight + gap;
  bodyLines.forEach((line, i) => {
    ctx.fillText(line, c.width / 2, bodyY + i * bodyLineHeight);
  });

  const texture = new THREE.CanvasTexture(c);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = renderer.capabilities.getMaxAnisotropy();
  texture.needsUpdate = true;
  return texture;
}

function makeVoiceDetailDimmer() {
  const mesh = new THREE.Mesh(
    new THREE.PlaneGeometry(3.0, 1.72),
    new THREE.MeshBasicMaterial({
      color: 0x000000,
      transparent: true,
      opacity: 0.20,
      depthWrite: false,
      side: THREE.DoubleSide
    })
  );
  mesh.position.set(0, 1.60, -1.38);
  mesh.renderOrder = -1;
  stageRoot.add(mesh);
  return mesh;
}

function openVoice(voice) { selectedVoice = voice; renderVoiceDetail(voice); }

function renderVoiceDetail(voice) {
  clearStage();
  currentStage = 'voiceDetail';
  resetDesktopOrbit();
  setDesktopOrbitEnabled(false);
  setIsleBackground('voice');
  setStatus(voice.label || voice.title.replace('\n', ' '));
  makeBack();

  // Figma 832:8798 / Swift VoiceDetailOrb: 600×600 attachment visual.
  makePlane({
    width: 0.60,
    height: 0.60,
    position: [0, 1.72, -1.06],
    texture: makeVoiceDetailOrbTexture(),
    opacity: 1
  });

  const audio = new Audio(voice.asset);
  audio.preload = 'metadata';
  audio.volume = 1;
  boostVoiceAudio(audio, 1.6);
  activeMedia.add(audio);

  const player = makeVoicePlayerTexture(audio);

  const togglePlayback = async () => {
    if (!audio.paused && !audio.ended) {
      audio.pause();
      player.draw();
      return;
    }
    if (audio.ended || (Number.isFinite(audio.duration) && audio.currentTime >= audio.duration - 0.05)) {
      audio.currentTime = 0;
    }
    try {
      await resumeVoiceAudioContext();
      await audio.play();
      player.draw();
    } catch (e) {
      showToast('Audio playback needs another pinch/click.');
    }
  };

  const playerPlane = makePlane({
    width: 0.64,
    height: 0.093,
    position: [0, 1.405, -1.01],
    texture: player.texture,
    opacity: 1,
    action: togglePlayback
  });
  playerPlane.material.depthWrite = false;
  playerPlane.renderOrder = 20;

  makePlane({
    width: 1.30,
    height: 0.204,
    position: [0, 1.185, -1.02],
    texture: makeVoiceDescriptionTexture(voice),
    opacity: 1
  });

  audio.addEventListener('loadedmetadata', player.draw);
  audio.addEventListener('durationchange', player.draw);
  audio.addEventListener('play', player.draw);
  audio.addEventListener('pause', player.draw);
  audio.addEventListener('ended', player.draw);

  animated.push({
    type: 'voicePlayback',
    object: playerPlane,
    audio,
    draw: player.draw,
    lastDrawAt: -1
  });
}

function updateButtonLabel(button,label) {
  button.material.map?.dispose?.();
  button.material.map = makeButtonTexture(label, { bg: 'rgba(245,250,255,.90)', fg: '#1c334a' });
  button.material.needsUpdate = true;
}


function makeReflectionDimmer() {
  const mesh = new THREE.Mesh(
    new THREE.PlaneGeometry(3.25, 1.86),
    new THREE.MeshBasicMaterial({
      color: 0x000000,
      transparent: true,
      opacity: 0.20,
      depthWrite: false,
      side: THREE.DoubleSide
    })
  );
  mesh.position.set(0, 1.60, -1.24);
  mesh.renderOrder = -20;
  stageRoot.add(mesh);
  return mesh;
}

const REFLECTION_MPP = 0.001;
const REFLECTION_CENTER_Y = 1.60;
const REFLECTION_PANEL_Z = -1.02;
const REFLECTION_CONTENT_Z = -0.985;

function reflectionPoint(widthPx, heightPx, xPx, yPx, z = REFLECTION_CONTENT_Z) {
  return [
    (xPx - widthPx / 2) * REFLECTION_MPP,
    REFLECTION_CENTER_Y + (heightPx / 2 - yPx) * REFLECTION_MPP,
    z
  ];
}

function makeReflectionPanelTexture({
  widthPx = 720,
  heightPx = 460,
  title = '',
  subtitle = '',
  titleSize = 50,
  titleY = 68,
  subtitleY = 147,
  horizontalPadding = 60
} = {}) {
  const scale = 2;
  const c = document.createElement('canvas');
  c.width = widthPx * scale;
  c.height = heightPx * scale;
  const ctx = c.getContext('2d');
  ctx.scale(scale, scale);
  ctx.clearRect(0, 0, widthPx, heightPx);

  // Figma: rgba(243,240,237,.6), 50px radius, soft white halo.
  ctx.fillStyle = 'rgba(243,240,237,0.60)';
  roundedRect(ctx, 0, 0, widthPx, heightPx, 50);
  ctx.fill();

  // Subtle inner sheen only; do not veil content placed in front of this plane.
  ctx.strokeStyle = 'rgba(255,255,255,0.25)';
  ctx.lineWidth = 1;
  roundedRect(ctx, 1, 1, widthPx - 2, heightPx - 2, 49);
  ctx.stroke();

  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';
  ctx.fillStyle = '#000000';
  ctx.font = fontString({ size: titleSize, weight: 700, family: 'serif' });
  ctx.fillText(title, horizontalPadding, titleY);

  if (subtitle) {
    ctx.fillStyle = '#7A736C';
    ctx.font = fontString({ size: 24, weight: 500, family: 'sans', italic: true });
    const maxWidth = widthPx - horizontalPadding * 2;
    const lines = String(subtitle).split('\n').flatMap(line => wrapText(ctx, line, maxWidth));
    lines.forEach((line, i) => ctx.fillText(line, horizontalPadding, subtitleY + i * 33.6));
  }

  const texture = new THREE.CanvasTexture(c);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = renderer.capabilities.getMaxAnisotropy();
  texture.needsUpdate = true;
  return texture;
}

function makeReflectionTextTexture(text, {
  widthPx = 240,
  heightPx = 40,
  fontSize = 20,
  weight = 700,
  family = 'serif',
  fg = '#000000',
  align = 'center'
} = {}) {
  const scale = 2;
  const c = document.createElement('canvas');
  c.width = widthPx * scale;
  c.height = heightPx * scale;
  const ctx = c.getContext('2d');
  ctx.scale(scale, scale);
  ctx.clearRect(0, 0, widthPx, heightPx);
  ctx.font = fontString({ size: fontSize, weight, family });
  ctx.fillStyle = fg;
  ctx.textAlign = align;
  ctx.textBaseline = 'middle';
  ctx.fillText(text, align === 'center' ? widthPx / 2 : 0, heightPx / 2 + 1);
  const texture = new THREE.CanvasTexture(c);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = renderer.capabilities.getMaxAnisotropy();
  texture.needsUpdate = true;
  return texture;
}

function makeReflectionButtonTexture(label, { widthPx = 200, heightPx = 64, bg = '#F3F0ED', fg = '#7A736C' } = {}) {
  const scale = 2;
  const c = document.createElement('canvas');
  c.width = widthPx * scale;
  c.height = heightPx * scale;
  const ctx = c.getContext('2d');
  ctx.scale(scale, scale);
  ctx.clearRect(0, 0, widthPx, heightPx);
  ctx.fillStyle = bg;
  roundedRect(ctx, 0, 0, widthPx, heightPx, heightPx / 2);
  ctx.fill();
  ctx.font = fontString({ size: 24, weight: 700, family: 'sans' });
  ctx.fillStyle = fg;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(label, widthPx / 2, heightPx / 2 + 1);
  const texture = new THREE.CanvasTexture(c);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = renderer.capabilities.getMaxAnisotropy();
  texture.needsUpdate = true;
  return texture;
}

function makeReflectionButton(label, panelWidthPx, panelHeightPx, centerXPx, centerYPx, action, {
  widthPx = 200,
  heightPx = 64,
  bg = '#F3F0ED',
  fg = '#7A736C'
} = {}) {
  const mesh = makeRoundedTextureMesh(
    makeReflectionButtonTexture(label, { widthPx, heightPx, bg, fg }),
    widthPx * REFLECTION_MPP,
    heightPx * REFLECTION_MPP,
    (heightPx / 2) * REFLECTION_MPP,
    reflectionPoint(panelWidthPx, panelHeightPx, centerXPx, centerYPx),
    action
  );
  mesh.material.depthWrite = false;
  mesh.material.toneMapped = false;
  mesh.renderOrder = 12;
  return mesh;
}

function makeReflectionPanel({ width, height, texture, position = [0,REFLECTION_CENTER_Y,REFLECTION_PANEL_Z] }) {
  const mesh = makeRoundedTextureMesh(texture, width, height, Math.min(width, height) * 0.075, position);
  mesh.material.depthWrite = false;
  mesh.material.toneMapped = false;
  mesh.renderOrder = -5;
  return mesh;
}

function makeReflectionMemoryCard(choice, selected, position, action) {
  const group = new THREE.Group();
  group.position.set(...position);
  group.renderOrder = 8;

  const mediaW = 0.270;
  const mediaH = 0.200;
  const radius = 0.017;

  if (selected) {
    // Figma selected card: 5px orange stroke, translucent warm backing, 10px padding.
    const outerW = 0.300;
    const outerH = 0.230;
    const frame = new THREE.Mesh(
      new THREE.ShapeGeometry(roundedRectShape(outerW, outerH, 0.021), 24),
      new THREE.MeshBasicMaterial({ color: 0xE8956A, transparent: true, opacity: 1, depthWrite: false, toneMapped: false })
    );
    group.add(frame);
    const inner = new THREE.Mesh(
      new THREE.ShapeGeometry(roundedRectShape(outerW - 0.010, outerH - 0.010, 0.019), 24),
      new THREE.MeshBasicMaterial({ color: 0xF3F0ED, transparent: true, opacity: 0.64, depthWrite: false, toneMapped: false })
    );
    inner.position.z = 0.002;
    group.add(inner);
  }

  let texture;
  if (choice === 'boracay') texture = cacheTexture('./assets/images/boracay.jpg');
  else if (choice === 'paris') texture = makeVideoPreviewTexture('./assets/video/paris.mp4');
  else texture = cacheTexture('./assets/images/reflection-jungfrau.png');

  const cardBg = new THREE.Mesh(
    new THREE.ShapeGeometry(roundedRectShape(mediaW, mediaH, radius), 24),
    new THREE.MeshBasicMaterial({
      color: choice === 'keyring' ? 0xFFFFFF : 0xF3F0ED,
      transparent: true,
      opacity: choice === 'keyring' ? 0.96 : 1,
      depthWrite: false,
      toneMapped: false
    })
  );
  cardBg.position.z = 0.004;
  cardBg.userData.action = action;
  interactables.push(cardBg);
  group.add(cardBg);

  const displayW = choice === 'keyring' ? 0.210 : mediaW;
  const displayH = choice === 'keyring' ? 0.160 : mediaH;
  const media = makeRoundedTextureMesh(texture, displayW, displayH, radius * 0.9, [0, choice === 'keyring' ? 0.008 : 0, 0.007], action);
  stageRoot.remove(media);
  media.material.toneMapped = false;
  media.renderOrder = 9;
  group.add(media);

  // User requested no tiny labels under these thumbnails.
  stageRoot.add(group);
  return group;
}

function makeReflectionMoodCard(choice, selected, position, action) {
  const configs = {
    struggling: { title: 'Still struggling.', icon: './assets/icons/feeling-1.svg' },
    better: { title: 'Feeling better.', icon: './assets/icons/feeling-2.svg' },
    good: { title: 'Feeling good!', icon: './assets/icons/feeling-3.svg' }
  };
  const cfg = configs[choice];
  const group = new THREE.Group();
  group.position.set(...position);
  group.renderOrder = 8;

  const cardW = 0.234;
  const cardH = 0.267;

  if (selected) {
    const frame = new THREE.Mesh(
      new THREE.ShapeGeometry(roundedRectShape(cardW, cardH, 0.050), 28),
      new THREE.MeshBasicMaterial({ color: 0xE8956A, transparent: true, opacity: 1, depthWrite: false, toneMapped: false })
    );
    group.add(frame);
    const inner = new THREE.Mesh(
      new THREE.ShapeGeometry(roundedRectShape(cardW - 0.010, cardH - 0.010, 0.047), 28),
      new THREE.MeshBasicMaterial({ color: 0xFFFFFF, transparent: true, opacity: 0.40, depthWrite: false, toneMapped: false })
    );
    inner.position.z = 0.002;
    group.add(inner);
  }

  const icon = new THREE.Mesh(
    new THREE.PlaneGeometry(0.125, 0.125),
    new THREE.MeshBasicMaterial({
      map: cacheTexture(cfg.icon),
      transparent: true,
      opacity: 1,
      depthWrite: false,
      side: THREE.DoubleSide,
      toneMapped: false
    })
  );
  // 40px top padding: icon centre = 40 + 62.5.
  icon.position.set(0, cardH / 2 - 0.1025, 0.008);
  icon.userData.action = action;
  interactables.push(icon);
  group.add(icon);

  const label = new THREE.Mesh(
    new THREE.PlaneGeometry(0.220, 0.036),
    new THREE.MeshBasicMaterial({
      map: makeReflectionTextTexture(cfg.title, { widthPx: 220, heightPx: 36, fontSize: 20, weight: 700, family: 'serif', fg: '#000000' }),
      transparent: true,
      depthWrite: false,
      toneMapped: false
    })
  );
  label.position.set(0, cardH / 2 - 0.205, 0.009);
  label.userData.action = action;
  interactables.push(label);
  group.add(label);

  const hit = new THREE.Mesh(
    new THREE.PlaneGeometry(cardW, cardH),
    new THREE.MeshBasicMaterial({ transparent: true, opacity: 0, depthWrite: false, toneMapped: false })
  );
  hit.position.z = 0.012;
  hit.userData.action = action;
  interactables.push(hit);
  group.add(hit);

  stageRoot.add(group);
  return group;
}

function makeReflectionMicTexture() {
  const c = document.createElement('canvas');
  c.width = 640;
  c.height = 640;
  const ctx = c.getContext('2d');
  ctx.clearRect(0, 0, c.width, c.height);
  const g = ctx.createRadialGradient(320,320,20,320,320,255);
  g.addColorStop(0, 'rgba(255,255,255,0.96)');
  g.addColorStop(0.34, 'rgba(232,149,106,0.30)');
  g.addColorStop(1, 'rgba(232,149,106,0)');
  ctx.fillStyle = g;
  ctx.beginPath(); ctx.arc(320,320,255,0,Math.PI*2); ctx.fill();

  ctx.fillStyle = '#ffffff';
  roundedRect(ctx, 286, 218, 68, 150, 34); ctx.fill();
  ctx.strokeStyle = '#ffffff';
  ctx.lineWidth = 16;
  ctx.beginPath();
  ctx.arc(320, 335, 115, 0.12*Math.PI, 0.88*Math.PI);
  ctx.stroke();
  ctx.beginPath(); ctx.moveTo(320,448); ctx.lineTo(320,498); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(265,498); ctx.lineTo(375,498); ctx.stroke();

  const texture = new THREE.CanvasTexture(c);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = renderer.capabilities.getMaxAnisotropy();
  texture.needsUpdate = true;
  return texture;
}

function makeReflectionTimerTexture() {
  const widthPx = 420;
  const heightPx = 44;
  const scale = 2;
  const c = document.createElement('canvas');
  c.width = widthPx * scale;
  c.height = heightPx * scale;
  const ctx = c.getContext('2d');
  ctx.scale(scale, scale);
  const texture = new THREE.CanvasTexture(c);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = renderer.capabilities.getMaxAnisotropy();
  const draw = (seconds = 0) => {
    ctx.clearRect(0, 0, widthPx, heightPx);
    ctx.fillStyle = '#FFFFFF';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = fontString({ size: 24, weight: 700, family: 'sans' });
    const mm = String(Math.floor(seconds / 60)).padStart(2,'0');
    const ss = String(seconds % 60).padStart(2,'0');
    ctx.fillText(`Recording · ${mm}:${ss}`, widthPx / 2, heightPx / 2 + 1);
    texture.needsUpdate = true;
  };
  draw(0);
  return { texture, draw, widthPx, heightPx };
}

function makeReflectionSavedTexture() {
  const c = document.createElement('canvas');
  c.width = 1440;
  c.height = 1000;
  const ctx = c.getContext('2d');
  ctx.clearRect(0,0,c.width,c.height);
  ctx.save();
  ctx.shadowColor = 'rgba(255,255,255,0.20)';
  ctx.shadowBlur = 25;
  ctx.shadowOffsetY = 0;
  ctx.fillStyle = 'rgba(243,240,237,0.60)';
  roundedRect(ctx, 16, 16, c.width-32, c.height-32, 100); ctx.fill();
  ctx.restore();
  ctx.strokeStyle = 'rgba(255,255,255,0.24)'; ctx.lineWidth = 2;
  roundedRect(ctx, 16, 16, c.width-32, c.height-32, 100); ctx.stroke();

  ctx.fillStyle = '#f3f0ed';
  ctx.beginPath(); ctx.arc(190, 220, 90, 0, Math.PI*2); ctx.fill();
  ctx.strokeStyle = '#7a736c'; ctx.lineWidth = 16; ctx.lineCap='round';
  ctx.beginPath(); ctx.moveTo(145,220); ctx.lineTo(180,255); ctx.lineTo(240,185); ctx.stroke();

  ctx.textAlign='left'; ctx.textBaseline='top';
  ctx.fillStyle='#000'; ctx.font=fontString({size:100,weight:700,family:'serif'});
  ctx.fillText('Reflection saved',120,355);
  ctx.fillStyle='#7a736c'; ctx.font=fontString({size:48,weight:500,family:'sans',italic:true});
  ctx.fillText('You can revisit it later in your mobile Journal.',120,500);

  ctx.fillStyle='#f3f0ed'; roundedRect(ctx, 500, 700, 440, 130, 65); ctx.fill();
  ctx.fillStyle='#7a736c'; ctx.font=fontString({size:46,weight:700,family:'sans'}); ctx.textAlign='center'; ctx.textBaseline='middle';
  ctx.fillText('Finish Session',720,765);

  const texture = new THREE.CanvasTexture(c);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = renderer.capabilities.getMaxAnisotropy();
  texture.needsUpdate = true;
  return texture;
}

function prepareReflectionStage(stageName) {
  clearStage();
  currentStage = stageName;
  resetDesktopOrbit();
  setDesktopOrbitEnabled(false);
  setIsleBackground(stageBeforeExit === 'voice' ? 'voice' : 'heaven');
  makeReflectionDimmer();
  setStatus('Reflection');
}

function openExitPrompt() {
  if (currentStage === 'voice' || currentStage === 'heaven') stageBeforeExit = currentStage;
  prepareReflectionStage('exitPrompt');
  makeBack();

  const W = 720, H = 406;
  makeReflectionPanel({
    width: W * REFLECTION_MPP,
    height: H * REFLECTION_MPP,
    texture: makeReflectionPanelTexture({
      widthPx: W,
      heightPx: H,
      title: 'Ready to leave?',
      subtitle: 'Save a short reflection before you finish,\nor leave without saving.',
      titleY: 68,
      subtitleY: 147,
      horizontalPadding: 60
    })
  });

  makeReflectionButton('Reflect', W, H, 270, 306, renderReflectionComfort, { widthPx: 170, heightPx: 64 });
  makeReflectionButton('Exit now', W, H, 462, 306, () => renderHeaven(false), {
    widthPx: 190,
    heightPx: 64,
    bg: 'rgba(255,255,255,0.20)',
    fg: '#000000'
  });
}

function renderReflectionComfort({ preserveSelection = false } = {}) {
  if (!preserveSelection) reflectionComfort = null;
  prepareReflectionStage('reflectionComfort');
  makeBack();

  const W = 1060;
  const H = reflectionComfort ? 609 : 485;
  makeReflectionPanel({
    width: W * REFLECTION_MPP,
    height: H * REFLECTION_MPP,
    texture: makeReflectionPanelTexture({
      widthPx: W,
      heightPx: H,
      title: 'What brought you comfort today?',
      titleY: 68,
      horizontalPadding: 60
    })
  });

  // 68 top / 60 side padding; 60px content gap. Thumbnail labels intentionally omitted.
  const choices = ['boracay', 'paris', 'keyring'];
  const centersX = [205, 525, 845];
  const cardCenterY = 302;
  choices.forEach((choice, i) => {
    makeReflectionMemoryCard(
      choice,
      reflectionComfort === choice,
      reflectionPoint(W, H, centersX[i], cardCenterY),
      () => { reflectionComfort = choice; renderReflectionComfort({ preserveSelection: true }); }
    );
  });

  if (reflectionComfort) {
    makeReflectionButton('Next', W, H, W / 2, 509, () => renderReflectionFeeling(), {
      widthPx: 300,
      heightPx: 64,
      fg: '#7A736C'
    });
  }
}

function renderReflectionComfortSelected() {
  renderReflectionComfort({ preserveSelection: true });
}

function renderReflectionFeeling({ preserveSelection = false } = {}) {
  if (!preserveSelection) reflectionFeeling = null;
  prepareReflectionStage('reflectionFeeling');
  makeBack();

  const W = 942;
  const H = reflectionFeeling ? 733 : 609;
  makeReflectionPanel({
    width: W * REFLECTION_MPP,
    height: H * REFLECTION_MPP,
    texture: makeReflectionPanelTexture({
      widthPx: W,
      heightPx: H,
      title: 'How do you feel now?',
      subtitle: 'Take a moment before you leave.\nChoose what feels closest.',
      titleY: 68,
      subtitleY: 147,
      horizontalPadding: 60
    })
  });

  const choices = ['struggling', 'better', 'good'];
  const centersX = [177, 471, 765];
  const cardCenterY = 407.5;
  choices.forEach((choice, i) => {
    makeReflectionMoodCard(
      choice,
      reflectionFeeling === choice,
      reflectionPoint(W, H, centersX[i], cardCenterY),
      () => { reflectionFeeling = choice; renderReflectionFeeling({ preserveSelection: true }); }
    );
  });

  if (reflectionFeeling) {
    makeReflectionButton('Next', W, H, W / 2, 633, renderReflectionVoice, {
      widthPx: 200,
      heightPx: 64,
      fg: '#7A736C'
    });
  }
}

function renderReflectionFeelingSelected() {
  renderReflectionFeeling({ preserveSelection: true });
}

function renderReflectionVoice() {
  prepareReflectionStage('reflectionVoice');
  makeBack();

  const W = 720, H = 789;
  makeReflectionPanel({
    width: W * REFLECTION_MPP,
    height: H * REFLECTION_MPP,
    texture: makeReflectionPanelTexture({
      widthPx: W,
      heightPx: H,
      title: 'Add a voice reflection',
      subtitle: 'Take a moment to share whatever is on your mind. You can revisit your reflection and explore suggested activities later in the Isle app.',
      titleY: 68,
      subtitleY: 147,
      horizontalPadding: 60
    })
  });

  const mic = makePlane({
    width: 0.228,
    height: 0.228,
    position: reflectionPoint(W, H, W / 2, 422),
    texture: makeReflectionMicTexture(),
    opacity: 1
  });
  mic.material.depthWrite = false;
  mic.material.toneMapped = false;
  mic.renderOrder = 8;
  animated.push({ type: 'pulse', object: mic, speed: 0.55, phase: 0 });

  const timer = makeReflectionTimerTexture();
  const timerPlane = makePlane({
    width: timer.widthPx * REFLECTION_MPP,
    height: timer.heightPx * REFLECTION_MPP,
    position: reflectionPoint(W, H, W / 2, 583),
    texture: timer.texture,
    opacity: 1
  });
  timerPlane.material.depthWrite = false;
  timerPlane.material.toneMapped = false;
  timerPlane.renderOrder = 8;
  animated.push({ type: 'reflectionTimer', object: timerPlane, startedAt: clock.getElapsedTime(), lastSecond: -1, draw: timer.draw });

  makeReflectionButton('Save', W, H, W / 2, 689, renderReflectionSaved, {
    widthPx: 200,
    heightPx: 64,
    fg: '#7A736C'
  });
}

function makeReflectionSavedPanelTexture(widthPx = 720, heightPx = 520) {
  const scale = 2;
  const c = document.createElement('canvas');
  c.width = widthPx * scale;
  c.height = heightPx * scale;
  const ctx = c.getContext('2d');
  ctx.scale(scale, scale);
  ctx.clearRect(0, 0, widthPx, heightPx);
  ctx.fillStyle = 'rgba(243,240,237,0.60)';
  roundedRect(ctx, 0, 0, widthPx, heightPx, 50);
  ctx.fill();

  // 90px check chip, matching Figma C.4.
  ctx.fillStyle = '#F3F0ED';
  ctx.beginPath(); ctx.arc(105, 113, 45, 0, Math.PI * 2); ctx.fill();
  ctx.strokeStyle = '#8C8279';
  ctx.lineWidth = 8;
  ctx.lineCap = 'round';
  ctx.beginPath(); ctx.moveTo(83,113); ctx.lineTo(101,131); ctx.lineTo(131,96); ctx.stroke();

  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';
  ctx.fillStyle = '#000000';
  ctx.font = fontString({ size: 50, weight: 700, family: 'serif' });
  ctx.fillText('Reflection saved', 60, 190);
  ctx.fillStyle = '#7A736C';
  ctx.font = fontString({ size: 24, weight: 500, family: 'sans', italic: true });
  ctx.fillText('You can revisit it later in your mobile Journal.', 60, 269);

  const texture = new THREE.CanvasTexture(c);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = renderer.capabilities.getMaxAnisotropy();
  texture.needsUpdate = true;
  return texture;
}

function renderReflectionSaved() {
  prepareReflectionStage('reflectionSaved');
  setStatus('Reflection saved');
  const W = 720, H = 520;
  makeReflectionPanel({
    width: W * REFLECTION_MPP,
    height: H * REFLECTION_MPP,
    texture: makeReflectionSavedPanelTexture(W, H)
  });
  makeReflectionButton('Finish Session', W, H, W / 2, 407, () => renderHeaven(false), {
    widthPx: 250,
    heightPx: 64,
    fg: '#7A736C'
  });
}

function goBack() {
  if (currentStage==='voiceDetail') return renderVoiceIsle(false);
  if (currentStage==='photoCinema') return renderPhotoDetail(selectedMemory);
  if (currentStage==='videoCinema') return renderVideoDetail(selectedMemory);
  if (currentStage==='objectExpanded') return renderObjectDetail(selectedMemory);
  if (['photoDetail','videoDetail','objectDetail','noteDetail'].includes(currentStage)) return renderHeaven(false);
  if (currentStage==='exitPrompt') return stageBeforeExit==='voice'?renderVoiceIsle(false):renderHeaven(false);
  if (currentStage==='reflectionComfort') return openExitPrompt();
  if (currentStage==='reflectionFeeling') return renderReflectionComfort({ preserveSelection: true });
  if (currentStage==='reflectionVoice') return renderReflectionFeeling({ preserveSelection: true });
}

function endXRSession() {
  const s = renderer.xr.getSession();
  if (s) s.end();
  clearStage(); currentStage='sessionEnd'; setStatus('Session ended');
  makeTextPanel({width:.85,height:.44,position:[0,1.62,-2.0],canvas:{width:950,height:520,title:'See you later',body:'Your island will be here when you need it.',titleSize:66,bodySize:34,bg:'rgba(246,250,255,.91)'}});
  makeButton('Return to Isle',[0,1.18,-1.87],()=>renderHeaven(false),{width:.42});
}

function showToast(text) {
  const toast = makeTextPanel({width:.85,height:.18,position:[0,1.06,-1.72],canvas:{width:1000,height:220,title:text,titleSize:34,bg:'rgba(26,54,82,.76)',fg:'#fff'}});
  setTimeout(()=>stageRoot.remove(toast),2200);
}

function resolveAction(obj) {
  let current = obj;
  while (current) {
    if (typeof current.userData?.action === 'function') return current.userData.action;
    current = current.parent;
  }
  return null;
}

function findDragTarget(obj) {
  let current = obj;
  while (current) {
    if (current.userData?.dragTarget) return current.userData.dragTarget;
    if (current.userData?.dragRotate) return current;
    current = current.parent;
  }
  return null;
}

function getDragTargetFromPointer(event) {
  const rect = renderer.domElement.getBoundingClientRect();
  pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
  pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
  raycaster.setFromCamera(pointer, camera);
  const hits = raycaster.intersectObjects(interactables, true);
  for (const hit of hits) {
    const dragTarget = findDragTarget(hit.object);
    if (dragTarget) return dragTarget;
  }
  return null;
}

function addObjectInspectLights(anchor = [0, 1.52, -1.92]) {
  const group = new THREE.Group();

  const hemi = new THREE.HemisphereLight(0xf7fbff, 0x6c7f96, 1.15);
  group.add(hemi);

  const key = new THREE.DirectionalLight(0xfff3e1, 1.75);
  key.position.set(anchor[0] + 0.72, anchor[1] + 0.72, anchor[2] + 0.92);
  key.target.position.set(anchor[0], anchor[1] + 0.06, anchor[2]);
  group.add(key, key.target);

  const fill = new THREE.DirectionalLight(0xe4eefc, 0.95);
  fill.position.set(anchor[0] - 0.85, anchor[1] + 0.18, anchor[2] + 0.55);
  fill.target.position.set(anchor[0], anchor[1], anchor[2]);
  group.add(fill, fill.target);

  const ambient = new THREE.AmbientLight(0xffffff, 0.26);
  group.add(ambient);

  stageRoot.add(group);
  return group;
}

function brightenModelMaterials(root) {
  root.traverse((obj) => {
    if (!obj.isMesh) return;
    const materials = Array.isArray(obj.material) ? obj.material : [obj.material];
    materials.forEach((material) => {
      if (!material) return;
      if ('metalness' in material) material.metalness = Math.min(material.metalness ?? 0.5, 0.55);
      if ('roughness' in material) material.roughness = Math.max(material.roughness ?? 0.35, 0.32);
      if ('envMapIntensity' in material) material.envMapIntensity = Math.max(material.envMapIntensity || 1, 1.08);
      if ('emissiveIntensity' in material) material.emissiveIntensity = 0;
      material.needsUpdate = true;
    });
  });
}

function resolveTutorialAction(hit) {
  const regions = hit.object?.userData?.tutorialHits;
  if (!Array.isArray(regions) || !hit.uv) return null;

  // Plane UV origin is bottom-left; the tutorial canvas origin is top-left.
  const px = hit.uv.x * TUTORIAL_FRAME_PX.width;
  const py = (1 - hit.uv.y) * TUTORIAL_FRAME_PX.height;

  const region = regions.find(r =>
    px >= r.x && px <= r.x + r.w &&
    py >= r.y && py <= r.y + r.h
  );
  return region?.action || null;
}

function pickWithRay(ray) {
  raycaster.ray.copy(ray);
  const hits = raycaster.intersectObjects(interactables, true);
  for (const hit of hits) {
    const tutorialAction = resolveTutorialAction(hit);
    if (tutorialAction) { tutorialAction(); return true; }

    const action = resolveAction(hit.object);
    if (action) { action(); return true; }
  }
  return false;
}

function onPointerClick(event) {
  if (renderer.xr.isPresenting || suppressNextSceneClick) {
    suppressNextSceneClick = false;
    return;
  }
  const rect = renderer.domElement.getBoundingClientRect();
  pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
  pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
  raycaster.setFromCamera(pointer,camera);
  pickWithRay(raycaster.ray);
}

// Heaven/Voice use OrbitControls for 360 drag. Object inspection uses direct
// drag-to-rotate on the model itself so the background stays still.
renderer.domElement.addEventListener('pointerdown', (event) => {
  if (event.pointerType === 'mouse' && event.button !== 0) return;

  if (!renderer.xr.isPresenting && currentStage === 'objectExpanded') {
    const dragTarget = getDragTargetFromPointer(event);
    if (dragTarget) {
      objectDragState = {
        target: dragTarget,
        startX: event.clientX,
        startRotationY: dragTarget.rotation.y
      };
      objectDragMoved = false;
      suppressNextSceneClick = false;
      renderer.domElement.style.cursor = 'grabbing';
      return;
    }
  }

  if (event.pointerType !== 'mouse' || event.button !== 0) return;
  orbitPointerDown = true;
  orbitDragStartX = event.clientX;
  orbitDragStartY = event.clientY;
  suppressNextSceneClick = false;
  if (controls.enableRotate) renderer.domElement.style.cursor = 'grabbing';
});
window.addEventListener('pointermove', (event) => {
  if (objectDragState) {
    const dx = event.clientX - objectDragState.startX;
    objectDragState.target.rotation.y = objectDragState.startRotationY + dx * 0.012;
    if (Math.abs(dx) > 2) {
      objectDragMoved = true;
      suppressNextSceneClick = true;
    }
    return;
  }

  if (!orbitPointerDown || event.pointerType !== 'mouse') return;
  const dx = event.clientX - orbitDragStartX;
  const dy = event.clientY - orbitDragStartY;
  if (Math.hypot(dx, dy) > 5) suppressNextSceneClick = true;
});
window.addEventListener('pointerup', (event) => {
  if (objectDragState) {
    if (objectDragMoved) suppressNextSceneClick = true;
    objectDragState = null;
    renderer.domElement.style.cursor = controls.enableRotate ? 'grab' : 'default';
    return;
  }

  if (event.pointerType !== 'mouse') return;
  orbitPointerDown = false;
  renderer.domElement.style.cursor = controls.enableRotate ? 'grab' : 'default';
});
renderer.domElement.addEventListener('click', onPointerClick);

renderer.xr.addEventListener('sessionstart',() => {
  // XR local-floor already provides the user's physical eye height.
  stageRoot.position.y = 0;
  resetDesktopOrbit();
  controls.enabled=false; setStatus(`${statusEl.textContent} · XR`);
  const session=renderer.xr.getSession();
  session.addEventListener('select',onXRSelect);
});
renderer.xr.addEventListener('sessionend',()=>{
  stageRoot.position.y = DESKTOP_STAGE_Y_OFFSET;
  controls.enabled=true;
  resetDesktopOrbit();
  setDesktopOrbitEnabled(currentStage === 'heaven' || currentStage === 'voice' || currentStage === 'photoCinema' || currentStage === 'videoCinema');
});

function onXRSelect(event) {
  const ref = renderer.xr.getReferenceSpace();
  if (!ref || !event.frame || !event.inputSource?.targetRaySpace) return;
  const pose = event.frame.getPose(event.inputSource.targetRaySpace, ref);
  if (!pose) return;
  const m = new THREE.Matrix4().fromArray(pose.transform.matrix);
  const origin = new THREE.Vector3().setFromMatrixPosition(m);
  const q = new THREE.Quaternion().setFromRotationMatrix(m);
  const dir = new THREE.Vector3(0,0,-1).applyQuaternion(q).normalize();
  pickWithRay(new THREE.Ray(origin,dir));
}

function loadImageElement(path) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = path;
  });
}

async function preloadTutorialAssets() {
  const files = [
    ['tutorial-1', './assets/tutorial/tutorial-1.png'],
    ['tutorial-2', './assets/tutorial/tutorial-2.png'],
    ['tutorial-3', './assets/tutorial/tutorial-3.png'],
    ['tutorial-4', './assets/tutorial/tutorial-4.png'],
    ['gaze', './assets/icons/gaze.svg'],
    ['pinch', './assets/icons/pinch.svg'],
    ['zoom', './assets/icons/zoom.svg']
  ];
  const loaded = await Promise.all(files.map(async ([key, path]) => [key, await loadImageElement(path)]));
  loaded.forEach(([key, img]) => tutorialAssets.set(key, img));
}

async function ensureFontsReady() {
  if (!document.fonts) return;
  try {
    await Promise.all([
      document.fonts.load('600 82px "Playfair Display"'),
      document.fonts.load('700 50px "Playfair Display"'),
      document.fonts.load('700 28px "Playfair Display"')
    ]);
  } catch (e) {
    console.warn('Playfair Display did not finish loading; serif fallback will be used.', e);
  }
}

async function loadWorld() {
  try {
    setIsleBackground('heaven');
  } catch (e) { console.warn('Sky texture fallback', e); }

  // Tutorial appears immediately after its fonts/images are ready; heavy USDZ models load in the background.
  await Promise.all([ensureFontsReady(), preloadTutorialAssets()]);
  loadingEl.classList.add('hidden');
  renderTutorial();

  const loadModel = async (path) => {
    try { return await usdLoader.loadAsync(path); }
    catch (error) { console.warn(`USD model failed: ${path}`, error); return null; }
  };
  Promise.all([
    loadModel('./assets/models/island.usdz'),
    loadModel('./assets/models/jungfrau.usdz')
  ]).then(([island, jungfrau]) => {
    islandModel = island;
    jungfrauModel = jungfrau;
    if (currentStage === 'heaven' && !randomMode) renderHeaven(false);
  });
}

function centeredScaledClone(source, targetSize = 1) {
  const clone = source.clone(true);
  const box = new THREE.Box3().setFromObject(clone);
  const size = box.getSize(new THREE.Vector3());
  const max = Math.max(size.x, size.y, size.z) || 1;
  const scale = targetSize / max;
  clone.scale.multiplyScalar(scale);

  const scaledBox = new THREE.Box3().setFromObject(clone);
  const center = scaledBox.getCenter(new THREE.Vector3());
  const group = new THREE.Group();
  clone.position.sub(center);
  group.add(clone);
  return group;
}

function animateObjects(t) {
  for (const a of animated) {
    if (!a.object?.parent) continue;
    if (a.type==='float') a.object.position.y = a.baseY + Math.sin(t*a.speed*2 + a.phase)*a.amp;
    else if (a.type==='portalFloat') {
      a.object.position.y = a.baseY + Math.sin(t * a.speed * 2 + a.phase) * a.amp;
      const s = 1 + Math.sin(t * 0.55) * 0.012;
      a.object.scale.setScalar(s);
    }
    else if (a.type==='pulse') { const s=1+Math.sin(t*a.speed*2+a.phase)*.025; a.object.scale.setScalar(s); }
    else if (a.type==='rotateSlow') a.object.rotation.y += .0025;
    else if (a.type === 'voicePlayback') {
      if (t - a.lastDrawAt >= 0.05) {
        a.lastDrawAt = t;
        a.draw();
      }
    }
    else if (a.type === 'reflectionTimer') {
      const elapsed = Math.max(0, Math.floor(t - a.startedAt));
      if (elapsed !== a.lastSecond) {
        a.lastSecond = elapsed;
        a.draw(elapsed);
      }
    }
    else if (a.type === 'tutorialEnter') {
      const p = Math.min(1, Math.max(0, (t - a.startedAt) / a.duration));
      const eased = p < 0.5 ? 2 * p * p : 1 - Math.pow(-2 * p + 2, 2) / 2;
      const scale = 0.97 + 0.03 * eased;
      a.object.scale.setScalar(scale);
      a.mats.forEach(m => { m.opacity = eased; });
    }
    else if (a.type === 'stageIntro') {
      const elapsed = t - a.startedAt;
      if (elapsed <= a.hold) {
        a.object.material.opacity = 1;
      } else {
        const p = Math.min(1, (elapsed - a.hold) / a.fade);
        a.object.material.opacity = 1 - p;
        if (p >= 1 && a.object.parent) a.object.parent.remove(a.object);
      }
    }
  }
}

function onResize() {
  camera.aspect=window.innerWidth/window.innerHeight; camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth,window.innerHeight);
}
window.addEventListener('resize',onResize);

renderer.setAnimationLoop(() => {
  const t=clock.getElapsedTime();
  if (!renderer.xr.isPresenting) controls.update();
  animateObjects(t);
  renderer.render(scene,camera);
});

loadWorld();
