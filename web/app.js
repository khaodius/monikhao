/**
 * app.js - Monikhao 3D Dashboard
 * Three.js scene with agent orbs, CSS2D labels, thought bubbles,
 * station panels, attention system, context menus, voice input,
 * and real-time WebSocket updates from the worker service.
 */
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { CSS2DRenderer, CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js';
import { Line2 } from 'three/addons/lines/Line2.js';
import { LineMaterial } from 'three/addons/lines/LineMaterial.js';
import { LineGeometry } from 'three/addons/lines/LineGeometry.js';

// ─── State ─────────────────────────────────────────────────────────────────────
let appState = {
  session: null,
  agents: [],
  timeline: [],
  files: [],
  stats: {},
  config: {}
};

let ws = null;
let reconnectTimer = null;
let reconnectDelay = 1000;

// Three.js objects
let scene, camera, renderer, css2DRenderer, controls, clock;
const agentMeshes = new Map();   // agentId -> { group, sphere, ring, light, label, bubbles, radius, vx, vy, vz, restPos, lastToolTime, lastToolName, spawnAnim, hidden }
const connectionLines = new Map();
const particles = [];
const fileNodes = new Map();
const starField = [];
let gridHelper = null;
const proximityLines = []; // { line, mat } — pooled line objects for particle proximity

// Attention system
let focusedAgentId = null;
let focusTarget = new THREE.Vector3(0, 0, 0);
let userInteracting = false;
let lastUserInteraction = 0;
let focusPanning = false;    // true while camera is animating to a new target
let focusPanProgress = 0;    // 0 → 1 over the pan duration
const FOCUS_PAN_SPEED = 2.5; // ~0.4s to complete a pan

// Context menu
let contextMenuAgentId = null;

// FPS counter
let fpsFrames = 0;
let fpsLastTime = performance.now();
let fpsEl = null;

// ─── Model Pricing ($ per million tokens) ────────────────────────────────────
const MODEL_PRICING = {
  // Anthropic
  'opus-4.6':       { input: 5,     output: 25,    label: 'Claude Opus 4.6' },
  'opus-4.5':       { input: 5,     output: 25,    label: 'Claude Opus 4.5' },
  'opus-4.1':       { input: 15,    output: 75,    label: 'Claude Opus 4.1' },
  'opus-4':         { input: 15,    output: 75,    label: 'Claude Opus 4' },
  'sonnet-4.5':     { input: 3,     output: 15,    label: 'Claude Sonnet 4.5' },
  'sonnet-4':       { input: 3,     output: 15,    label: 'Claude Sonnet 4' },
  'haiku-4.5':      { input: 1,     output: 5,     label: 'Claude Haiku 4.5' },
  'haiku-3.5':      { input: 0.80,  output: 4,     label: 'Claude Haiku 3.5' },
  // OpenAI
  'gpt-5.2':        { input: 1.75,  output: 14,    label: 'GPT-5.2' },
  'gpt-5.1':        { input: 1.25,  output: 10,    label: 'GPT-5.1' },
  'gpt-5':          { input: 1.25,  output: 10,    label: 'GPT-5' },
  'gpt-5-mini':     { input: 0.25,  output: 2,     label: 'GPT-5 Mini' },
  'gpt-4.1':        { input: 2,     output: 8,     label: 'GPT-4.1' },
  'gpt-4.1-mini':   { input: 0.40,  output: 1.60,  label: 'GPT-4.1 Mini' },
  'gpt-4o':         { input: 2.50,  output: 10,    label: 'GPT-4o' },
  'gpt-4o-mini':    { input: 0.15,  output: 0.60,  label: 'GPT-4o Mini' },
  'o3':             { input: 2,     output: 8,     label: 'o3' },
  'o4-mini':        { input: 1.10,  output: 4.40,  label: 'o4-mini' },
};

/** Convert raw model ID (e.g. "claude-opus-4-6-20250514") to display name */
function formatModelName(raw) {
  if (!raw) return '';
  // Anthropic: "claude-opus-4-6-20250514" → "Opus 4.6"
  const claude = raw.match(/claude-(\w+)-(\d+)-(\d+)/);
  if (claude) {
    const family = claude[1].charAt(0).toUpperCase() + claude[1].slice(1);
    return `${family} ${claude[2]}.${claude[3]}`;
  }
  // OpenAI: "gpt-4o-2024-08-06" → "GPT-4o"
  const gpt = raw.match(/^(gpt-[\w.]+)/);
  if (gpt) return gpt[1].toUpperCase();
  // o-series: "o3-2025-04-16" → "o3"
  const oSeries = raw.match(/^(o\d[\w-]*?)(-\d{4})/);
  if (oSeries) return oSeries[1];
  return raw;
}

function estimateCost(tokens, modelKey) {
  const p = MODEL_PRICING[modelKey];
  if (!p) return 0;
  // Assume ~70% input, ~30% output for agent workflows (output is more expensive)
  const avgPerMTok = p.input * 0.7 + p.output * 0.3;
  return (tokens / 1_000_000) * avgPerMTok;
}

// ─── Ambient Audio Soundscape ─────────────────────────────────────────────────
let audioCtx = null;
let audioDrone = null;
let audioGain = null;
let audioInitialized = false;

function initAudio() {
  if (audioInitialized) return;
  try {
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();

    // Master gain
    audioGain = audioCtx.createGain();
    audioGain.gain.value = 0;
    audioGain.connect(audioCtx.destination);

    // Low drone: two detuned oscillators for warm texture
    const drone1 = audioCtx.createOscillator();
    drone1.type = 'sine';
    drone1.frequency.value = 55; // A1
    const drone1Gain = audioCtx.createGain();
    drone1Gain.gain.value = 0.08;
    drone1.connect(drone1Gain);
    drone1Gain.connect(audioGain);
    drone1.start();

    const drone2 = audioCtx.createOscillator();
    drone2.type = 'sine';
    drone2.frequency.value = 55.5; // Slightly detuned — creates slow beat frequency
    const drone2Gain = audioCtx.createGain();
    drone2Gain.gain.value = 0.06;
    drone2.connect(drone2Gain);
    drone2Gain.connect(audioGain);
    drone2.start();

    // Sub-bass foundation
    const sub = audioCtx.createOscillator();
    sub.type = 'sine';
    sub.frequency.value = 27.5; // A0
    const subGain = audioCtx.createGain();
    subGain.gain.value = 0.04;
    sub.connect(subGain);
    subGain.connect(audioGain);
    sub.start();

    audioDrone = { drone1, drone1Gain, drone2, drone2Gain, sub, subGain };
    audioInitialized = true;

    // Fade in gently over 2 seconds
    audioGain.gain.linearRampToValueAtTime(0.5, audioCtx.currentTime + 2);
  } catch (e) {
    // Web Audio not available — silent fallback
  }
}

function setAudioVolume(vol) {
  if (!audioGain || !audioCtx) return;
  audioGain.gain.linearRampToValueAtTime(vol, audioCtx.currentTime + 0.3);
}

// Play a brief tone on tool calls — pitch varies by tool type
function playToolTone(toolName) {
  if (!audioCtx || !audioGain) return;
  if (!(appState.config?.features?.ambientAudio ?? false)) return;

  const toneMap = {
    Read: 440,     // A4 — intake
    Write: 523,    // C5 — output
    Edit: 494,     // B4 — modify
    Bash: 330,     // E4 — execute
    Grep: 587,     // D5 — scan
    Glob: 587,     // D5 — scan
    Task: 659,     // E5 — spawn (higher)
    WebSearch: 392, // G4
    WebFetch: 392,
  };
  const freq = toneMap[toolName] || 440;

  const osc = audioCtx.createOscillator();
  osc.type = 'triangle';
  osc.frequency.value = freq;

  const env = audioCtx.createGain();
  env.gain.value = 0;
  const now = audioCtx.currentTime;
  env.gain.linearRampToValueAtTime(0.06, now + 0.02);  // Quick attack
  env.gain.exponentialRampToValueAtTime(0.001, now + 0.4); // Gentle decay

  osc.connect(env);
  env.connect(audioGain);
  osc.start(now);
  osc.stop(now + 0.5);
}

// Rising arpeggio on subagent spawn
function playSpawnChord() {
  if (!audioCtx || !audioGain) return;
  if (!(appState.config?.features?.ambientAudio ?? false)) return;

  const notes = [330, 440, 554, 659]; // E4, A4, C#5, E5 — A major
  notes.forEach((freq, i) => {
    const osc = audioCtx.createOscillator();
    osc.type = 'sine';
    osc.frequency.value = freq;
    const env = audioCtx.createGain();
    env.gain.value = 0;
    const now = audioCtx.currentTime + i * 0.08;
    env.gain.linearRampToValueAtTime(0.04, now + 0.02);
    env.gain.exponentialRampToValueAtTime(0.001, now + 0.6);
    osc.connect(env);
    env.connect(audioGain);
    osc.start(now);
    osc.stop(now + 0.7);
  });
}

// Resolving chord on completion
function playCompletionChord() {
  if (!audioCtx || !audioGain) return;
  if (!(appState.config?.features?.ambientAudio ?? false)) return;

  const notes = [262, 330, 392, 523]; // C4, E4, G4, C5 — C major (resolution)
  notes.forEach((freq, i) => {
    const osc = audioCtx.createOscillator();
    osc.type = 'sine';
    osc.frequency.value = freq;
    const env = audioCtx.createGain();
    env.gain.value = 0;
    const now = audioCtx.currentTime;
    env.gain.linearRampToValueAtTime(0.035, now + 0.05);
    env.gain.exponentialRampToValueAtTime(0.001, now + 1.2);
    osc.connect(env);
    env.connect(audioGain);
    osc.start(now);
    osc.stop(now + 1.3);
  });
}

// ─── GPU Background Shader System ────────────────────────────────────────────
let bgScene = null, bgCamera = null, bgMesh = null, bgMaterial = null;
let bgRunning = false;
let bgTime = 0;
let currentBgType = '';
let mouseNorm = { x: 0.5, y: 0.5 };
let mouseActive = 0;
let mouseLastMove = 0;
let trailCanvas, trailCtx, trailTexture;

const BG_VERTEX = /* glsl */`
void main() { gl_Position = vec4(position, 1.0); }
`;

const BG_SHADERS = {
  'waves': /* glsl */`
    precision highp float;
    uniform float uTime;
    uniform vec2 uResolution;
    uniform float uIntensity;
    uniform float uOpacity;
    uniform vec3 uCamPos;
    uniform vec3 uThemeColor;
    uniform vec2 uCamRot;
    uniform sampler2D uFontAtlas;
    uniform float uCharCount;
    uniform vec2 uCellSize;
    uniform sampler2D uTrail;

    float hash(float n) { return fract(sin(n) * 43758.5453123); }

    // All distance math in cell units — thresholds are intuitive and resolution-independent
    float shootingStar(vec2 cell, vec2 gridSize, float t, float seed) {
      float h1 = hash(seed);
      float h2 = hash(seed + 1.0);
      float h3 = hash(seed + 2.0);
      float h4 = hash(seed + 3.0);

      // Each star cycles on its own period (20-45s), visible for ~4-6s
      float period = 20.0 + h1 * 25.0;
      float lifetime = 4.0 + h4 * 2.0;
      float phase = mod(t + h1 * period, period);
      if (phase > lifetime) return 0.0;
      float progress = phase / lifetime;

      // Start position in cell coords — upper-left area
      vec2 start = vec2(
        (-0.1 + h2 * 0.4) * gridSize.x,
        (0.65 + h3 * 0.35) * gridSize.y
      );

      // Direction in cell units, y scaled by 10/14 to correct for
      // non-square cells so visual angle on screen is ~25-40°
      vec2 dir = normalize(vec2(
        0.7 + h4 * 0.2,
        -(0.25 + h2 * 0.35) * 0.714
      ));

      // Travel distance scales with grid so star crosses a chunk of screen
      float speed = (0.6 + h3 * 0.4) * gridSize.x;
      vec2 headPos = start + dir * progress * speed;

      vec2 toHead = cell - headPos;
      float alongDir = dot(toHead, dir);
      float perpDist = length(toHead - dir * alongDir);

      // Bright head — 2 cell radius
      float headDist = length(toHead);
      float head = smoothstep(2.0, 0.0, headDist) * 1.5;

      // Fading trail: 10-25 cells long, ~1.5 cells wide
      float trailLen = 10.0 + h1 * 15.0;
      float trail = 0.0;
      if (alongDir < 0.0 && alongDir > -trailLen) {
        float tf = 1.0 + alongDir / trailLen;
        trail = tf * tf * smoothstep(1.5, 0.0, perpDist);
      }

      return head + trail;
    }

    void main() {
      // Character grid cells
      vec2 gridSize = floor(uResolution / uCellSize);
      vec2 cell = floor(gl_FragCoord.xy / uCellSize);
      vec2 cellUV = fract(gl_FragCoord.xy / uCellSize);
      cellUV.y = 1.0 - cellUV.y;

      // Wave math per cell
      vec2 norm = cell / gridSize;
      float t = uTime;
      // Strong camera offset for 3D parallax — shifts wave origin with view direction
      float cx = uCamPos.x * 0.08 + uCamRot.x * 1.5;
      float cy = uCamPos.y * 0.06 + uCamRot.y * 1.2;

      // Offset the cell coordinates to scroll the pattern with camera
      vec2 shifted = norm + vec2(uCamRot.x * 0.3, uCamRot.y * 0.25);

      float w1 = sin(shifted.x * 8.0 + t * 0.8 + cx) * cos(shifted.y * 6.0 - t * 0.5 + cy);
      float w2 = sin((shifted.x + shifted.y) * 5.0 - t * 1.2 + cx * 0.6) * 0.6;
      float w3 = cos(shifted.x * 12.0 - shifted.y * 4.0 + t * 0.7 - cy * 0.4) * 0.3;
      float w4 = sin(shifted.y * 10.0 + t * 0.4 + cx * 0.3) * sin(shifted.x * 3.0 - t * 0.9) * 0.4;

      // Mouse trail disturbance
      float trail = texture2D(uTrail, gl_FragCoord.xy / uResolution.xy).r;
      float mouseRipple = trail * 2.0;

      float val = (w1 + w2 + w3 + w4 + mouseRipple) * uIntensity;
      val = clamp((val + 2.3) / 4.6, 0.0, 1.0);

      // Shooting stars — 2 staggered slots, rare appearance
      float star = 0.0;
      for (int i = 0; i < 2; i++) {
        star += shootingStar(cell, gridSize, t, float(i) * 7.31);
      }
      star = clamp(star, 0.0, 1.0);
      val = max(val, star);

      // Map value to character index, sample font atlas
      float charIdx = floor(val * (uCharCount - 1.0));
      float atlasX = (charIdx + cellUV.x) / uCharCount;
      float charAlpha = texture2D(uFontAtlas, vec2(atlasX, cellUV.y)).r;

      // Color: purple waves, brighter lavender-white for shooting stars
      float c = charAlpha * val * val;
      vec3 waveCol = uThemeColor * 0.35;
      vec3 starCol = uThemeColor * 0.75 + vec3(0.1);
      vec3 color = mix(waveCol, starCol, star) * c;
      gl_FragColor = vec4(color * uOpacity, 1.0);
    }
  `,

  'plasma': /* glsl */`
    precision highp float;
    uniform float uTime;
    uniform vec2 uResolution;
    uniform float uIntensity;
    uniform float uOpacity;
    uniform vec3 uCamPos;
    uniform vec3 uThemeColor;
    uniform vec2 uCamRot;
    uniform sampler2D uFontAtlas;
    uniform float uCharCount;
    uniform vec2 uCellSize;
    uniform sampler2D uTrail;

    void main() {
      vec2 gridSize = floor(uResolution / uCellSize);
      vec2 cell = floor(gl_FragCoord.xy / uCellSize);
      vec2 cellUV = fract(gl_FragCoord.xy / uCellSize);
      cellUV.y = 1.0 - cellUV.y;
      vec2 norm = cell / gridSize;
      float t = uTime;

      vec2 shifted = norm + vec2(uCamRot.x * 0.2, uCamRot.y * 0.15);

      float p1 = sin(shifted.x * 10.0 + t * 0.7);
      float p2 = sin(shifted.y * 8.0 - t * 0.9);
      float p3 = sin((shifted.x + shifted.y) * 6.0 + t * 1.1);
      float p4 = sin(length(shifted - 0.5) * 12.0 - t * 1.3);
      float p5 = cos(shifted.x * 7.0 - shifted.y * 9.0 + t * 0.5);

      // Mouse trail disturbance
      float trail = texture2D(uTrail, gl_FragCoord.xy / uResolution.xy).r;
      float mouseRipple = trail * 2.0;

      float val = (p1 + p2 + p3 + p4 + p5 + mouseRipple) * uIntensity;
      val = clamp((val + 5.0) / 10.0, 0.0, 1.0);

      float charIdx = floor(val * (uCharCount - 1.0));
      float atlasX = (charIdx + cellUV.x) / uCharCount;
      float charAlpha = texture2D(uFontAtlas, vec2(atlasX, cellUV.y)).r;

      float c = charAlpha * val * val;
      float hue = val * 2.0 + t * 0.1;
      vec3 col = uThemeColor * vec3(
        0.5 + 0.3 * sin(hue),
        0.3 + 0.2 * sin(hue + 2.094),
        0.5 + 0.3 * sin(hue + 4.189)
      );
      gl_FragColor = vec4(col * c * uOpacity, 1.0);
    }
  `,

  'fire': /* glsl */`
    precision highp float;
    uniform float uTime;
    uniform vec2 uResolution;
    uniform float uIntensity;
    uniform float uOpacity;
    uniform vec3 uCamPos;
    uniform vec3 uThemeColor;
    uniform vec2 uCamRot;
    uniform sampler2D uFontAtlas;
    uniform float uCharCount;
    uniform vec2 uCellSize;
    uniform sampler2D uTrail;

    float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }

    float noise(vec2 p) {
      vec2 i = floor(p);
      vec2 f = fract(p);
      f = f * f * (3.0 - 2.0 * f);
      float a = hash(i);
      float b = hash(i + vec2(1.0, 0.0));
      float c = hash(i + vec2(0.0, 1.0));
      float d = hash(i + vec2(1.0, 1.0));
      return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
    }

    float fbm(vec2 p) {
      float v = 0.0;
      float a = 0.5;
      for (int i = 0; i < 5; i++) {
        v += a * noise(p);
        p *= 2.0;
        a *= 0.5;
      }
      return v;
    }

    void main() {
      vec2 gridSize = floor(uResolution / uCellSize);
      vec2 cell = floor(gl_FragCoord.xy / uCellSize);
      vec2 cellUV = fract(gl_FragCoord.xy / uCellSize);
      cellUV.y = 1.0 - cellUV.y;
      vec2 norm = cell / gridSize;
      float t = uTime;

      vec2 shifted = norm + vec2(uCamRot.x * 0.1, 0.0);

      // Fire rises from bottom, turbulence increases with height
      vec2 fireUV = vec2(shifted.x * 4.0, shifted.y * 3.0 - t * 1.5);
      float turb = fbm(fireUV * 3.0 + t * 0.5);
      float turb2 = fbm(fireUV * 6.0 - t * 0.8);

      // Height-based intensity — strongest at bottom, fading up
      float heightFade = pow(1.0 - norm.y, 1.8);
      // Horizontal taper toward edges
      float centerFade = 1.0 - pow(abs(norm.x - 0.5) * 2.0, 2.0);

      // Mouse trail stokes the flames
      float trail = texture2D(uTrail, gl_FragCoord.xy / uResolution.xy).r;
      float mouseFlare = trail * 0.6;

      float val = (turb * 0.7 + turb2 * 0.3) * heightFade * centerFade * uIntensity * 2.0;
      val += mouseFlare;
      val = clamp(val, 0.0, 1.0);

      float charIdx = floor(val * (uCharCount - 1.0));
      float atlasX = (charIdx + cellUV.x) / uCharCount;
      float charAlpha = texture2D(uFontAtlas, vec2(atlasX, cellUV.y)).r;

      float c = charAlpha * val;
      vec3 col = mix(
        uThemeColor * 0.15,
        mix(uThemeColor * 0.5, uThemeColor * 0.8 + vec3(0.1), val),
        val
      );
      gl_FragColor = vec4(col * c * uOpacity, 1.0);
    }
  `,

  'topology': /* glsl */`
    precision highp float;
    uniform float uTime;
    uniform vec2 uResolution;
    uniform float uIntensity;
    uniform float uOpacity;
    uniform vec3 uCamPos;
    uniform vec3 uThemeColor;
    uniform vec2 uCamRot;
    uniform sampler2D uFontAtlas;
    uniform float uCharCount;
    uniform vec2 uCellSize;
    uniform sampler2D uTrail;

    float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }

    float noise(vec2 p) {
      vec2 i = floor(p);
      vec2 f = fract(p);
      f = f * f * (3.0 - 2.0 * f);
      float a = hash(i);
      float b = hash(i + vec2(1.0, 0.0));
      float c = hash(i + vec2(0.0, 1.0));
      float d = hash(i + vec2(1.0, 1.0));
      return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
    }

    float fbm(vec2 p) {
      float v = 0.0;
      float a = 0.5;
      for (int i = 0; i < 4; i++) {
        v += a * noise(p);
        p *= 2.0;
        a *= 0.5;
      }
      return v;
    }

    void main() {
      vec2 gridSize = floor(uResolution / uCellSize);
      vec2 cell = floor(gl_FragCoord.xy / uCellSize);
      vec2 cellUV = fract(gl_FragCoord.xy / uCellSize);
      cellUV.y = 1.0 - cellUV.y;
      vec2 norm = cell / gridSize;
      float t = uTime;

      vec2 shifted = norm * 4.0 + vec2(uCamRot.x * 0.5, uCamRot.y * 0.4) + t * 0.05;

      // Mouse trail warps terrain
      vec2 scrUV = gl_FragCoord.xy / uResolution.xy;
      float trail = texture2D(uTrail, scrUV).r;
      vec2 tOfs = 1.0 / vec2(256.0);
      vec2 tGrad = vec2(
        texture2D(uTrail, scrUV + vec2(tOfs.x, 0)).r - texture2D(uTrail, scrUV - vec2(tOfs.x, 0)).r,
        texture2D(uTrail, scrUV + vec2(0, tOfs.y)).r - texture2D(uTrail, scrUV - vec2(0, tOfs.y)).r
      );
      shifted += tGrad * 0.5;

      float height = fbm(shifted) + 0.3 * fbm(shifted * 3.0 + 7.0);

      // Contour lines at regular intervals
      float contourSpacing = 0.08;
      float contour = abs(fract(height / contourSpacing + 0.5) - 0.5) * 2.0;
      float line = 1.0 - smoothstep(0.0, 0.15, contour);

      // Elevation shading
      float shade = height * 0.6;

      float val = (line * 0.8 + shade * 0.4) * uIntensity;
      val = clamp(val, 0.0, 1.0);

      float charIdx = floor(val * (uCharCount - 1.0));
      float atlasX = (charIdx + cellUV.x) / uCharCount;
      float charAlpha = texture2D(uFontAtlas, vec2(atlasX, cellUV.y)).r;

      float c = charAlpha * val;
      // Topo green with elevation tint
      vec3 col = mix(uThemeColor * 0.15, uThemeColor * 0.4, height);
      col = mix(col, vec3(0.2, 0.4, 0.3), line * 0.5);
      gl_FragColor = vec4(col * c * uOpacity, 1.0);
    }
  `,

  'ripples': /* glsl */`
    precision highp float;
    uniform float uTime;
    uniform vec2 uResolution;
    uniform float uIntensity;
    uniform float uOpacity;
    uniform vec3 uCamPos;
    uniform vec3 uThemeColor;
    uniform vec2 uCamRot;
    uniform sampler2D uFontAtlas;
    uniform float uCharCount;
    uniform vec2 uCellSize;
    uniform sampler2D uTrail;

    float hash(float n) { return fract(sin(n) * 43758.5453); }

    void main() {
      vec2 gridSize = floor(uResolution / uCellSize);
      vec2 cell = floor(gl_FragCoord.xy / uCellSize);
      vec2 cellUV = fract(gl_FragCoord.xy / uCellSize);
      cellUV.y = 1.0 - cellUV.y;
      vec2 norm = cell / gridSize;
      float t = uTime;

      vec2 shifted = norm + vec2(uCamRot.x * 0.15, uCamRot.y * 0.12);

      float val = 0.0;
      for (int i = 0; i < 5; i++) {
        float fi = float(i);
        float period = 6.0 + hash(fi * 3.7) * 8.0;
        float phase = mod(t + hash(fi * 5.1) * period, period);
        vec2 center = vec2(hash(fi * 1.3 + 0.1), hash(fi * 2.7 + 0.5));
        center += vec2(sin(t * 0.1 + fi), cos(t * 0.13 + fi * 2.0)) * 0.1;

        float dist = length(shifted - center) * 12.0;
        float ripple = sin(dist - phase * 4.0) * 0.5 + 0.5;
        float fade = exp(-phase * 0.4) * exp(-dist * 0.15);
        val += ripple * fade;
      }

      // Mouse trail creates ripple disturbance
      float trail = texture2D(uTrail, gl_FragCoord.xy / uResolution.xy).r;
      val += trail * 1.5;

      val *= uIntensity;
      val = clamp(val, 0.0, 1.0);

      float charIdx = floor(val * (uCharCount - 1.0));
      float atlasX = (charIdx + cellUV.x) / uCharCount;
      float charAlpha = texture2D(uFontAtlas, vec2(atlasX, cellUV.y)).r;

      float c = charAlpha * val;
      vec3 col = uThemeColor * 0.2 + uThemeColor * 0.35 * val;
      gl_FragColor = vec4(col * c * uOpacity, 1.0);
    }
  `,

  'fractal': /* glsl */`
    precision highp float;
    uniform float uTime;
    uniform vec2 uResolution;
    uniform float uIntensity;
    uniform float uOpacity;
    uniform vec3 uCamPos;
    uniform vec3 uThemeColor;
    uniform vec2 uCamRot;
    uniform sampler2D uFontAtlas;
    uniform float uCharCount;
    uniform vec2 uCellSize;
    uniform sampler2D uTrail;

    void main() {
      vec2 gridSize = floor(uResolution / uCellSize);
      vec2 cell = floor(gl_FragCoord.xy / uCellSize);
      vec2 cellUV = fract(gl_FragCoord.xy / uCellSize);
      cellUV.y = 1.0 - cellUV.y;
      vec2 norm = cell / gridSize;
      float t = uTime;

      // Mouse trail shifts fractal center
      vec2 scrUV = gl_FragCoord.xy / uResolution.xy;
      float trail = texture2D(uTrail, scrUV).r;
      vec2 tOfs = 1.0 / vec2(256.0);
      vec2 tGrad = vec2(
        texture2D(uTrail, scrUV + vec2(tOfs.x, 0)).r - texture2D(uTrail, scrUV - vec2(tOfs.x, 0)).r,
        texture2D(uTrail, scrUV + vec2(0, tOfs.y)).r - texture2D(uTrail, scrUV - vec2(0, tOfs.y)).r
      );

      float zoom = 2.5 + sin(t * 0.05) * 1.0;
      vec2 center = vec2(-0.745, 0.186) + vec2(sin(t * 0.03), cos(t * 0.04)) * 0.02;
      center += uCamRot * 0.05;
      center += tGrad * 0.03;

      vec2 c = center + (norm - 0.5) * zoom;
      vec2 z = vec2(0.0);
      float iter = 0.0;
      const float maxIter = 50.0;

      for (float i = 0.0; i < maxIter; i++) {
        z = vec2(z.x * z.x - z.y * z.y, 2.0 * z.x * z.y) + c;
        if (dot(z, z) > 4.0) break;
        iter++;
      }

      float val = iter / maxIter;
      // Smooth coloring with escape distance
      if (iter < maxIter) {
        float sl = iter - log2(log2(dot(z, z))) + 4.0;
        val = sl / maxIter;
      }
      val = clamp(val * uIntensity, 0.0, 1.0);

      float charIdx = floor(val * (uCharCount - 1.0));
      float atlasX = (charIdx + cellUV.x) / uCharCount;
      float charAlpha = texture2D(uFontAtlas, vec2(atlasX, cellUV.y)).r;

      float c2 = charAlpha * val;
      // Fractal coloring driven by theme
      vec3 col = uThemeColor * vec3(
        0.3 + 0.3 * sin(val * 6.0 + t * 0.2),
        0.2 + 0.2 * sin(val * 5.0 + 2.0),
        0.4 + 0.3 * sin(val * 4.0 + 4.0)
      );
      gl_FragColor = vec4(col * c2 * uOpacity, 1.0);
    }
  `,

  'lissajous': /* glsl */`
    precision highp float;
    uniform float uTime;
    uniform vec2 uResolution;
    uniform float uIntensity;
    uniform float uOpacity;
    uniform vec3 uCamPos;
    uniform vec3 uThemeColor;
    uniform vec2 uCamRot;
    uniform sampler2D uFontAtlas;
    uniform float uCharCount;
    uniform vec2 uCellSize;
    uniform sampler2D uTrail;

    void main() {
      vec2 gridSize = floor(uResolution / uCellSize);
      vec2 cell = floor(gl_FragCoord.xy / uCellSize);
      vec2 cellUV = fract(gl_FragCoord.xy / uCellSize);
      cellUV.y = 1.0 - cellUV.y;
      vec2 norm = (cell / gridSize - 0.5) * 2.0;
      float t = uTime;

      // Mouse trail displacement
      vec2 scrUV = gl_FragCoord.xy / uResolution.xy;
      float trail = texture2D(uTrail, scrUV).r;
      vec2 tOfs = 1.0 / vec2(256.0);
      vec2 tGrad = vec2(
        texture2D(uTrail, scrUV + vec2(tOfs.x, 0)).r - texture2D(uTrail, scrUV - vec2(tOfs.x, 0)).r,
        texture2D(uTrail, scrUV + vec2(0, tOfs.y)).r - texture2D(uTrail, scrUV - vec2(0, tOfs.y)).r
      );
      norm += tGrad * 0.15;

      norm += uCamRot * 0.2;

      float val = 0.0;
      // Multiple Lissajous curves with different frequency ratios
      for (int i = 0; i < 4; i++) {
        float fi = float(i);
        float a = 2.0 + fi;
        float b = 3.0 + fi * 0.7;
        float phase = t * (0.3 + fi * 0.1) + fi * 1.57;
        float drift = sin(t * 0.05 + fi) * 0.5;

        float minD = 1e10;
        // Trace curve and find closest point
        for (float s = 0.0; s < 80.0; s++) {
          float st = s / 80.0 * 6.2831;
          vec2 pt = vec2(
            sin(a * st + phase + drift) * 0.85,
            sin(b * st + phase * 0.7) * 0.85
          );
          minD = min(minD, length(norm - pt));
        }

        float glow = 0.02 / (minD + 0.02);
        val += glow * (0.4 - fi * 0.06);
      }

      val *= uIntensity;
      val = clamp(val, 0.0, 1.0);

      float charIdx = floor(val * (uCharCount - 1.0));
      float atlasX = (charIdx + cellUV.x) / uCharCount;
      float charAlpha = texture2D(uFontAtlas, vec2(atlasX, cellUV.y)).r;

      float c = charAlpha * val * val;
      vec3 col = uThemeColor * 0.3 * c + uThemeColor * 0.5 * c * val;
      gl_FragColor = vec4(col * uOpacity, 1.0);
    }
  `,

  'snow': /* glsl */`
    precision highp float;
    uniform float uTime;
    uniform vec2 uResolution;
    uniform float uIntensity;
    uniform float uOpacity;
    uniform vec3 uCamPos;
    uniform vec3 uThemeColor;
    uniform vec2 uCamRot;
    uniform sampler2D uFontAtlas;
    uniform float uCharCount;
    uniform vec2 uCellSize;
    uniform sampler2D uTrail;

    float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }

    void main() {
      vec2 gridSize = floor(uResolution / uCellSize);
      vec2 cell = floor(gl_FragCoord.xy / uCellSize);
      vec2 cellUV = fract(gl_FragCoord.xy / uCellSize);
      cellUV.y = 1.0 - cellUV.y;
      vec2 norm = cell / gridSize;
      float t = uTime;

      float val = 0.0;

      // Multiple depth layers of falling snow
      for (int layer = 0; layer < 5; layer++) {
        float fl = float(layer);
        float speed = 0.4 + fl * 0.15;
        float scale = 15.0 + fl * 8.0;
        float drift = sin(t * (0.2 + fl * 0.05)) * (0.02 + fl * 0.01);
        float windShift = uCamRot.x * (0.1 + fl * 0.05);

        vec2 st = norm * scale;
        st.x += drift + windShift;
        st.y += t * speed;

        vec2 id = floor(st);
        vec2 f = fract(st);

        float h = hash(id);
        float size = 0.15 + h * 0.2;
        vec2 center = vec2(hash(id + 0.3), hash(id + 0.7)) * 0.6 + 0.2;
        // Horizontal sway
        center.x += sin(t * (0.5 + h) + h * 6.28) * 0.1;

        float d = length(f - center);
        float flake = smoothstep(size, 0.0, d) * (0.5 + h * 0.5);
        // Depth fade: closer layers are brighter
        flake *= (1.0 - fl * 0.15);
        val += flake;
      }

      // Mouse trail clears snow
      float trail = texture2D(uTrail, gl_FragCoord.xy / uResolution.xy).r;
      val *= (1.0 - trail * 0.8);
      val += trail * 0.15;

      val *= uIntensity * 0.7;
      val = clamp(val, 0.0, 1.0);

      float charIdx = floor(val * (uCharCount - 1.0));
      float atlasX = (charIdx + cellUV.x) / uCharCount;
      float charAlpha = texture2D(uFontAtlas, vec2(atlasX, cellUV.y)).r;

      float c = charAlpha * val;
      vec3 col = mix(uThemeColor * 0.15, uThemeColor * 0.5, val);
      gl_FragColor = vec4(col * c * uOpacity, 1.0);
    }
  `,

  'hyperbolic': /* glsl */`
    precision highp float;
    uniform float uTime;
    uniform vec2 uResolution;
    uniform float uIntensity;
    uniform float uOpacity;
    uniform vec3 uCamPos;
    uniform vec3 uThemeColor;
    uniform vec2 uCamRot;
    uniform sampler2D uFontAtlas;
    uniform float uCharCount;
    uniform vec2 uCellSize;
    uniform sampler2D uTrail;

    void main() {
      vec2 gridSize = floor(uResolution / uCellSize);
      vec2 cell = floor(gl_FragCoord.xy / uCellSize);
      vec2 cellUV = fract(gl_FragCoord.xy / uCellSize);
      cellUV.y = 1.0 - cellUV.y;
      vec2 norm = (cell / gridSize - 0.5) * 2.0;
      norm += uCamRot * 0.15;
      float t = uTime;

      // Poincaré disk — hyperbolic tiling
      float r = length(norm);
      float disk = smoothstep(1.02, 0.98, r);
      // Map to hyperbolic space via inverse stereographic
      vec2 h = norm / (1.0 + sqrt(max(0.0, 1.0 - r * r)));
      h *= 3.0;
      h += vec2(sin(t * 0.15), cos(t * 0.12)) * 0.4;

      // Repeating hyperbolic pattern — multiple overlapping circular arcs
      float val = 0.0;
      for (int i = 0; i < 6; i++) {
        float fi = float(i);
        float angle = fi * 1.0472 + t * (0.08 + fi * 0.02);
        vec2 center = vec2(cos(angle), sin(angle)) * (1.2 + fi * 0.3);
        float d = abs(length(h - center) - (0.8 + sin(t * 0.3 + fi) * 0.2));
        val += smoothstep(0.12, 0.0, d) * (0.6 - fi * 0.06);
      }

      // Concentric hyperbolic rings
      float rings = abs(sin(length(h) * 6.0 - t * 0.8));
      rings = smoothstep(0.85, 1.0, rings);
      val += rings * 0.4;

      // Radial symmetry lines
      float angle = atan(h.y, h.x);
      float sym = abs(sin(angle * 4.0 + t * 0.2));
      sym = smoothstep(0.92, 1.0, sym);
      val += sym * 0.2 * smoothstep(0.3, 1.5, length(h));

      // Mouse trail
      float trail = texture2D(uTrail, gl_FragCoord.xy / uResolution.xy).r;
      val += trail * 1.5;

      val *= disk * uIntensity;
      val = clamp(val, 0.0, 1.0);

      float charIdx = floor(val * (uCharCount - 1.0));
      float atlasX = (charIdx + cellUV.x) / uCharCount;
      float charAlpha = texture2D(uFontAtlas, vec2(atlasX, cellUV.y)).r;

      float c = charAlpha * val;
      vec3 col = mix(uThemeColor * 0.15, uThemeColor * 0.5, val);
      gl_FragColor = vec4(col * c * uOpacity, 1.0);
    }
  `,

  'spiral': /* glsl */`
    precision highp float;
    uniform float uTime;
    uniform vec2 uResolution;
    uniform float uIntensity;
    uniform float uOpacity;
    uniform vec3 uCamPos;
    uniform vec3 uThemeColor;
    uniform vec2 uCamRot;
    uniform sampler2D uFontAtlas;
    uniform float uCharCount;
    uniform vec2 uCellSize;
    uniform sampler2D uTrail;

    void main() {
      vec2 gridSize = floor(uResolution / uCellSize);
      vec2 cell = floor(gl_FragCoord.xy / uCellSize);
      vec2 cellUV = fract(gl_FragCoord.xy / uCellSize);
      cellUV.y = 1.0 - cellUV.y;
      vec2 norm = (cell / gridSize - 0.5) * 2.0;
      norm += uCamRot * 0.12;
      float t = uTime;

      float r = length(norm);
      float angle = atan(norm.y, norm.x);

      float val = 0.0;

      // Multiple logarithmic spirals rotating at different speeds
      for (int i = 0; i < 4; i++) {
        float fi = float(i);
        float spiralAngle = angle - log(max(r, 0.01)) * (3.0 + fi * 0.5) + t * (0.4 + fi * 0.15);
        float arm = sin(spiralAngle * (2.0 + fi)) * 0.5 + 0.5;
        arm = pow(arm, 3.0 + fi);
        float fade = exp(-r * (0.8 + fi * 0.3));
        val += arm * fade * (0.5 - fi * 0.08);
      }

      // Central pulse
      float pulse = exp(-r * 4.0) * (0.5 + 0.3 * sin(t * 2.0));
      val += pulse;

      // Outer expanding rings (satisfying ripple)
      float ringPhase = r * 8.0 - t * 1.5;
      float rings = sin(ringPhase) * 0.5 + 0.5;
      rings *= exp(-r * 1.5) * smoothstep(0.1, 0.3, r);
      val += rings * 0.3;

      // Mouse trail
      float trail = texture2D(uTrail, gl_FragCoord.xy / uResolution.xy).r;
      val += trail * 1.5;

      val *= uIntensity;
      val = clamp(val, 0.0, 1.0);

      float charIdx = floor(val * (uCharCount - 1.0));
      float atlasX = (charIdx + cellUV.x) / uCharCount;
      float charAlpha = texture2D(uFontAtlas, vec2(atlasX, cellUV.y)).r;

      float c = charAlpha * val * val;
      vec3 col = mix(uThemeColor * 0.2, uThemeColor * 0.55, val);
      gl_FragColor = vec4(col * c * uOpacity, 1.0);
    }
  `,

  'moire': /* glsl */`
    precision highp float;
    uniform float uTime;
    uniform vec2 uResolution;
    uniform float uIntensity;
    uniform float uOpacity;
    uniform vec3 uCamPos;
    uniform vec3 uThemeColor;
    uniform vec2 uCamRot;
    uniform sampler2D uFontAtlas;
    uniform float uCharCount;
    uniform vec2 uCellSize;
    uniform sampler2D uTrail;

    void main() {
      vec2 gridSize = floor(uResolution / uCellSize);
      vec2 cell = floor(gl_FragCoord.xy / uCellSize);
      vec2 cellUV = fract(gl_FragCoord.xy / uCellSize);
      cellUV.y = 1.0 - cellUV.y;
      vec2 norm = (cell / gridSize - 0.5) * 2.0;
      norm += uCamRot * 0.1;
      float t = uTime;

      // Overlapping circular wave patterns — moiré interference
      float val = 0.0;

      // Center 1: slowly orbiting
      vec2 c1 = vec2(sin(t * 0.17) * 0.3, cos(t * 0.13) * 0.3);
      float d1 = length(norm - c1);
      float w1 = sin(d1 * 18.0 - t * 0.8) * 0.5 + 0.5;

      // Center 2: opposite orbit
      vec2 c2 = vec2(cos(t * 0.19) * 0.35, sin(t * 0.23) * 0.25);
      float d2 = length(norm - c2);
      float w2 = sin(d2 * 20.0 + t * 0.6) * 0.5 + 0.5;

      // Center 3: figure-8 path
      vec2 c3 = vec2(sin(t * 0.11) * cos(t * 0.07) * 0.4, sin(t * 0.14) * 0.3);
      float d3 = length(norm - c3);
      float w3 = sin(d3 * 16.0 - t * 1.1) * 0.5 + 0.5;

      // Parallel line grids at different angles
      float a1 = norm.x * cos(t * 0.1) + norm.y * sin(t * 0.1);
      float lines1 = sin(a1 * 25.0) * 0.5 + 0.5;

      float a2 = norm.x * cos(t * 0.1 + 1.0) + norm.y * sin(t * 0.1 + 1.0);
      float lines2 = sin(a2 * 27.0) * 0.5 + 0.5;

      // Combine: interference creates beautiful shifting patterns
      val = w1 * w2 * 0.6 + w2 * w3 * 0.4 + lines1 * lines2 * 0.3;
      val = pow(val, 0.8);

      // Mouse trail
      float trail = texture2D(uTrail, gl_FragCoord.xy / uResolution.xy).r;
      val += trail * 1.2;

      val *= uIntensity;
      val = clamp(val, 0.0, 1.0);

      float charIdx = floor(val * (uCharCount - 1.0));
      float atlasX = (charIdx + cellUV.x) / uCharCount;
      float charAlpha = texture2D(uFontAtlas, vec2(atlasX, cellUV.y)).r;

      float c = charAlpha * val;
      float hue = val * 1.5 + t * 0.05;
      vec3 col = uThemeColor * vec3(
        0.3 + 0.2 * sin(hue),
        0.25 + 0.15 * sin(hue + 2.094),
        0.4 + 0.2 * sin(hue + 4.189)
      );
      gl_FragColor = vec4(col * c * uOpacity, 1.0);
    }
  `,

  'flow': /* glsl */`
    precision highp float;
    uniform float uTime;
    uniform vec2 uResolution;
    uniform float uIntensity;
    uniform float uOpacity;
    uniform vec3 uCamPos;
    uniform vec3 uThemeColor;
    uniform vec2 uCamRot;
    uniform sampler2D uFontAtlas;
    uniform float uCharCount;
    uniform vec2 uCellSize;
    uniform sampler2D uTrail;

    float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }

    float noise(vec2 p) {
      vec2 i = floor(p);
      vec2 f = fract(p);
      f = f * f * (3.0 - 2.0 * f);
      float a = hash(i);
      float b = hash(i + vec2(1.0, 0.0));
      float c = hash(i + vec2(0.0, 1.0));
      float d = hash(i + vec2(1.0, 1.0));
      return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
    }

    void main() {
      vec2 gridSize = floor(uResolution / uCellSize);
      vec2 cell = floor(gl_FragCoord.xy / uCellSize);
      vec2 cellUV = fract(gl_FragCoord.xy / uCellSize);
      cellUV.y = 1.0 - cellUV.y;
      vec2 norm = cell / gridSize;
      float t = uTime;

      vec2 shifted = norm + vec2(uCamRot.x * 0.1, uCamRot.y * 0.08);

      // Advect position through curl noise field — creates smooth flowing streaks
      vec2 pos = shifted * 4.0;
      float val = 0.0;

      for (int i = 0; i < 8; i++) {
        // Curl noise: rotate gradient 90° for divergence-free flow
        float eps = 0.01;
        float nx = noise(pos + vec2(eps, 0.0) + t * 0.1);
        float ny = noise(pos + vec2(0.0, eps) + t * 0.1);
        float n0 = noise(pos + t * 0.1);
        vec2 curl = vec2(ny - n0, -(nx - n0)) / eps;

        pos += curl * 0.06;
        float streak = noise(pos * 2.0 + t * 0.15);
        val += streak * (0.3 - float(i) * 0.03);
      }

      // Smooth flowing highlights
      float highlight = noise(pos * 3.0 - t * 0.2);
      highlight = smoothstep(0.5, 0.8, highlight);
      val += highlight * 0.4;

      // Mouse trail
      float trail = texture2D(uTrail, gl_FragCoord.xy / uResolution.xy).r;
      val += trail * 1.5;

      val *= uIntensity * 0.6;
      val = clamp(val, 0.0, 1.0);

      float charIdx = floor(val * (uCharCount - 1.0));
      float atlasX = (charIdx + cellUV.x) / uCharCount;
      float charAlpha = texture2D(uFontAtlas, vec2(atlasX, cellUV.y)).r;

      float c = charAlpha * val;
      vec3 col = mix(uThemeColor * 0.1, uThemeColor * 0.45, val);
      gl_FragColor = vec4(col * c * uOpacity, 1.0);
    }
  `
};

// Font atlas for wave characters — symbol presets sorted by visual density
const SYMBOL_PRESETS = {
  'dots':       ' .·∘∙°:•◦○◎●░▒▓',
  'runes':      ' ·᛫ᚠᚢᚦᚨᚱᚲᚷᚹᚺᚾᛁᛃᛈᛇᛉᛊᛋᛏᛒᛖᛗᛚᛞᛟ',
  'alchemical': ' ·°☽✧⊙◇◈☉⊕✦⊛◆●❖✡⊗',
  'zodiac':     ' ·°♈♉♊♋♌♍♎♏♐♑♒♓☉☽✦',
  'geometric':  ' ·∘○◇△□◎◆▽■▲●◉░▓█',
  'occult':     ' ·∴⊛☽☾✧⛧⊕⊗◈⛥✡⊘❖♁☉⛦',
  'sigils':     ' ·⚶♃♄♅♆♇☊☋☌☍⚷⚸⊛✧❖◉',
  'binary':     ' 0011001101010111',
  'katakana':   ' ·ｦｱｲｳｴｵｶｷｸｹｺｻｼｽｾｿﾀﾁ',
  'blocks':     ' ░▁▂▃▄▅▆▇█▉▊▋▌▍▎▏▐▒▓',
  'braille':    ' ⠁⠂⠃⠄⠅⠆⠇⠈⠉⠊⠋⠌⠍⠎⠏⠐⠑⠒⠓⠔⠕⠖⠗⠘⠙⠚⠛⠟⠿⣿',
  'circuit':    ' ·╌╎┄┈╴╶╵╷┌┐└┘├┤┬┴┼═║╔╗╚╝╠╣█',
  'arrows':     ' ·˙→↗↑↖←↙↓↘⟶⇒⇐⇑⇓⤴⤵↺↻⊳⊲▶◀',
  'math':       ' ·∘±×÷∑∏∫∂∇√∞≈≠≤≥∈∉⊂⊃∪∩∀∃⊕⊗',
  'chess':      ' ·∘♙♟♘♞♗♝♖♜♕♛♔♚▪▫◻◼◽◾⬛',
  'hacker':     ' <>{}[]()#!/$%&@~^*=+|\\',
};
let fontAtlasTexture = null;
let currentSymbolPreset = 'dots';

function createFontAtlas(preset) {
  const chars = SYMBOL_PRESETS[preset] || SYMBOL_PRESETS['dots'];
  currentSymbolPreset = preset || 'dots';

  const size = 32;
  const canvas = document.createElement('canvas');
  canvas.width = chars.length * size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');

  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.font = `${size - 4}px 'Noto Sans Symbols 2', 'Noto Sans Runic', 'Noto Sans JP', 'Segoe UI Symbol', 'DejaVu Sans', sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = '#fff';

  for (let i = 0; i < chars.length; i++) {
    ctx.fillText(chars[i], i * size + size / 2, size / 2);
  }

  // Dispose old texture and create fresh — .image replacement doesn't
  // reliably re-upload when canvas dimensions change across presets.
  if (fontAtlasTexture) fontAtlasTexture.dispose();

  fontAtlasTexture = new THREE.CanvasTexture(canvas);
  fontAtlasTexture.minFilter = THREE.LinearFilter;
  fontAtlasTexture.magFilter = THREE.LinearFilter;

  if (bgMaterial) {
    bgMaterial.uniforms.uFontAtlas.value = fontAtlasTexture;
    bgMaterial.uniforms.uCharCount.value = chars.length;
  }
}

// Expose for config changes
window.setWaveSymbols = function(preset) {
  if (!SYMBOL_PRESETS[preset]) return;
  createFontAtlas(preset);
};

window.setCellSize = function(size) {
  size = Math.max(8, Math.min(28, size));
  if (bgMaterial) {
    bgMaterial.uniforms.uCellSize.value.set(size, Math.round(size * 1.286));
  }
  updateConfig('display.cellSize', size);
};

function initBackground() {
  bgScene = new THREE.Scene();
  bgCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

  // Create font atlas for ASCII modes
  const symbolPreset = appState.config?.display?.waveSymbols || 'dots';
  createFontAtlas(symbolPreset);

  const cellW = appState.config?.display?.cellSize || 14;
  const cellH = Math.round(cellW * 1.286);

  bgMaterial = new THREE.ShaderMaterial({
    uniforms: {
      uTime: { value: 0 },
      uResolution: { value: new THREE.Vector2(window.innerWidth, window.innerHeight) },
      uIntensity: { value: 0.6 },
      uOpacity: { value: 1.0 },
      uCamPos: { value: new THREE.Vector3() },
      uCamRot: { value: new THREE.Vector2() },
      uFontAtlas: { value: fontAtlasTexture },
      uCharCount: { value: (SYMBOL_PRESETS[symbolPreset] || SYMBOL_PRESETS['dots']).length },
      uCellSize: { value: new THREE.Vector2(cellW, cellH) },
      uThemeColor: { value: new THREE.Vector3(0.627, 0.314, 1.0) },
      uTrail: { value: null },
    },
    vertexShader: BG_VERTEX,
    fragmentShader: BG_SHADERS['waves'],
    depthWrite: false,
    depthTest: false,
  });

  bgMesh = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), bgMaterial);
  bgScene.add(bgMesh);
  currentBgType = 'waves';

  // Trail texture — offscreen canvas that accumulates mouse path and fades
  trailCanvas = document.createElement('canvas');
  trailCanvas.width = 256;
  trailCanvas.height = 256;
  trailCtx = trailCanvas.getContext('2d');
  trailCtx.fillStyle = '#000';
  trailCtx.fillRect(0, 0, 256, 256);
  trailTexture = new THREE.CanvasTexture(trailCanvas);
  trailTexture.minFilter = THREE.LinearFilter;
  trailTexture.magFilter = THREE.LinearFilter;
  bgMaterial.uniforms.uTrail.value = trailTexture;

  window.addEventListener('resize', () => {
    if (bgMaterial) bgMaterial.uniforms.uResolution.value.set(window.innerWidth, window.innerHeight);
  });

  window.addEventListener('mousemove', (e) => {
    mouseNorm.x = e.clientX / window.innerWidth;
    mouseNorm.y = e.clientY / window.innerHeight;
    mouseActive = 1.0;
    mouseLastMove = performance.now();
  });

  // Hide old DOM canvas
  const domCanvas = document.getElementById('ascii-rain');
  if (domCanvas) domCanvas.style.display = 'none';

  if (appState.config?.display?.asciiRain ?? true) startBackground();
}

function setBgType(type) {
  if (!BG_SHADERS[type] || type === currentBgType) return;
  bgMaterial.fragmentShader = BG_SHADERS[type];
  bgMaterial.needsUpdate = true;
  currentBgType = type;
}

function startBackground() {
  bgRunning = true;
}

function stopBackground() {
  bgRunning = false;
}

function updateBackground() {
  if (!bgRunning || !bgMaterial) return;

  const speed = appState.config?.animation?.speed || 1;
  const intensity = appState.config?.display?.asciiRainDensity ?? 0.6;
  const opacity = (appState.config?.display?.bgOpacity ?? 100) / 100;
  const bgType = appState.config?.display?.bgType || 'waves';

  if (bgType !== currentBgType) setBgType(bgType);

  // Decay mouse activity — fade over 1.5s after last move
  const elapsed = (performance.now() - mouseLastMove) / 1500;
  mouseActive = Math.max(0, 1.0 - elapsed);

  // Update trail canvas — fade old trail, paint dot at cursor
  // Skip GPU upload entirely once trail has fully faded (~3s after last mouse move)
  if (trailCtx && elapsed < 3.0) {
    trailCtx.fillStyle = 'rgba(0, 0, 0, 0.04)';
    trailCtx.fillRect(0, 0, 256, 256);
    if (mouseActive > 0.01) {
      trailCtx.globalAlpha = Math.min(mouseActive * 0.7, 0.6);
      trailCtx.fillStyle = '#fff';
      trailCtx.beginPath();
      trailCtx.arc(mouseNorm.x * 256, mouseNorm.y * 256, 6, 0, Math.PI * 2);
      trailCtx.fill();
      trailCtx.globalAlpha = 1.0;
    }
    trailTexture.needsUpdate = true;
  }

  bgMaterial.uniforms.uTime.value = bgTime;
  bgMaterial.uniforms.uIntensity.value = intensity;
  bgMaterial.uniforms.uOpacity.value = opacity;

  if (camera) {
    bgMaterial.uniforms.uCamPos.value.copy(camera.position);
    // World direction scaled to match Euler-like range, smooth + no wrap
    camera.getWorldDirection(_tempDir);
    bgMaterial.uniforms.uCamRot.value.set(_tempDir.x * 4.0, _tempDir.y * 4.0);
  }

  bgTime += 0.015 * speed;
}

// ─── Three.js Setup ────────────────────────────────────────────────────────────
function initScene() {
  const container = document.getElementById('canvas-container');

  scene = new THREE.Scene();
  scene.fog = new THREE.FogExp2(0x0a0a1a, 0.015);

  camera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 0.1, 1000);
  camera.position.set(0, 8, 20);

  renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setClearColor(0x000000, 1);
  container.appendChild(renderer.domElement);

  // CSS2D Renderer for labels, bubbles, panels
  css2DRenderer = new CSS2DRenderer();
  css2DRenderer.setSize(window.innerWidth, window.innerHeight);
  css2DRenderer.domElement.style.position = 'absolute';
  css2DRenderer.domElement.style.top = '0';
  css2DRenderer.domElement.style.left = '0';
  css2DRenderer.domElement.style.pointerEvents = 'none';
  container.appendChild(css2DRenderer.domElement);

  controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.05;
  controls.autoRotate = true;
  controls.autoRotateSpeed = 0.5;
  controls.maxDistance = 60;
  controls.minDistance = 5;

  // Track user interaction for attention system
  controls.addEventListener('start', () => { userInteracting = true; });
  controls.addEventListener('end', () => { userInteracting = false; });

  clock = new THREE.Clock();

  scene.add(new THREE.AmbientLight(0x222244, 0.5));

  const centerLight = new THREE.PointLight(0x4488ff, 2, 50);
  centerLight.position.set(0, 5, 0);
  scene.add(centerLight);

  createStarField();

  gridHelper = new THREE.GridHelper(60, 60, 0x111133, 0x111133);
  gridHelper.position.y = -3;
  gridHelper.material.opacity = 0.3;
  gridHelper.material.transparent = true;
  gridHelper.visible = false;
  scene.add(gridHelper);

  setupRaycaster();
  setupContextMenu();
  window.addEventListener('resize', onResize);
}

function createStarField() {
  const geo = new THREE.BufferGeometry();
  const positions = new Float32Array(3000);
  for (let i = 0; i < 3000; i++) {
    positions[i] = (Math.random() - 0.5) * 200;
  }
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  const mat = new THREE.PointsMaterial({
    color: 0x6666aa,
    size: 0.15,
    transparent: true,
    opacity: 0.6,
    sizeAttenuation: true
  });
  const stars = new THREE.Points(geo, mat);
  scene.add(stars);
}

function onResize() {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
  css2DRenderer.setSize(window.innerWidth, window.innerHeight);
}

// ─── Agent Orbs ────────────────────────────────────────────────────────────────
function getAgentColor(agent) {
  // Use per-agent random color if assigned by worker
  if (agent.color) return agent.color;
  const colors = appState.config?.theme?.subagentColors || {};
  if (agent.type === 'main') return appState.config?.theme?.mainAgent || '#4488ff';
  return colors[agent.subagentType] || colors.default || '#cccccc';
}

function getToolColor(toolName) {
  const colors = appState.config?.theme?.toolColors || {};
  return colors[toolName] || colors.default || '#888888';
}

function hexToThreeColor(hex) {
  return new THREE.Color(hex);
}

function createAgentLabel(agent) {
  const div = document.createElement('div');
  div.className = 'agent-label-3d';

  const name = document.createElement('span');
  name.className = 'agent-label-name';
  name.textContent = agent.name || 'Agent';
  div.appendChild(name);

  if (agent.subagentType || agent.type !== 'main') {
    const badge = document.createElement('span');
    badge.className = 'agent-label-badge';
    badge.textContent = agent.subagentType || agent.type;
    div.appendChild(badge);
  }

  const label = new CSS2DObject(div);
  label.position.set(0, 1.8, 0);
  return label;
}


function createCoreGeometry(shape, radius) {
  switch (shape) {
    case 'icosahedron': return new THREE.IcosahedronGeometry(radius, 1);
    case 'octahedron': return new THREE.OctahedronGeometry(radius);
    case 'dodecahedron': return new THREE.DodecahedronGeometry(radius, 0);
    case 'cube': return new THREE.BoxGeometry(radius * 1.4, radius * 1.4, radius * 1.4);
    case 'torus': return new THREE.TorusGeometry(radius * 0.7, radius * 0.35, 16, 32);
    case 'cone': return new THREE.ConeGeometry(radius, radius * 2, 6);
    case 'sphere': default: return new THREE.SphereGeometry(radius, 32, 32);
  }
}

function createIndicator(shape, radius, color) {
  const mat = new THREE.MeshBasicMaterial({
    color,
    transparent: true,
    opacity: 0.25,
    side: THREE.DoubleSide,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  });
  let geo, mesh;
  switch (shape) {
    case 'icosahedron':
      geo = new THREE.TorusGeometry(radius + 0.3, 0.06, 8, 48);
      mesh = new THREE.Mesh(geo, mat);
      mesh.rotation.x = -Math.PI / 2;
      break;
    case 'octahedron':
      geo = new THREE.TorusKnotGeometry(radius + 0.1, 0.04, 64, 8, 2, 3);
      mesh = new THREE.Mesh(geo, mat);
      break;
    case 'dodecahedron':
      geo = new THREE.RingGeometry(radius + 0.2, radius + 0.45, 6);
      mesh = new THREE.Mesh(geo, mat);
      mesh.rotation.x = -Math.PI / 3;
      break;
    case 'cube':
      geo = new THREE.RingGeometry(radius + 0.2, radius + 0.45, 4);
      mesh = new THREE.Mesh(geo, mat);
      mesh.rotation.x = -Math.PI / 2;
      break;
    case 'torus':
      geo = new THREE.RingGeometry(radius + 0.3, radius + 0.55, 64);
      mesh = new THREE.Mesh(geo, mat);
      break;
    case 'cone':
      geo = new THREE.RingGeometry(radius + 0.15, radius + 0.4, 3);
      mesh = new THREE.Mesh(geo, mat);
      mesh.rotation.x = -Math.PI / 2;
      break;
    case 'sphere': default:
      geo = new THREE.RingGeometry(radius + 0.2, radius + 0.45, 64);
      mesh = new THREE.Mesh(geo, mat);
      mesh.rotation.x = -Math.PI / 2;
      break;
  }
  return mesh;
}

function createAgentMesh(agent, index) {
  const group = new THREE.Group();
  const color = hexToThreeColor(getAgentColor(agent));
  const radius = agent.type === 'main' ? 1.2 : 0.7;
  const shape = agent.shape || 'sphere';

  // Core geometry — shape varies per agent
  const sphereGeo = createCoreGeometry(shape, radius);
  const sphereMat = new THREE.MeshPhongMaterial({
    color,
    emissive: color,
    emissiveIntensity: 0.5,
    shininess: 120,
    specular: new THREE.Color(0x444466),
  });
  const sphere = new THREE.Mesh(sphereGeo, sphereMat);
  group.add(sphere);

  // Outer glow shell — matches core shape, slightly larger
  const glowGeo = createCoreGeometry(shape, radius * 1.15);
  const glowMat = new THREE.MeshBasicMaterial({
    color,
    transparent: true,
    opacity: 0.12,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  });
  const glowShell = new THREE.Mesh(glowGeo, glowMat);
  group.add(glowShell);

  // Indicator — unique per shape (ring, torus, knot, polygon, etc.)
  const ring = createIndicator(shape, radius, color);
  group.add(ring);

  // Point light
  const light = new THREE.PointLight(color, 1.2, 10);
  group.add(light);

  // CSS2D label
  const showLabels = appState.config?.display?.showLabels ?? true;
  const label = createAgentLabel(agent);
  label.visible = showLabels;
  group.add(label);

  // CSS2D thinking log disabled — content now in agent panel
  const thinkingDiv = document.createElement('div');
  thinkingDiv.className = 'agent-thinking-log hidden';
  thinkingDiv.style.display = 'none';
  const activityLabel = new CSS2DObject(thinkingDiv);
  activityLabel.position.set(0, -(radius + 1.4), 0);
  group.add(activityLabel);

  // Position
  let targetPos;
  const MIN_MAIN_SEPARATION = 8; // minimum distance between main orb rest positions
  if (agent.type === 'main') {
    const mainAgents = appState.agents.filter(a => a.type === 'main');
    const sessionIdx = mainAgents.indexOf(agent);
    const sessionCount = Math.max(mainAgents.length, 1);
    if (sessionCount === 1) {
      targetPos = new THREE.Vector3(0, 0, 0);
    } else {
      const angle = (sessionIdx / sessionCount) * Math.PI * 2;
      const spread = Math.max(10 + sessionCount * 2, MIN_MAIN_SEPARATION * sessionCount / Math.PI);
      targetPos = new THREE.Vector3(Math.cos(angle) * spread, 0, Math.sin(angle) * spread);
    }
    // Nudge away from any existing main orb rest positions that are too close
    for (const [, existing] of agentMeshes) {
      if (existing.agent.type !== 'main') continue;
      const dx = targetPos.x - existing.restPos.x;
      const dz = targetPos.z - existing.restPos.z;
      const dist = Math.sqrt(dx * dx + dz * dz);
      if (dist < MIN_MAIN_SEPARATION && dist > 0.001) {
        const nx = dx / dist;
        const nz = dz / dist;
        const push = MIN_MAIN_SEPARATION - dist;
        targetPos.x += nx * push;
        targetPos.z += nz * push;
      }
    }
  } else {
    const parentMesh = agentMeshes.get(agent.parentId);
    const parentPos = parentMesh ? parentMesh.group.position : new THREE.Vector3(0, 0, 0);
    const siblings = appState.agents.filter(a => a.parentId === agent.parentId);
    const subIndex = siblings.indexOf(agent);
    const siblingCount = Math.max(1, siblings.length);
    const angle = (subIndex / siblingCount) * Math.PI * 2;
    const dist = 5 + siblingCount * 1.2;
    targetPos = new THREE.Vector3(
      parentPos.x + Math.cos(angle) * dist,
      parentPos.y + (Math.random() - 0.5) * 2,
      parentPos.z + Math.sin(angle) * dist
    );
    // Nudge away from any existing orb that's too close
    const MIN_SUB_SEPARATION = 4;
    for (const [, existing] of agentMeshes) {
      const dx = targetPos.x - existing.restPos.x;
      const dy = targetPos.y - existing.restPos.y;
      const dz = targetPos.z - existing.restPos.z;
      const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
      if (d < MIN_SUB_SEPARATION && d > 0.001) {
        const push = (MIN_SUB_SEPARATION - d) / d;
        targetPos.x += dx * push;
        targetPos.y += dy * push;
        targetPos.z += dz * push;
      }
    }
  }

  // Spawn animation for subagents
  const doSpawnAnim = agent.type === 'subagent' && (appState.config?.features?.spawnAnimations ?? true);
  if (doSpawnAnim) {
    const parentMesh = agentMeshes.get(agent.parentId);
    const startPos = parentMesh ? parentMesh.group.position.clone() : targetPos.clone();
    group.position.copy(startPos);
    group.scale.setScalar(0.01);
  } else {
    group.position.copy(targetPos);
  }

  scene.add(group);
  const restPos = targetPos.clone();

  const meshData = {
    group, sphere, ring, light, label, glowShell, activityLabel,
    agent, radius,
    vx: 0, vy: 0, vz: 0,
    restPos,
    bubbles: [],
    lastToolTime: 0,
    lastToolName: null,
    currentActivity: null,
    thinkingLog: [],
    hidden: false,
    // Spawn animation state
    spawnAnim: doSpawnAnim ? { startTime: performance.now(), duration: 800, targetPos: targetPos.clone() } : null,
    // Ring base scale for context-aware animations
    ringBaseScale: 1.0
  };

  agentMeshes.set(agent.id, meshData);

  // Spawn burst particles for subagents
  if (doSpawnAnim) {
    for (let i = 0; i < 18; i++) {
      spawnBurstParticle(agent.id, getAgentColor(agent));
    }
  }

  return group;
}

function updateAgentMesh(agentId) {
  const meshData = agentMeshes.get(agentId);
  if (!meshData) return;

  const agent = appState.agents.find(a => a.id === agentId);
  if (!agent) return;

  const color = hexToThreeColor(getAgentColor(agent));
  meshData.sphere.material.color.copy(color);
  meshData.sphere.material.emissive.copy(color);
  meshData.light.color.copy(color);

  // Update label text
  const labelDiv = meshData.label.element;
  const nameSpan = labelDiv.querySelector('.agent-label-name');
  if (nameSpan) nameSpan.textContent = agent.name || 'Agent';

  // Label visibility
  const showLabels = appState.config?.display?.showLabels ?? true;
  meshData.label.visible = showLabels && !meshData.hidden;

  if (agent.status === 'completed') {
    // Trigger dissolution once on status transition
    if (!meshData.dissolving) {
      meshData.dissolving = true;
      meshData.dissolveStart = performance.now();

      // Bright flash before dissolving
      meshData.sphere.material.emissiveIntensity = 1.5;
      meshData.glowShell.material.opacity = 0.5;
      meshData.glowShell.scale.setScalar(1.4);

      // Fade out orbiting particles belonging to this agent
      for (const p of particles) {
        if (p.sourceId === agent.id && !p.freeFlying) {
          p.persistent = false;
          p.maxLife = 2500;
          p.life = Math.min(p.life, 2500);
        }
      }

      // Spawn particles that arc toward parent
      if (agent.type === 'subagent' && agent.parentId) {
        const parentMesh = agentMeshes.get(agent.parentId);
        if (parentMesh) {
          const agentPos = meshData.group.position;
          const parentPos = parentMesh.group.position;
          const dir = new THREE.Vector3().subVectors(parentPos, agentPos).normalize();
          for (let i = 0; i < 12; i++) {
            spawnArcParticle(agent.id, agent.parentId, getAgentColor(agent));
          }
        }
      }
    }

    // Dissolution animation over 1.5 seconds
    const dissolveElapsed = performance.now() - (meshData.dissolveStart || 0);
    const dissolveT = Math.min(dissolveElapsed / 1500, 1);

    if (agent.type === 'subagent') {
      // Shrink + fade
      const targetScale = Math.max(0.05, 1 - dissolveT * 0.95);
      meshData.group.scale.setScalar(targetScale);
    }

    // Flash fades to dim
    meshData.sphere.material.emissiveIntensity = 1.5 * (1 - dissolveT) + 0.05 * dissolveT;
    meshData.sphere.material.color.setScalar(0.08 + 0.5 * (1 - dissolveT));
    meshData.ring.material.opacity = 0.25 * (1 - dissolveT) + 0.03 * dissolveT;
    meshData.glowShell.material.opacity = 0.5 * (1 - dissolveT);
    meshData.glowShell.scale.setScalar(1.4 * (1 - dissolveT) + 1.0 * dissolveT);
    meshData.light.intensity = 1.2 * (1 - dissolveT) + 0.1 * dissolveT;
    labelDiv.classList.add('completed');
  } else if (agent.status === 'active') {
    meshData.dissolving = false; // Reset if reactivated
    if (!meshData.spawnAnim) meshData.group.scale.setScalar(1);
    meshData.sphere.material.emissiveIntensity = 0.5;
    meshData.sphere.material.color.copy(hexToThreeColor(getAgentColor(agent)));
    meshData.ring.material.opacity = 0.25;
    meshData.light.intensity = 1.2;
    labelDiv.classList.remove('completed');
  }

  meshData.group.visible = !meshData.hidden;
}

// ─── Thought Bubbles ──────────────────────────────────────────────────────────
function showThoughtBubble(agentId, text, color, duration) {
  if (!(appState.config?.features?.thoughtBubbles ?? true)) return;
  const meshData = agentMeshes.get(agentId);
  if (!meshData) return;

  duration = duration || 4500;

  // Max 3 bubbles per agent
  while (meshData.bubbles.length >= 3) {
    const old = meshData.bubbles.shift();
    meshData.group.remove(old.css2d);
    old.css2d.element.remove();
  }

  const div = document.createElement('div');
  div.className = 'thought-bubble';
  if (color) div.style.borderLeftColor = color;

  const textSpan = document.createElement('span');
  textSpan.textContent = text;
  div.appendChild(textSpan);

  const css2d = new CSS2DObject(div);
  // Stack bubbles vertically
  const yOffset = 2.5 + meshData.bubbles.length * 0.8;
  css2d.position.set(0, yOffset, 0);

  meshData.group.add(css2d);

  const bubbleData = {
    css2d,
    createdAt: performance.now(),
    duration
  };
  meshData.bubbles.push(bubbleData);

  // Auto-fade
  setTimeout(() => {
    div.classList.add('fading');
  }, duration - 600);

  setTimeout(() => {
    const idx = meshData.bubbles.indexOf(bubbleData);
    if (idx !== -1) meshData.bubbles.splice(idx, 1);
    meshData.group.remove(css2d);
    div.remove();
  }, duration);
}

function clearThoughtBubbles(agentId) {
  const meshData = agentMeshes.get(agentId);
  if (!meshData) return;
  for (const b of meshData.bubbles) {
    b.css2d.element.classList.add('fading');
  }
  // Remove after fade
  setTimeout(() => {
    for (const b of meshData.bubbles) {
      meshData.group.remove(b.css2d);
      b.css2d.element.remove();
    }
    meshData.bubbles = [];
  }, 600);
}

// ─── Thinking Log ────────────────────────────────────────────────────────────
const MAX_THINKING_ENTRIES = 12;

function appendThinkingEntry(agentId, toolName, text) {
  const meshData = agentMeshes.get(agentId);
  if (!meshData) return;

  const container = meshData.activityLabel?.element;
  if (!container) return;

  // Create new entry
  const entry = document.createElement('div');
  entry.className = 'thinking-entry';
  entry.dataset.tool = toolName || 'thinking';

  const icon = document.createElement('span');
  icon.className = 'te-icon';
  icon.textContent = getToolIcon(toolName);

  const txt = document.createElement('span');
  txt.className = 'te-text';
  txt.textContent = text;
  txt.title = text;

  entry.appendChild(icon);
  entry.appendChild(txt);
  container.appendChild(entry);

  // Track for cleanup
  meshData.thinkingLog.push({ el: entry, time: Date.now() });

  // Trim old entries
  while (meshData.thinkingLog.length > MAX_THINKING_ENTRIES) {
    const old = meshData.thinkingLog.shift();
    old.el.remove();
  }

  // Auto-scroll to bottom
  container.scrollTop = container.scrollHeight;

  // Show the log
  container.classList.remove('hidden');
  meshData.lastToolTime = Date.now();
}

function clearThinkingLog(agentId) {
  const meshData = agentMeshes.get(agentId);
  if (!meshData) return;
  const container = meshData.activityLabel?.element;
  if (container) container.innerHTML = '';
  meshData.thinkingLog = [];
}

// ─── Connection Lines + Energy Flow ────────────────────────────────────────────
const FLOW_PARTICLES_PER_LINE = 4;

function createConnectionLine(parentId, childId) {
  const key = `${parentId}-${childId}`;
  if (connectionLines.has(key)) return;

  const parentMesh = agentMeshes.get(parentId);
  const childMesh = agentMeshes.get(childId);
  if (!parentMesh || !childMesh) return;

  const points = [parentMesh.group.position.clone(), childMesh.group.position.clone()];
  const geo = new THREE.BufferGeometry().setFromPoints(points);
  const currentTheme = THEMES[appState.config?.display?.theme || 'purple'];
  const lineColor = currentTheme ? new THREE.Color(currentTheme.accent) : new THREE.Color(0x4488ff);
  const mat = new THREE.LineBasicMaterial({
    color: lineColor,
    transparent: true,
    opacity: 0.3
  });
  const line = new THREE.Line(geo, mat);
  scene.add(line);

  // Flash bright on creation for spawn animation
  if (appState.config?.features?.spawnAnimations ?? true) {
    mat.opacity = 0.9;
  }

  // Create energy flow particles along the line
  const flowParticles = [];
  for (let i = 0; i < FLOW_PARTICLES_PER_LINE; i++) {
    const flowGeo = new THREE.SphereGeometry(0.04, 4, 4);
    const flowMat = new THREE.MeshBasicMaterial({
      color: lineColor,
      transparent: true,
      opacity: 0.6,
      blending: THREE.AdditiveBlending,
      depthWrite: false
    });
    const flowMesh = new THREE.Mesh(flowGeo, flowMat);
    scene.add(flowMesh);
    flowParticles.push({
      mesh: flowMesh,
      t: i / FLOW_PARTICLES_PER_LINE, // Spread evenly along line
      speed: 0.3 + Math.random() * 0.2
    });
  }

  connectionLines.set(key, { line, parentId, childId, flowParticles });
}

function updateConnectionLines(time, dt) {
  for (const [key, data] of connectionLines) {
    const parentMesh = agentMeshes.get(data.parentId);
    const childMesh = agentMeshes.get(data.childId);
    if (!parentMesh || !childMesh) {
      // Cleanup flow particles if connection is dead
      if (data.flowParticles) {
        for (const fp of data.flowParticles) {
          scene.remove(fp.mesh);
          fp.mesh.geometry.dispose();
          fp.mesh.material.dispose();
        }
      }
      scene.remove(data.line);
      data.line.geometry.dispose();
      data.line.material.dispose();
      connectionLines.delete(key);
      continue;
    }

    const childAgent = childMesh.agent;
    const isActive = childAgent?.status !== 'completed';
    const targetOpacity = isActive ? 0.3 : 0.05;
    data.line.material.opacity += (targetOpacity - data.line.material.opacity) * 0.1;

    const pPos = parentMesh.group.position;
    const cPos = childMesh.group.position;

    // Update line endpoints
    const positions = data.line.geometry.attributes.position.array;
    positions[0] = pPos.x; positions[1] = pPos.y; positions[2] = pPos.z;
    positions[3] = cPos.x; positions[4] = cPos.y; positions[5] = cPos.z;
    data.line.geometry.attributes.position.needsUpdate = true;

    // Animate energy flow particles along the line
    if (data.flowParticles) {
      for (const fp of data.flowParticles) {
        if (isActive) {
          fp.t += fp.speed * dt;
          if (fp.t > 1) fp.t -= 1;

          // Lerp position from parent to child
          fp.mesh.position.lerpVectors(pPos, cPos, fp.t);

          // Pulse brightness near endpoints, dimmer in the middle
          const edgeDist = Math.min(fp.t, 1 - fp.t);
          const brightness = 0.3 + edgeDist * 1.4;
          fp.mesh.material.opacity = brightness * data.line.material.opacity * 2;
          fp.mesh.scale.setScalar(0.6 + Math.sin(time * 3 + fp.t * 6) * 0.3);
          fp.mesh.visible = true;
        } else {
          fp.mesh.visible = false;
        }
      }
    }
  }
}

// ─── Particles ─────────────────────────────────────────────────────────────────
const MAX_PARTICLES = 300;

function spawnParticle(agentId, toolName) {
  const meshData = agentMeshes.get(agentId);
  if (!meshData) return;

  if (particles.length >= MAX_PARTICLES) {
    const oldest = particles.shift();
    scene.remove(oldest.mesh);
    oldest.mesh.geometry.dispose();
    oldest.mesh.material.dispose();
  }

  const color = hexToThreeColor(getToolColor(toolName));
  const lifetime = appState.config?.animation?.particleLifetime || 60000;
  const orbRadius = (meshData.radius || 1) + 0.5 + Math.random() * 1.5;

  const geo = new THREE.SphereGeometry(0.06 + Math.random() * 0.04, 6, 6);
  const mat = new THREE.MeshBasicMaterial({
    color,
    transparent: true,
    opacity: 0.85
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.position.copy(meshData.group.position);

  scene.add(mesh);
  particles.push({
    mesh,
    life: lifetime,
    maxLife: lifetime,
    sourceId: agentId,
    angle: Math.random() * Math.PI * 2,
    angleSpeed: (0.5 + Math.random() * 1.5) * (Math.random() < 0.5 ? 1 : -1),
    radius: orbRadius,
    yOffset: (Math.random() - 0.5) * 2,
    yDrift: (Math.random() - 0.5) * 0.3,
    tilt: (Math.random() - 0.5) * 0.6,
    vx: 0, vy: 0, vz: 0,
    ox: 0, oy: 0, oz: 0,
    collisionRadius: 0.15,
    persistent: lifetime >= 120000
  });

  // Pulse the agent orb + glow flash
  meshData.sphere.material.emissiveIntensity = 1.0;
  meshData.glowShell.material.opacity = 0.3;
  meshData.glowShell.scale.setScalar(1.2);
  setTimeout(() => {
    if (meshData.sphere.material) {
      const agent = appState.agents.find(a => a.id === agentId);
      meshData.sphere.material.emissiveIntensity = agent?.status === 'active' ? 0.5 : 0.1;
      meshData.glowShell.material.opacity = 0.12;
      meshData.glowShell.scale.setScalar(1.0);
    }
  }, 300);
}

// Burst particles for spawn/completion animations
function spawnBurstParticle(agentId, colorHex) {
  const meshData = agentMeshes.get(agentId);
  if (!meshData) return;

  if (particles.length >= MAX_PARTICLES) {
    const oldest = particles.shift();
    scene.remove(oldest.mesh);
    oldest.mesh.geometry.dispose();
    oldest.mesh.material.dispose();
  }

  const color = hexToThreeColor(colorHex);
  const geo = new THREE.SphereGeometry(0.08, 6, 6);
  const mat = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.9 });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.position.copy(meshData.group.position);
  scene.add(mesh);

  // Random outward velocity
  const theta = Math.random() * Math.PI * 2;
  const phi = Math.random() * Math.PI;
  const speed = 3 + Math.random() * 4;

  particles.push({
    mesh,
    life: 1500,
    maxLife: 1500,
    sourceId: null, // Not orbiting - free-flying
    angle: 0, angleSpeed: 0, radius: 0,
    yOffset: 0, yDrift: 0, tilt: 0,
    vx: Math.sin(phi) * Math.cos(theta) * speed,
    vy: Math.cos(phi) * speed * 0.5,
    vz: Math.sin(phi) * Math.sin(theta) * speed,
    ox: 0, oy: 0, oz: 0,
    collisionRadius: 0.1,
    freeFlying: true
  });
}

// Arc particles that fly from source agent toward target (parent) agent
function spawnArcParticle(sourceId, targetId, colorHex) {
  const sourceMesh = agentMeshes.get(sourceId);
  const targetMesh = agentMeshes.get(targetId);
  if (!sourceMesh || !targetMesh) return;

  if (particles.length >= MAX_PARTICLES) {
    const oldest = particles.shift();
    scene.remove(oldest.mesh);
    oldest.mesh.geometry.dispose();
    oldest.mesh.material.dispose();
  }

  const color = hexToThreeColor(colorHex);
  const geo = new THREE.SphereGeometry(0.06, 6, 6);
  const mat = new THREE.MeshBasicMaterial({
    color,
    transparent: true,
    opacity: 0.9,
    blending: THREE.AdditiveBlending,
    depthWrite: false
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.position.copy(sourceMesh.group.position);
  scene.add(mesh);

  // Velocity toward parent with random spread for organic arcing
  const dir = new THREE.Vector3().subVectors(targetMesh.group.position, sourceMesh.group.position);
  const dist = dir.length();
  dir.normalize();

  // Add perpendicular scatter for arc effect
  const up = new THREE.Vector3(0, 1, 0);
  const perp = new THREE.Vector3().crossVectors(dir, up).normalize();
  const scatter = (Math.random() - 0.5) * 3;
  const yScatter = (Math.random() - 0.5) * 2;

  const spd = dist * 0.8 + Math.random() * 2;

  particles.push({
    mesh,
    life: 2000,
    maxLife: 2000,
    sourceId: null,
    angle: 0, angleSpeed: 0, radius: 0,
    yOffset: 0, yDrift: 0, tilt: 0,
    vx: dir.x * spd + perp.x * scatter,
    vy: dir.y * spd + yScatter,
    vz: dir.z * spd + perp.z * scatter,
    ox: 0, oy: 0, oz: 0,
    collisionRadius: 0.08,
    freeFlying: true,
    targetId, // Used for homing behavior
    homing: true
  });
}

let _particleCollisionFrame = 0;
function updateParticles(dt) {
  const speed = appState.config?.animation?.speed || 1;
  const dtScaled = dt * speed;

  // Particle collision — run every 3rd frame (visual difference is negligible)
  if (++_particleCollisionFrame % 3 === 0) {
    const BOUNCE_STRENGTH = 4.0;
    const n = particles.length;
    for (let i = 0; i < n; i++) {
      const a = particles[i];
      if (a.life <= 0 || a.freeFlying) continue;
      const ax = a.mesh.position.x, ay = a.mesh.position.y, az = a.mesh.position.z;
      const sid = a.sourceId;

      for (let j = i + 1; j < n; j++) {
        const b = particles[j];
        if (b.life <= 0 || b.freeFlying) continue;
        // Only collide particles orbiting the same agent
        if (b.sourceId !== sid) continue;

        const dx = ax - b.mesh.position.x;
        const dy = ay - b.mesh.position.y;
        const dz = az - b.mesh.position.z;
        const distSq = dx * dx + dy * dy + dz * dz;
        const minDist = a.collisionRadius + b.collisionRadius;

        if (distSq < minDist * minDist && distSq > 0.0001) {
          const dist = Math.sqrt(distSq);
          const nx = dx / dist, ny = dy / dist, nz = dz / dist;
          const impulse = BOUNCE_STRENGTH * (minDist - dist);
          a.vx += nx * impulse;
          a.vy += ny * impulse;
          a.vz += nz * impulse;
          b.vx -= nx * impulse;
          b.vy -= ny * impulse;
          b.vz -= nz * impulse;
        }
      }
    }
  }

  // Update positions & lifetime
  for (let i = particles.length - 1; i >= 0; i--) {
    const p = particles[i];

    // Persistent orbital particles: don't age while source agent exists
    if (p.persistent && p.sourceId) {
      if (agentMeshes.has(p.sourceId)) {
        p.life = p.maxLife; // hold at full life
      } else {
        // Agent gone — transition to short fadeout
        p.persistent = false;
        p.maxLife = 3000;
        p.life = 3000;
      }
    }

    p.life -= dt * 1000 * speed;
    if (p.life <= 0) {
      scene.remove(p.mesh);
      p.mesh.geometry.dispose();
      p.mesh.material.dispose();
      // Swap-and-pop: O(1) removal instead of O(n) splice
      const last = particles.length - 1;
      if (i !== last) particles[i] = particles[last];
      particles.pop();
      continue;
    }

    const t = p.life / p.maxLife;

    if (p.freeFlying) {
      // Homing particles: steer toward target agent
      if (p.homing && p.targetId) {
        const target = agentMeshes.get(p.targetId);
        if (target) {
          const dx = target.group.position.x - p.mesh.position.x;
          const dy = target.group.position.y - p.mesh.position.y;
          const dz = target.group.position.z - p.mesh.position.z;
          const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
          if (dist > 0.3) {
            // Gentle steering — increases as particle ages (gets more urgent)
            const steerForce = 3 + (1 - t) * 8;
            p.vx += (dx / dist) * steerForce * dtScaled;
            p.vy += (dy / dist) * steerForce * dtScaled;
            p.vz += (dz / dist) * steerForce * dtScaled;
          } else {
            // Close to target — absorb (kill particle)
            p.life = 0;
          }
        }
      }

      // Free-flying burst particles - just apply velocity with drag
      p.vx *= 0.96;
      p.vy *= 0.96;
      p.vz *= 0.96;
      if (!p.homing) p.vy -= 2 * dtScaled; // gravity (not for homing)
      p.mesh.position.x += p.vx * dtScaled;
      p.mesh.position.y += p.vy * dtScaled;
      p.mesh.position.z += p.vz * dtScaled;
      p.mesh.material.opacity = t * 0.9;
      p.mesh.scale.setScalar(0.5 + t * 0.5);
      continue;
    }

    // Orbital particles
    p.ox += p.vx * dtScaled;
    p.oy += p.vy * dtScaled;
    p.oz += p.vz * dtScaled;
    const dampen = Math.pow(0.04, dtScaled);
    p.vx *= dampen;
    p.vy *= dampen;
    p.vz *= dampen;
    const restore = Math.pow(0.1, dtScaled);
    p.ox *= restore;
    p.oy *= restore;
    p.oz *= restore;

    const source = agentMeshes.get(p.sourceId);
    if (source) {
      p.angle += p.angleSpeed * dtScaled;
      p.yOffset += p.yDrift * dtScaled;

      const r = p.radius + (1 - t) * 0.3;
      const cx = source.group.position.x;
      const cy = source.group.position.y;
      const cz = source.group.position.z;
      p.mesh.position.set(
        cx + Math.cos(p.angle) * r + p.ox,
        cy + p.yOffset + Math.sin(p.angle * 0.7 + p.tilt) * 0.4 + p.oy,
        cz + Math.sin(p.angle) * r + p.oz
      );
    }

    p.mesh.material.opacity = t < 0.1 ? (t / 0.1) * 0.75 : 0.75;
    const scale = 0.8 + t * 0.2;
    p.mesh.scale.setScalar(scale);
  }

  // Proximity lines between nearby particles
  updateProximityLines();
}

let proxLineIdx = 0;
let proxLineMode = 'fat'; // 'fat' (Line2) or 'thin' (THREE.Line)
const _orbitals = []; // reused every frame

function clearProximityPool() {
  for (const pl of proximityLines) {
    scene.remove(pl.line);
    pl.line.geometry.dispose();
    pl.mat.dispose();
  }
  proximityLines.length = 0;
  proxLineIdx = 0;
}

function getProximityLine(useFat) {
  if (proxLineIdx < proximityLines.length) {
    return proximityLines[proxLineIdx++];
  }
  let line, mat, geo;
  if (useFat) {
    geo = new LineGeometry();
    geo.setPositions([0,0,0, 0,0,0]);
    mat = new LineMaterial({
      color: 0x9966ff, linewidth: 2, transparent: true, opacity: 0,
      depthWrite: false, resolution: new THREE.Vector2(window.innerWidth, window.innerHeight)
    });
    line = new Line2(geo, mat);
    line.computeLineDistances();
  } else {
    geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute([0,0,0, 0,0,0], 3));
    mat = new THREE.LineBasicMaterial({ color: 0x9966ff, transparent: true, opacity: 0, depthWrite: false });
    line = new THREE.Line(geo, mat);
  }
  line.frustumCulled = false;
  scene.add(line);
  proximityLines.push({ line, mat, geo, fat: useFat });
  proxLineIdx++;
  return proximityLines[proxLineIdx - 1];
}

function updateProximityLines() {
  const proxDist = appState.config?.display?.wireDistance ?? 1.8;
  const proxDistSq = proxDist * proxDist;
  const wireThickness = appState.config?.display?.wireThickness ?? 2;
  const useFat = wireThickness > 1;
  const wantMode = useFat ? 'fat' : 'thin';

  // If line type changed, flush the pool
  if (wantMode !== proxLineMode) {
    clearProximityPool();
    proxLineMode = wantMode;
  }

  proxLineIdx = 0;

  _orbitals.length = 0;
  for (let i = 0; i < particles.length; i++) {
    const p = particles[i];
    if (p.life > 0 && !p.freeFlying) _orbitals.push(p);
  }

  for (let i = 0; i < _orbitals.length; i++) {
    const a = _orbitals[i];
    const ax = a.mesh.position.x, ay = a.mesh.position.y, az = a.mesh.position.z;
    for (let j = i + 1; j < _orbitals.length; j++) {
      const b = _orbitals[j];
      const dx = ax - b.mesh.position.x;
      const dy = ay - b.mesh.position.y;
      const dz = az - b.mesh.position.z;
      const distSq = dx * dx + dy * dy + dz * dz;

      if (distSq < proxDistSq && distSq > 0.001) {
        const dist = Math.sqrt(distSq);
        const t = 1 - dist / proxDist;
        const opacity = t * 0.4;

        const pl = getProximityLine(useFat);
        if (useFat) {
          pl.geo.setPositions([ax, ay, az, b.mesh.position.x, b.mesh.position.y, b.mesh.position.z]);
          pl.mat.linewidth = wireThickness;
        } else {
          const pos = pl.geo.attributes.position;
          pos.array[0] = ax; pos.array[1] = ay; pos.array[2] = az;
          pos.array[3] = b.mesh.position.x; pos.array[4] = b.mesh.position.y; pos.array[5] = b.mesh.position.z;
          pos.needsUpdate = true;
        }
        pl.mat.opacity = opacity;
        pl.line.visible = true;
      }
    }
  }

  for (let i = proxLineIdx; i < proximityLines.length; i++) {
    proximityLines[i].line.visible = false;
  }
}


// ─── File Nodes ────────────────────────────────────────────────────────────────
function addFileNode(filePath, agentId) {
  if (fileNodes.has(filePath)) {
    const fn = fileNodes.get(filePath);
    fn.life = 8000;
    fn.mesh.material.opacity = 0.6;
    return;
  }

  const maxFiles = appState.config?.maxFileNodes || 50;
  if (fileNodes.size >= maxFiles) {
    let oldest = null;
    let oldestLife = Infinity;
    for (const [path, fn] of fileNodes) {
      if (fn.life < oldestLife) { oldestLife = fn.life; oldest = path; }
    }
    if (oldest) removeFileNode(oldest);
  }

  const agentMesh = agentMeshes.get(agentId);
  const basePos = agentMesh ? agentMesh.group.position : new THREE.Vector3(0, 0, 0);

  const geo = new THREE.BoxGeometry(0.2, 0.2, 0.2);
  const mat = new THREE.MeshPhongMaterial({
    color: 0x00cccc,
    emissive: 0x00cccc,
    emissiveIntensity: 0.3,
    transparent: true,
    opacity: 0.6
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.position.set(
    basePos.x + (Math.random() - 0.5) * 4,
    basePos.y + (Math.random() - 0.5) * 3 - 1,
    basePos.z + (Math.random() - 0.5) * 4
  );
  mesh.rotation.set(Math.random(), Math.random(), Math.random());
  scene.add(mesh);
  fileNodes.set(filePath, { mesh, life: 8000, path: filePath });
}

function removeFileNode(path) {
  const fn = fileNodes.get(path);
  if (fn) {
    scene.remove(fn.mesh);
    fn.mesh.geometry.dispose();
    fn.mesh.material.dispose();
    fileNodes.delete(path);
  }
}

function updateFileNodes(dt) {
  const speed = appState.config?.animation?.speed || 1;
  for (const [path, fn] of fileNodes) {
    fn.life -= dt * 1000 * speed;
    if (fn.life <= 0) {
      removeFileNode(path);
      continue;
    }
    const t = Math.min(fn.life / 3000, 1);
    fn.mesh.material.opacity = t * 0.6;
    fn.mesh.rotation.y += 0.005 * speed;
  }
}

// ─── Raycaster (Hover Tooltips + Click) ───────────────────────────────────────
const raycaster = new THREE.Raycaster();
const mouse = new THREE.Vector2();
let hoveredAgent = null;

function setupRaycaster() {
  window.addEventListener('mousemove', (e) => {
    mouse.x = (e.clientX / window.innerWidth) * 2 - 1;
    mouse.y = -(e.clientY / window.innerHeight) * 2 + 1;
    checkHover(e.clientX, e.clientY);
  });

  // Click to focus
  window.addEventListener('click', (e) => {
    // Don't focus if clicking UI
    if (e.target.closest('#side-panel, #top-bar, #context-menu')) return;
    hideContextMenu();

    raycaster.setFromCamera(mouse, camera);
    const spheres = [];
    for (const [id, data] of agentMeshes) spheres.push(data.sphere);
    const intersects = raycaster.intersectObjects(spheres);

    if (intersects.length > 0) {
      for (const [id, data] of agentMeshes) {
        if (data.sphere === intersects[0].object) {
          setFocusedAgent(id);
          break;
        }
      }
    }
  });
}

function checkHover(mouseX, mouseY) {
  raycaster.setFromCamera(mouse, camera);
  const spheres = [];
  for (const [id, data] of agentMeshes) spheres.push(data.sphere);

  const intersects = raycaster.intersectObjects(spheres);
  const tooltip = document.getElementById('tooltip');

  if (intersects.length > 0) {
    const hit = intersects[0].object;
    let foundAgent = null;
    for (const [id, data] of agentMeshes) {
      if (data.sphere === hit) { foundAgent = data.agent; break; }
    }
    if (foundAgent) {
      hoveredAgent = foundAgent;
      const lastTool = foundAgent.toolCalls?.[foundAgent.toolCalls.length - 1];
      tooltip.querySelector('.tooltip-title').textContent = `${foundAgent.name} (${foundAgent.type})`;
      tooltip.querySelector('.tooltip-detail').textContent = [
        `Status: ${foundAgent.status}`,
        `Type: ${foundAgent.subagentType || 'main'}`,
        `Tool calls: ${foundAgent.toolCallCount || 0}`,
        lastTool ? `Last tool: ${lastTool.tool} - ${lastTool.inputSummary || ''}` : ''
      ].filter(Boolean).join(' | ');
      tooltip.style.display = 'block';
      tooltip.style.left = mouseX + 16 + 'px';
      tooltip.style.top = mouseY + 16 + 'px';
    }
  } else {
    hoveredAgent = null;
    tooltip.style.display = 'none';
  }
}

// ─── Context Menu ──────────────────────────────────────────────────────────────
function setupContextMenu() {
  window.addEventListener('contextmenu', (e) => {
    if (e.target.closest('#side-panel, #top-bar')) return;

    raycaster.setFromCamera(mouse, camera);
    const spheres = [];
    for (const [id, data] of agentMeshes) spheres.push(data.sphere);
    const intersects = raycaster.intersectObjects(spheres);

    if (intersects.length > 0) {
      e.preventDefault();
      for (const [id, data] of agentMeshes) {
        if (data.sphere === intersects[0].object) {
          contextMenuAgentId = id;
          showContextMenu(e.clientX, e.clientY, data);
          break;
        }
      }
    } else {
      hideContextMenu();
    }
  });

  const menu = document.getElementById('context-menu');
  menu.addEventListener('click', (e) => {
    const action = e.target.closest('.ctx-item')?.dataset.action;
    if (!action || !contextMenuAgentId) return;
    handleContextAction(action, contextMenuAgentId);
    hideContextMenu();
  });

  window.addEventListener('click', (e) => {
    if (!e.target.closest('#context-menu')) hideContextMenu();
  });
  window.addEventListener('scroll', hideContextMenu);
}

function showContextMenu(x, y, meshData) {
  const menu = document.getElementById('context-menu');
  const hideItem = menu.querySelector('[data-action="hide"]');
  if (hideItem) hideItem.textContent = meshData.hidden ? 'Show Agent' : 'Hide Agent';
  menu.style.display = 'block';
  menu.style.left = x + 'px';
  menu.style.top = y + 'px';
}

function hideContextMenu() {
  document.getElementById('context-menu').style.display = 'none';
  contextMenuAgentId = null;
}

function handleContextAction(action, agentId) {
  const meshData = agentMeshes.get(agentId);
  if (!meshData) return;

  switch (action) {
    case 'focus':
      setFocusedAgent(agentId);
      break;
    case 'details':
      window.switchTab('agents');
      break;
    case 'copy': {
      const info = JSON.stringify(meshData.agent, null, 2);
      navigator.clipboard.writeText(info).catch(() => {});
      break;
    }
    case 'hide':
      meshData.hidden = !meshData.hidden;
      meshData.group.visible = !meshData.hidden;
      break;
  }
}

// ─── Attention System ──────────────────────────────────────────────────────────
function setFocusedAgent(agentId) {
  focusedAgentId = agentId;
  // Manual click: start a pan to the clicked orb
  startFocusPan(agentId);
}

function startFocusPan(agentId) {
  if (!(appState.config?.display?.autoFocus ?? true)) return;
  const data = agentMeshes.get(agentId);
  if (!data) return;

  // Same orb firing again while already focused — no new pan needed
  if (focusedAgentId === agentId && !focusPanning) return;

  // Switching targets mid-pan — don't fully reset, just redirect
  if (focusedAgentId !== agentId && focusPanning) {
    focusPanProgress = Math.max(focusPanProgress * 0.3, 0);
  } else {
    focusPanProgress = 0;
  }

  focusedAgentId = agentId;
  focusPanning = true;
  controls.enabled = false;
}

function updateAttention(dt) {
  if (!(appState.config?.display?.autoFocus ?? true)) {
    // If auto-focus is off, make sure controls are unlocked
    if (!controls.enabled) controls.enabled = true;
    focusPanning = false;
    return;
  }

  if (!focusPanning) return;

  const targetData = focusedAgentId ? agentMeshes.get(focusedAgentId) : null;
  if (!targetData) {
    // Target gone — release controls
    focusPanning = false;
    controls.enabled = true;
    return;
  }

  // Advance pan progress
  focusPanProgress += dt * FOCUS_PAN_SPEED;
  if (focusPanProgress > 1) focusPanProgress = 1;

  // Smooth ease-out curve
  const t = 1 - Math.pow(1 - focusPanProgress, 3);

  const targetPos = targetData.group.position;
  focusTarget.lerp(targetPos, t * 0.15 + 0.02);
  controls.target.copy(focusTarget);

  // Pan complete — unlock controls
  if (focusPanProgress >= 1) {
    focusPanning = false;
    controls.enabled = true;
  }
}

// ─── Orb Collision Physics ──────────────────────────────────────────────────
const _orbArr = []; // reused every frame
function updateOrbCollisions(dt) {
  _orbArr.length = 0;
  for (const v of agentMeshes.values()) _orbArr.push(v);
  const len = _orbArr.length;
  if (len < 2) return;

  const BOUNCE = 10.0;
  const DAMPEN = 0.88;
  const RESTORE = 1.8;

  for (let i = 0; i < len; i++) {
    const a = _orbArr[i];
    const ap = a.group.position;

    for (let j = i + 1; j < len; j++) {
      const b = _orbArr[j];
      const bp = b.group.position;

      const dx = ap.x - bp.x;
      const dy = ap.y - bp.y;
      const dz = ap.z - bp.z;
      const distSq = dx * dx + dy * dy + dz * dz;
      // Exclusion zones sized to prevent visual overlap (orb + ring + glow)
      const bothMain = a.agent.type === 'main' && b.agent.type === 'main';
      const eitherMain = a.agent.type === 'main' || b.agent.type === 'main';
      const buffer = bothMain ? 6.0 : eitherMain ? 3.5 : 2.5;
      const minDist = (a.radius || 1) + (b.radius || 0.7) + buffer;

      if (distSq < minDist * minDist) {
        let dist, nx, ny, nz;
        if (distSq < 0.01) {
          // Nearly identical positions — random kick to separate
          nx = Math.random() - 0.5; ny = Math.random() - 0.5; nz = Math.random() - 0.5;
          const mag = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1;
          nx /= mag; ny /= mag; nz /= mag;
          dist = 0.1;
        } else {
          dist = Math.sqrt(distSq);
          nx = dx / dist; ny = dy / dist; nz = dz / dist;
        }
        const overlap = minDist - dist;
        const impulse = BOUNCE * overlap;

        // Hard separation: immediately push positions apart by half the overlap
        const hardPush = overlap * 0.3;
        ap.x += nx * hardPush; ap.y += ny * hardPush; ap.z += nz * hardPush;
        bp.x -= nx * hardPush; bp.y -= ny * hardPush; bp.z -= nz * hardPush;

        a.vx += nx * impulse;
        a.vy += ny * impulse;
        a.vz += nz * impulse;
        b.vx -= nx * impulse;
        b.vy -= ny * impulse;
        b.vz -= nz * impulse;
      }
    }
  }

  for (let i = 0; i < len; i++) {
    const o = _orbArr[i];
    const pos = o.group.position;
    const rest = o.restPos;

    o.vx += (rest.x - pos.x) * RESTORE * dt;
    o.vy += (rest.y - pos.y) * RESTORE * dt;
    o.vz += (rest.z - pos.z) * RESTORE * dt;
    o.vx *= DAMPEN;
    o.vy *= DAMPEN;
    o.vz *= DAMPEN;
    pos.x += o.vx * dt;
    pos.y += o.vy * dt;
    pos.z += o.vz * dt;
  }
}

// ─── Context-Aware Animations ─────────────────────────────────────────────────
// Heartbeat waveform: double-pulse (lub-dub) then rest, like a real heartbeat
// Smooth heartbeat waveform: gentle double-pulse (lub-dub)
// Uses wider gaussians so pulses span ~10+ frames even at high BPM
function heartbeat(t, bpm) {
  const period = 60 / bpm;
  const phase = (t % period) / period; // 0..1 within one cycle
  // Wider gaussians (6 and 7 instead of 12 and 14) for smooth animation
  const g1 = (phase - 0.0) * 6;
  const beat1 = Math.exp(-(g1 * g1));
  const g2 = (phase - 0.22) * 7;
  const beat2 = Math.exp(-(g2 * g2)) * 0.5;
  return beat1 + beat2;
}

function updateContextAnimations(time, dt, speed) {
  const nowMs = Date.now();
  for (const [id, data] of agentMeshes) {
    const agent = data.agent;
    if (agent.status !== 'active') continue;

    const timeSinceLastTool = nowMs - (data.lastToolTime || 0);
    // Activity fades smoothly from working to idle over 5 seconds
    const activity = Math.max(0, Math.min(1, 1 - (timeSinceLastTool - 1000) / 4000));

    // Heartbeat only fires during active tool execution, dead still when idle
    const bpm = 45;
    const hb = activity > 0.01 ? heartbeat(time, bpm) * activity : 0;

    // Scale: steady at idle, pulses only on tool execution
    const breathScale = 1.0 + hb * 0.035;
    data.sphere.scale.setScalar(breathScale);

    // Bob: gentle non-accumulating drift (always, even idle)
    if (data.baseRestY == null) data.baseRestY = data.restPos.y;
    data.restPos.y = data.baseRestY + Math.sin(time * 0.5 + (data.baseRestY || 0)) * 0.02;

    // Ring: very slow idle rotation, faster when working
    data.ring.rotation.z += (0.002 + activity * 0.018) * speed;

    // Emissive: calm at idle, pulses with heartbeat on execution
    data.sphere.material.emissiveIntensity = 0.2 + hb * 0.4;

    // Glow shell: dim at idle, pulses on execution
    data.glowShell.material.opacity = 0.05 + hb * 0.08;
    data.glowShell.scale.setScalar(1.0 + hb * 0.04);

    // Tool-specific ring reactions
    if (data.lastToolName === 'Grep' || data.lastToolName === 'Glob') {
      if (timeSinceLastTool < 1000) {
        const expand = 1 + (1 - timeSinceLastTool / 1000) * 0.3;
        data.ring.scale.setScalar(expand);
      } else {
        data.ring.scale.setScalar(1);
      }
    } else if (data.lastToolName === 'Read' && timeSinceLastTool < 600) {
      // Brief cyan tint on read
      const flash = 1 - timeSinceLastTool / 600;
      data.ring.material.color.setRGB(flash * 0.2, 0.3 + flash * 0.7, 0.5 + flash * 0.5);
    } else if ((data.lastToolName === 'Write' || data.lastToolName === 'Edit') && timeSinceLastTool < 600) {
      // Brief orange tint on write
      const flash = 1 - timeSinceLastTool / 600;
      data.ring.material.color.setRGB(0.5 + flash * 0.5, 0.2 + flash * 0.3, flash * 0.1);
    } else {
      data.ring.scale.setScalar(1);
      // Reset ring color to agent color
      const agentColor = data.sphere.material.color;
      data.ring.material.color.copy(agentColor);
    }

    // Thinking log disabled — content now in agent panel
  }
}

// ─── Spawn Animation Update ──────────────────────────────────────────────────
function updateSpawnAnimations() {
  const now = performance.now();
  for (const [id, data] of agentMeshes) {
    if (!data.spawnAnim) continue;
    const { startTime, duration, targetPos } = data.spawnAnim;
    const elapsed = now - startTime;
    const t = Math.min(elapsed / duration, 1);

    // Spring-overshoot easing
    const spring = t < 0.6
      ? (t / 0.6) * 1.2
      : 1.2 - (t - 0.6) / 0.4 * 0.2;
    const scale = Math.min(spring, 1.2) * (t < 1 ? 1 : 1);

    data.group.scale.setScalar(t >= 1 ? 1 : scale);

    // Lerp position from parent to target
    const parentMesh = agentMeshes.get(data.agent.parentId);
    const startPos = parentMesh ? parentMesh.group.position : targetPos;
    data.group.position.lerpVectors(startPos, targetPos, Math.min(t * 1.5, 1));
    data.restPos.copy(targetPos);

    if (t >= 1) {
      data.spawnAnim = null;
      data.group.scale.setScalar(1);
      data.group.position.copy(targetPos);
    }
  }
}

// ─── Animation Loop ────────────────────────────────────────────────────────────
let lastFrameTime = 0;
const _tempDir = new THREE.Vector3(); // reused every frame for camera direction

function animate() {
  requestAnimationFrame(animate);

  const now = performance.now();
  const maxFps = appState.config?.animation?.maxFps ?? 0;
  if (maxFps > 0) {
    const interval = 1000 / maxFps;
    if (now - lastFrameTime < interval) return;
    // Snap to ideal cadence to prevent drift — actual FPS stays accurate to slider
    lastFrameTime = now - ((now - lastFrameTime) % interval);
  }

  const dt = clock.getDelta();
  const anim = appState.config?.animation;
  const disp = appState.config?.display;
  const speed = anim?.speed || 1;

  controls.autoRotate = anim?.autoRotate ?? true;
  controls.autoRotateSpeed = (anim?.orbitSpeed || 0.002) * 250;
  controls.update();

  const time = clock.getElapsedTime();

  updateSpawnAnimations();
  updateContextAnimations(time, dt, speed);
  updateAttention(dt);
  updateOrbCollisions(dt * speed);
  updateConnectionLines(time, dt);
  updateParticles(dt);
  updateFileNodes(dt);

  // GPU background: two-pass render
  updateBackground();
  renderer.autoClear = false;
  renderer.clear();
  if (bgRunning && bgScene && bgCamera) {
    renderer.render(bgScene, bgCamera);
  }
  renderer.render(scene, camera);
  css2DRenderer.render(scene, camera);

  // FPS counter
  fpsFrames++;
  if (now - fpsLastTime >= 1000) {
    if (!fpsEl) fpsEl = document.getElementById('fps-counter');
    if (fpsEl) fpsEl.textContent = fpsFrames;
    fpsFrames = 0;
    fpsLastTime = now;
  }
}

// ─── UI Updates ────────────────────────────────────────────────────────────────
// Cache DOM elements once — avoids getElementById per second
let _uiEls = null;
function _getUiEls() {
  if (_uiEls) return _uiEls;
  _uiEls = {
    dot: document.getElementById('status-dot'),
    label: document.getElementById('status-label'),
    sessInfo: document.getElementById('session-info'),
    agents: document.getElementById('stat-agents'),
    active: document.getElementById('stat-active'),
    tools: document.getElementById('stat-tools'),
    rate: document.getElementById('stat-rate'),
    errors: document.getElementById('stat-errors'),
    files: document.getElementById('stat-files'),
    changes: document.getElementById('stat-changes'),
    tokens: document.getElementById('stat-tokens'),
    cost: document.getElementById('stat-cost'),
    turns: document.getElementById('stat-turns'),
    uptime: document.getElementById('stat-uptime'),
  };
  return _uiEls;
}

function updateUI() {
  const { session, agents, stats } = appState;
  const ui = _getUiEls();

  const dot = ui.dot;
  const label = ui.label;
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    dot.className = 'status-dot disconnected';
    label.textContent = 'Disconnected';
  } else if (session?.status === 'ended') {
    dot.className = 'status-dot ended';
    label.textContent = 'Session Ended';
  } else if (session) {
    dot.className = 'status-dot';
    label.textContent = 'Active';
  } else {
    dot.className = 'status-dot disconnected';
    label.textContent = 'No Session';
  }

  const sessCount = stats.activeSessionCount || 0;
  ui.sessInfo.textContent =
    sessCount > 0 ? `${sessCount} active session${sessCount > 1 ? 's' : ''}` : 'Waiting for session...';

  ui.agents.textContent = stats.agentCount || agents.length || 0;
  ui.active.textContent = stats.activeTools || 0;
  ui.tools.textContent = stats.toolCalls || 0;

  // Tools/min
  if (stats.startedAt && stats.toolCalls > 0) {
    const mins = (Date.now() - stats.startedAt) / 60000;
    const rate = mins > 0 ? (stats.toolCalls / mins).toFixed(1) : '0';
    ui.rate.textContent = rate;
  } else {
    ui.rate.textContent = '0';
  }

  // Errors
  const errCount = stats.errors || 0;
  ui.errors.textContent = errCount;
  ui.errors.className = errCount > 0 ? 'stat-value stat-errors has-errors' : 'stat-value stat-errors';

  ui.files.textContent = stats.filesAccessed || 0;
  const added = stats.linesAdded || 0;
  const removed = stats.linesRemoved || 0;
  ui.changes.innerHTML =
    `<span class="line-add">+${added}</span> <span class="line-del">-${removed}</span>`;
  const tokens = stats.estimatedTokens || 0;
  ui.tokens.textContent = tokens.toLocaleString();

  const modelKey = appState.config?.pricing?.model || 'opus-4.6';
  const cost = estimateCost(tokens, modelKey);
  ui.cost.textContent = cost >= 0.01 ? `$${cost.toFixed(2)}` : '$0';

  ui.turns.textContent = stats.turns || 0;

  if (stats.startedAt) {
    const elapsed = Math.floor((Date.now() - stats.startedAt) / 1000);
    const m = Math.floor(elapsed / 60);
    const s = elapsed % 60;
    ui.uptime.textContent = m > 0 ? `${m}m ${s}s` : `${s}s`;
  }

  const empty = document.getElementById('empty-state');
  if (empty) empty.style.display = (agents.length === 0) ? 'block' : 'none';
}

// Persistent session display order — survives re-renders
const sessionOrder = []; // array of session ids in user's preferred order

function updateAgentsTab() {
  const container = document.getElementById('tab-agents');
  if (container.style.display === 'none') return;

  const sessionMap = new Map();
  for (const agent of appState.agents) {
    const sid = agent.sessionId || 'unknown';
    if (!sessionMap.has(sid)) sessionMap.set(sid, []);
    sessionMap.get(sid).push(agent);
  }

  // Maintain stable order: keep existing order, append new sessions at end
  for (const sid of sessionMap.keys()) {
    if (!sessionOrder.includes(sid)) sessionOrder.push(sid);
  }
  // Remove sessions that no longer exist
  for (let i = sessionOrder.length - 1; i >= 0; i--) {
    if (!sessionMap.has(sessionOrder[i])) sessionOrder.splice(i, 1);
  }

  function buildTree(agents) {
    const roots = [];
    const childMap = new Map();
    for (const agent of agents) {
      if (!agent.parentId) roots.push(agent);
      else {
        if (!childMap.has(agent.parentId)) childMap.set(agent.parentId, []);
        childMap.get(agent.parentId).push(agent);
      }
    }
    return { roots, childMap };
  }

  function renderAgent(agent, childMap, depth, isLast) {
    const color = getAgentColor(agent);
    const lastTool = agent.toolCalls?.[agent.toolCalls.length - 1];
    const children = childMap.get(agent.id) || [];
    const indent = depth > 0 ? 'padding-left:' + (depth * 20) + 'px;' : '';
    const treeLine = depth > 0
      ? `<span class="tree-branch">${isLast ? '\u2514' : '\u251C'}\u2500 </span>`
      : '';

    let html = `
      <div class="agent-item agent-depth-${depth}" style="${indent}" data-agent-id="${escHtml(agent.id)}">
        <div class="agent-header">
          ${treeLine}
          <div class="agent-dot ${agent.status}" style="background:${color}; color:${color}"></div>
          <div class="agent-name">${escHtml(agent.name)}</div>
          ${(agent.type !== 'main' || children.length > 0) ? `<div class="agent-type">${agent.subagentType || agent.type}</div>` : ''}
          ${agent.model ? `<div class="agent-model">${escHtml(formatModelName(agent.model))}</div>` : ''}
        </div>
        <div class="agent-stats" style="${depth > 0 ? 'padding-left:' + (depth * 20 + 20) + 'px;' : ''}">
          ${agent.toolCallCount || 0} tool calls
          ${lastTool ? ` | Last: ${escHtml(lastTool.tool)}` : ''}
        </div>
        <div class="agent-events" id="agent-events-${CSS.escape(agent.id)}"></div>
        <div class="agent-thoughts" id="agent-thoughts-${CSS.escape(agent.id)}"></div>
      </div>
    `;

    for (let i = 0; i < children.length; i++) {
      html += renderAgent(children[i], childMap, depth + 1, i === children.length - 1);
    }
    return html;
  }

  let html = '';
  const showHeaders = sessionOrder.length > 1;

  for (const sid of sessionOrder) {
    const agents = sessionMap.get(sid);
    if (!agents) continue;
    const sess = (appState.sessions || []).find(s => s.id === sid);
    const statusClass = sess?.status === 'active' ? 'active' : 'ended';

    html += `<div class="session-group" draggable="true" data-session-id="${escHtml(sid)}">`;

    if (showHeaders) {
      html += `<div class="session-header drag-handle">
        <div class="drag-grip">\u2630</div>
        <div class="session-dot ${statusClass}"></div>
        Session ${escHtml(sid.slice(0, 8))}
        <span class="session-count">${agents.length} agent${agents.length > 1 ? 's' : ''}</span>
      </div>`;
    }

    const { roots, childMap } = buildTree(agents);
    html += roots.map((root, i) =>
      renderAgent(root, childMap, 0, i === roots.length - 1)
    ).join('');

    html += '</div>';
  }

  container.innerHTML = html;

  // Re-populate cached events and thoughts into per-agent containers
  replayEventsIntoAgents();
  replayThoughtsIntoAgents();

  // Attach drag-and-drop listeners
  initSessionDrag(container);
}

// ─── Drag & Drop for Session Groups ─────────────────────────────────────────
let draggedSessionId = null;

function initSessionDrag(container) {
  const groups = container.querySelectorAll('.session-group');
  for (const group of groups) {
    group.addEventListener('dragstart', (e) => {
      draggedSessionId = group.dataset.sessionId;
      group.classList.add('dragging');
      e.dataTransfer.effectAllowed = 'move';
    });
    group.addEventListener('dragend', () => {
      group.classList.remove('dragging');
      draggedSessionId = null;
      container.querySelectorAll('.session-group').forEach(g => g.classList.remove('drag-over'));
    });
    group.addEventListener('dragover', (e) => {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      if (group.dataset.sessionId !== draggedSessionId) {
        group.classList.add('drag-over');
      }
    });
    group.addEventListener('dragleave', () => {
      group.classList.remove('drag-over');
    });
    group.addEventListener('drop', (e) => {
      e.preventDefault();
      group.classList.remove('drag-over');
      const targetSid = group.dataset.sessionId;
      if (!draggedSessionId || draggedSessionId === targetSid) return;

      // Reorder sessionOrder
      const fromIdx = sessionOrder.indexOf(draggedSessionId);
      const toIdx = sessionOrder.indexOf(targetSid);
      if (fromIdx === -1 || toIdx === -1) return;
      sessionOrder.splice(fromIdx, 1);
      sessionOrder.splice(toIdx, 0, draggedSessionId);

      // Re-render
      updateAgentsTab();
    });
  }
}

// Cached event list per agent id — survives tab re-renders
const agentEventCache = new Map(); // agentId -> [{timestamp, tool_name, phase, detail, color}]
const MAX_AGENT_EVENTS = 30;

// Cached thoughts per agent — separate from tool events
const agentThoughtsCache = new Map();
const MAX_AGENT_THOUGHTS = 8;

function appendThought(agentId, text, timestamp) {
  if (!agentId || !text) return;
  const ts = timestamp || Date.now();

  if (!agentThoughtsCache.has(agentId)) agentThoughtsCache.set(agentId, []);
  const cache = agentThoughtsCache.get(agentId);
  // Skip duplicate if same text as last entry
  if (cache.length > 0 && cache[cache.length - 1].text === text) return;
  cache.push({ timestamp: ts, text });
  while (cache.length > MAX_AGENT_THOUGHTS) cache.shift();

  const container = document.getElementById(`agent-thoughts-${CSS.escape(agentId)}`);
  if (container) {
    appendThoughtDOM(container, { timestamp: ts, text });
    while (container.children.length > MAX_AGENT_THOUGHTS) container.removeChild(container.firstChild);
    container.scrollTop = container.scrollHeight;
  }
}

function appendThoughtDOM(container, entry) {
  const div = document.createElement('div');
  div.className = 'agent-thought-item';
  const icon = document.createElement('span');
  icon.className = 'at-icon';
  icon.textContent = '\uD83D\uDCAD';
  const txt = document.createElement('span');
  txt.className = 'at-text';
  txt.textContent = entry.text;
  div.appendChild(icon);
  div.appendChild(txt);
  container.appendChild(div);
}

function replayThoughtsIntoAgents() {
  for (const [agentId, thoughts] of agentThoughtsCache) {
    const container = document.getElementById(`agent-thoughts-${CSS.escape(agentId)}`);
    if (!container) continue;
    container.innerHTML = '';
    for (const entry of thoughts) {
      appendThoughtDOM(container, entry);
    }
    container.scrollTop = container.scrollHeight;
  }
}

function addEventToFeed(event) {
  if (!event.tool_name && event.phase !== 'session_start' && event.phase !== 'session_end' && event.phase !== 'notification') return;

  // Find which agent this event belongs to
  const sid = event.session_id;
  const agent = sid
    ? appState.agents.find(a => a.sessionId === sid && a.status === 'active')
      || appState.agents.find(a => a.sessionId === sid)
    : null;
  const agentId = agent?.id;
  if (!agentId) return;

  const color = event.phase === 'notification' ? '#d080ff' : getToolColor(event.tool_name);
  let detail = '';
  if (event.phase === 'session_start') {
    detail = 'Session started';
  } else if (event.phase === 'session_end') {
    detail = 'Session ended';
  } else if (event.phase === 'notification') {
    detail = event.message || 'Response';
  } else if (event.phase === 'pre') {
    detail = summarizeInputForUI(event.tool_name, event.tool_input) || '';
  } else if (event.phase === 'post') {
    detail = 'completed';
  }

  // Cache the event
  if (!agentEventCache.has(agentId)) agentEventCache.set(agentId, []);
  const cache = agentEventCache.get(agentId);
  cache.push({ timestamp: event.timestamp, tool_name: event.tool_name, phase: event.phase, detail, color });
  while (cache.length > MAX_AGENT_EVENTS) cache.shift();

  // Append to DOM if container exists
  const container = document.getElementById(`agent-events-${CSS.escape(agentId)}`);
  if (container) {
    appendEventDOM(container, { timestamp: event.timestamp, tool_name: event.tool_name, phase: event.phase, detail, color });
    while (container.children.length > MAX_AGENT_EVENTS) container.removeChild(container.firstChild);
    container.scrollTop = container.scrollHeight;
  }
}

function appendEventDOM(container, ev) {
  const time = new Date(ev.timestamp).toLocaleTimeString();
  const div = document.createElement('div');
  div.className = 'agent-event-item';
  div.style.borderLeftColor = ev.color;
  div.innerHTML = `<span class="ae-time">${escHtml(time)}</span><span class="ae-tool" style="color:${ev.color}">${escHtml(ev.tool_name || ev.phase)}</span><span class="ae-detail">${escHtml(ev.detail)}</span>`;
  container.appendChild(div);
}

function replayEventsIntoAgents() {
  for (const [agentId, events] of agentEventCache) {
    const container = document.getElementById(`agent-events-${CSS.escape(agentId)}`);
    if (!container) continue;
    container.innerHTML = '';
    for (const ev of events) {
      appendEventDOM(container, ev);
    }
    container.scrollTop = container.scrollHeight;
  }
}

function updateTimelineBar() {
  const bar = document.getElementById('timeline-bar');
  const events = appState.timeline;
  if (events.length === 0) return;

  const bucketCount = Math.min(events.length, 120);
  const startTime = events[0]?.timestamp || Date.now();
  const endTime = events[events.length - 1]?.timestamp || Date.now();
  const range = Math.max(endTime - startTime, 1);

  const buckets = new Array(bucketCount).fill(0);
  for (const evt of events) {
    const idx = Math.min(Math.floor(((evt.timestamp - startTime) / range) * bucketCount), bucketCount - 1);
    buckets[idx]++;
  }

  const maxCount = Math.max(...buckets, 1);
  bar.innerHTML = buckets.map(count => {
    const h = Math.max(2, (count / maxCount) * 20);
    return `<div class="timeline-tick" style="height:${h}px"></div>`;
  }).join('');
}

// ─── Helpers ───────────────────────────────────────────────────────────────────
function escHtml(str) {
  if (!str) return '';
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

const TOOL_ICONS = {
  Read: '\u{1F4C4}', Write: '\u{270F}\u{FE0F}', Edit: '\u{270F}\u{FE0F}', Bash: '\u{1F4BB}',
  Grep: '\u{1F50D}', Glob: '\u{1F50D}', Task: '\u{1F680}', WebSearch: '\u{1F310}',
  WebFetch: '\u{1F310}', TodoWrite: '\u{2705}', NotebookEdit: '\u{1F4D3}',
  thinking: '\u{1F4AD}',
};

function getToolIcon(toolName) { return TOOL_ICONS[toolName] || '\u{2699}\u{FE0F}'; }

function shortenPath(p) {
  if (!p) return '';
  const parts = p.replace(/\\/g, '/').split('/');
  return parts.length > 1 ? parts.slice(-2).join('/') : parts[0];
}

function summarizeActivityForUI(toolName, input) {
  if (!input) return toolName;
  switch (toolName) {
    case 'Read': return `Reading ${shortenPath(input.file_path)}`;
    case 'Write': return `Writing ${shortenPath(input.file_path)}`;
    case 'Edit': return `Editing ${shortenPath(input.file_path)}`;
    case 'Bash': {
      const cmd = (input.command || '').split(/\s+/).slice(0, 3).join(' ');
      return `Running ${cmd.slice(0, 40)}`;
    }
    case 'Grep': return `Searching /${(input.pattern || '').slice(0, 20)}/`;
    case 'Glob': return `Finding ${(input.pattern || '').slice(0, 30)}`;
    case 'Task': return `Spawning ${input.description || input.subagent_type || 'agent'}`;
    case 'WebSearch': return `Searching "${(input.query || '').slice(0, 25)}"`;
    case 'WebFetch': return 'Fetching page';
    case 'TodoWrite': return 'Updating todos';
    default: return toolName;
  }
}

function summarizeInputForUI(toolName, input) {
  if (!input) return '';
  switch (toolName) {
    case 'Read': return input.file_path || '';
    case 'Write': return input.file_path || '';
    case 'Edit': return input.file_path || '';
    case 'Bash': return (input.command || '').slice(0, 80);
    case 'Grep': return `/${input.pattern || ''}/ in ${input.path || '.'}`;
    case 'Glob': return input.pattern || '';
    case 'Task': return `[${input.subagent_type || '?'}] ${input.description || ''}`;
    case 'WebSearch': return input.query || '';
    default: return '';
  }
}

// ─── State Sync ────────────────────────────────────────────────────────────────
function syncSceneWithState() {
  const currentAgentIds = new Set(appState.agents.map(a => a.id));

  // Remove meshes for agents no longer in state
  for (const [id, data] of agentMeshes) {
    if (!currentAgentIds.has(id)) {
      scene.remove(data.group);
      data.sphere.geometry.dispose();
      data.sphere.material.dispose();
      data.ring.geometry.dispose();
      data.ring.material.dispose();
      // Clean up CSS2D objects
      if (data.label) { data.group.remove(data.label); data.label.element.remove(); }
      if (data.activityLabel) { data.group.remove(data.activityLabel); data.activityLabel.element.remove(); }

      for (const b of data.bubbles) { data.group.remove(b.css2d); b.css2d.element.remove(); }
      agentMeshes.delete(id);
    }
  }

  // Remove orphaned connection lines
  for (const [key, data] of connectionLines) {
    if (!agentMeshes.has(data.parentId) || !agentMeshes.has(data.childId)) {
      scene.remove(data.line);
      data.line.geometry.dispose();
      data.line.material.dispose();
      connectionLines.delete(key);
    }
  }

  // Create/update agent meshes
  for (const agent of appState.agents) {
    if (!agentMeshes.has(agent.id)) {
      createAgentMesh(agent, appState.agents.indexOf(agent));
    }
    const meshData = agentMeshes.get(agent.id);
    if (meshData) meshData.agent = agent;
    updateAgentMesh(agent.id);
  }

  // Create connection lines
  for (const agent of appState.agents) {
    if (agent.parentId) {
      createConnectionLine(agent.parentId, agent.id);
    }
  }

  updateUI();
  updateAgentsTab();
  updateTimelineBar();
}

function handleEvent(event) {
  addEventToFeed(event);

  // On session end, clear thought bubbles and thinking log
  if (event.phase === 'session_end') {
    const sid = event.session_id;
    const agent = sid
      ? appState.agents.find(a => a.sessionId === sid)
      : appState.agents.find(a => a.status === 'active') || appState.agents[0];
    if (agent) {
      clearThoughtBubbles(agent.id);
      clearThinkingLog(agent.id);
    }
  }

  // Thought bubbles + particles for tool calls
  if (event.phase === 'pre' && event.tool_name) {
    // Find the LAST active agent for this session (most recently spawned subagent)
    // This matches the worker's findActiveAgent() which iterates backwards
    const sid = event.session_id;
    let activeAgent = null;
    if (sid) {
      for (let i = appState.agents.length - 1; i >= 0; i--) {
        if (appState.agents[i].sessionId === sid && appState.agents[i].status === 'active') {
          activeAgent = appState.agents[i];
          break;
        }
      }
    }
    if (!activeAgent) {
      for (let i = appState.agents.length - 1; i >= 0; i--) {
        if (appState.agents[i].status === 'active') { activeAgent = appState.agents[i]; break; }
      }
    }
    if (!activeAgent) activeAgent = appState.agents[0];
    if (activeAgent) {
      spawnParticle(activeAgent.id, event.tool_name);
      if (event.tool_name === 'Task') {
        playSpawnChord();
      } else {
        playToolTone(event.tool_name);
      }

      // Track tool for context-aware animations
      const meshData = agentMeshes.get(activeAgent.id);
      if (meshData) {
        meshData.lastToolTime = Date.now();
        meshData.lastToolName = event.tool_name;
        meshData.currentActivity = summarizeActivityForUI(event.tool_name, event.tool_input);
      }

      // File node
      const filePath = event.tool_input?.file_path || event.tool_input?.path;
      if (filePath) {
        addFileNode(filePath, activeAgent.id);
      }

      // Feed thinking text into dedicated thoughts box (right side)
      if (event.thinking) {
        appendThought(activeAgent.id, event.thinking, event.timestamp);
      }

      // Auto-focus: pan to active agent when it does something
      if (appState.config?.display?.autoFocus ?? true) {
        startFocusPan(activeAgent.id);
      }
    }
  }

  // Notification/response capture — feed into agent panel instead of thought bubble
  if (event.phase === 'notification' && event.message) {
    // Already handled by addEventToFeed at top of handleEvent
  }

  // Subagent completion burst
  if (event.phase === 'post' && event.tool_name === 'Task') {
    const completedSub = appState.agents.find(a => a.type === 'subagent' && a.status === 'completed');
    if (completedSub) {
      for (let i = 0; i < 8; i++) {
        spawnBurstParticle(completedSub.id, getAgentColor(completedSub));
      }
      playCompletionChord();
    }
  }
}

function clearScene() {
  for (const [id, data] of agentMeshes) {
    scene.remove(data.group);
    data.sphere.geometry.dispose();
    data.sphere.material.dispose();
    data.ring.geometry.dispose();
    data.ring.material.dispose();
    if (data.label) { data.group.remove(data.label); data.label.element.remove(); }
    if (data.activityLabel) { data.group.remove(data.activityLabel); data.activityLabel.element.remove(); }
    for (const b of data.bubbles) { data.group.remove(b.css2d); b.css2d.element.remove(); }
  }
  agentMeshes.clear();

  for (const [key, data] of connectionLines) {
    scene.remove(data.line);
    data.line.geometry.dispose();
    data.line.material.dispose();
  }
  connectionLines.clear();

  for (const p of particles) {
    scene.remove(p.mesh);
    p.mesh.geometry.dispose();
    p.mesh.material.dispose();
  }
  particles.length = 0;

  clearProximityPool();

  for (const [path] of fileNodes) {
    removeFileNode(path);
  }

  focusedAgentId = null;
  focusPanning = false;
  focusPanProgress = 0;
  controls.enabled = true;

  agentEventCache.clear();
  document.getElementById('timeline-bar').innerHTML = '';
}

// ─── Event Replay ──────────────────────────────────────────────────────────────
function replayEventsFromTimeline() {
  agentEventCache.clear();

  const timeline = appState.timeline || [];
  const recent = timeline.slice(-100);
  for (const evt of recent) {
    const toolName = evt.data?.tool || null;
    const color = toolName ? getToolColor(toolName) : '#4488ff';
    const agentId = evt.agentId || null;
    if (!agentId) continue;

    let label = '';
    let detail = '';
    if (evt.type === 'tool_start') {
      label = toolName || 'tool';
      detail = evt.data?.input || '';
    } else if (evt.type === 'tool_end') {
      label = toolName || 'tool';
      detail = 'completed';
    } else if (evt.type === 'agent_spawn') {
      label = 'Task';
      detail = `[${evt.data?.subagentType || '?'}] ${evt.data?.name || ''}`;
    } else if (evt.type === 'agent_response') {
      label = 'Response';
      detail = evt.data?.message || '';
    } else {
      continue;
    }

    if (!agentEventCache.has(agentId)) agentEventCache.set(agentId, []);
    const cache = agentEventCache.get(agentId);
    cache.push({ timestamp: evt.timestamp, tool_name: label, phase: evt.type, detail, color });
    while (cache.length > MAX_AGENT_EVENTS) cache.shift();
  }

  // DOM will be populated by updateAgentsTab -> replayEventsIntoAgents
}

// ─── Voice Input (Web Speech API) ──────────────────────────────────────────────
let speechRecognition = null;
let isListening = false;
let voiceInited = false;

function initVoiceInput() {
  if (voiceInited) return;
  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SpeechRecognition) return;

  const voiceBtn = document.getElementById('voice-btn');
  const voiceTranscript = document.getElementById('voice-transcript');
  if (!voiceBtn) return;

  voiceInited = true;

  speechRecognition = new SpeechRecognition();
  speechRecognition.continuous = false;
  speechRecognition.interimResults = true;
  speechRecognition.lang = 'en-US';

  function stopListening() {
    if (!isListening) return;
    try { speechRecognition.stop(); } catch {}
    isListening = false;
    voiceBtn.classList.remove('listening');
  }

  function startListening() {
    if (isListening) return;
    try { speechRecognition.start(); } catch {}
    isListening = true;
    voiceBtn.classList.add('listening');
    voiceTranscript.textContent = 'Listening...';
    voiceTranscript.style.display = 'block';
    voiceTranscript.classList.remove('fading');
  }

  speechRecognition.onresult = (e) => {
    let transcript = '';
    for (let i = e.resultIndex; i < e.results.length; i++) {
      transcript += e.results[i][0].transcript;
    }
    voiceTranscript.textContent = transcript;
    voiceTranscript.style.display = 'block';

    if (e.results[e.results.length - 1].isFinal) {
      fetch('/api/voice-command', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ transcript, timestamp: Date.now() })
      }).catch(() => {});

      setTimeout(() => {
        voiceTranscript.classList.add('fading');
        setTimeout(() => {
          voiceTranscript.style.display = 'none';
          voiceTranscript.classList.remove('fading');
        }, 600);
      }, 5000);
    }
  };

  speechRecognition.onend = () => {
    isListening = false;
    voiceBtn.classList.remove('listening');
  };

  speechRecognition.onerror = () => {
    isListening = false;
    voiceBtn.classList.remove('listening');
  };

  // Toggle mode: click to start/stop
  voiceBtn.addEventListener('click', () => {
    const mode = appState.config?.features?.voiceMode || 'toggle';
    if (mode === 'ptt') return; // PTT uses mousedown/mouseup
    if (isListening) stopListening();
    else startListening();
  });

  // Push-to-talk: hold to talk
  voiceBtn.addEventListener('mousedown', (e) => {
    const mode = appState.config?.features?.voiceMode || 'toggle';
    if (mode !== 'ptt') return;
    e.preventDefault();
    startListening();
  });

  const pttStop = () => {
    const mode = appState.config?.features?.voiceMode || 'toggle';
    if (mode !== 'ptt') return;
    stopListening();
  };
  voiceBtn.addEventListener('mouseup', pttStop);
  voiceBtn.addEventListener('mouseleave', pttStop);

  // Update visibility based on current config
  syncVoiceVisibility();
}

function syncVoiceVisibility() {
  const voiceBtn = document.getElementById('voice-btn');
  const modeRow = document.getElementById('voice-mode-row');
  const enabled = appState.config?.features?.voiceInput ?? false;
  if (voiceBtn) voiceBtn.style.display = enabled ? '' : 'none';
  if (modeRow) modeRow.style.display = enabled ? '' : 'none';
}

// ─── WebSocket Connection ──────────────────────────────────────────────────────
function connectWebSocket() {
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  ws = new WebSocket(`${protocol}//${location.host}/ws`);

  ws.onopen = () => {
    reconnectDelay = 1000;
    document.getElementById('connection-banner').style.display = 'none';
    updateUI();
  };

  ws.onmessage = (e) => {
    let msg;
    try { msg = JSON.parse(e.data); } catch { return; }

    switch (msg.type) {
      case 'init':
        appState = msg.state;
        syncSceneWithState();
        syncConfigUI();
        replayEventsFromTimeline();
        // Init voice after config is available
        initVoiceInput();
        break;

      case 'event':
        appState = msg.state;
        handleEvent(msg.event);
        syncSceneWithState();
        break;

      case 'state_update':
        appState = msg.state;
        syncSceneWithState();
        break;

      case 'config_update':
        appState.config = msg.config;
        syncConfigUI();
        initVoiceInput();
        syncVoiceVisibility();
        break;
    }
  };

  ws.onclose = () => {
    document.getElementById('connection-banner').style.display = 'block';
    updateUI();
    clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(() => {
      reconnectDelay = Math.min(reconnectDelay * 1.5, 10000);
      connectWebSocket();
    }, reconnectDelay);
  };

  ws.onerror = () => { ws.close(); };
}

// ─── Panel Controls ────────────────────────────────────────────────────────────
window.togglePanel = function() {
  const panel = document.getElementById('side-panel');
  const toggle = document.getElementById('panel-toggle');
  const timeline = document.getElementById('timeline-bar');
  panel.classList.toggle('collapsed');
  toggle.classList.toggle('collapsed');
  toggle.textContent = panel.classList.contains('collapsed') ? '\u2039' : '\u203A';
  timeline.classList.toggle('expanded', panel.classList.contains('collapsed'));
};

window.switchTab = function(tabName) {
  document.querySelectorAll('.panel-tab').forEach(t => t.classList.remove('active'));
  document.querySelector(`[data-tab="${tabName}"]`)?.classList.add('active');

  document.getElementById('tab-agents').style.display = tabName === 'agents' ? '' : 'none';
  document.getElementById('tab-config').style.display = tabName === 'config' ? '' : 'none';

  if (tabName === 'agents') updateAgentsTab();
  if (tabName === 'config') syncConfigUI();
};

window.updateConfig = function(path, value) {
  const keys = path.split('.');
  const update = {};
  let current = update;
  for (let i = 0; i < keys.length - 1; i++) {
    current[keys[i]] = {};
    current = current[keys[i]];
  }
  current[keys[keys.length - 1]] = value;

  deepMerge(appState.config, update);

  fetch('/api/config', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(update)
  });
};

