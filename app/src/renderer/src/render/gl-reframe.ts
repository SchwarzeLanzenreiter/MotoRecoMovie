// Reframe rendering with WebGL2.
// For each output pixel: perspective ray -> virtual camera rotation (rig coordinates) -> projection onto each lens (Mei + RadtanPro)
// -> rolling shutter correction (reproject using the pose at the time of the captured row) -> crossfade the seam.
import { focalFor, wideK } from './projection'
import type { LensModel } from '../core/lens'
import { seamBasis } from '../core/seamfit'
import { blurSeamQ, chooseSeamCut, chooseSeamDepth, CUT_OFFS, groundPrior, type SeamCutState, type SeamDepthState } from './seamdepth'
import { matT, type Mat3 } from '../core/quat'
import { t } from '../i18n'
import { BAND_H, BAND_STEP, BAND_TH0, BAND_W, bodyTexData, type BodyMapC } from '../core/bodymap'

export const RS_SLICES = 17
/** Number of azimuth divisions for finding the seam distance, and the candidates for the inverse distance [1/m] (0 = infinity ... 2.2 = about 45cm) */
export const SEAM_BINS = 256
export const SEAM_CAND = [0, 0.12, 0.25, 0.4, 0.55, 0.75, 1.0, 1.3, 1.7, 2.2]
const SEAM_CANDS = SEAM_CAND.length
const CUTS = CUT_OFFS.length
/** Number of rows in the search result: match score per distance candidate (SEAM_CANDS rows) + image difference per seam position candidate (CUTS rows) */
const PROBE_ROWS = SEAM_CANDS + CUTS

const VS = `#version 300 es
in vec2 aPos;
void main() { gl_Position = vec4(aPos, 0.0, 1.0); }
`

/** Lens projection (shared by the main draw and the seam distance search) */
const LENS_GLSL = `
struct Lens {
  float xi; float fx; float fy; float cx; float cy; float scale; float size;
  float edge;              // edge angle correction [rad] (edgeCorrect in core/lens.ts)
  vec3 pos;                // lens position [m] (rig coordinates, origin at the midpoint of the two lenses)
  mat3 camFromRig;
  float d[13];
};
uniform Lens uL0;
uniform Lens uL1;

// Ray (rig coordinates, direction as seen from the lens) -> video pixel (u, v) and angle from the optical axis
vec3 projectLens(Lens L, vec3 dRig) {
  vec3 c = normalize(L.camFromRig * dRig);
  if (L.edge != 0.0) {
    float rxy = length(c.xy);
    if (rxy > 1e-6) {
      float t = acos(clamp(c.z, -1.0, 1.0));
      float t2 = t + L.edge * pow(t / 1.5707963, 3.0);
      c = vec3(c.xy / rxy * sin(t2), cos(t2));
    }
  }
  float den = c.z + L.xi;
  float mx = c.x / den;
  float my = c.y / den;
  float r2 = mx * mx + my * my;
  float r4 = r2 * r2;
  float R = 1.0 + L.d[0] * r2 + L.d[1] * r4 + L.d[2] * r4 * r2 + L.d[3] * r4 * r4 + L.d[4] * r4 * r4 * r2;
  float a = L.d[5] + L.d[7] * r2;
  float b = L.d[6] + L.d[8] * r2;
  float xd = mx * R + (r2 + 2.0 * mx * mx) * a + 2.0 * mx * my * b + L.d[9] * r2 + L.d[11] * r4;
  float yd = my * R + (r2 + 2.0 * my * my) * b + 2.0 * mx * my * a + L.d[10] * r2 + L.d[12] * r4;
  float u = (L.fx * xd + L.cx) * L.scale;
  float v = (L.fy * yd + L.cy) * L.scale;
  return vec3(u, v, acos(clamp(c.z, -1.0, 1.0)));
}

// Seam coordinate system: the optical axis of lens 0, uSeamAx, and uSeamE1 and uSeamE2 orthogonal to it (reference of the azimuth phi)
uniform vec3 uSeamAx;
uniform vec3 uSeamE1;
uniform vec3 uSeamE2;

// Parallax correction is applied only near the seam (the band where the two lenses are mixed): fully within +/-7 deg of the seam, and 0 at +/-15 deg.
// |cos(angle from the optical axis)| = sin(angle from the seam). It used to be applied with a falloff out to +/-40 deg, so even areas away from the seam
// (such as the roadside grass at the lower left of the front-facing screen) stretched and shrank a little with a distance that changed every frame
float seamTaper(vec3 d) {
  float c = abs(dot(d, uSeamAx));
  return 1.0 - smoothstep(0.1219, 0.2588, c);
}
`

