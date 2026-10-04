'use client';

import { useEffect, useRef } from 'react';

// Ported from the portfolio (victorj). Colors come from CSS variables on the parent (--caret-*), which
// follow light/dark mode; the field re-rasterizes its sprites when the color scheme changes.
//
// Renders the whole field as a single WebGL fragment shader over one
// fullscreen quad: every pixel's cell state (which of the 4 sweep-frame
// sprites it shows, whether it's in the mouse trail) is computed
// independently, in parallel, on the GPU - so it stays smooth even under
// heavy main-thread load, unlike a per-cell Canvas2D redraw loop.

type Shape = { cols: number; rows: number; cells: [number, number][] };

const SHAPES: Record<'dot' | 'vline' | 'caret', Shape> = {
  dot: { cols: 1, rows: 1, cells: [[0, 0]] },
  vline: {
    cols: 2,
    rows: 2,
    cells: [
      [0, 0],
      [0, 1],
    ],
  },
  caret: {
    cols: 2,
    rows: 3,
    cells: [
      [0, 0],
      [1, 1],
      [0, 2],
    ],
  },
};

type Tokens = { ink: string; fill: string; fillInk: string };

// ============================================================
// PARAMS - every tunable knob for the field lives here.
//
// lineCount and trailMaxLength are baked into the shader source as
// #define constants at compile time (see buildFragmentShader) rather than
// passed as uniforms, since GLSL ES 1.00 (WebGL1) requires array sizes and
// loop bounds to be compile-time constants.
// ============================================================
const PARAMS = {
  spacingPx: 5, // gap between cell centers, in css px (grid fineness)
  lineCount: 7, // how many evenly-spaced parallel lines sweep together
  loopSeconds: 30, // seconds for one full sweep, start to loop back

  bandFraction: 0.13, // total line thickness, as a fraction of screen width

  // The band splits into a solid core and a fade: coreFraction is the
  // inner slice (0..1 of the half-width) that counts as "the core," coreAmp
  // caps how much that core still dithers, and fadeBias shapes the curve
  // across the rest of the band (1 = linear, higher lingers longer before
  // dropping).
  coreFraction: 0.9,
  coreAmp: 0.9,
  fadeBias: 1,

  // Small wobble added to each cell's effective distance from the line, so
  // the fade isn't perfectly smooth.
  noiseFraction: 0.15,
  noiseSpeed: 0.6,

  // The view pans toward the mouse - a per-pixel world-space offset inside
  // the shader, not a moving/oversized canvas element.
  panStrength: 0.08, // how much of the mouse's offset from center becomes pan
  panMaxFraction: 0.05, // clamp on pan distance, as a fraction of the larger screen dimension
  panEase: 0.13, // how quickly the field chases the mouse each frame

  // Mouse trail: cells the cursor passes over light up in a muted green,
  // no fade. The tail is a queue of touched cells; every frame its tail
  // end retracts toward trailTargetLength (eased toward 0 while idle) by an
  // amount proportional to how far past target it currently sits.
  trailTargetLength: 26,
  trailSpringStrength: 6,
  trailTargetEase: 0.25,
  trailMaxLength: 120,

  trailStampSpacing: 0.5, // fraction of a cell-box to step by when interpolating a fast mouse move
  trailMaxStepsPerFrame: 40, // caps new cells one frame's mouse movement can stamp in
};

function paintShape(
  ctx: CanvasRenderingContext2D,
  shape: Shape,
  unit: number,
  boxW: number,
  boxH: number,
  color: string
) {
  const ox = Math.round((boxW - shape.cols * unit) / 2);
  const oy = Math.round((boxH - shape.rows * unit) / 2);
  ctx.fillStyle = color;
  for (const [col, row] of shape.cells) {
    ctx.fillRect(ox + col * unit, oy + row * unit, unit, unit);
  }
}

// The filled cell's background, with one unit-sized pixel notched out of
// each corner (a light chamfer instead of a plain square).
function paintFilledBackground(
  ctx: CanvasRenderingContext2D,
  unit: number,
  boxSize: number,
  color: string
) {
  ctx.fillStyle = color;
  ctx.fillRect(0, 0, boxSize, boxSize);
  ctx.clearRect(0, 0, unit, unit);
  ctx.clearRect(boxSize - unit, 0, unit, unit);
  ctx.clearRect(0, boxSize - unit, unit, unit);
  ctx.clearRect(boxSize - unit, boxSize - unit, unit, unit);
}