function deepMerge(target, source) {
  for (const key of Object.keys(source)) {
    if (source[key] && typeof source[key] === 'object' && !Array.isArray(source[key])) {
      if (!target[key]) target[key] = {};
      deepMerge(target[key], source[key]);
    } else {
      target[key] = source[key];
    }
  }
}

function syncConfigUI() {
  const c = appState.config || {};
  const anim = c.animation || {};
  const display = c.display || {};
  const features = c.features || {};
  const el = (id) => document.getElementById(id);

  const themeSelect = el('cfg-theme');
  if (themeSelect) {
    const theme = display.theme || 'purple';
    themeSelect.value = theme;
    const customRow = document.getElementById('custom-color-row');
    if (theme === 'custom') {
      if (customRow) customRow.style.display = '';
      const picker = document.getElementById('cfg-custom-color');
      const savedColor = display.customColor || '#b050ff';
      if (picker) picker.value = savedColor;
      const key = 'custom:' + savedColor;
      if (_activeThemeKey !== key) applyCustomTheme(savedColor);
    } else {
      if (customRow) customRow.style.display = 'none';
      if (_activeThemeKey !== theme) applyTheme(theme);
    }
  }

  const maxFps = el('cfg-max-fps');
  if (maxFps) {
    const mf = anim.maxFps ?? 0;
    maxFps.value = mf;
    const mfVal = el('max-fps-val');
    if (mfVal) mfVal.textContent = mf === 0 ? 'Off' : mf;
  }

  const speed = el('cfg-speed');
  if (speed) speed.value = anim.speed ?? 1;

  const autoRotate = el('cfg-autorotate');
  if (autoRotate) autoRotate.checked = anim.autoRotate ?? false;

  const orbit = el('cfg-orbit');
  if (orbit) orbit.value = anim.orbitSpeed ?? 0.002;

  const pLifetime = el('cfg-particles');
  if (pLifetime) pLifetime.value = anim.particleLifetime ?? 60000;



  const showFps = el('cfg-show-fps');
  if (showFps) showFps.checked = display.showFps ?? true;
  const fpsStat = document.getElementById('fps-stat');
  if (fpsStat) fpsStat.style.display = (display.showFps ?? true) ? '' : 'none';

  const pricingModel = el('cfg-pricing-model');
  if (pricingModel) pricingModel.value = c.pricing?.model || 'opus-4.6';

  const maxFiles = el('cfg-maxfiles');
  if (maxFiles) maxFiles.value = c.maxFileNodes ?? 50;

  const showLabels = el('cfg-labels');
  if (showLabels) showLabels.checked = display.showLabels ?? true;

  const autoFocus = el('cfg-autofocus');
  if (autoFocus) autoFocus.checked = display.autoFocus ?? true;

  const voiceInput = el('cfg-voice');
  if (voiceInput) voiceInput.checked = features.voiceInput ?? false;

  const voiceMode = el('cfg-voice-mode');
  if (voiceMode) voiceMode.value = features.voiceMode || 'toggle';

  syncVoiceVisibility();

  const thoughtBubbles = el('cfg-bubbles');
  if (thoughtBubbles) thoughtBubbles.checked = features.thoughtBubbles ?? true;

  const spawnAnims = el('cfg-spawnanim');
  if (spawnAnims) spawnAnims.checked = features.spawnAnimations ?? true;

  const asciiRain = el('cfg-asciirain');
  if (asciiRain) asciiRain.checked = display.asciiRain ?? true;

  const bgType = el('cfg-bg-type');
  if (bgType) bgType.value = display.bgType || 'waves';

  const waveSymbols = el('cfg-wave-symbols');
  if (waveSymbols) {
    const preset = display.waveSymbols || 'dots';
    waveSymbols.value = preset;
    if (preset !== currentSymbolPreset) createFontAtlas(preset);
  }

  const cellSizeSlider = el('cfg-cell-size');
  if (cellSizeSlider) {
    const cs = display.cellSize || 14;
    cellSizeSlider.value = cs;
    const csVal = el('cell-size-val');
    if (csVal) csVal.textContent = cs;
    if (bgMaterial) {
      bgMaterial.uniforms.uCellSize.value.set(cs, Math.round(cs * 1.286));
    }
  }

  const asciiDensity = el('cfg-ascii-density');
  if (asciiDensity) asciiDensity.value = display.asciiRainDensity ?? 0.6;

  const bgOpacity = el('cfg-bg-opacity');
  if (bgOpacity) bgOpacity.value = display.bgOpacity ?? 100;

  const wireThickness = el('cfg-wire-thickness');
  if (wireThickness) {
    const wt = display.wireThickness ?? 2;
    wireThickness.value = wt;
    const wtVal = el('wire-thickness-val');
    if (wtVal) wtVal.textContent = wt + 'px';
  }

  const wireDistance = el('cfg-wire-distance');
  if (wireDistance) {
    const wd = display.wireDistance ?? 1.8;
    wireDistance.value = wd;
    const wdVal = el('wire-distance-val');
    if (wdVal) wdVal.textContent = parseFloat(wd).toFixed(1);
  }

  // Toggle background on/off
  const bgEnabled = display.asciiRain ?? true;
  if (bgEnabled && !bgRunning) startBackground();
  else if (!bgEnabled && bgRunning) stopBackground();

  // Audio
  const audioToggle = el('cfg-audio');
  if (audioToggle) audioToggle.checked = features.ambientAudio ?? false;
  const audioVol = el('cfg-audio-volume');
  if (audioVol) audioVol.value = features.audioVolume ?? 50;

  // Start/stop audio based on toggle
  if (features.ambientAudio) {
    initAudio();
    setAudioVolume((features.audioVolume ?? 50) / 100);
  } else {
    setAudioVolume(0);
  }
}

