// WebGL2 によるリフレーム描画。
// 出力画素ごとに: 透視投影の光線 → 仮想カメラの回転（リグ座標）→ 各レンズへ投影（Mei + RadtanPro）
// → ローリングシャッター補正（撮像された行の時刻の姿勢で投影し直す）→ 継ぎ目をクロスフェード。
import { focalFor, wideK } from './projection'
import type { LensModel } from '../core/lens'
import { seamBasis } from '../core/seamfit'
import { blurSeamQ, chooseSeamCut, chooseSeamDepth, CUT_OFFS, groundPrior, type SeamCutState, type SeamDepthState } from './seamdepth'
import { matT, type Mat3 } from '../core/quat'
import { t } from '../i18n'
import { BAND_H, BAND_STEP, BAND_TH0, BAND_W, bodyTexData, type BodyMapC } from '../core/bodymap'

export const RS_SLICES = 17
/** 継ぎ目の距離を求める方位の分割数と、距離の逆数の候補 [1/m]（0 = 無限遠 … 2.2 = 約 45cm） */
export const SEAM_BINS = 256
export const SEAM_CAND = [0, 0.12, 0.25, 0.4, 0.55, 0.75, 1.0, 1.3, 1.7, 2.2]
const SEAM_CANDS = SEAM_CAND.length
const CUTS = CUT_OFFS.length
/** 探索の結果の行数: 距離の候補ごとの一致度（SEAM_CANDS 行）+ つなぎ目の位置の候補ごとの像の差（CUTS 行） */
const PROBE_ROWS = SEAM_CANDS + CUTS

const VS = `#version 300 es
in vec2 aPos;
void main() { gl_Position = vec4(aPos, 0.0, 1.0); }
`