// dot -> vertical line -> caret -> filled: the 4 sweep states, rasterized
// once per resize into cell-sized sprite canvases, later composited into
// one texture atlas the shader samples from.
function buildSprites(box: number, unit: number, c: Tokens): HTMLCanvasElement[] {
  function blank() {
    const t = document.createElement('canvas');
    t.width = box;
    t.height = box;
    return t;
  }

  const dot = blank();
  paintShape(dot.getContext('2d')!, SHAPES.dot, unit, box, box, c.ink);

  const vline = blank();
  paintShape(vline.getContext('2d')!, SHAPES.vline, unit, box, box, c.ink);

  const caret = blank();
  paintShape(caret.getContext('2d')!, SHAPES.caret, unit, box, box, c.ink);

  const filled = blank();
  const fctx = filled.getContext('2d')!;
  paintFilledBackground(fctx, unit, box, c.fill);
  paintShape(fctx, SHAPES.caret, unit, box, box, c.fillInk);

  return [dot, vline, caret, filled];
}

// Row 0 = plain (dot, vline, caret, filled), row 1 = trail tint, same
// order - the shader picks a column by sweep level and a row by trail
// membership, then samples that one tile.
function buildAtlas(
  box: number,
  sprites: HTMLCanvasElement[],
  spritesTrail: HTMLCanvasElement[]
): HTMLCanvasElement {
  const atlas = document.createElement('canvas');
  atlas.width = box * 4;
  atlas.height = box * 2;
  const actx = atlas.getContext('2d')!;
  for (let lvl = 0; lvl < 4; lvl++) {
    actx.drawImage(sprites[lvl], lvl * box, 0);
    actx.drawImage(spritesTrail[lvl], lvl * box, box);
  }
  return atlas;
}

const VERTEX_SRC = 'attribute vec2 aPos;' + 'void main() { gl_Position = vec4(aPos, 0.0, 1.0); }';