const FS = `#version 300 es
precision highp float;
uniform sampler2D uTex0;
uniform sampler2D uTex1;
${LENS_GLSL}
uniform mat3 uView;      // output camera coordinates -> rig coordinates (at the time of the frame center)
uniform vec2 uOut;       // size of the rectangle to draw [px]
uniform vec2 uOrigin;    // lower left of the rectangle (GL pixel coordinates)
uniform float uFocal;    // output focal length [px]
uniform float uK;        // projection blend (0 = perspective ... 1 = stereographic; projection.ts)
uniform vec3 uRs[${RS_SLICES}]; // relative rotation during readout (rotation vector, rig coordinates)
uniform int uRsIters;
uniform float uBlendDeg;
uniform int uDebug;      // for debugging: 1 = lens 0 only, 2 = lens 1 only, 3 = color the seam blend range, 4 = seam distance
// Values per seam azimuth. R32F of SEAM_BINSx4: row 1 = inverse distance [1/m] (0 = infinity), row 2 = inverse distance blurred along the seam,
// row 3 = seam position [deg] (angle shifted from the geometric seam toward lens 0), row 4 = blend width multiplier (1 = uBlendDeg)
uniform sampler2D uSeamTex;
// Seam template of the own bike (core/bodymap.ts): RGBA at band coordinates = fraction that is own-bike part, fraction from lens 1, offset of the position read from lens 1 (column, row).
// The templates of two sections are mixed with uBodyMix. uFill = hole-filled color (alpha = degree of hole)
uniform int uBodyOn;
uniform float uBodyMix;
uniform sampler2D uBodyA;
uniform sampler2D uBodyB;
uniform sampler2D uFillA;
uniform sampler2D uFillB;
out vec4 outColor;

// Apply the inverse rotation of rotation vector r to d (Rodrigues formula)
vec3 rotInv(vec3 r, vec3 d) {
  float ang = length(r);
  if (ang < 1e-9) return d;
  vec3 k = r / ang;
  float c = cos(-ang);
  float s = sin(-ang);
  return d * c + cross(k, d) * s + k * dot(k, d) * (1.0 - c);
}

vec3 rsAt(float frac) {
  float f = clamp(frac, 0.0, 1.0) * float(${RS_SLICES - 1});
  int k0 = int(min(floor(f), float(${RS_SLICES - 2})));
  float t = f - float(k0);
  return mix(uRs[k0], uRs[k0 + 1], t);
}

vec3 projectRs(Lens L, vec3 dMid) {
  vec3 p = projectLens(L, dMid);
  for (int i = 0; i < 4; i++) {
    if (i >= uRsIters) break;
    vec3 r = rsAt(p.y / L.size);  // readout goes from the top of the image to the bottom
    p = projectLens(L, rotInv(r, dMid));
  }
  return p;
}

// Seam parameters for a ray direction: x = inverse distance used for parallax correction (interpolated by azimuth, weakened away from the seam),
// y = seam position [deg], z = blend width multiplier.
// In the band where the two lenses are mixed (+/-3 deg from the seam) the per-bin distance is used as is, and from there out to +/-7 deg it moves to the distance blurred along the seam.
// Where only one lens sees, alignment is not needed, and the per-bin distance differences would turn directly into scenery distortion (a triangular fold in lines).
// For bins whose seam position was shifted, the shifted position is the center
vec3 seamAt(vec3 d) {
  float ph = atan(dot(d, uSeamE2), dot(d, uSeamE1));
  float f = (ph < 0.0 ? ph + 6.2831853 : ph) / 6.2831853 * float(${SEAM_BINS}) - 0.5;
  float fl = floor(f);
  float t = f - fl;
  int i0 = int(mod(fl, float(${SEAM_BINS})));
  int i1 = int(mod(fl + 1.0, float(${SEAM_BINS})));
  float q = mix(texelFetch(uSeamTex, ivec2(i0, 0), 0).r, texelFetch(uSeamTex, ivec2(i1, 0), 0).r, t);
  float qb = mix(texelFetch(uSeamTex, ivec2(i0, 1), 0).r, texelFetch(uSeamTex, ivec2(i1, 1), 0).r, t);
  float off = mix(texelFetch(uSeamTex, ivec2(i0, 2), 0).r, texelFetch(uSeamTex, ivec2(i1, 2), 0).r, t);
  float ws = mix(texelFetch(uSeamTex, ivec2(i0, 3), 0).r, texelFetch(uSeamTex, ivec2(i1, 3), 0).r, t);
  // sin of the angle from the seam (the shifted position)
  float a = asin(clamp(dot(d, uSeamAx), -1.0, 1.0)) - radians(off);
  float s = abs(sin(a));
  float wide = smoothstep(0.0523, 0.1219, s);
  float taper = 1.0 - smoothstep(0.1219, 0.2588, s);
  return vec3(mix(q, qb, wide) * taper, off, ws);
}

void main() {
  vec2 local = gl_FragCoord.xy - uOrigin;
  vec2 px = vec2(local.x, uOut.y - local.y);
  vec2 q = (px - uOut * 0.5) / uFocal;
  float r = length(q);
  float th = (1.0 + uK) * atan(r / (1.0 + uK)); // angle from the optical axis
  vec3 ray = r > 1e-6 ? vec3(q / r * sin(th), cos(th)) : vec3(0.0, 0.0, 1.0);
  vec3 dMid = uView * ray;
  // Parallax: treat the scenery near the seam as lying on a sphere of distance 1/sq, and take the direction as seen from each lens position
  vec3 sp = seamAt(dMid);
  float sq = sp.x;
  vec3 p0 = projectRs(uL0, normalize(dMid - uL0.pos * sq));
  vec3 p1 = projectRs(uL1, normalize(dMid - uL1.pos * sq));
  // Difference in angle from the optical axis (0 at the seam; moving 1 deg toward lens 0 gives about 2 deg). For bins with a shifted seam, it is 0.5 at the shifted position.
  // Where the images of the two lenses do not match (near things whose distance does not fit, or things that appear in only one), narrow the width so nothing looks doubled
  float diff = degrees(p1.z - p0.z) - 2.0 * sp.y;
  float w0 = smoothstep(0.0, 1.0, clamp(0.5 + diff / (uBlendDeg * sp.z), 0.0, 1.0));
  // The reference of the parallax correction (the eye position) moves between the two lenses according to the mix fraction (lens 1 position -> lens 0 position).
  // Where only one lens sees (w0 = 0 or 1), that lens's image is not shifted (the shape as captured by the lens). Only within the mixed band,
  // the other lens's image is shifted to overlap. It used to shift both lenses' images by half each, so even outside the band, the shape of near things (the top case etc.)
  // was distorted by the per-azimuth distance differences, leaving steps across the fastener (2026-10-11 Shiretoko at 8:00.76)
  if (sq > 0.0) {
    vec3 eye = mix(uL1.pos, uL0.pos, w0);
    if (w0 > 0.0) p0 = projectRs(uL0, normalize(dMid - (uL0.pos - eye) * sq));
    if (w0 < 1.0) p1 = projectRs(uL1, normalize(dMid - (uL1.pos - eye) * sq));
  }
  if (uDebug == 1) w0 = 1.0;
  if (uDebug == 2) w0 = 0.0;
  vec3 col = vec3(0.0);
  if (w0 > 0.0) col += w0 * texture(uTex0, p0.xy / uL0.size).rgb;
  if (w0 < 1.0) col += (1.0 - w0) * texture(uTex1, p1.xy / uL1.size).rgb;
  // The own-bike part is drawn with the seam and offsets of the template built per section (lens 0 as is, lens 1 read with a shift)
  if (uBodyOn == 1 && uDebug != 1 && uDebug != 2) {
    float thb = degrees(acos(clamp(dot(dMid, uSeamAx), -1.0, 1.0)));
    float row = (thb - ${BAND_TH0.toFixed(4)}) / ${BAND_STEP.toFixed(4)};
    if (row > 0.5 && row < ${(BAND_H - 0.5).toFixed(1)}) {
      float ph = atan(dot(dMid, uSeamE2), dot(dMid, uSeamE1));
      if (ph < 0.0) ph += 6.2831853;
      vec2 uv = vec2(ph / 6.2831853, row / ${BAND_H.toFixed(1)});
      vec4 bm = mix(texture(uBodyA, uv), texture(uBodyB, uv), uBodyMix);
      if (bm.x > 0.002) {
        vec3 q0 = projectRs(uL0, dMid);
        float ph1 = ph + bm.z * ${(6.2831853 / BAND_W).toFixed(8)};
        float th1 = radians(thb + bm.w * ${BAND_STEP.toFixed(4)});
        vec3 d1 = cos(th1) * uSeamAx + sin(th1) * (cos(ph1) * uSeamE1 + sin(ph1) * uSeamE2);
        vec3 q1 = projectRs(uL1, d1);
        vec3 cb = vec3(0.0);
        if (bm.y < 1.0) cb += (1.0 - bm.y) * texture(uTex0, q0.xy / uL0.size).rgb;
        if (bm.y > 0.0) cb += bm.y * texture(uTex1, q1.xy / uL1.size).rgb;
        vec4 fl = mix(texture(uFillA, uv), texture(uFillB, uv), uBodyMix);
        cb = mix(cb, fl.rgb, fl.a);
        col = mix(col, cb, bm.x);
        // For debugging: color the own-bike part where the two lenses are mixed green, and holes yellow
        if (uDebug == 3 && bm.x > 0.5) {
          w0 = 1.0;
          if (bm.y > 0.02 && bm.y < 0.98) col = mix(col, vec3(0.0, 1.0, 0.3), 0.45);
          if (fl.a > 0.5) col = mix(col, vec3(1.0, 0.9, 0.0), 0.45);
        }
        if (uDebug == 5) col = mix(col, vec3(0.0, 0.6, 1.0), 0.4 * bm.x);
      }
    }
  }
  if (uDebug == 3 && w0 > 0.0 && w0 < 1.0) col = mix(col, vec3(1.0, 0.0, 1.0), 0.35);
  if (uDebug == 4 && w0 > 0.0 && w0 < 1.0) col = mix(col, vec3(clamp(sq / 2.0, 0.0, 1.0), 0.2, 1.0 - clamp(sq / 2.0, 0.0, 1.0)), 0.6);
  outColor = vec4(col, 1.0);
}
`

/**
 * Seam distance search: 1 output pixel = (azimuth bin, distance candidate). In the overlap band (86.5-93.5 deg from the optical axis of lens 0),
 * find the brightness correlation of both lenses and write R = (1 - correlation)/2 (smaller = better match), G = texture strength
 */
const PROBE_FS = `#version 300 es
precision highp float;
uniform sampler2D uTex0;
uniform sampler2D uTex1;
${LENS_GLSL}
uniform float uCand[${SEAM_CANDS}]; // candidates for the inverse distance [1/m]
out vec4 outColor;

float luma(sampler2D t, vec2 uv, vec2 px) {
  // Average of the 4 surrounding points to suppress flicker from fine texture
  vec3 c = texture(t, uv + vec2(px.x, px.y)).rgb + texture(t, uv + vec2(-px.x, px.y)).rgb
         + texture(t, uv + vec2(px.x, -px.y)).rgb + texture(t, uv + vec2(-px.x, -px.y)).rgb;
  return dot(c * 0.25, vec3(0.299, 0.587, 0.114));
}

void main() {
  int bin = int(gl_FragCoord.x);
  float q = uCand[int(gl_FragCoord.y)];
  float n = 0.0, sa = 0.0, sb = 0.0, saa = 0.0, sbb = 0.0, sab = 0.0;
  vec2 px0 = vec2(1.5 / uL0.size);
  vec2 px1 = vec2(1.5 / uL1.size);
  for (int it = 0; it < 8; it++) {
    float th = radians(86.5 + float(it));
    for (int jp = 0; jp < 16; jp++) {
      float ph = (float(bin) + (float(jp) + 0.5) / 16.0) / float(${SEAM_BINS}) * 6.2831853;
      vec3 d = cos(th) * uSeamAx + sin(th) * (cos(ph) * uSeamE1 + sin(ph) * uSeamE2);
      float qq = q * seamTaper(d);
      vec3 p0 = projectLens(uL0, normalize(d - uL0.pos * qq));
      vec3 p1 = projectLens(uL1, normalize(d - uL1.pos * qq));
      float a = luma(uTex0, p0.xy / uL0.size, px0);
      float b = luma(uTex1, p1.xy / uL1.size, px1);
      n += 1.0; sa += a; sb += b; saa += a * a; sbb += b * b; sab += a * b;
    }
  }
  float va = max(saa / n - (sa / n) * (sa / n), 0.0);
  float vb = max(sbb / n - (sb / n) * (sb / n), 0.0);
  float cov = sab / n - (sa / n) * (sb / n);
  float ncc = cov / sqrt(va * vb + 1e-8);
  outColor = vec4(clamp((1.0 - ncc) * 0.5, 0.0, 1.0), clamp(sqrt(min(va, vb)) * 8.0, 0.0, 1.0), 0.0, 1.0);
}
`

