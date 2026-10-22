# Roll correction from the MotoReco log

Implementation: `proto/motoreco.py` (loading and sync), `proto/leanfusion.py` (lean angle fusion), `proto/renderer.py` (`Settings.lean` / `lean_ratio`)

## Properties of the log ("TO Custom v1" CSV)

| Signal | Update rate | Notes |
|---|---|---|
| RollRate / YawRate | 10 ms | Invalid value is −125. Used for sync |
| LeanAngle | median 60 ms, 90% within 250 ms | 0.71° steps (about 7 bits). **80 stretches where it freezes for 1 s or more, 117 s in total**. About **7% smaller** than the actual lean |
| Speed | 1 s | |

The columns have no absolute time, so the log cannot be synced by time alone.

## Sync

1. Project the camera gyro onto the bike's roll axis (the forward direction of the mount correction `R_mount`), average it into 10 ms bins in video time (evenly spaced 100 Hz), and apply a 3 Hz lowpass
2. Cross-correlate it with the log's RollRate over the whole length using an FFT for a coarse sync (finds the offset however many minutes it is). The ratio of the main peak to the second peak is 3.6
3. For each 30 s window (every 15 s), search ±4 s around the coarse offset in 50 ms steps, and fit a line to the window offsets (median slope). Then refine within ±60 ms of that line in 10 ms → 1 ms steps and
   fit `log time = a·video time + b`

Result for this sample: `b = −6.440s`, clock rate difference +5 ppm (about 7 ms over 25 min). Per-window correlation 0.94–0.99, MAD of the offsets 8 ms.

**The X5 IMU does not run at 1000 Hz** (996.3 Hz and 995.9 Hz on the two clips on hand; the X6 is 999.9 Hz). The gyro used to be grouped 10 samples at a time and treated as 100 Hz, so
on the X5 the time scale was off by 0.4%, the coarse sync missed by 2 s (13-min video), and the refinement, which only searched ±0.3 s, found none of the windows. The lean angle went to ±120°, and
floating signs were tilted by up to 50° against the scenery (video from 2026-08-13). After re-binning at even intervals, the coarse sync peak ratio went from 2.2 → 3.4, the window correlation to 0.99, the lean angle error to 1.1°,
and the sign tilt mismatch (difference from the gravity direction derived from acceleration) from 29° → 1.8° RMS (the X6 0919 clip stays at 2.6°; `test/signtilt.test.ts`). Signs are now leveled by gravity rather than the GPS grade, which brings it to 0.3° (see `telemetry.md`, "Sign projection").
When sync fails, the mount orientation refined with the log (`refineMountWithLog`) is also off. In this video, forward was off by 2.0° to the left and 3.0° down, and in the forward view the vanishing point appeared right of the screen center
(after fixing the sync, the vanishing point of the road on straights is almost at the screen center)

## Lean angle fusion (RTS smoothing)

- State: lean angle and gyro bias
- Prediction: integrate the roll component of the camera gyro (below 3 Hz)
- Observation: the log's LeanAngle is used **only at the times it updates**. Frozen stretches are bridged with the gyro
- Scale: `dLean/dt = k·ω_roll` with k = 0.928 (correlation 0.989). The log is multiplied by 1/k to match the actual angle
  - Reason: with the raw log values and the horizon held level, utility poles stay tilted by about 7% of the lean angle (about 2.6° at 36.5°, about 2.1° at −29.8°). Multiplying by 1/k brings this within about 1°
  - This difference is part of why "the lean was 37° but the screen looked tilted by about 45°" before. The actual lean was about 39°, and the rest is how wide-angle perspective makes it look

## Roll correction

```
virtual camera = qs · R(fore-aft axis, L − G*L) · [R(fore-aft axis, −(1−ratio)·L)] · R_mount · R_view
```

- `qs`: attitude from the smoothed gyro. Its roll component is dulled to G*L
- `L − G*L`: the lean motion lost to smoothing. It is added back from L fused with the log (complementary filter)
- `ratio`: share of the lean kept on screen (1 = tilts with the bike, 0 = horizon level)

Validation (`proto/validate_tilt.py`, 1380–1420 s): lag (tilt − L, below 1 Hz)

| Setting | RMS / max |
|---|---|
| σ0.25 | 0.43° / 1.12° |
| Per axis P0.6/Y0.3/R0.2 | 0.29° / 0.75° |
| σ0.25 + correction | 0.07° / 0.32° |
| Per axis + correction | 0.05° / 0.22° |
| σ1.0 + correction | 0.55° / 2.0° |

With `ratio=0` the screen tilt = 0.000·L; with `ratio=0.5` it is −0.500·L (residual RMS 0.2°).