/** レンズの投影（本描画と継ぎ目の距離の探索で共通） */
const LENS_GLSL = `
struct Lens {
  float xi; float fx; float fy; float cx; float cy; float scale; float size;
  float edge;              // 縁の角度の補正 [rad]（core/lens.ts の edgeCorrect）
  vec3 pos;                // レンズの位置 [m]（リグ座標、2 つのレンズの中点が原点）
  mat3 camFromRig;
  float d[13];
};
uniform Lens uL0;
uniform Lens uL1;

// 光線（リグ座標、レンズから見た向き）→ 映像の画素 (u, v) と光軸からの角度
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

// 継ぎ目の座標系: レンズ0の光軸 uSeamAx と、それに直交する uSeamE1・uSeamE2（方位 φ の基準）
uniform vec3 uSeamAx;
uniform vec3 uSeamE1;
uniform vec3 uSeamE2;

// 視差の補正は継ぎ目の付近（2 つのレンズを混ぜる帯）だけにかける: 継ぎ目から ±7° は全部、±15° で 0。
// |cos(光軸からの角度)| = sin(継ぎ目からの角度)。以前は ±40° まで弱めながらかけていたため、継ぎ目から離れた所
//（前を向いた画面の左下の路肩の草など）まで、フレームごとに変わる距離で少しずつ伸び縮みして見えていた
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
uniform mat3 uView;      // 出力カメラ座標 → リグ座標（フレーム中央の時刻）
uniform vec2 uOut;       // 描画する矩形のサイズ [px]
uniform vec2 uOrigin;    // 矩形の左下（GL の画素座標）
uniform float uFocal;    // 出力の焦点距離 [px]
uniform float uK;        // 投影の度合い（0 = 透視投影 … 1 = 立体射影。projection.ts）
uniform vec3 uRs[${RS_SLICES}]; // 読み出し中の相対回転（回転ベクトル, リグ座標）
uniform int uRsIters;
uniform float uBlendDeg;
uniform int uDebug;      // 確認用: 1 = レンズ0だけ、2 = レンズ1だけ、3 = 継ぎ目のブレンド範囲に色を付ける、4 = 継ぎ目の距離
// 継ぎ目の方位ごとの値。SEAM_BINS×4 の R32F: 1 行目 = 距離の逆数 [1/m]（0 = 無限遠）、2 行目 = 継ぎ目に沿ってぼかした距離の逆数、
// 3 行目 = つなぎ目の位置 [deg]（幾何学的な継ぎ目からレンズ0の側へずらす角度）、4 行目 = 切り替えの幅の倍率（1 = uBlendDeg）
uniform sampler2D uSeamTex;
// 自車の継ぎ目の型（core/bodymap.ts）: 帯の座標の RGBA = 自車の部分の度合い・レンズ1 の割合・レンズ1 を読む位置のずれ（列・行）。
// 2 つの区間の型を uBodyMix で混ぜる。uFill = 穴を埋めた色（アルファ = 穴の度合い）
uniform int uBodyOn;
uniform float uBodyMix;
uniform sampler2D uBodyA;
uniform sampler2D uBodyB;
uniform sampler2D uFillA;
uniform sampler2D uFillB;
out vec4 outColor;

// 回転ベクトル r の逆回転を d に適用（ロドリゲスの公式）
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
    vec3 r = rsAt(p.y / L.size);  // 読み出しは画像の上→下
    p = projectLens(L, rotInv(r, dMid));
  }
  return p;
}

// 光線の方向の、継ぎ目のパラメーター: x = 視差の補正に使う距離の逆数（方位で補間し、つなぎ目から離れるほど弱める）、
// y = つなぎ目の位置 [deg]、z = 切り替えの幅の倍率。
// 2 つのレンズを混ぜる帯（つなぎ目から ±3°）ではビンごとの距離をそのまま使い、そこから ±7° までに継ぎ目に沿ってぼかした距離へ移る。
// 片方のレンズだけが見える所では位置合わせは要らず、ビンごとの距離の差がそのまま景色のゆがみ（線の三角の折れ）になるため。
// つなぎ目の位置をずらしたビンでは、ずらした位置を中心にする
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
  // つなぎ目（ずらした位置）からの角度の sin
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
  float th = (1.0 + uK) * atan(r / (1.0 + uK)); // 光軸からの角度
  vec3 ray = r > 1e-6 ? vec3(q / r * sin(th), cos(th)) : vec3(0.0, 0.0, 1.0);
  vec3 dMid = uView * ray;
  // 視差: 継ぎ目の付近の景色を距離 1/sq の球面上にあるとみなし、各レンズの位置から見た向きにする
  vec3 sp = seamAt(dMid);
  float sq = sp.x;
  vec3 p0 = projectRs(uL0, normalize(dMid - uL0.pos * sq));
  vec3 p1 = projectRs(uL1, normalize(dMid - uL1.pos * sq));
  // 光軸からの角度の差（つなぎ目で 0、レンズ0の側へ 1° 進むと約 2°）。つなぎ目をずらしたビンでは、ずらした位置で 0.5 にする。
  // 2 つのレンズの像が合わない所（近い物で距離が合わない・片方にだけ写る物がある）では幅を狭め、二重に見えないようにする
  float diff = degrees(p1.z - p0.z) - 2.0 * sp.y;
  float w0 = smoothstep(0.0, 1.0, clamp(0.5 + diff / (uBlendDeg * sp.z), 0.0, 1.0));
  // 視差の補正の基準（目の位置）を、混ぜる割合に応じて 2 つのレンズの間で動かす（レンズ1 の位置 → レンズ0 の位置）。
  // 片方のレンズだけが見える所（w0 = 0 または 1）では、そのレンズの像をずらさない（レンズで撮ったままの形）。混ぜる帯の中だけで、
  // もう一方のレンズの像をずらして重ねる。以前は両方のレンズの像を半分ずつずらしていたので、帯の外でも、方位ごとに違う距離の分だけ
  // 近い物（トップケースなど）の形がゆがみ、留め具を境に段違いになっていた（2026-10-11 知床の 8:00.76）
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
  // 自車の部分は、区間ごとに作った型のつなぎ目とずれで描く（レンズ0 はそのまま、レンズ1 はずらして読む）
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
        // 確認用: 自車の部分の、2 つのレンズを混ぜる所を緑に、穴を黄色に
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
 * 継ぎ目の距離の探索: 出力の 1 画素 = (方位のビン, 距離の候補)。重なり帯（レンズ0の光軸から 86.5〜93.5°）で
 * 両レンズの明るさの相関を求め、R = (1 − 相関)/2（小さいほど一致）、G = 模様の強さ を書く
 */
const PROBE_FS = `#version 300 es
precision highp float;
uniform sampler2D uTex0;
uniform sampler2D uTex1;
${LENS_GLSL}
uniform float uCand[${SEAM_CANDS}]; // 距離の逆数の候補 [1/m]
out vec4 outColor;