function buildFragmentShader(): string {
  return [
    '#ifdef GL_FRAGMENT_PRECISION_HIGH',
    'precision highp float;',
    '#else',
    'precision mediump float;',
    '#endif',
    '',
    '#define LINE_COUNT ' + PARAMS.lineCount,
    '#define TRAIL_LENGTH ' + PARAMS.trailMaxLength,
    '#define CORE_FRACTION ' + PARAMS.coreFraction.toFixed(6),
    '#define CORE_AMP ' + PARAMS.coreAmp.toFixed(6),
    '#define FADE_BIAS ' + PARAMS.fadeBias.toFixed(6),
    '#define NOISE_SPEED ' + PARAMS.noiseSpeed.toFixed(6),
    '',
    'uniform vec2 uResolution;',
    'uniform vec2 uCenter;',
    'uniform float uBox;',
    'uniform float uBand;',
    'uniform float uNoiseAmp;',
    'uniform float uTime;',
    'uniform vec2 uPan;',
    'uniform float uLinePositions[LINE_COUNT];',
    'uniform vec2 uTrailCells[TRAIL_LENGTH];', // (col, row); (-1,-1) = empty slot
    'uniform sampler2D uAtlas;',
    '',
    'float hash(float a, float b) {',
    '  float v = sin(a * 127.1 + b * 311.7) * 43758.5453123;',
    '  return fract(v);',
    '}',
    '',
    'float depthFor(float dist, float halfBand) {',
    '  float frac = clamp((dist + halfBand) / uBand, 0.0, 1.0);',
    '  float coreEdgeDepth = 3.0 - CORE_AMP;',
    '  if (frac <= CORE_FRACTION) {',
    '    if (CORE_FRACTION <= 0.0) return coreEdgeDepth;',
    '    float ct = frac / CORE_FRACTION;',
    '    return 3.0 - CORE_AMP * ct;',
    '  }',
    '  float t = (frac - CORE_FRACTION) / (1.0 - CORE_FRACTION);',
    '  float shaped = (FADE_BIAS == 1.0) ? t : pow(t, FADE_BIAS);',
    '  return coreEdgeDepth * (1.0 - shaped);',
    '}',
    '',
    'int pickLevel(float depth, float ditherHash) {',
    '  float base = floor(depth);',
    '  float remainder = depth - base;',
    '  int baseInt = int(base);',
    '  if (ditherHash < remainder) {',
    '    int next = baseInt + 1;',
    '    return next < 3 ? next : 3;',
    '  }',
    '  return baseInt;',
    '}',
    '',
    'void main() {',
    '  vec2 frag = vec2(gl_FragCoord.x, uResolution.y - gl_FragCoord.y);',
    '  vec2 world = frag + uPan;',
    '',
    '  float cellX = floor(world.x / uBox);',
    '  float cellY = floor(world.y / uBox);',
    '  vec2 local = world - vec2(cellX, cellY) * uBox;',
    '',
    '  const float NX = 0.70710678;',
    '  const float NY = -0.70710678;',
    '  float cellCenterX = cellX * uBox + uBox * 0.5;',
    '  float cellCenterY = cellY * uBox + uBox * 0.5;',
    '  float proj = (cellCenterX - uCenter.x) * NX + (cellCenterY - uCenter.y) * NY;',
    '',
    '  float ditherHash = hash(cellX, cellY);',
    '  float phase = hash(cellY, cellX) * 6.28318530718;',
    '  float noise = uNoiseAmp * sin(uTime * NOISE_SPEED + phase);',
    '  float halfBand = uBand * 0.5;',
    '',
    '  int level = 0;',
    '  for (int i = 0; i < LINE_COUNT; i++) {',
    '    float dist = abs(proj - uLinePositions[i]) + noise;',
    '    if (dist < halfBand) {',
    '      int lvl = pickLevel(depthFor(dist, halfBand), ditherHash);',
    '      if (lvl > level) level = lvl;',
    '    }',
    '    if (level >= 3) break;',
    '  }',
    '',
    '  bool inTrail = false;',
    '  for (int i = 0; i < TRAIL_LENGTH; i++) {',
    '    vec2 tc = uTrailCells[i];',
    '    if (tc.x == cellX && tc.y == cellY) { inTrail = true; }',
    '  }',
    '',
    '  float atlasRow = inTrail ? 1.0 : 0.0;',
    '  vec2 atlasSize = vec2(uBox * 4.0, uBox * 2.0);',
    '  vec2 atlasUV = (vec2(float(level), atlasRow) * uBox + local) / atlasSize;',
    '  vec4 texColor = texture2D(uAtlas, atlasUV);',
    '  if (texColor.a < 0.5) discard;',
    '  gl_FragColor = texColor;',
    '}',
  ].join('\n');
}

function compileShader(gl: WebGLRenderingContext, type: number, src: string): WebGLShader {
  const sh = gl.createShader(type)!;
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    console.error('Shader compile error:', gl.getShaderInfoLog(sh));
  }
  return sh;
}

type TailCell = { col: number; row: number };