// ─── Color Themes ───────────────────────────────────────────────────────────────
// Each theme defines: bg, surface, surfaceHover, text, textDim, accent hex, accentBright hex, accentRGB (for opacity variants)
const THEMES = {
  purple:  { bg: '#0d0015', surface: 'rgba(20,5,40,0.88)',  surfaceHover: 'rgba(40,15,70,0.9)',  text: '#e0d0f0', textDim: '#8868aa', accent: '#b050ff', accentBright: '#d080ff', r: 160, g: 80,  b: 255 },
  cyan:    { bg: '#000d15', surface: 'rgba(5,20,35,0.88)',   surfaceHover: 'rgba(10,35,60,0.9)',  text: '#d0f0f8', textDim: '#5898aa', accent: '#00c8e0', accentBright: '#40e8ff', r: 0,   g: 180, b: 220 },
  emerald: { bg: '#000d08', surface: 'rgba(5,25,15,0.88)',   surfaceHover: 'rgba(10,45,25,0.9)',  text: '#d0f0e0', textDim: '#58aa78', accent: '#30d080', accentBright: '#60f0a0', r: 40,  g: 200, b: 120 },
  rose:    { bg: '#150008', surface: 'rgba(35,5,18,0.88)',   surfaceHover: 'rgba(60,12,30,0.9)',  text: '#f0d0e0', textDim: '#aa5878', accent: '#e04080', accentBright: '#ff60a0', r: 220, g: 60,  b: 120 },
  amber:   { bg: '#150d00', surface: 'rgba(35,20,5,0.88)',   surfaceHover: 'rgba(60,35,10,0.9)',  text: '#f0e8d0', textDim: '#aa8850', accent: '#e0a020', accentBright: '#ffc040', r: 220, g: 160, b: 40  },
  crimson: { bg: '#120002', surface: 'rgba(30,5,8,0.88)',   surfaceHover: 'rgba(55,12,18,0.9)', text: '#f0d8d0', textDim: '#aa6058', accent: '#c03020', accentBright: '#e05040', r: 180, g: 45,  b: 30  },
};