float luma(sampler2D t, vec2 uv, vec2 px) {
  // 細かい模様のちらつきを抑えるため、周りの 4 点の平均
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
 * つなぎ目の位置の探索: 出力の 1 画素 = (方位のビン, つなぎ目の位置の候補)。その位置（幾何学的な継ぎ目からレンズ0の側へ off°）で、
 * 今の距離（uSeamTex の 1 行目）で位置を合わせた両レンズの明るさの差（ビンの中の平均の差を除いた絶対値の平均）を書く。
 * 差が小さい所で切り替えれば、切り替わりが目立たない。どちらかのレンズの写る範囲（光軸から 100°）を超える位置は 1
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
  // 両方のレンズで模様の無い面どうしなら、平均の明るさの差も見る（2 つのレンズの露出の違い程度の 0.04 までは許す）。
  // 平均を除いた差だけだと、灰色のケースと、片方のレンズにだけ写る黒いカメラの台が「合う」ことになり、
  // そこへつなぎ目を寄せて、台の黒い縁がケースに透けて見えた（2026-10-11 知床の 8:00.76）。
  // 模様のある所（物の縁など）では、位置の少しのずれでも平均が変わるので見ない（1:35.20 のナンバープレートの上の縁で、つなぎ目がプレートへ逃げた）
  float flatness = 1.0 - smoothstep(0.005, 0.012, max(va, vb) / 48.0);
  float dc = max(0.0, abs(ma - mb) - 0.04) * flatness;
  outColor = vec4(bad ? 1.0 : clamp((e / 48.0 + 0.5 * dc) * 4.0, 0.0, 1.0), 0.0, 0.0, 1.0);
}
`

/**
 * 帯の画像（自車の継ぎ目の型を作るため、core/bodymap.ts）: 出力の画素 (x, y) = (方位 φ, レンズ0 の光軸からの角度 θ) の向きを、
 * 片方のレンズでそのまま（視差の補正・ローリングシャッターの補正なし）見た色。アルファ = そのレンズの写る範囲（光軸から 100°）の内か
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

/** 出力画面内の矩形（左上原点の画素） */
export interface PixelRect {
  x: number
  y: number
  w: number
  h: number
}

export interface FrameParams {
  view: Mat3 // 出力カメラ → リグ（行優先）
  rs: Float32Array | null // RS_SLICES×3（null で補正なし）
  hfovDeg: number
}

export class GlReframer {
  readonly gl: WebGL2RenderingContext
  private prog: WebGLProgram
  private tex: [WebGLTexture, WebGLTexture]
  private loc = new Map<string, WebGLUniformLocation | null>()
  private lenses: LensModel[] = []
  private ovProg: WebGLProgram
  private probeProg: WebGLProgram
  private cutProg: WebGLProgram
  private bandProg: WebGLProgram
  /** 自車の継ぎ目の型のテクスチャ（2 区間分）と、今入っている型 */
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
  /** 継ぎ目の距離を求めるフレームの重力の下向き（リグ座標） */
  private seamDown: ArrayLike<number> | null = null
  private seam: SeamDepthState | null = null
  private seamTex: WebGLTexture
  private probePbo: WebGLBuffer
  private pending: WebGLSync | null = null
  /** 直近の探索結果（確認用） */
  lastProbe: { cost: Float32Array; texture: Float32Array; cutDiff: Float32Array } | null = null
  /** 動的なつなぎ合わせ（継ぎ目の距離をフレームごとに求めて視差を補正する） */
  dynamicSeam = true
  /** 像が合わない所で、つなぎ目の位置をずらして狭く切り替える（seamdepth.ts の chooseSeamCut。確認用に切れる） */
  adaptiveCut = true
  private ovTex: WebGLTexture
  private ovLoc: WebGLUniformLocation | null

  constructor(readonly canvas: HTMLCanvasElement | OffscreenCanvas) {
    const gl = canvas.getContext('webgl2', { antialias: false, preserveDrawingBuffer: true }) as WebGL2RenderingContext | null
    if (!gl) throw new Error(t('WebGL2 が使えません'))
    this.gl = gl
    const sh = (type: number, src: string): WebGLShader => {
      const s = gl.createShader(type)!
      gl.shaderSource(s, src)
      gl.compileShader(s)
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(t('シェーダーのコンパイルに失敗: {log}', { log: String(gl.getShaderInfoLog(s)) }))
      return s
    }
    const link = (vs: string, fs: string): WebGLProgram => {
      const pr = gl.createProgram()!
      gl.attachShader(pr, sh(gl.VERTEX_SHADER, vs))
      gl.attachShader(pr, sh(gl.FRAGMENT_SHADER, fs))
      gl.bindAttribLocation(pr, 0, 'aPos')
      gl.linkProgram(pr)
      if (!gl.getProgramParameter(pr, gl.LINK_STATUS)) throw new Error(t('シェーダーのリンクに失敗: {log}', { log: String(gl.getProgramInfoLog(pr)) }))
      return pr
    }
    const p = link(VS, FS)
    this.prog = p
    this.ovProg = link(OVERLAY_VS, OVERLAY_FS)
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
    // 継ぎ目の距離の探索の出力先（方位のビン × 距離の候補）
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
    // 継ぎ目の距離（本描画が読む）
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
    // 自車の継ぎ目の型（方位は一周でつながる）
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
   * 自車の継ぎ目の型を使う（core/bodymap.ts の bodyAt で選んだ 2 つの区間の型と、混ぜる割合）。
   * どちらも null なら使わない。型が変わったときだけテクスチャを書き換える
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
   * 今のフレーム（upload の後）の、片方のレンズの帯の画像（BAND_W×BAND_H の RGBA、行 0 = 帯の始まりの角度）を読む。
   * アルファ = そのレンズの写る範囲の内（255）か外（0）か
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
   * 継ぎ目の距離を求めて本描画に渡す（upload の後、draw の前に呼ぶ）。frame はフレーム番号
   * （連続したフレームなら前の結果から少しずつ変える）。down はそのフレームの重力の下向き（リグ座標）。
   * 渡すと、水平より下の方位では地面までの距離を目安にする
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
      // シーク直後など: その場で求める（GPU の処理を待つので少し時間がかかる）
      this.dropPending()
      this.runProbe()
      gl.readPixels(0, 0, SEAM_BINS, PROBE_ROWS, gl.RGBA, gl.UNSIGNED_BYTE, this.probeBuf)
      gl.bindFramebuffer(gl.FRAMEBUFFER, null)
      this.applyProbe(frame)
      return
    }
    // 連続したフレーム（再生・書き出し）: 前のフレームで投げた探索の結果を、GPU を待たずに受け取って使う
    //（1 フレーム遅れるが、前のフレームからの変化は小さく、もともと少しずつ近づけている）
    if (this.pending) {
      const st = gl.clientWaitSync(this.pending, 0, 0)
      if (st === gl.TIMEOUT_EXPIRED || st === gl.WAIT_FAILED) {
        // まだ終わっていない: 今回は前の値のまま（フレーム番号だけ進める）
        this.seam = { ...this.seam!, frame }
        return
      }
      gl.bindBuffer(gl.PIXEL_PACK_BUFFER, this.probePbo)
      gl.getBufferSubData(gl.PIXEL_PACK_BUFFER, 0, this.probeBuf)
      gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null)
      this.dropPending()
      this.applyProbe(frame)
    } else this.seam = { ...this.seam!, frame }
    // 今のフレームの探索を投げておく（結果は次のフレームで受け取る）
    this.runProbe()
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, this.probePbo)
    gl.readPixels(0, 0, SEAM_BINS, PROBE_ROWS, gl.RGBA, gl.UNSIGNED_BYTE, 0)
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null)
    gl.bindFramebuffer(gl.FRAMEBUFFER, null)
    this.pending = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0)
    gl.flush()
  }

  /** 探索を描く（フレームバッファは探索用のまま返る） */
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
    // つなぎ目の位置の候補ごとの像の差（今の距離で位置を合わせて）
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

  /** 読み出した探索の結果から距離を選び、本描画へ渡す */
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
    // 水平より下の方位は、地面までの距離を目安にする
    let ground: Float32Array | null = null
    if (this.seamDown && this.lenses.length >= 2) {
      const { e1, e2 } = seamBasis(this.lenses)
      ground = groundPrior(e1, e2, this.seamDown, SEAM_BINS)
    }
    this.seam = chooseSeamDepth(cost, texture, SEAM_CAND, SEAM_BINS, this.seam, frame, ground)
    // つなぎ目の位置と切り替えの幅: 2 つのレンズの像が合わない所では、像の差の小さい位置で狭く切り替える
    this.cut = this.adaptiveCut ? chooseSeamCut(cutDiff, cost, texture, SEAM_CAND, this.seam.q, SEAM_BINS, this.cut, frame) : null
    this.setSeamQ(this.seam.q, this.cut)
  }

  /**
   * 継ぎ目の値を本描画のテクスチャへ: 距離の逆数（そのままの値と、継ぎ目に沿ってぼかした値）、つなぎ目の位置と切り替えの幅の倍率
   * （cut を省略すると、位置は幾何学的な継ぎ目・幅はそのまま）
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

  /** 確認用: 継ぎ目の距離の逆数をすべてのビンでこの値にする */
  forceSeamQ(q: number): void {
    this.setSeamQ(new Float32Array(SEAM_BINS).fill(q), this.cut)
  }

  /** 直近に求めたつなぎ目の位置と幅（確認用） */
  seamCut(): SeamCutState | null {
    return this.cut
  }

  /** 直近に求めた継ぎ目の距離の逆数（確認用） */
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
      [this.bandProg, (n: string) => this.uB(n)]
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
        // GLSL の mat3 は列優先。行優先の行列を転置して渡す
        gl.uniformMatrix3fv(u(n + 'camFromRig'), false, new Float32Array(matT(L.camFromRig)))
        for (let k = 0; k < 13; k++) gl.uniform1f(u(`${n}d[${k}]`), L.d[k])
      })
      gl.uniform3f(u('uSeamAx'), ax[0], ax[1], ax[2])
      gl.uniform3f(u('uSeamE1'), e1[0], e1[1], e1[2])
      gl.uniform3f(u('uSeamE2'), e2[0], e2[1], e2[2])
    }
    this.setSeamQ(new Float32Array(SEAM_BINS))
  }


  /** 各レンズのフレーム（VideoFrame など）をテクスチャに転送する */
  upload(frames: [TexImageSource, TexImageSource]): void {
    const gl = this.gl
    frames.forEach((f, i) => {
      gl.activeTexture(gl.TEXTURE0 + i)
      gl.bindTexture(gl.TEXTURE_2D, this.tex[i])
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, f)
    })
  }

  /** 出力サイズを合わせて黒で塗りつぶす（フレームの描き始め） */
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
   * 継ぎ目のクロスフェードの幅 [deg]（光軸からの角度の差。S 字でなめらかに切り替える）。
   * 2 つのレンズは細部のくっきりさや色が少し違うので、狭いと切り替わる線が見える。
   * 位置を合わせた後は 12° 程度が自然（18° だと近い物が二重に見え始める）
   */
  blendDeg = 12

  /** 確認用の表示（0 = 通常）。シェーダーの uDebug を参照 */
  debug = 0

  /** 確認用: 投影の度合い k を画角によらずこの値にする（null = 画角から決める） */
  kOverride: number | null = null

  /** 視点を1つ描く。rect を省略すると出力全体。画角 hfov は矩形の幅に対する水平画角 */
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

  /** 矩形の内側に枠線を描く（範囲を限定した塗りつぶしで描くので、重なり順はレイヤーの順になる） */
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
    strip(r.x, glY + r.h - t, r.w, t) // 上
    strip(r.x, glY, r.w, t) // 下
    strip(r.x, glY, t, r.h) // 左
    strip(r.x + r.w - t, glY, t, r.h) // 右
    gl.disable(gl.SCISSOR_TEST)
    gl.clearColor(0, 0, 0, 1)
  }

  /** Canvas 2D で描いた重ね表示を、出力全体にアルファ合成する */
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
