# Insta360 X6 `.insv` structure notes

Sample: `E:\R1200GSA\Movie\2026\0919宗谷丘陵\VID_20260919_140847_00_006.insv` (34.5GB / 25 min 18 s / FW v1.1.7) <!-- i18n-ignore -->

## Video and audio (MP4 container)

| stream | contents |
|---|---|
| 0 | HEVC Main10, 3840×3840, 50fps, ~90Mbps: circular fisheye of **lens 1** |
| 1 | HEVC Main10, 3840×3840, 50fps, ~90Mbps: circular fisheye of **lens 0** |
| 2 | AAC 48kHz stereo |

One file holds both lenses (there is no `_10_` file as on older models).
The tracks are in **reverse** lens order (same as X5's `DUAL_STREAM_TRACK_REVERSE`). Confirmed by comparing the seam error.
`LRV_*.lrv` is 2048×1024 / 25fps: a preview with the two fisheye images shrunk and placed side by side (**not stitched**).

## Trailer at the end of the file

Last 72 bytes of the file: `padding[32] | u32 trailer_size | u32 version(=3) | magic "8db42d694ccc418790edff439fe026bf"`

Trailer start = `file_size - trailer_size`.
Each record has the form `data[size] | u8 format | u8 id | u32 size` (the header follows the data).
The record just before the end (id=0, 590 bytes) is the **table of contents**: a list of 10-byte entries `u16 id | u32 size | u32 offset` (offset is the position from the trailer start).

| id | size | contents |
|---|---|---|
| 0x101 | 1.5KB | Metadata (protobuf). See below |
| 0x2 | 1.2MB | Thumbnail |
| 0x3 | 30MB | **IMU**: 20B/sample, about 1kHz |
| 0x4 | 16B×frame count | Frame times and exposure times of lens 0 (`u64 ts_us + f64 seconds`). Use this for the frame intervals and put the first frame at field 24 (see "Frame times and the gyro time axis" below) |
| 0xc | 16B×frame count | Same for lens 1 (about 40us later than 0x4) |
| 0x34 / 0x36 | 607584B | 37974 entries of `u64 + f64`, 16B each (about one per 2 frames). Contents not analyzed |
| 0x9, 0xb, 0x16, 0x1b, 0x1c, 0x1d | — | Not analyzed |

### IMU (id 0x3)

`u64 timestamp_us | u16×6`. Values are offset binary (`v - 0x8000`).

- Order is `acc x,y,z, gyro x,y,z` (at rest the acc norm is about 1024, equal to 1g)
- Range: protobuf field 65 = `{acc: 32g, gyro: 2000dps}` → acc 1024 LSB/g, gyro 16.384 LSB/dps
- Timestamps are on the same time axis as the frame times (0x4). Matching against the video, the offset was within ±5ms
- Sample spacing is 1.000ms (999.9Hz) on the X6 and 1.004ms on average (996Hz) on the X5. Don't count time by the number of samples; use the timestamps
- **IMU → rig coordinates** (rig: +x right, +y down, +z = optical axis of lens 0): `rig = M·imu`, `M = [[0,0,-1],[1,0,0],[0,-1,0]]` (`rig_x=-imu_z, rig_y=imu_x, rig_z=-imu_y`). Found by matching the frame-to-frame rotation (SIFT + essential matrix) against the integrated gyro with the Procrustes method
- Offset of **6.45 seconds** from the bike's vehicle log (0919.csv), with no drift over the 25 minutes

#### Frame times and the gyro time axis

What matches the gyro time is metadata field 24 (time of the first frame). In ordinary X6 videos the 0x4 time is the same as field 24, but some videos differ:

| video | field 24 − start of 0x4 |
|---|---|
| X6 (my 6 files) | 0 |
| X5 (11 of my 13 files) | +767.5ms |
| X5 2026-07-20 | +166.8ms |
| 2nd and later files of a split recording (X6 0906_002 / 1011_004, X5 0815_014 / 016) | +7.4 to 18.7 s |

If the gyro is looked up with the 0x4 times as they are, the correction uses motion from that much earlier and stabilization makes the shake worse
(on the X5 2026-08-13 video, the vertical shake without stabilization is 4.6px/frame; with 0x4 as is it is 5.0px, and aligned to field 24 it is 1.8px. For the 2nd and later files of a split recording too, the shake drops to near 0 only when aligned to field 24).
So the frame time = field 24 + (0x4 time − start of 0x4) (`gyroFrameTimes` in `core/insv.ts`). The video time is also derived from this,
so times saved in projects from earlier versions (keyframes etc.) are shifted by this difference when the project is opened (`Project.timeBase`, `shiftProjectTimes` in `engine/project.ts`).

### Main fields of the metadata protobuf (id 0x101)

| field | value | meaning |
|---|---|---|
| 1 | BXEA3ABFHGCF4R | Serial number |
| 2 | Insta360 X6 | Model |
| 3 | v1.1.7 | FW |
| 19 / 44 | 3840×3840 | Stream resolution |
| 20 | 50 | fps |
| 24 | 432945272 | ts (us) of the first frame (the gyro time axis. In ordinary X6 videos it equals the start of 0x4; X5 etc. differ) |
| 25 | 15.36 | **Rolling shutter readout time** (ms). Positive = top to bottom |
| 28 / 29 | 1.1 / true | **gyro_timestamp** (ms). Correction from frame time to the gyro time axis |
| 131 | 4 | stream_type = `DUAL_STREAM_TRACK_REVERSE` (tracks are in reverse lens order) |
| 27 | 7744/7744/7680/7680 | Sensor-side resolution |
| 36 | 1789794528825 | Recording start (epoch ms) |
| 40 | 75947 | Frame count |
| 65 | {32, 2000} | acc range (g), gyro range (dps) |
| 111/112 | `2_2.455430_7218.140_...` | **Lens calibration string** (see below) |
| 213 | quat×2 | Orientation of the lens (or the IMU)? |

### Calibration string (field 111) = offset **V6**

Follows the definitions in telemetry-parser (`src/insta360/rig.rs`) and the video-types crate (`MeiDistortion::RadtanPro`).

`<lens count>_<lens 0: 27 values>_<lens 1: 27 values>_<packed tail>`

- packed tail `394240 = 0x60400` = `(version 6 << 16) | (X=4 << 8)`. If X=5, the lens 0 image is mirrored left-right (this file has 4, so no mirroring)
- 27 values per lens: `xi, fx, fy, cx, cy, yaw, pitch, roll (degrees), tx, ty, tz (m), d0..d12, overall width, height, lens_type`
- The calibration space is 15488×7744 with the two lenses side by side. Subtract 7744 from cx of lens 1. A uniform scale of `3840/7744` maps it to the video

Projection (ray in rig coordinates → pixel):

```
R_cam_from_rig = V(ypr_i, i) · V([0,0,90], 0)ᵀ
V(ypr, i) = Ry(pitch+90°)·Rz(yaw)·Rx(roll) [· Rz(180°) if i==0]   # world→camera
c = normalize(R_cam_from_rig · ray)
mx = cx_/(cz+xi), my = cy_/(cz+xi), r² = mx²+my²
R  = 1 + d0r² + d1r⁴ + d2r⁶ + d3r⁸ + d4r¹⁰
xd = mx·R + (r²+2mx²)(d5+d7r²) + 2mx·my(d6+d8r²) + d9r²  + d11r⁴
yd = my·R + (r²+2my²)(d6+d8r²) + 2mx·my(d5+d7r²) + d10r² + d12r⁴
u = (fx·xd + cx)·scale,  v = (fy·yd + cy)·scale
```

The seam is a linear crossfade of ±3° (6° wide) in the difference of the angle from the optical axis (Studio's default).

### Seam fitting (calibration correction, `core/seamfit.ts`)

- With the calibration as is, the lens 1 image is shifted **about 2° forward on both left and right** when looking sideways (27 to 37px at 1920 width and 100° FOV, and 6 to 11px vertically)
- The same shift while stopped (876s) and while riding at 100km/h (60s) → not due to a capture-time difference (rolling shutter, exposure)
- Symmetric left and right → a rotation of lens 1 does not fix it (fitting with rotation alone fixed one side and made the other worse). Changing how the signs of yaw, pitch and roll are interpreted doesn't help either
- Lens position (tx, ty, tz): lens 1 is at tz = −32.8mm (behind lens 0). The parallax is 0.4° at 5m and about 1.3° on the road surface 1.5m ahead, which cannot explain the 2° at distance
- → Treated as an **error in the angle from the optical axis**: lens 1 gets an "edge angle correction" θ' = θ + δ·(θ/90°)³ (the center stays nearly unchanged, the edge is affected more) plus a small rotation
- Estimation: at 5 keyframes between 10% and 90% of the video, search with the Nelder–Mead method for the δ and rotation that minimize the brightness difference in the overlap band (86 to 94° from the optical axis of lens 0, all the way around), measured as an absolute difference after matching mean and spread
- Result for this file: **δ = 1.94°**, rotation 0.1 to 0.3° (the same in the Python prototype and TypeScript). The difference in the overlap band drops by about 30%, and the shift when looking sideways goes from 27 to 37px down to 1 to 10px (nearly 0 for far and mid-range scenery; the rest is parallax of the nearby road surface)

### Dynamic stitching (parallax of near objects, `render/seamdepth.ts` and PROBE_FS in the shader)

- The calibration's tx, ty, tz are in lens 0's camera coordinates, and the **projection center is treated as the position with that sign reversed** (the projection center of lens 1 is 32.8mm ahead along the optical axis of lens 0). This looks opposite to the placement of the front elements, but the projection center of a fisheye lens is not necessarily at the front element. The sign was confirmed on real data: the bridge railing at 3:22 matches at a near distance only in this direction, and gets worse at every distance in the opposite direction
- The parallax from the difference in the two lens positions is about 1.9°/D[m] at distance D (1.9° at 1m, 0.7° at 2.6m)
- The scenery near the seam is assumed to lie on a sphere whose distance is decided per azimuth (position along the seam), and is projected in the direction seen from each lens position (the correction applies only near the seam: in full within ±7° of the seam, 0 at ±15°. Previously it was applied while fading out to ±40°, so even places far from the seam, such as the roadside grass at the lower left of a forward-facing view, stretched and shrank with a distance that changed from frame to frame and looked unnaturally in motion)
- The distance is searched per frame on the GPU: for each combination of 256 azimuth divisions × 10 distance candidates (infinity to 45cm), the correlation of brightness at 128 points in the overlap band (86.5 to 93.5°) is computed, and the distance with the highest correlation is chosen. Places without texture are left to the neighbors and the previous frame; the distance is kept from changing abruptly between neighbors and from the previous frame, and the farther one is chosen when they are about equal
- **For azimuths below the horizon, the distance to the ground is used as a guide**: from the direction of gravity (the horizontal direction obtained by removing the lean from the body attitude, `MotionModel.downInRig`),
  find the downward angle e of each azimuth on the seam, and add the ground distance = camera height (assumed 1.5m) ÷ sin e to the candidates for that azimuth.
  - Candidates farther than the ground are strongly penalized (nothing beyond the ground is visible. Allowing for slopes and height error, up to 1.25 times the ground distance is permitted)
  - Candidates nearer than the ground (own bike, rider, a wall right beside, etc.) are chosen only when the match is clearly good
  - On the road surface (asphalt) the fine texture is blurred at the lens edge and the correlation is poor at every distance (mismatch 0.3 to 0.6). Choosing the distance from that scatter
    makes the distance jump between 0.5m and ∞ from bin to bin along the seam, and white lines get zigzag kinks. For azimuths where the ground is visible, the correlation is used only when the mismatch of the best candidate is below 0.2;
    otherwise the ground distance is used
  - With a normal mount (lenses front and back) the seam runs vertically through the exact left and right sides and only crosses the road at one's feet.
    This matters when the camera is mounted sideways (top of the body facing forward, lenses toward the sky and the ground)
    and the seam crosses the road ahead diagonally (the center line at 1:07.74 of Shiretoko Pass, 2026-08-30)
- **Don't rely on the match score for bins that match badly at every distance**: if the mismatch of the best candidate is 0.1 or less the match score is used as is, and if it is 0.35 or more it is not used (linear fade in between.
  What isn't used is left to the neighbors and the previous frame, and the farther one is chosen when they are about equal). At the border with a bright sky or on weakly textured concrete, the mismatch is 0.4 to 0.7 at every distance, yet
  only the nearest candidate (45cm) happens to come out at 0.24 to 0.38, so that bin alone used to pick 0.5m. Things that are clearly visible are below 0.2
  (0919 bridge railing 0.05 to 0.18, own bike 0.01 to 0.06), so they are still chosen as before. The "use the correlation only when below 0.2" rule for azimuths where the ground is visible stays separately from this
- **Away from the seam, use a distance blurred along the seam**: in the band where the two lenses are blended (±3° from the seam) the per-bin distance is used as is (needed for alignment),
  then it moves to a Gaussian-blurred distance (σ = 3 bins ≈ 4°) up to ±7°, and the correction reaches 0 at ±15°. Where only one lens is visible no alignment is needed, and differences in per-bin distance
  turn directly into distortion of the scenery. The correction isn't weakened until ±7°, so if a single bin (1.4°) has a near distance, a straight line crossing it is pulled by 2 to 4° over the width of that bin and becomes a small triangular step
  - 3:04.66 of Shiretoko Pass 2026-08-30 (facing toward the own bike): a triangular step appeared at the border between the tunnel wall and the lower ledge. The cause was bin 143 (8° from the seam) choosing 0.5m through the "accidental match" above.
    It disappeared with the weakening of the match score, and the kinked crossbar in the bridge railing that followed (a crossbar 1m away running along the seam) was also smoothed by the blurring.
    A slight offset remains when a near crossbar runs along the seam inside the seam band (with one distance per azimuth, the crossbar and the trees behind it can't be aligned at the same time)
- **The reference point of the correction moves between the two lens positions according to the blend ratio**: with a scenery point = direction × distance, each lens draws that point in the direction seen from its own position.
  The reference point (the "viewing eye") is placed at the position mix(lens 1, lens 0, w0) blended with lens 0's weight w0. Where only lens 0 draws (w0 = 1) it is seen exactly from lens 0's position,
  so it is not distorted whatever the distance. The correction applies only inside the band where the two lenses are blended, and there the other lens is fitted to it
  - Previously the reference point was fixed at the midpoint of the two lenses, with half the correction applied to each lens in opposite directions. Near the seam where only one lens is visible (±7 to 15°) it was pulled by distances that differ per azimuth,
    and in 8:00.76 of Shiretoko 2026-10-11 (a video with the camera mounted behind the top case), the edge of the top case had a step at the fastener and the left and right reflectors were at different heights
    (the reciprocal of the distance of adjacent bins differed by about 2/m, a shift of about 30px). In lens 1 the case is hidden by the camera mount, so it is a place drawn only by lens 0. In Insta360 Studio it was connected cleanly
  - After the fix: the case edge and the reflectors connect straight. The left and right bands looking slightly different in height is perspective (the angle of the case) and is the same in Studio. Other scenes (`testdata/seam`) are unchanged
    (only a slight bleed of the grass beside the case in 1011-plate). Widening the range over which the seam position is shifted to ±16° makes no visible difference, so it stays at ±8°
- The distance changes gradually over consecutive frames (toward the new value by 15% per frame, about 0.3 seconds at 50fps)
- In playback and export, the result of the search issued in the previous frame is received one frame late (no waiting for the GPU). The added time is about 1.3ms per frame
- The seam crossfade is 12° wide (S-shaped). The two lenses differ slightly in sharpness of detail (lens 0 is a little blurrier), so at 6° the switching line is visible. At 18° near objects start to look doubled
- **For azimuths where the images don't match, shift the seam position and switch over a narrow width** (`chooseSeamCut` in `render/seamdepth.ts`, CUT_FS in the shader)
  - 1:35.20 of Shiretoko 2026-10-11 (a video with the camera mounted behind the top case): the license plate and top case at 0.3 to 0.7m sat right on the seam, and the license plate showed through twice.
    The mismatch at that azimuth is 0.39 to 0.70 at every distance. The camera mount appears in only one lens (lens 1), and the distances of the plate, the top case and the road behind differ, so one distance per azimuth can't align them.
    Drawing with the distance fixed to 0.17 to ∞ m doesn't remove the doubling. It's the same with the rolling shutter correction turned off (the plate moves together with the camera, so it isn't an effect of the correction)
  - On the GPU, for each combination of azimuth bin × seam position candidate (from the geometric seam toward the lens 0 side, −8 to +8°, every 2°), compute the brightness difference between the two lenses aligned at the current distance
    (mean absolute value after removing the mean difference within the bin: 3 columns of 16 points along the seam × 0.8° spacing). Positions beyond the range either lens can see (100° from the optical axis) are not used
  - "Mismatch degree" = mismatch at the chosen distance (0.2 to 0.4 maps to 0→1) × image difference at the seam position (0.12 to 0.3 maps to 0→1). Azimuths without texture (sky) get 0 (because a brightness difference would show as a line).
    It is widened to the 2 adjacent bins and then blurred so that it reaches the edges of objects
  - The worse an azimuth matches, the narrower the switching width (1/4 = 3° at the worst), and the seam position moves to where the image difference is small. The position is chosen as the shortest path along the bin sequence (image difference + shift amount + difference from the neighbor)
    and smoothed along the azimuth (with a small weight against differences from neighbors, the seam kinked in a zigzag and left a step at the edge of the top case). Matching azimuths keep the geometric seam and the 12° width
  - **Where neither lens has texture, the mean brightness difference is also added to the image difference** (differences up to 0.04, about an exposure difference, are tolerated). With only the difference after removing the mean, two textureless surfaces "match" even if their brightness differs
    - 8:00.76 of Shiretoko 2026-10-11: the seam moved toward the lower edge of the top case (lens 0 sees the gray case, lens 1 the black camera mount), the black edge of the mount appeared in the narrow switching band,
      and the license plate looked as if it were seen through the case. Looking at the brightness difference, the seam moves to the road side below the plate (lens 0 draws up to the plate)
    - Not looked at where there is texture (the mean difference over 3 columns × 48 points from the mean is 0.005 to 0.012, mapped 1→0). At the edge of an object the mean changes even with a slight position shift,
      and looking at it always made the seam leave the upper edge of the license plate at 1:35.20 and run through the plate, smearing the edges of the digits
  - **The image difference and the mismatch degree are smoothed over time** (3% per frame, about 0.7 seconds at 50fps). Near objects on the seam (top case, license plate, camera mount) move together with the camera, so the good position barely changes.
    The per-frame image difference fluctuated on the road streaming backward and re-chose between distant candidates (such as −5° and +3°)
    (in the 2 seconds around 1:35 of Shiretoko 2026-10-11, the total change in bin positions near the case was 62 to 90° → 0.4 to 12° after smoothing). Smoothing only the output position still crosses the object while going back and forth between candidates
  - **When moving the position to an adjacent bin, count the image difference of the positions in between too** (the seam line crosses between them diagonally). When positions with a small difference are split above the object (+2 to +4°) and below it (−8 to −6°),
    the transfer between them crossed the license plate and left digits of the plate missing. With it included in the transfer cost, the path goes through one side or the other
    - 0:00 of Shiretoko 2026-10-11 (parking lot. The case is close, at 0.5 to 1m, and the camera mount blocks the middle of lens 1): the lower left of the case was missing and became road surface, and part of the plate disappeared; this was fixed.
      In Insta360 Studio too, this video looks off with anything other than AI stitching (what the two lenses see is itself different, so choosing the seam position alone has limits)
  - Over consecutive frames, the position and width approach the new values by 25% per frame

### Seam template for the own bike (AI, experimental. `core/bodymap.ts`, `engine/bodymap.ts`, `engine/bodymap.worker.ts`)

When the camera is mounted behind the top case, the top case, license plate and camera mount sit right on the seam. They are close, at 0.3 to 1m,
and in lens 1 the camera mount blocks the case, so the images of the two lenses don't match at any distance. In the per-frame seam position selection
(above, "For azimuths where the images don't match, shift the seam position and switch over a narrow width"), corners of the case and parts of the plate go missing, and re-selection while riding makes them flicker.
In Insta360 Studio too, this video looks off with anything other than AI stitching (optical flow etc.).

These move together with the camera, so they are stationary within the lens images. So the video is divided into 30-second sections, and once per section:

1. Make a band image of the area near the seam: columns = azimuth φ (2400 columns, 0.15°), rows = angle θ from the optical axis of lens 0 (68.4 to 111.6°, 288 rows).
   Make bands of both lenses at the section's keyframes (every 5 seconds, up to 9) and take the median (the template)
2. Parts that don't change over time = the own-bike parts: where there is texture, the median of the local correlation (7×7) between each frame and the template maps 0.5 to 0.8 to 0→1; where there is no texture, the brightness spread is below 0.015.
   Deciding by brightness spread alone treated the aluminum case, whose brightness changes with the sunlight, as "changing" and dropped most of the case.
   The case edge moves by about 1 pixel with the shake of the camera mount, so the brightness is blurred slightly before comparing
3. Stretch the overlap that both lenses see (θ 79 to 101°) vertically and feed it to NeuFlow v2 (432×768), and compute flows in both directions, lens 0 → lens 1 and the reverse (0.2 to 0.4 seconds per image with WebGPU, 5 seconds on CPU).
   Use only where forward and backward agree within 2px; elsewhere don't shift. Feed only the range both lenses see, not the whole overlap
   (feeding the whole band made it match the black areas outside each lens's visible range, which broke the flow)
4. Decide the seam row for each column: the shortest path of [image difference of the template (difference with lens 1 shifted and overlaid, average over 7 rows × 3 columns) × 3 + angle from 90° × 0.04/° + number of rows of unalignable own-bike parts drawn by lens 1 × 0.01],
   plus the row difference from the neighboring column × 0.2/row. Each side is drawn by its own lens (no decision on which lens is correct)
   - "Treat the dark side as the occluding object" and "treat the side with more texture as correct" were dropped because they doubled the reflector or erased the black edge of the case
   - Making the difference from the neighboring column cheap made the seam bend into a U shape and showed the other lens's reflector and tire, shifted by parallax
5. Shift of the position to read from lens 1 = the reliable flow. Fade to 0 within 40 rows (6°) of the seam (fading within 2° made straight lines such as the reflector kink just beyond the seam)
6. Holes (outside the range seen by the lens drawing this side of the seam, and the other is outside too) are filled in the template with AI inpainting (LaMa, or MI-GAN).
   With the mount behind the top case, lens 1's mount is always on the lens 0 side and no holes appear. "Treat dark, unchanging, textureless places as holes" was also tried, but dropped because it erased even the case's black edge and the rider's black trousers

When drawing, the own-bike parts use this template's seam and shift to paste the current video (brightness and shadows as they are at the time). Everything else uses the per-frame processing as before.
Between the centers of sections, the two templates are blended linearly (so the seam doesn't change abruptly at section boundaries in videos where the camera mount rotates slowly).
The template is saved to `.motorecomovie-body.bin` next to the video (gzip; only the columns of the own-bike parts).

Results ("with / without the own-bike seam template" in `testdata/seam`):

| scene | with template |
|---|---|
| 1011 Shiretoko 0:00 (parking lot, case a few tens of cm away) | The lower left of the case is not missing and the reflector is straight. The license plate is slightly distorted |
| 1011 Shiretoko 1:35 (riding) | The case edge connects. The left end of the left reflector and the lower left of the case bleed slightly |
| 1011 Shiretoko 8:00.76 | Nearly the same as without the template |
| 1011 Shiretoko 1:53 (pannier) | The left end of the left reflector bleeds slightly |
| 0919, 0830 | Unchanged |

The flicker while riding (re-selection of the seam position) also settled without the template once the image difference was smoothed over time, so the template, which improves some places and worsens others, is off by default (the "Align the body seam with AI (experimental)" checkbox in the Stabilization section).

The models of Insta360 Studio's AI stitching (`.ins` / `.insnx` in `data/models`, run with MNN and DirectML) are encrypted and can't be read
(the name `self_stick_det_320x160` suggests there is a model that finds and removes the camera mount and selfie stick). They belong to Insta360, so they are not used.
  - Result: the license plate appears crisp as a single image, and the seam avoids the plate and runs over the road. No flicker in the exported video either. A small smear sometimes remains at the left end of the top case.
    The bridge railing in 0919, the center line in 0830 and the edge of the tunnel wall in 0830 are unchanged (`testdata/seam`)