// Derive a full theme object from a single hex accent color
function deriveThemeFromHex(hex) {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  // Desaturated dim version for text-dim
  const dimR = Math.round(r * 0.55 + 40);
  const dimG = Math.round(g * 0.55 + 40);
  const dimB = Math.round(b * 0.55 + 40);
  // Brighter version for accent-bright
  const brR = Math.min(255, Math.round(r * 1.25 + 30));
  const brG = Math.min(255, Math.round(g * 1.25 + 30));
  const brB = Math.min(255, Math.round(b * 1.25 + 30));
  // Background: very dark tinted version
  const bgR = Math.round(r * 0.05);
  const bgG = Math.round(g * 0.05);
  const bgB = Math.round(b * 0.05);
  // Surface: slightly tinted dark
  const sfR = Math.round(r * 0.1 + 5);
  const sfG = Math.round(g * 0.1 + 5);
  const sfB = Math.round(b * 0.1 + 5);
  const shR = Math.round(r * 0.18 + 10);
  const shG = Math.round(g * 0.18 + 10);
  const shB = Math.round(b * 0.18 + 10);
  // Text: light tinted version
  const txR = Math.min(255, Math.round(200 + r * 0.2));
  const txG = Math.min(255, Math.round(200 + g * 0.2));
  const txB = Math.min(255, Math.round(200 + b * 0.2));
  const toHex2 = (v) => v.toString(16).padStart(2, '0');
  return {
    bg: `#${toHex2(bgR)}${toHex2(bgG)}${toHex2(bgB)}`,
    surface: `rgba(${sfR},${sfG},${sfB},0.88)`,
    surfaceHover: `rgba(${shR},${shG},${shB},0.9)`,
    text: `#${toHex2(txR)}${toHex2(txG)}${toHex2(txB)}`,
    textDim: `#${toHex2(dimR)}${toHex2(dimG)}${toHex2(dimB)}`,
    accent: hex,
    accentBright: `#${toHex2(brR)}${toHex2(brG)}${toHex2(brB)}`,
    r, g, b
  };
}