export default function HeroCaretField() {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const parent = canvas.parentElement;
    if (!parent) return;

    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    const gl = canvas.getContext('webgl', {
      alpha: true,
      antialias: false,
      premultipliedAlpha: true,
      depth: false,
      stencil: false,
    }) as WebGLRenderingContext | null;
    if (!gl) return;

    function tokens(): Tokens {
      const s = getComputedStyle(parent!);
      return {
        ink: s.getPropertyValue('--caret-ink').trim(),
        fill: s.getPropertyValue('--caret-fill').trim(),
        fillInk: s.getPropertyValue('--caret-fill-ink').trim(),
      };
    }

    function trailTokens(): Tokens {
      const s = getComputedStyle(parent!);
      return {
        ink: s.getPropertyValue('--caret-trail-ink').trim(),
        fill: s.getPropertyValue('--caret-trail-fill').trim(),
        fillInk: s.getPropertyValue('--caret-trail-fill-ink').trim(),
      };
    }

    const program = gl.createProgram()!;
    gl.attachShader(program, compileShader(gl, gl.VERTEX_SHADER, VERTEX_SRC));
    gl.attachShader(program, compileShader(gl, gl.FRAGMENT_SHADER, buildFragmentShader()));
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      console.error('Program link error:', gl.getProgramInfoLog(program));
    }
    gl.useProgram(program);

    const quadBuf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, quadBuf);
    gl.bufferData(
      gl.ARRAY_BUFFER,
      new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]),
      gl.STATIC_DRAW
    );
    const aPos = gl.getAttribLocation(program, 'aPos');
    gl.enableVertexAttribArray(aPos);
    gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);

    const uResolution = gl.getUniformLocation(program, 'uResolution');
    const uCenter = gl.getUniformLocation(program, 'uCenter');
    const uBox = gl.getUniformLocation(program, 'uBox');
    const uBand = gl.getUniformLocation(program, 'uBand');
    const uNoiseAmp = gl.getUniformLocation(program, 'uNoiseAmp');
    const uTime = gl.getUniformLocation(program, 'uTime');
    const uPan = gl.getUniformLocation(program, 'uPan');
    const uLinePositions = gl.getUniformLocation(program, 'uLinePositions[0]');
    const uTrailCells = gl.getUniformLocation(program, 'uTrailCells[0]');
    const uAtlas = gl.getUniformLocation(program, 'uAtlas');

    const atlasTexture = gl.createTexture();
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, atlasTexture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.uniform1i(uAtlas, 0);

    let dpr = Math.min(window.devicePixelRatio || 1, 2);
    let cssWidth = 0;
    let cssHeight = 0;
    let box = 1;
    let band = 0;
    let noiseAmp = 0;
    let centerX = 0;
    let centerY = 0;
    let projHalf = 0;
    let pad = 0;
    let panX = 0;
    let panY = 0;
    let panMargin = 0;
    let mouseX = 0;
    let mouseY = 0;
    let visible = true;

    const linePositionsBuf = new Float32Array(PARAMS.lineCount);
    let tailQueue: TailCell[] = [];
    let tailRetractProgress = 0;
    let tailEffectiveTarget = 0;
    const tailUniformData = new Float32Array(PARAMS.trailMaxLength * 2);
    let prevTrailX: number | null = null;
    let prevTrailY: number | null = null;

    function handleMouseMove(e: MouseEvent) {
      // getBoundingClientRect reflects any live CSS `scale` transform on an
      // ancestor (e.g. HeroStack's shrink-into-Projects tween) *and* any
      // browser zoom, but the canvas's own coordinate space (cssWidth/
      // cssHeight, last set by setup() at a stable dpr) is pinned to
      // whatever it was at the last real resize - zoom no longer updates
      // it at all. Rescale by that frozen size / the live rendered size so
      // mouseX/mouseY always land in the same frozen space the pan/trail
      // math (and box/dpr) already use, regardless of the current scale or
      // zoom level.
      const rect = parent!.getBoundingClientRect();
      const scaleX = cssWidth / rect.width;
      const scaleY = cssHeight / rect.height;
      mouseX = (e.clientX - rect.left) * scaleX;
      mouseY = (e.clientY - rect.top) * scaleY;
    }

    // Only checked against the current head so same-cell jitter collapses
    // into one entry, while revisiting an earlier cell still adds it again.
    function stampTrail(px: number, py: number) {
      const col = Math.floor(px / box);
      const row = Math.floor(py / box);
      const head = tailQueue[tailQueue.length - 1];
      if (head && head.col === col && head.row === row) return;
      tailQueue.push({ col, row });
      if (tailQueue.length > PARAMS.trailMaxLength) tailQueue.shift();
    }

    function retractTail(dt: number, isMoving: boolean) {
      const rawTarget = isMoving ? PARAMS.trailTargetLength : 0;
      tailEffectiveTarget += (rawTarget - tailEffectiveTarget) * PARAMS.trailTargetEase;

      const excess = Math.max(0, tailQueue.length - tailEffectiveTarget);
      const rate = PARAMS.trailSpringStrength * excess;
      tailRetractProgress += rate * dt;
      while (tailRetractProgress >= 1 && tailQueue.length > 0) {
        tailQueue.shift();
        tailRetractProgress -= 1;
      }
    }

    function updateTrail(dt: number) {
      const x = mouseX * dpr + panX;
      const y = mouseY * dpr + panY;
      let isMoving = false;

      if (prevTrailX === null || prevTrailY === null) {
        stampTrail(x, y);
      } else {
        const ddx = x - prevTrailX;
        const ddy = y - prevTrailY;
        const dist = Math.sqrt(ddx * ddx + ddy * ddy);
        if (dist > 0.5) {
          isMoving = true;
          const stepPx = box * PARAMS.trailStampSpacing;
          const steps = Math.min(Math.ceil(dist / stepPx), PARAMS.trailMaxStepsPerFrame);
          for (let i = 1; i <= steps; i++) {
            const f = i / steps;
            stampTrail(prevTrailX + ddx * f, prevTrailY + ddy * f);
          }
        }
      }

      prevTrailX = x;
      prevTrailY = y;

      retractTail(dt, isMoving);

      for (let t = 0; t < PARAMS.trailMaxLength; t++) {
        const c = tailQueue[t];
        tailUniformData[t * 2] = c ? c.col : -1;
        tailUniformData[t * 2 + 1] = c ? c.row : -1;
      }
    }

    function updatePan() {
      let targetX = (mouseX - cssWidth / 2) * PARAMS.panStrength * dpr;
      let targetY = (mouseY - cssHeight / 2) * PARAMS.panStrength * dpr;

      if (targetX > panMargin) targetX = panMargin;
      else if (targetX < -panMargin) targetX = -panMargin;
      if (targetY > panMargin) targetY = panMargin;
      else if (targetY < -panMargin) targetY = -panMargin;

      panX += (targetX - panX) * PARAMS.panEase;
      panY += (targetY - panY) * PARAMS.panEase;
    }

    // The lines share one loop, phase-shifted by an even fraction of the
    // period each, so they sit evenly spaced along the travel direction.
    function updateLinePositions(t: number) {
      const span = (projHalf + pad) * 2;
      for (let i = 0; i < PARAMS.lineCount; i++) {
        const phaseT = t + i * (PARAMS.loopSeconds / PARAMS.lineCount);
        linePositionsBuf[i] = ((phaseT / PARAMS.loopSeconds) % 1) * span - (projHalf + pad);
      }
    }

    function render(t: number) {
      updateLinePositions(t);

      gl!.clearColor(0, 0, 0, 0);
      gl!.clear(gl!.COLOR_BUFFER_BIT);

      gl!.uniform2f(uResolution, canvas!.width, canvas!.height);
      gl!.uniform2f(uCenter, centerX, centerY);
      gl!.uniform1f(uBox, box);
      gl!.uniform1f(uBand, band);
      gl!.uniform1f(uNoiseAmp, noiseAmp);
      gl!.uniform1f(uTime, t);
      gl!.uniform2f(uPan, panX, panY);
      gl!.uniform1fv(uLinePositions, linePositionsBuf);
      gl!.uniform2fv(uTrailCells, tailUniformData);

      gl!.drawArrays(gl!.TRIANGLE_STRIP, 0, 4);
    }

    let lastDpr: number | null = null;

    function setup() {
      const liveDpr = Math.min(window.devicePixelRatio || 1, 2);

      // Browser zoom changes devicePixelRatio; a genuine layout resize at a
      // stable zoom level does not. The canvas's CSS size (100% of its
      // parent) already tracks the container correctly through zoom on its
      // own - the element's physical on-screen footprint never actually
      // changes - so recomputing the grid off a temporarily-zoomed dpr only
      // makes things worse: spacingPx * dpr rounds down to a degenerate
      // 1px cell at low zoom, which is what turned the dot grid into flat
      // diagonal bands. Skipping the rebuild whenever dpr has drifted from
      // the last value we actually rendered at keeps the field pixel-for-
      // pixel identical across every zoom level, while still reacting to
      // real resizes once the zoom level (and dpr) settles.
      if (lastDpr !== null && liveDpr !== lastDpr) return;
      lastDpr = liveDpr;
      dpr = liveDpr;

      const rect = parent!.getBoundingClientRect();
      cssWidth = rect.width;
      cssHeight = rect.height;

      // Backing-buffer resolution only — display size is left to CSS
      // (width/height: 100% in HeroCaretField.css), same pattern as
      // CylinderRig's canvas. Setting canvas.style.width/height here from
      // a JS-measured value invites exactly the sub-pixel mismatch that
      // caused it: a getBoundingClientRect() float that doesn't bit-for-bit
      // match how the layout engine itself renders the parent's edge shows
      // up as a hairline gap along the right/bottom.
      canvas!.width = Math.max(1, Math.round(cssWidth * dpr));
      canvas!.height = Math.max(1, Math.round(cssHeight * dpr));
      gl!.viewport(0, 0, canvas!.width, canvas!.height);

      box = Math.max(1, Math.round(PARAMS.spacingPx * dpr));
      band = canvas!.width * PARAMS.bandFraction;
      noiseAmp = band * PARAMS.noiseFraction;
      pad = band * (0.5 + PARAMS.noiseFraction);

      centerX = canvas!.width / 2;
      centerY = canvas!.height / 2;
      projHalf = ((canvas!.width + canvas!.height) * Math.SQRT1_2) / 2;

      panMargin = Math.round(Math.max(canvas!.width, canvas!.height) * PARAMS.panMaxFraction);

      const unit = Math.max(1, Math.round(dpr));
      const sprites = buildSprites(box, unit, tokens());
      const spritesTrail = buildSprites(box, unit, trailTokens());
      const atlas = buildAtlas(box, sprites, spritesTrail);

      gl!.bindTexture(gl!.TEXTURE_2D, atlasTexture);
      gl!.pixelStorei(gl!.UNPACK_FLIP_Y_WEBGL, false);
      gl!.texImage2D(gl!.TEXTURE_2D, 0, gl!.RGBA, gl!.RGBA, gl!.UNSIGNED_BYTE, atlas);

      tailQueue = [];
      tailRetractProgress = 0;
      tailEffectiveTarget = 0;
      tailUniformData.fill(-1);
      prevTrailX = null;
      prevTrailY = null;
      mouseX = cssWidth / 2;
      mouseY = cssHeight / 2;

      if (reducedMotion) render(PARAMS.loopSeconds / 2); // one frozen mid-sweep frame
    }

    let resizeTimeout = 0;
    function scheduleResize() {
      window.clearTimeout(resizeTimeout);
      resizeTimeout = window.setTimeout(setup, 120);
    }

    setup();
    const resizeObserver = new ResizeObserver(scheduleResize);
    resizeObserver.observe(parent);

    // Light/dark switch: sprites bake the colors in, so rebuild them (setup also resets the trail).
    const colorScheme = window.matchMedia('(prefers-color-scheme: dark)');
    const onSchemeChange = () => {
      lastDpr = null;
      setup();
    };
    colorScheme.addEventListener('change', onSchemeChange);

    function cleanupGL() {
      gl!.deleteProgram(program);
      gl!.deleteBuffer(quadBuf);
      gl!.deleteTexture(atlasTexture);
    }

    if (reducedMotion) {
      return () => {
        window.clearTimeout(resizeTimeout);
        resizeObserver.disconnect();
        colorScheme.removeEventListener('change', onSchemeChange);
        cleanupGL();
      };
    }

    const intersectionObserver = new IntersectionObserver(
      (entries) => {
        visible = entries[0]?.isIntersecting ?? true;
      },
      { threshold: 0 }
    );
    intersectionObserver.observe(parent);
    // window, not parent: once hero2 is layered on top (grid-stacked
    // sibling), it can own pointer-events and intercept the hit-test
    // target before it ever reaches .hero-section — a parent-scoped
    // listener would silently stop firing. window always sees the event
    // regardless of hit-test target; the IntersectionObserver above
    // already gates real work behind `visible` so this stays cheap while
    // off-screen.
    window.addEventListener('mousemove', handleMouseMove, { passive: true });

    let rafId = 0;
    let lastTickNow: number | null = null;

    function tick(now: number) {
      rafId = requestAnimationFrame(tick);
      if (!visible) {
        lastTickNow = now;
        return;
      }
      // Clamp dt so a long gap (tab backgrounded) can't register as one huge
      // trail-retraction step.
      const dt = lastTickNow === null ? 0 : Math.min((now - lastTickNow) / 1000, 0.1);
      lastTickNow = now;

      updatePan();
      updateTrail(dt);
      render(now / 1000);
    }

    rafId = requestAnimationFrame(tick);

    return () => {
      cancelAnimationFrame(rafId);
      window.clearTimeout(resizeTimeout);
      resizeObserver.disconnect();
      colorScheme.removeEventListener('change', onSchemeChange);
      intersectionObserver.disconnect();
      window.removeEventListener('mousemove', handleMouseMove);
      cleanupGL();
    };
  }, []);

  return <canvas ref={canvasRef} className="pointer-events-none absolute inset-0 z-[1] block h-full w-full" aria-hidden="true" />;
}