/**
 * Seam position search: 1 output pixel = (azimuth bin, seam position candidate). At that position (shifted by `off` degrees from the geometric seam toward lens 0),
 * write the brightness difference between both lenses aligned at the current distance (row 1 of uSeamTex) (mean absolute value after removing the in-bin mean difference).
 * If the seam is switched where the difference is small, the switch is not noticeable. Positions beyond the visible range of either lens (100 deg from the optical axis) are 1
 */
const CUT_FS = `#version 300 es
precision highp float;
uniform sampler2D uTex0;
uniform sampler2D uTex1;
uniform sampler2D uSeamTex;
${LENS_GLSL}
uniform float uOffs[${CUTS}];
uniform float uRow0;
out vec4 outColor;

float luma(sampler2D t, vec2 uv) {
  return dot(texture(t, uv).rgb, vec3(0.299, 0.587, 0.114));
}

void main() {
  int bin = int(gl_FragCoord.x);
  float off = uOffs[int(gl_FragCoord.y - uRow0)];
  float q = texelFetch(uSeamTex, ivec2(bin, 0), 0).r;
  float a[48];
  float b[48];
  float ma = 0.0, mb = 0.0;
  bool bad = false;
  for (int it = 0; it < 3; it++) {
    float th = radians(90.0 - off + (float(it) - 1.0) * 0.8);
    for (int jp = 0; jp < 16; jp++) {
      float ph = (float(bin) + (float(jp) + 0.5) / 16.0) / float(${SEAM_BINS}) * 6.2831853;
      vec3 d = cos(th) * uSeamAx + sin(th) * (cos(ph) * uSeamE1 + sin(ph) * uSeamE2);
      vec3 p0 = projectLens(uL0, normalize(d - uL0.pos * q));
      vec3 p1 = projectLens(uL1, normalize(d - uL1.pos * q));
      if (p0.z > 1.745 || p1.z > 1.745) bad = true;
      int k = it * 16 + jp;
      a[k] = luma(uTex0, p0.xy / uL0.size);
      b[k] = luma(uTex1, p1.xy / uL1.size);
      ma += a[k];
      mb += b[k];
    }
  }
  ma /= 48.0;
  mb /= 48.0;
  float e = 0.0;
  float va = 0.0, vb = 0.0;
  for (int k = 0; k < 48; k++) {
    e += abs((a[k] - ma) - (b[k] - mb));
    va += abs(a[k] - ma);
    vb += abs(b[k] - mb);
  }
  // If both lenses see untextured surfaces, also look at the difference in mean brightness (allow up to 0.04, about the exposure difference between the two lenses).
  // With only the difference after removing the mean, a gray case and a black camera mount that appears in only one lens would "match",
  // the seam would move there, and the mount's black edge showed through the case (2026-10-11 Shiretoko at 8:00.76).
  // Where there is texture (object edges etc.), even a slight position shift changes the mean, so it is not checked (at 1:35.20, the seam escaped onto the plate at the edge above the license plate)
  float flatness = 1.0 - smoothstep(0.005, 0.012, max(va, vb) / 48.0);
  float dc = max(0.0, abs(ma - mb) - 0.04) * flatness;
  outColor = vec4(bad ? 1.0 : clamp((e / 48.0 + 0.5 * dc) * 4.0, 0.0, 1.0), 0.0, 0.0, 1.0);
}
`

/**
 * Band image (to build the own-bike seam template, core/bodymap.ts): the color seen directions of output pixel (x, y) = (azimuth phi, angle theta from the optical axis of lens 0)
 * through one lens as is (no parallax correction or rolling shutter correction). Alpha = whether it is inside the visible range of that lens (100 deg from the optical axis)
 */
const BAND_FS = `#version 300 es
precision highp float;
uniform sampler2D uTex0;
uniform sampler2D uTex1;
${LENS_GLSL}
uniform int uWhich;
out vec4 outColor;

void main() {
  float ph = gl_FragCoord.x / float(${BAND_W}) * 6.2831853;
  float th = radians(${BAND_TH0.toFixed(4)} + gl_FragCoord.y * ${BAND_STEP.toFixed(4)});
  vec3 d = cos(th) * uSeamAx + sin(th) * (cos(ph) * uSeamE1 + sin(ph) * uSeamE2);
  vec3 p = uWhich == 0 ? projectLens(uL0, d) : projectLens(uL1, d);
  vec3 col = uWhich == 0 ? texture(uTex0, p.xy / uL0.size).rgb : texture(uTex1, p.xy / uL1.size).rgb;
  outColor = vec4(col, p.z <= 1.745 ? 1.0 : 0.0);
}
`

// The whole sphere around the camera as a small equirectangular image in rig coordinates (fixed to the camera, so the own bike stays put
// and the scenery flows by). Kept for a few frames to see what moved (drawSigns). Each direction takes the lens nearer to its axis
const MOTION_W = 512
const MOTION_H = 256
const SPHERE_FS = `#version 300 es
precision highp float;
uniform sampler2D uTex0;
uniform sampler2D uTex1;
${LENS_GLSL}
out vec4 outColor;

void main() {
  // Row j holds e.y = (j + 0.5) / height (as the textures are sampled in drawSigns: e.y = 0 at the top of the sphere)
  float lon = (gl_FragCoord.x / ${MOTION_W.toFixed(1)} - 0.5) * 6.2831853;
  float lat = (0.5 - gl_FragCoord.y / ${MOTION_H.toFixed(1)}) * 3.14159265;
  vec3 d = vec3(cos(lat) * sin(lon), -sin(lat), cos(lat) * cos(lon));
  vec3 p0 = projectLens(uL0, d);
  vec3 p1 = projectLens(uL1, d);
  vec3 col = p0.z <= p1.z ? texture(uTex0, p0.xy / uL0.size).rgb : texture(uTex1, p1.xy / uL1.size).rgb;
  outColor = vec4(col, 1.0);
}
`
/** Frames kept, and how many frames back the comparison looks (4 frames = 80 ms at 50 fps) */
const MOTION_RING = 5
const MOTION_LAG = 4

const OVERLAY_VS = `#version 300 es
in vec2 aPos;
out vec2 vUv;
void main() {
  vUv = vec2((aPos.x + 1.0) * 0.5, 1.0 - (aPos.y + 1.0) * 0.5);
  gl_Position = vec4(aPos, 0.0, 1.0);
}
`
const OVERLAY_FS = `#version 300 es
precision mediump float;
uniform sampler2D uTex;
in vec2 vUv;
out vec4 outColor;
void main() { outColor = texture(uTex, vUv); }
`

// Corner signs over the video, with the own bike and rider cut out (core/bikemask.ts).
// For each pixel of a view: the ray of the view (same projection as the main draw) in rig coordinates looks up the bike masks;
// where the bike surely is (core) the sign is removed; where the bike or rider can be (envelope), the color of the video at that pixel
// decides through the color table (5 taps, so single pixels do not flicker)
/** Most plates pixelated in one view per draw */
export const MOSAIC_MAX = 16

/**
 * Privacy mosaic: pixels inside any of the quads (convex, GL pixel coordinates) take the mean color of their block (uBlock px, a
 * grid of 3×3 samples of the frame drawn so far); others are left as they are
 */
const MOSAIC_FS = `#version 300 es
precision highp float;
uniform sampler2D uFrame;
uniform vec2 uSize;
uniform vec2 uQ[${4 * 16}];
uniform float uBlock[16];
uniform int uN;
out vec4 outColor;
bool inside(vec2 p, int k) {
  bool pos = false;
  bool neg = false;
  for (int j = 0; j < 4; j++) {
    vec2 a = uQ[k * 4 + j];
    vec2 b = uQ[k * 4 + (j + 1) % 4];
    float c = (b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x);
    pos = pos || c > 0.0;
    neg = neg || c < 0.0;
  }
  return !(pos && neg);
}
void main() {
  vec2 p = gl_FragCoord.xy;
  for (int k = 0; k < 16; k++) {
    if (k >= uN) break;
    if (!inside(p, k)) continue;
    float bs = uBlock[k];
    vec2 c0 = floor(p / bs) * bs;
    vec3 acc = vec3(0.0);
    for (int y = 0; y < 3; y++)
      for (int x = 0; x < 3; x++) acc += texture(uFrame, (c0 + (vec2(x, y) + 0.5) * bs / 3.0) / uSize).rgb;
    outColor = vec4(acc / 9.0, 1.0);
    return;
  }
  discard;
}
`