function applyThemeObject(t) {
  const root = document.documentElement.style;
  const rgba = (a) => `rgba(${t.r},${t.g},${t.b},${a})`;
  root.setProperty('--bg', t.bg);
  root.setProperty('--surface', t.surface);
  root.setProperty('--surface-hover', t.surfaceHover);
  root.setProperty('--border', rgba(0.25));
  root.setProperty('--border-glow', rgba(0.5));
  root.setProperty('--text', t.text);
  root.setProperty('--text-dim', t.textDim);
  root.setProperty('--accent', t.accent);
  root.setProperty('--accent-bright', t.accentBright);
  root.setProperty('--accent-glow', rgba(0.4));
  root.setProperty('--accent-05', rgba(0.05));
  root.setProperty('--accent-08', rgba(0.08));
  root.setProperty('--accent-10', rgba(0.1));
  root.setProperty('--accent-12', rgba(0.12));
  root.setProperty('--accent-15', rgba(0.15));
  root.setProperty('--accent-20', rgba(0.2));
  root.setProperty('--accent-30', rgba(0.3));
  // Update shader theme color
  if (bgMaterial && bgMaterial.uniforms.uThemeColor) {
    bgMaterial.uniforms.uThemeColor.value.set(t.r / 255, t.g / 255, t.b / 255);
  }
  // Recolor connection lines + flow particles
  const threeAccent = new THREE.Color(t.accent);
  for (const [, cData] of connectionLines) {
    if (cData.line?.material) cData.line.material.color.copy(threeAccent);
    for (const fp of (cData.flowParticles || [])) {
      if (fp.mesh?.material) fp.mesh.material.color.copy(threeAccent);
    }
  }
  // Recolor proximity lines
  if (typeof proximityLines !== 'undefined') {
    for (const pl of proximityLines) {
      if (pl.mat) pl.mat.color.copy(threeAccent);
    }
  }
  // Recolor scene fog + ambient
  if (scene?.fog) scene.fog.color.set(t.bg);
  // Recolor grid
  if (gridHelper) {
    gridHelper.material.color.copy(threeAccent);
    gridHelper.material.color.multiplyScalar(0.15);
  }
}