const SIGNS_FS = `#version 300 es
precision highp float;
precision highp sampler3D;
uniform sampler2D uSigns;  // signs of all views (premultiplied, the whole output)
uniform sampler2D uFrame;  // the video of this frame (copy of the output)
uniform sampler2D uCore;   // equirectangular, rig coordinates
uniform sampler2D uEnv;
uniform sampler3D uLut;    // likelihood of the bike by color
uniform vec2 uSize;        // output size
uniform vec2 uOut;         // view rectangle size
uniform vec2 uOrigin;      // view rectangle origin (GL coordinates)
uniform float uFocal;
uniform float uK;
uniform mat3 uView;        // output camera -> rig
uniform int uDebug;        // 1 = show the cut area in red
uniform vec4 uAbove[8];    // rectangles of views drawn later (GL coordinates x, y, w, h): those pixels belong to them
uniform int uAboveN;
uniform sampler2D uNow;    // the sphere now and a few frames back (rig coordinates; SPHERE_FS)
uniform sampler2D uPast;
uniform int uMotion;       // 1 = the frames are consecutive (playback, export), so the change between them can be used
uniform int uSeg;          // 1 = the outline of the own bike and rider from the segmentation model (renderCrop) is fresh: it decides alone
uniform sampler2D uSegTex; // that outline in the crop (rows from the top)
uniform mat3 uCrop;        // crop camera -> rig (columns = its right, down, forward)
uniform float uCropF;      // focal length of the crop [crop pixels / crop size]
// The outline in the crop (exactly the model's outline: hiding more than the rider and bike shows as a gap in the sign)
float segAt(sampler2D t, mat3 crop, float f, vec3 d) {
  vec3 c = transpose(crop) * d;
  if (c.z <= 0.0) return 0.0;
  vec2 uv = c.xy / c.z * f + 0.5;
  if (any(lessThan(uv, vec2(0.0))) || any(greaterThan(uv, vec2(1.0)))) return 0.0;
  return smoothstep(0.45, 0.55, texture(t, uv).r);
}
out vec4 outColor;
float bike(ivec2 p) {
  vec3 c = texelFetch(uFrame, p, 0).rgb;
  return texture(uLut, c * ${(15 / 16).toFixed(6)} + ${(0.5 / 16).toFixed(6)}).r;
}
void main() {
  for (int i = 0; i < 8; i++) {
    if (i >= uAboveN) break;
    vec4 a = uAbove[i];
    if (gl_FragCoord.x >= a.x && gl_FragCoord.x < a.x + a.z && gl_FragCoord.y >= a.y && gl_FragCoord.y < a.y + a.w) discard;
  }
  vec4 s = texture(uSigns, vec2(gl_FragCoord.x / uSize.x, 1.0 - gl_FragCoord.y / uSize.y));
  if (s.a <= 0.0 && uDebug == 0) discard;
  vec2 local = gl_FragCoord.xy - uOrigin;
  vec2 px = vec2(local.x, uOut.y - local.y);
  vec2 q = (px - uOut * 0.5) / uFocal;
  float r = length(q);
  float th = (1.0 + uK) * atan(r / (1.0 + uK));
  vec3 ray = r > 1e-6 ? vec3(q / r * sin(th), cos(th)) : vec3(0.0, 0.0, 1.0);
  vec3 d = uView * ray;
  vec2 e = vec2(atan(d.x, d.z) / 6.2831853 + 0.5, 0.5 - atan(-d.y, length(d.xz)) / 3.14159265);
  float occ = 0.0;
  if (uSeg == 1) {
    // Outside the crop there is no own bike
    occ = segAt(uSegTex, uCrop, uCropF, d);
    outColor = s * (1.0 - occ);
    if (uDebug == 1) outColor = outColor * (1.0 - 0.5 * occ) + vec4(0.0, 0.0, 0.5 * occ, 0.5 * occ);
    return;
  }
  float core = texture(uCore, e).r;
  float env = texture(uEnv, e).r;
  occ = core;
  if (env > 0.0) {
    ivec2 p = ivec2(gl_FragCoord.xy);
    float b = (2.0 * bike(p) + bike(p + ivec2(1, 0)) + bike(p - ivec2(1, 0)) + bike(p + ivec2(0, 1)) + bike(p - ivec2(0, 1))) / 6.0;
    float c = env * smoothstep(0.35, 0.65, b);
    // Narrowed down by the flow: what changed a lot since a few frames ago flows by with the speed, so it is scenery whatever its color.
    // Not applied to the core: paint and chrome on the bike mirror the scenery going by
    if (uMotion == 1 && c > 0.0) c *= 1.0 - smoothstep(0.08, 0.2, length(texture(uNow, e).rgb - texture(uPast, e).rgb));
    occ = max(occ, c);
  }
  outColor = s * (1.0 - occ);
  if (uDebug == 1) outColor = outColor * (1.0 - 0.5 * occ) + vec4(0.5 * occ, 0.0, 0.0, 0.5 * occ);
}
`

/** Outline of the own bike and rider from the segmentation model, in a square perspective crop (renderCrop) */
export interface SignSegmentation {
  /** size × size, 0..255, rows from the top */
  mask: Uint8Array
  size: number
  /** crop camera -> rig (row-major; columns = its right, down, forward) and its field of view [deg] */
  view: Mat3
  fov: number
}

/** Own bike masks as handed to drawSigns (core/bikemask.ts BikeMask) */
export interface SignOcclusion {
  core: Uint8Array
  env: Uint8Array
  lut: Uint8Array
  width: number
  height: number
  lutN: number
}

/** Rectangle within the output screen (pixels, origin at the top left) */
export interface PixelRect {
  x: number
  y: number
  w: number
  h: number
}

export interface FrameParams {
  view: Mat3 // output camera -> rig (row-major)
  rs: Float32Array | null // RS_SLICES×3 (null for no correction)
  hfovDeg: number
}

export class GlReframer {
  readonly gl: WebGL2RenderingContext
  private prog: WebGLProgram
  private tex: [WebGLTexture, WebGLTexture]
  private loc = new Map<string, WebGLUniformLocation | null>()
  private lenses: LensModel[] = []
  private ovProg: WebGLProgram
  private signsProg: WebGLProgram
  private mosaicProg: WebGLProgram
  private mosaicTex: WebGLTexture | null = null
  private signsLoc = new Map<string, WebGLUniformLocation | null>()
  /** Textures of drawSigns: the signs, the copy of the frame, the masks (the mask set currently loaded) */
  private signsTex: WebGLTexture[] = []
  private signsMask: SignOcclusion | null = null
  private sphereProg: WebGLProgram
  /** Outline from the segmentation model (drawSigns) and the mask currently in the texture */
  private segTex: WebGLTexture | null = null
  private segLoaded: Uint8Array | null = null
  /** Render target of renderCrop */
  private cropFb: WebGLFramebuffer | null = null
  private sphereLoc = new Map<string, WebGLUniformLocation | null>()
  /** Ring of sphere images (updateMotion): textures, framebuffers, next slot, how many consecutive frames are in it, last frame number */
  private motionTex: WebGLTexture[] = []
  private motionFb: WebGLFramebuffer[] = []
  private motionHead = 0
  private motionCount = 0
  private motionLast = -2
  private probeProg: WebGLProgram
  private cutProg: WebGLProgram
  private bandProg: WebGLProgram
  /** Textures of the own-bike seam template (for 2 sections) and the templates currently loaded */
  private bodyTex: [WebGLTexture, WebGLTexture]
  private fillTex: [WebGLTexture, WebGLTexture]
  private bodyCur: [BodyMapC | null | undefined, BodyMapC | null | undefined] = [undefined, undefined]
  private bodyBuf: { map: Float32Array<ArrayBuffer>; fill: Uint8Array<ArrayBuffer> } | null = null
  private bandLoc = new Map<string, WebGLUniformLocation | null>()
  private bandFb: WebGLFramebuffer | null = null
  private cutLoc = new Map<string, WebGLUniformLocation | null>()
  private cut: SeamCutState | null = null
  private probeLoc = new Map<string, WebGLUniformLocation | null>()
  private probeFb: WebGLFramebuffer
  private probeBuf = new Uint8Array(SEAM_BINS * PROBE_ROWS * 4)
  /** Gravity pointing down (rig coordinates) of the frame whose seam distance is being found */
  private seamDown: ArrayLike<number> | null = null
  private seam: SeamDepthState | null = null
  private seamTex: WebGLTexture
  private probePbo: WebGLBuffer
  private pending: WebGLSync | null = null
  /** Most recent search result (for checking) */
  lastProbe: { cost: Float32Array; texture: Float32Array; cutDiff: Float32Array } | null = null
  /** Dynamic stitching (find the seam distance every frame and correct the parallax) */
  dynamicSeam = true
  /** Where the images do not match, shift the seam position and switch narrowly (chooseSeamCut in seamdepth.ts. Can be turned off for checking) */
  adaptiveCut = true
  private ovTex: WebGLTexture
  private ovLoc: WebGLUniformLocation | null