window.applyTheme = function(name) {
  const t = THEMES[name];
  if (!t) return;
  _activeThemeKey = name;
  applyThemeObject(t);
};

let _activeThemeKey = null; // tracks current theme to prevent reapply loops

window.applyCustomTheme = function(hex) {
  const t = deriveThemeFromHex(hex);
  _activeThemeKey = 'custom:' + hex;
  applyThemeObject(t);
};

window.handleThemeSelect = function(value) {
  const customRow = document.getElementById('custom-color-row');
  if (value === 'custom') {
    if (customRow) customRow.style.display = '';
    const picker = document.getElementById('cfg-custom-color');
    const savedColor = appState.config?.display?.customColor || '#b050ff';
    if (picker) picker.value = savedColor;
    applyCustomTheme(savedColor);
    updateConfig('display.theme', 'custom');
    updateConfig('display.customColor', savedColor);
  } else {
    if (customRow) customRow.style.display = 'none';
    applyTheme(value);
    updateConfig('display.theme', value);
  }
};

// ─── Uptime Timer ──────────────────────────────────────────────────────────────
setInterval(updateUI, 1000);

// ─── Init ──────────────────────────────────────────────────────────────────────
initScene();
initBackground();
animate();
connectWebSocket();

// Init audio on first user interaction (browser requires gesture)
document.addEventListener('click', function audioUnlock() {
  if (appState.config?.features?.ambientAudio) {
    initAudio();
    setAudioVolume((appState.config?.features?.audioVolume ?? 50) / 100);
  }
  document.removeEventListener('click', audioUnlock);
}, { once: true });

// Rebuild font atlas once web fonts finish loading
document.fonts.ready.then(() => {
  const preset = appState.config?.display?.waveSymbols || 'dots';
  createFontAtlas(preset);
});