  constructor(readonly canvas: HTMLCanvasElement | OffscreenCanvas) {
    const gl = canvas.getContext('webgl2', { antialias: false, preserveDrawingBuffer: true }) as WebGL2RenderingContext | null
    if (!gl) throw new Error(t('WebGL2 is not available'))
    this.gl = gl
    const sh = (type: number, src: string): WebGLShader => {
      const s = gl.createShader(type)!
      gl.shaderSource(s, src)
      gl.compileShader(s)
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(t('Shader compile failed: {log}', { log: String(gl.getShaderInfoLog(s)) }))
      return s
    }
    const link = (vs: string, fs: string): WebGLProgram => {
      const pr = gl.createProgram()!
      gl.attachShader(pr, sh(gl.VERTEX_SHADER, vs))
      gl.attachShader(pr, sh(gl.FRAGMENT_SHADER, fs))
      gl.bindAttribLocation(pr, 0, 'aPos')
      gl.linkProgram(pr)
      if (!gl.getProgramParameter(pr, gl.LINK_STATUS)) throw new Error(t('Shader link failed: {log}', { log: String(gl.getProgramInfoLog(pr)) }))
      return pr
    }
    const p = link(VS, FS)
    this.prog = p
    this.ovProg = link(OVERLAY_VS, OVERLAY_FS)
    this.signsProg = link(VS, SIGNS_FS)
    this.mosaicProg = link(VS, MOSAIC_FS)
    this.sphereProg = link(VS, SPHERE_FS)
    this.probeProg = link(VS, PROBE_FS)
    this.cutProg = link(VS, CUT_FS)
    this.bandProg = link(VS, BAND_FS)
    this.ovLoc = gl.getUniformLocation(this.ovProg, 'uTex')
    gl.useProgram(p)
    const buf = gl.createBuffer()
    gl.bindBuffer(gl.ARRAY_BUFFER, buf)
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW)
    gl.enableVertexAttribArray(0)
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0)
    const mk = (): WebGLTexture => {
      const t = gl.createTexture()!
      gl.bindTexture(gl.TEXTURE_2D, t)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
      return t
    }
    this.tex = [mk(), mk()]
    this.ovTex = mk()
    gl.uniform1i(this.u('uTex0'), 0)
    gl.uniform1i(this.u('uTex1'), 1)
    // Output target of the seam distance search (azimuth bin × distance candidate)
    const pt = mk()
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, SEAM_BINS, PROBE_ROWS, 0, gl.RGBA, gl.UNSIGNED_BYTE, null)
    this.probeFb = gl.createFramebuffer()!
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.probeFb)
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, pt, 0)
    gl.bindFramebuffer(gl.FRAMEBUFFER, null)
    this.probePbo = gl.createBuffer()!
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, this.probePbo)
    gl.bufferData(gl.PIXEL_PACK_BUFFER, this.probeBuf.byteLength, gl.STREAM_READ)
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null)
    // Seam distance (read by the main draw)
    this.seamTex = mk()
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST)
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.R32F, SEAM_BINS, 4, 0, gl.RED, gl.FLOAT, new Float32Array(SEAM_BINS * 4))
    gl.uniform1i(this.u('uSeamTex'), 3)
    gl.useProgram(this.probeProg)
    gl.uniform1i(this.uP('uTex0'), 0)
    gl.uniform1i(this.uP('uTex1'), 1)
    gl.uniform1fv(this.uP('uCand[0]'), new Float32Array(SEAM_CAND))
    gl.useProgram(this.cutProg)
    gl.uniform1i(this.uC('uTex0'), 0)
    gl.uniform1i(this.uC('uTex1'), 1)
    gl.uniform1i(this.uC('uSeamTex'), 3)
    gl.uniform1fv(this.uC('uOffs[0]'), new Float32Array(CUT_OFFS))
    gl.uniform1f(this.uC('uRow0'), SEAM_CANDS)
    gl.useProgram(this.bandProg)
    gl.uniform1i(this.uB('uTex0'), 0)
    gl.uniform1i(this.uB('uTex1'), 1)
    // Own-bike seam template (the azimuth is continuous around the full circle)
    const mkBody = (fmt: 'map' | 'fill'): WebGLTexture => {
      const t = mk()
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT)
      if (fmt === 'map') gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, BAND_W, BAND_H, 0, gl.RGBA, gl.HALF_FLOAT, null)
      else gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, BAND_W, BAND_H, 0, gl.RGBA, gl.UNSIGNED_BYTE, null)
      return t
    }
    this.bodyTex = [mkBody('map'), mkBody('map')]
    this.fillTex = [mkBody('fill'), mkBody('fill')]
    gl.useProgram(this.prog)
    gl.uniform1i(this.u('uBodyA'), 4)
    gl.uniform1i(this.u('uBodyB'), 5)
    gl.uniform1i(this.u('uFillA'), 6)
    gl.uniform1i(this.u('uFillB'), 7)
    gl.uniform1i(this.u('uBodyOn'), 0)
  }

  /**
   * Use the own-bike seam template (the templates of the 2 sections chosen with bodyAt in core/bodymap.ts, and the mix fraction).
   * Not used if both are null. The texture is rewritten only when the template changes
   */
  setBody(a: BodyMapC | null, b: BodyMapC | null, mix: number): void {
    const gl = this.gl
    gl.useProgram(this.prog)
    if (!a && !b) {
      gl.uniform1i(this.u('uBodyOn'), 0)
      return
    }
    const want: [BodyMapC | null, BodyMapC | null] = [a ?? b, b ?? a]
    for (let k = 0; k < 2; k++) {
      if (this.bodyCur[k] === want[k]) continue
      this.bodyBuf = bodyTexData(want[k], this.bodyBuf?.map, this.bodyBuf?.fill)
      gl.activeTexture(gl.TEXTURE4 + k)
      gl.bindTexture(gl.TEXTURE_2D, this.bodyTex[k])
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, BAND_W, BAND_H, gl.RGBA, gl.FLOAT, this.bodyBuf.map)
      gl.activeTexture(gl.TEXTURE6 + k)
      gl.bindTexture(gl.TEXTURE_2D, this.fillTex[k])
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, BAND_W, BAND_H, gl.RGBA, gl.UNSIGNED_BYTE, this.bodyBuf.fill)
      this.bodyCur[k] = want[k]
    }
    gl.uniform1i(this.u('uBodyOn'), 1)
    gl.uniform1f(this.u('uBodyMix'), Math.max(0, Math.min(1, mix)))
  }

  private uB(name: string): WebGLUniformLocation | null {
    if (!this.bandLoc.has(name)) this.bandLoc.set(name, this.gl.getUniformLocation(this.bandProg, name))
    return this.bandLoc.get(name)!
  }

  /**
   * Read the band image of one lens for the current frame (after upload) (RGBA of BAND_W×BAND_H, row 0 = start angle of the band).
   * Alpha = whether it is inside (255) or outside (0) the visible range of that lens
   */
  renderBand(which: 0 | 1, out = new Uint8Array(BAND_W * BAND_H * 4)): Uint8Array {
    const gl = this.gl
    if (!this.bandFb) {
      const t = gl.createTexture()!
      gl.bindTexture(gl.TEXTURE_2D, t)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST)
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, BAND_W, BAND_H, 0, gl.RGBA, gl.UNSIGNED_BYTE, null)
      this.bandFb = gl.createFramebuffer()!
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.bandFb)
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, t, 0)
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.bandFb)
    gl.disable(gl.SCISSOR_TEST)
    gl.disable(gl.BLEND)
    gl.viewport(0, 0, BAND_W, BAND_H)
    gl.useProgram(this.bandProg)
    gl.uniform1i(this.uB('uWhich'), which)
    for (let i = 0; i < 2; i++) {
      gl.activeTexture(gl.TEXTURE0 + i)
      gl.bindTexture(gl.TEXTURE_2D, this.tex[i])
    }
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4)
    gl.readPixels(0, 0, BAND_W, BAND_H, gl.RGBA, gl.UNSIGNED_BYTE, out)
    gl.bindFramebuffer(gl.FRAMEBUFFER, null)
    gl.useProgram(this.prog)
    return out
  }

  private uC(name: string): WebGLUniformLocation | null {
    if (!this.cutLoc.has(name)) this.cutLoc.set(name, this.gl.getUniformLocation(this.cutProg, name))
    return this.cutLoc.get(name)!
  }

  private uP(name: string): WebGLUniformLocation | null {
    if (!this.probeLoc.has(name)) this.probeLoc.set(name, this.gl.getUniformLocation(this.probeProg, name))
    return this.probeLoc.get(name)!
  }

  /**
   * Find the seam distance and pass it to the main draw (call after upload, before draw). frame is the frame number
   * (for consecutive frames, change gradually from the previous result). down is the gravity pointing down (rig coordinates) of that frame.
   * If given, for azimuths below the horizon the distance to the ground is used as a guide
   */
  updateSeam(frame: number, down: ArrayLike<number> | null = null): void {
    const gl = this.gl
    this.seamDown = down
    if (!this.dynamicSeam || this.lenses.length < 2) {
      if (this.seam) {
        this.seam = null
        this.cut = null
        this.setSeamQ(new Float32Array(SEAM_BINS))
      }
      return
    }
    const continuous = !!this.seam && Math.abs(frame - this.seam.frame) === 1
    if (!continuous) {
      // Just after a seek etc.: compute on the spot (it waits for GPU work, so it takes a little time)
      this.dropPending()
      this.runProbe()
      gl.readPixels(0, 0, SEAM_BINS, PROBE_ROWS, gl.RGBA, gl.UNSIGNED_BYTE, this.probeBuf)
      gl.bindFramebuffer(gl.FRAMEBUFFER, null)
      this.applyProbe(frame)
      return
    }
    // Consecutive frames (playback, export): receive and use the result of the search issued in the previous frame, without waiting for the GPU
    // (one frame late, but the change from the previous frame is small, and the value was approaching gradually anyway)
    if (this.pending) {
      const st = gl.clientWaitSync(this.pending, 0, 0)
      if (st === gl.TIMEOUT_EXPIRED || st === gl.WAIT_FAILED) {
        // Not finished yet: keep the previous value this time (only advance the frame number)
        this.seam = { ...this.seam!, frame }
        return
      }
      gl.bindBuffer(gl.PIXEL_PACK_BUFFER, this.probePbo)
      gl.getBufferSubData(gl.PIXEL_PACK_BUFFER, 0, this.probeBuf)
      gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null)
      this.dropPending()
      this.applyProbe(frame)
    } else this.seam = { ...this.seam!, frame }
    // Issue the search for the current frame (the result is received in the next frame)
    this.runProbe()
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, this.probePbo)
    gl.readPixels(0, 0, SEAM_BINS, PROBE_ROWS, gl.RGBA, gl.UNSIGNED_BYTE, 0)
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null)
    gl.bindFramebuffer(gl.FRAMEBUFFER, null)
    this.pending = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0)
    gl.flush()
  }

  /** Draws the search (the framebuffer is left as for the search) */
  private runProbe(): void {
    const gl = this.gl
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.probeFb)
    gl.disable(gl.SCISSOR_TEST)
    gl.disable(gl.BLEND)
    gl.viewport(0, 0, SEAM_BINS, SEAM_CANDS)
    gl.useProgram(this.probeProg)
    for (let i = 0; i < 2; i++) {
      gl.activeTexture(gl.TEXTURE0 + i)
      gl.bindTexture(gl.TEXTURE_2D, this.tex[i])
    }
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4)
    // Image difference per seam position candidate (aligned at the current distance)
    gl.viewport(0, SEAM_CANDS, SEAM_BINS, CUTS)
    gl.useProgram(this.cutProg)
    gl.activeTexture(gl.TEXTURE3)
    gl.bindTexture(gl.TEXTURE_2D, this.seamTex)
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4)
  }

  private dropPending(): void {
    if (this.pending) this.gl.deleteSync(this.pending)
    this.pending = null
  }

  /** Choose the distance from the search result that was read back and pass it to the main draw */
  private applyProbe(frame: number): void {
    const cost = new Float32Array(SEAM_BINS * SEAM_CANDS)
    const texture = new Float32Array(SEAM_BINS)
    for (let k = 0; k < SEAM_CANDS; k++) {
      for (let b = 0; b < SEAM_BINS; b++) {
        const o = (k * SEAM_BINS + b) * 4
        cost[k * SEAM_BINS + b] = this.probeBuf[o] / 255
        texture[b] = Math.max(texture[b], this.probeBuf[o + 1] / 255)
      }
    }
    const cutDiff = new Float32Array(SEAM_BINS * CUTS)
    for (let j = 0; j < CUTS; j++) for (let b = 0; b < SEAM_BINS; b++) cutDiff[j * SEAM_BINS + b] = this.probeBuf[((SEAM_CANDS + j) * SEAM_BINS + b) * 4] / 255
    this.lastProbe = { cost, texture, cutDiff }
    // For azimuths below the horizon, use the distance to the ground as a guide
    let ground: Float32Array | null = null
    if (this.seamDown && this.lenses.length >= 2) {
      const { e1, e2 } = seamBasis(this.lenses)
      ground = groundPrior(e1, e2, this.seamDown, SEAM_BINS)
    }
    this.seam = chooseSeamDepth(cost, texture, SEAM_CAND, SEAM_BINS, this.seam, frame, ground)
    // Seam position and blend width: where the images of the two lenses do not match, switch narrowly at a position with a small image difference
    this.cut = this.adaptiveCut ? chooseSeamCut(cutDiff, cost, texture, SEAM_CAND, this.seam.q, SEAM_BINS, this.cut, frame) : null
    this.setSeamQ(this.seam.q, this.cut)
  }

  /**
   * Seam values into the main draw texture: inverse distance (the raw value and the value blurred along the seam), seam position, and blend width multiplier
   * (if cut is omitted, the position is the geometric seam and the width is unchanged)
   */
  private setSeamQ(q: Float32Array, cut: SeamCutState | null = null): void {
    const gl = this.gl
    const rows = new Float32Array(SEAM_BINS * 4)
    rows.set(q)
    rows.set(blurSeamQ(q), SEAM_BINS)
    if (cut) {
      rows.set(cut.off, SEAM_BINS * 2)
      rows.set(cut.width, SEAM_BINS * 3)
    } else rows.fill(1, SEAM_BINS * 3)
    gl.activeTexture(gl.TEXTURE3)
    gl.bindTexture(gl.TEXTURE_2D, this.seamTex)
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, SEAM_BINS, 4, gl.RED, gl.FLOAT, rows)
    gl.useProgram(this.prog)
  }

  /** For debugging: set the inverse seam distance of all bins to this value */
  forceSeamQ(q: number): void {
    this.setSeamQ(new Float32Array(SEAM_BINS).fill(q), this.cut)
  }

  /** Most recently found seam position and width (for checking) */
  seamCut(): SeamCutState | null {
    return this.cut
  }

  /** Most recently found inverse seam distance (for checking) */
  seamDepth(): Float32Array | null {
    return this.seam?.q ?? null
  }

  private u(name: string): WebGLUniformLocation | null {
    if (!this.loc.has(name)) this.loc.set(name, this.gl.getUniformLocation(this.prog, name))
    return this.loc.get(name)!
  }

  setLenses(lenses: LensModel[]): void {
    const gl = this.gl
    this.lenses = lenses
    this.seam = null
    this.cut = null
    this.dropPending()
    const { ax, e1, e2 } = seamBasis(lenses)
    for (const [prog, u] of [
      [this.prog, (n: string) => this.u(n)],
      [this.probeProg, (n: string) => this.uP(n)],
      [this.cutProg, (n: string) => this.uC(n)],
      [this.bandProg, (n: string) => this.uB(n)],
      [this.sphereProg, (n: string) => this.uSp(n)]
    ] as [WebGLProgram, (n: string) => WebGLUniformLocation | null][]) {
      gl.useProgram(prog)
      lenses.forEach((L, i) => {
        const n = `uL${i}.`
        gl.uniform1f(u(n + 'xi'), L.xi)
        gl.uniform1f(u(n + 'fx'), L.fx)
        gl.uniform1f(u(n + 'fy'), L.fy)
        gl.uniform1f(u(n + 'cx'), L.cx)
        gl.uniform1f(u(n + 'cy'), L.cy)
        gl.uniform1f(u(n + 'scale'), L.scale)
        gl.uniform1f(u(n + 'size'), L.pictureSize)
        gl.uniform1f(u(n + 'edge'), L.edge ?? 0)
        gl.uniform3f(u(n + 'pos'), L.pos[0], L.pos[1], L.pos[2])
        // GLSL mat3 is column-major. Transpose the row-major matrix before passing it
        gl.uniformMatrix3fv(u(n + 'camFromRig'), false, new Float32Array(matT(L.camFromRig)))
        for (let k = 0; k < 13; k++) gl.uniform1f(u(`${n}d[${k}]`), L.d[k])
      })
      gl.uniform3f(u('uSeamAx'), ax[0], ax[1], ax[2])
      gl.uniform3f(u('uSeamE1'), e1[0], e1[1], e1[2])
      gl.uniform3f(u('uSeamE2'), e2[0], e2[1], e2[2])
    }
    this.setSeamQ(new Float32Array(SEAM_BINS))
  }


  /** Transfers each lens frame (VideoFrame etc.) to a texture */
  upload(frames: [TexImageSource, TexImageSource]): void {
    const gl = this.gl
    frames.forEach((f, i) => {
      gl.activeTexture(gl.TEXTURE0 + i)
      gl.bindTexture(gl.TEXTURE_2D, this.tex[i])
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, f)
    })
  }

  /** Match the output size and fill with black (start of drawing a frame) */
  begin(width: number, height: number): void {
    const gl = this.gl
    if (this.canvas.width !== width) this.canvas.width = width
    if (this.canvas.height !== height) this.canvas.height = height
    gl.disable(gl.SCISSOR_TEST)
    gl.viewport(0, 0, width, height)
    gl.clearColor(0, 0, 0, 1)
    gl.clear(gl.COLOR_BUFFER_BIT)
  }

  /**
   * Seam crossfade width [deg] (difference in angle from the optical axis; switches smoothly with an S curve).
   * The two lenses differ slightly in sharpness of detail and in color, so if it is narrow the switching line is visible.
   * After alignment, about 12° looks natural (at 18° near things start to look doubled)
   */
  blendDeg = 12

  /** Display for debugging (0 = normal). See uDebug in the shader */
  debug = 0

  /** For debugging: set the projection blend k to this value regardless of the FOV (null = decide from the FOV) */
  kOverride: number | null = null

  /** Draws one view. If rect is omitted, the whole output. The FOV hfov is the horizontal FOV relative to the width of the rectangle */
  draw(p: FrameParams, width: number, height: number, rect?: PixelRect): void {
    const gl = this.gl
    const r = rect ?? { x: 0, y: 0, w: width, h: height }
    if (!rect) this.begin(width, height)
    const glY = height - (r.y + r.h)
    gl.enable(gl.SCISSOR_TEST)
    gl.viewport(r.x, glY, r.w, r.h)
    gl.scissor(r.x, glY, r.w, r.h)
    gl.disable(gl.BLEND)
    gl.useProgram(this.prog)
    gl.uniform2f(this.u('uOut'), r.w, r.h)
    gl.uniform2f(this.u('uOrigin'), r.x, glY)
    gl.uniform1f(this.u('uFocal'), focalFor(r.w, p.hfovDeg, this.kOverride ?? undefined))
    gl.uniform1f(this.u('uK'), this.kOverride ?? wideK(p.hfovDeg))
    gl.uniformMatrix3fv(this.u('uView'), false, new Float32Array(matT(p.view)))
    if (p.rs) gl.uniform3fv(this.u('uRs[0]'), p.rs)
    gl.uniform1i(this.u('uRsIters'), p.rs ? 2 : 0)
    gl.uniform1f(this.u('uBlendDeg'), this.blendDeg)
    gl.uniform1i(this.u('uDebug'), this.debug)
    for (let i = 0; i < 2; i++) {
      gl.activeTexture(gl.TEXTURE0 + i)
      gl.bindTexture(gl.TEXTURE_2D, this.tex[i])
    }
    gl.activeTexture(gl.TEXTURE3)
    gl.bindTexture(gl.TEXTURE_2D, this.seamTex)
    for (let k = 0; k < 2; k++) {
      gl.activeTexture(gl.TEXTURE4 + k)
      gl.bindTexture(gl.TEXTURE_2D, this.bodyTex[k])
      gl.activeTexture(gl.TEXTURE6 + k)
      gl.bindTexture(gl.TEXTURE_2D, this.fillTex[k])
    }
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4)
    gl.disable(gl.SCISSOR_TEST)
  }

  private uSp(name: string): WebGLUniformLocation | null {
    if (!this.sphereLoc.has(name)) this.sphereLoc.set(name, this.gl.getUniformLocation(this.sphereProg, name))
    return this.sphereLoc.get(name)!
  }

  /**
   * Keep the sphere of the frame just uploaded (call once per drawn frame, before drawSigns). frame is the frame number: the change between
   * frames is used only while they are consecutive (after a seek the ring starts over; drawing the same frame again adds nothing)
   */
  updateMotion(frame: number): void {
    if (frame === this.motionLast) return
    if (frame !== this.motionLast + 1) this.motionCount = 0
    this.motionLast = frame
    const gl = this.gl
    if (!this.motionTex.length) {
      for (let k = 0; k < MOTION_RING; k++) {
        const t = gl.createTexture()!
        gl.bindTexture(gl.TEXTURE_2D, t)
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT)
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, MOTION_W, MOTION_H, 0, gl.RGBA, gl.UNSIGNED_BYTE, null)
        const fb = gl.createFramebuffer()!
        gl.bindFramebuffer(gl.FRAMEBUFFER, fb)
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, t, 0)
        this.motionTex.push(t)
        this.motionFb.push(fb)
      }
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.motionFb[this.motionHead])
    gl.disable(gl.SCISSOR_TEST)
    gl.disable(gl.BLEND)
    gl.viewport(0, 0, MOTION_W, MOTION_H)
    gl.useProgram(this.sphereProg)
    gl.uniform1i(this.uSp('uTex0'), 0)
    gl.uniform1i(this.uSp('uTex1'), 1)
    for (let i = 0; i < 2; i++) {
      gl.activeTexture(gl.TEXTURE0 + i)
      gl.bindTexture(gl.TEXTURE_2D, this.tex[i])
    }
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4)
    gl.bindFramebuffer(gl.FRAMEBUFFER, null)
    gl.useProgram(this.prog)
    this.motionHead = (this.motionHead + 1) % MOTION_RING
    this.motionCount = Math.min(MOTION_RING, this.motionCount + 1)
  }

  /**
   * Render the uploaded frame as a square perspective view (no wide-angle blend) of size × size, for the segmentation model.
   * view: camera -> rig (row-major). Returns RGBA from the top row
   */
  renderCrop(view: Mat3, fov: number, size: number): Uint8Array {
    const gl = this.gl
    if (!this.cropFb) {
      const t = gl.createTexture()!
      gl.bindTexture(gl.TEXTURE_2D, t)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST)
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, size, size, 0, gl.RGBA, gl.UNSIGNED_BYTE, null)
      this.cropFb = gl.createFramebuffer()!
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.cropFb)
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, t, 0)
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.cropFb)
    const k = this.kOverride
    this.kOverride = 0
    this.draw({ view, rs: null, hfovDeg: fov }, size, size, { x: 0, y: 0, w: size, h: size })
    this.kOverride = k
    const raw = new Uint8Array(size * size * 4)
    gl.readPixels(0, 0, size, size, gl.RGBA, gl.UNSIGNED_BYTE, raw)
    gl.bindFramebuffer(gl.FRAMEBUFFER, null)
    // readPixels gives rows bottom-up
    const out = new Uint8Array(raw.length)
    const row = size * 4
    for (let y = 0; y < size; y++) out.set(raw.subarray((size - 1 - y) * row, (size - y) * row), y * row)
    return out
  }

  private uS(name: string): WebGLUniformLocation | null {
    if (!this.signsLoc.has(name)) this.signsLoc.set(name, this.gl.getUniformLocation(this.signsProg, name))
    return this.signsLoc.get(name)!
  }

  /**
   * Draw the corner signs (src: canvas of the whole output, signs only) over the video drawn so far, cutting out the own bike and rider
   * per view (call after all views are drawn and before the overlay). above: rectangles of the views drawn after each view (they cover it).
   * debug shows the cut area in red
   */
  /**
   * Pixelates quads of the frame drawn so far, inside rect only (a view: what is drawn later on top of it is not touched).
   * quads: corners in output pixels (from the top, 8 numbers each) and the block size [px]
   */
  drawMosaic(width: number, height: number, rect: PixelRect, quads: { pts: number[]; block: number }[]): void {
    if (!quads.length) return
    const gl = this.gl
    if (!this.mosaicTex) {
      this.mosaicTex = gl.createTexture()!
      gl.bindTexture(gl.TEXTURE_2D, this.mosaicTex)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
    }
    gl.activeTexture(gl.TEXTURE9)
    gl.bindTexture(gl.TEXTURE_2D, this.mosaicTex)
    gl.copyTexImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 0, 0, width, height, 0)
    gl.useProgram(this.mosaicProg)
    const u = (n: string): WebGLUniformLocation | null => gl.getUniformLocation(this.mosaicProg, n)
    gl.uniform1i(u('uFrame'), 9)
    gl.uniform2f(u('uSize'), width, height)
    const q = new Float32Array(4 * MOSAIC_MAX * 2)
    const b = new Float32Array(MOSAIC_MAX)
    const n = Math.min(MOSAIC_MAX, quads.length)
    for (let k = 0; k < n; k++) {
      for (let j = 0; j < 4; j++) {
        q[(k * 4 + j) * 2] = quads[k].pts[j * 2]
        q[(k * 4 + j) * 2 + 1] = height - quads[k].pts[j * 2 + 1]
      }
      b[k] = Math.max(2, quads[k].block)
    }
    gl.uniform2fv(u('uQ[0]'), q)
    gl.uniform1fv(u('uBlock[0]'), b)
    gl.uniform1i(u('uN'), n)
    gl.enable(gl.SCISSOR_TEST)
    gl.viewport(0, 0, width, height)
    gl.scissor(rect.x, height - (rect.y + rect.h), rect.w, rect.h)
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4)
    gl.disable(gl.SCISSOR_TEST)
    gl.activeTexture(gl.TEXTURE0)
    gl.useProgram(this.prog)
  }

  drawSigns(
    src: TexImageSource,
    width: number,
    height: number,
    views: { rect: PixelRect; view: Mat3; fov: number; above: PixelRect[] }[],
    mask: SignOcclusion,
    debug = false,
    seg: SignSegmentation | null = null
  ): void {
    const gl = this.gl
    if (!this.signsTex.length) {
      for (let i = 0; i < 5; i++) {
        const t = gl.createTexture()!
        const target = i === 4 ? gl.TEXTURE_3D : gl.TEXTURE_2D
        gl.bindTexture(target, t)
        gl.texParameteri(target, gl.TEXTURE_MIN_FILTER, i === 1 ? gl.NEAREST : gl.LINEAR)
        gl.texParameteri(target, gl.TEXTURE_MAG_FILTER, i === 1 ? gl.NEAREST : gl.LINEAR)
        // Equirectangular masks wrap around in longitude
        gl.texParameteri(target, gl.TEXTURE_WRAP_S, i === 2 || i === 3 ? gl.REPEAT : gl.CLAMP_TO_EDGE)
        gl.texParameteri(target, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
        if (i === 4) gl.texParameteri(target, gl.TEXTURE_WRAP_R, gl.CLAMP_TO_EDGE)
        this.signsTex.push(t)
      }
    }
    const [tSigns, tFrame, tCore, tEnv, tLut] = this.signsTex
    // Copy of the video drawn so far (read per pixel for the colors)
    gl.activeTexture(gl.TEXTURE9)
    gl.bindTexture(gl.TEXTURE_2D, tFrame)
    gl.copyTexImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 0, 0, width, height, 0)
    gl.activeTexture(gl.TEXTURE8)
    gl.bindTexture(gl.TEXTURE_2D, tSigns)
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true)
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, src)
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false)
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1)
    gl.activeTexture(gl.TEXTURE10)
    gl.bindTexture(gl.TEXTURE_2D, tCore)
    if (this.signsMask !== mask) gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, mask.width, mask.height, 0, gl.RED, gl.UNSIGNED_BYTE, mask.core)
    gl.activeTexture(gl.TEXTURE11)
    gl.bindTexture(gl.TEXTURE_2D, tEnv)
    if (this.signsMask !== mask) gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, mask.width, mask.height, 0, gl.RED, gl.UNSIGNED_BYTE, mask.env)
    gl.activeTexture(gl.TEXTURE12)
    gl.bindTexture(gl.TEXTURE_3D, tLut)
    if (this.signsMask !== mask) gl.texImage3D(gl.TEXTURE_3D, 0, gl.R8, mask.lutN, mask.lutN, mask.lutN, 0, gl.RED, gl.UNSIGNED_BYTE, mask.lut)
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4)
    this.signsMask = mask
    gl.useProgram(this.signsProg)
    gl.uniform1i(this.uS('uSigns'), 8)
    gl.uniform1i(this.uS('uFrame'), 9)
    gl.uniform1i(this.uS('uCore'), 10)
    gl.uniform1i(this.uS('uEnv'), 11)
    gl.uniform1i(this.uS('uLut'), 12)
    gl.uniform2f(this.uS('uSize'), width, height)
    gl.uniform1i(this.uS('uDebug'), debug ? 1 : 0)
    // The sphere now and MOTION_LAG frames back
    const motion = this.motionTex.length > 0 && this.motionCount > MOTION_LAG
    if (this.motionTex.length) {
      gl.activeTexture(gl.TEXTURE13)
      gl.bindTexture(gl.TEXTURE_2D, this.motionTex[(this.motionHead - 1 + MOTION_RING) % MOTION_RING])
      gl.activeTexture(gl.TEXTURE14)
      gl.bindTexture(gl.TEXTURE_2D, this.motionTex[(this.motionHead - 1 - MOTION_LAG + 2 * MOTION_RING) % MOTION_RING])
    }
    gl.uniform1i(this.uS('uNow'), 13)
    gl.uniform1i(this.uS('uPast'), 14)
    gl.uniform1i(this.uS('uMotion'), motion ? 1 : 0)
    // Outline from the segmentation model
    gl.uniform1i(this.uS('uSeg'), seg ? 1 : 0)
    gl.uniform1i(this.uS('uSegTex'), 15)
    if (seg) {
      if (!this.segTex) {
        this.segTex = gl.createTexture()!
        gl.bindTexture(gl.TEXTURE_2D, this.segTex)
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
      }
      gl.activeTexture(gl.TEXTURE15)
      gl.bindTexture(gl.TEXTURE_2D, this.segTex)
      if (this.segLoaded !== seg.mask) {
        gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1)
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, seg.size, seg.size, 0, gl.RED, gl.UNSIGNED_BYTE, seg.mask)
        gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4)
        this.segLoaded = seg.mask
      }
      gl.uniformMatrix3fv(this.uS('uCrop'), false, new Float32Array(matT(seg.view)))
      gl.uniform1f(this.uS('uCropF'), focalFor(1, seg.fov, 0))
    }
    gl.enable(gl.BLEND)
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA)
    gl.enable(gl.SCISSOR_TEST)
    for (const v of views) {
      const r = v.rect
      const glY = height - (r.y + r.h)
      gl.viewport(r.x, glY, r.w, r.h)
      gl.scissor(r.x, glY, r.w, r.h)
      gl.uniform2f(this.uS('uOut'), r.w, r.h)
      gl.uniform2f(this.uS('uOrigin'), r.x, glY)
      gl.uniform1f(this.uS('uFocal'), focalFor(r.w, v.fov))
      gl.uniform1f(this.uS('uK'), wideK(v.fov))
      gl.uniformMatrix3fv(this.uS('uView'), false, new Float32Array(matT(v.view)))
      const above = new Float32Array(32)
      v.above.slice(0, 8).forEach((a, k) => above.set([a.x, height - (a.y + a.h), a.w, a.h], k * 4))
      gl.uniform4fv(this.uS('uAbove[0]'), above)
      gl.uniform1i(this.uS('uAboveN'), Math.min(8, v.above.length))
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4)
    }
    gl.disable(gl.SCISSOR_TEST)
    gl.disable(gl.BLEND)
    gl.viewport(0, 0, width, height)
    gl.useProgram(this.prog)
  }

  /** Draws a border inside the rectangle (drawn as scissored fills, so the stacking order follows the layer order) */
  strokeRect(r: PixelRect, width: number, height: number, lw: number, color: [number, number, number]): void {
    const gl = this.gl
    const t = Math.max(1, Math.round(lw))
    const glY = height - (r.y + r.h)
    gl.enable(gl.SCISSOR_TEST)
    gl.clearColor(color[0], color[1], color[2], 1)
    const strip = (x: number, y: number, w: number, h: number): void => {
      if (w <= 0 || h <= 0) return
      gl.scissor(x, y, w, h)
      gl.clear(gl.COLOR_BUFFER_BIT)
    }
    strip(r.x, glY + r.h - t, r.w, t) // top
    strip(r.x, glY, r.w, t) // bottom
    strip(r.x, glY, t, r.h) // left
    strip(r.x + r.w - t, glY, t, r.h) // right
    gl.disable(gl.SCISSOR_TEST)
    gl.clearColor(0, 0, 0, 1)
  }

  /** Alpha-composites the overlays drawn with Canvas 2D onto the whole output */
  drawOverlay(src: TexImageSource, width: number, height: number): void {
    const gl = this.gl
    gl.viewport(0, 0, width, height)
    gl.disable(gl.SCISSOR_TEST)
    gl.useProgram(this.ovProg)
    gl.activeTexture(gl.TEXTURE2)
    gl.bindTexture(gl.TEXTURE_2D, this.ovTex)
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true)
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, src)
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false)
    gl.uniform1i(this.ovLoc, 2)
    gl.enable(gl.BLEND)
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA)
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4)
    gl.disable(gl.BLEND)
  }

  get ready(): boolean {
    return this.lenses.length === 2
  }
}
