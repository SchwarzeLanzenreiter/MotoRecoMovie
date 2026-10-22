# Unified telemetry

Implementation: `app/src/renderer/src/core/telemetry.ts` (the analysis runs in the Web Worker in `engine/analysis.worker.ts`)

The vehicle log columns (MotoReco "TO Custom v1") and the lean angle fused with the gyro are combined into **evenly spaced 100 Hz channels aligned to video time**. Both the gauges (overlay layers) and riding state detection (auto camera) use them.

## Channels

| Key | Content | Source column | Source update rate | Processing |
|---|---|---|---|---|
| speed | Speed km/h | **FrSpeed1** (front wheel speed) | 10 ms | 9-point median removes spikes (up to 469 km/h and so on). The `Speed` column updates once a second and lags, so it is not used (ratio to front wheel speed 1.00) |
| rpm | Engine rpm | RPM | 20 ms | |
| gear | Gear (0 = N) | Gear | on change | Stepped value; not interpolated |
| lean | Lean angle (actual angle) | fused | 100 Hz | [motoreco-lean.md](motoreco-lean.md) |
| airTemp | Air temperature °C | AirTemp | tens of seconds or more | 0.75 °C steps |
| accelG | Longitudinal acceleration G | **rate of change of front wheel speed** | | Speed smoothed with σ = 0.15 s, differentiated, then smoothed with σ = 0.1 s. The log's X_Axis_G includes the gravity component on slopes (regression of residual on grade 0.94) and saturates at −0.45 G (mean −0.455 during hard braking), so it is not used |
| latG | Lateral acceleration G | Y_Axis_G | 10 ms | Invalid values at the start (around −3.7) removed, smoothed with σ = 50 ms |
| throttle | Throttle % | ThrottelPosition | 10 ms | |
| brakeFront / brakeRear | Brake pressure bar | max(FrBrakeUp, FrBrakeDown) / RrBrake1 | 20 ms | |
| lat / lon | Latitude, longitude | lat (deg) / lon (deg) | **1 s** | Converted to plane coordinates, cubic Hermite interpolation |
| heading | Heading (north = 0°, east = 90°) | GPS track | | From the difference over ±0.5 s. Holds the previous value while stopped |
| alt | Elevation m | alt (m) | 1 s | Smoothed with σ = 1 s after interpolation |
| grade | Grade % | alt and distance | | Elevation difference over ±3 s ÷ distance (0 if under 20 m) |
| distance | Distance ridden km | GPS track | | |
| gpsX / gpsY | Plane coordinates m (east / north, origin = first fix) | GPS track | | For drawing the map. Storing latitude and longitude as Float32 would give steps of about 0.4 m |

For drawing the map, the track at 1 s intervals (east and north in m) and its extent are also kept.

Times with no log (for example where the recording started before the log) and the first 0.5 s after the logger starts (it writes bad values, e.g. a front wheel speed of 469 km/h) are treated as "no data" (NaN), and the gauges are not shown there. Only the lean angle covers the whole video, thanks to the gyro.

## Riding state (`core/riding.ts`)

Used to switch the look of the gauges and by auto camera.

| State | Enter when | Leave when |
|---|---|---|
| Stopped | speed < 3 km/h | speed > 6 km/h |
| Braking | brake pressure > 4 bar, or longitudinal G < −0.18 | brake pressure < 1.5 bar and longitudinal G > −0.08 |
| Cornering | lean angle > 15° | lean angle < 10° |
| Accelerating | longitudinal G > +0.08 and throttle > 25% | longitudinal G < +0.03 or throttle < 15% |
| Cruise | none of the above | |

- **Priority**: Stopped > Braking > Cornering > Accelerating > Cruise (braking before a corner takes priority as braking)
- **Anti-flicker**: stretches shorter than 0.6 s are absorbed into the previous state
- **Weights**: each state has a weight from 0 to 1, and the weights cross over at a constant rate over 0.4 s from the change. The gauge layout is interpolated with these weights
- **Max lean per corner**: holds the maximum so far within the stretch. Used for the gauges' "MAX" display

In this sample (25 min) the shares are cruise 27%, accelerating 10%, braking 17%, cornering 44% and stopped 2%, with about 12 changes per minute. Brake pressure exceeds 4 bar only about 1% of the time, so most "braking" is engine braking.

## GPS delay

The GPS in the log lags the actual fix by about **1 s**. This was confirmed by the correlation between the rate of change of the GPS heading and the camera gyro's yaw rate (about the bike's up axis), which peaks (0.93) at a correction of 0.95–1.0 s (`app/test/telemetry.test.ts`).

The delay may vary between devices, so it is not hard-coded but estimated automatically for each log with the same method (`estimateGpsDelay`). Stretches with no log (NaN) are excluded from the correlation (mixing them in makes the estimate always 0; `telemetry.test.ts` checks that the estimate falls within 0.85–1.15 s).

## Processing time (25-min log, inside the Web Worker)

CSV loading 0.35 s, sync 1.2 s, lean angle fusion 0.03 s, building the telemetry (including GPS delay estimation) 0.6–0.7 s. The UI thread is never blocked.

## Heading and position fusion (`core/nav.ts`)

To pin floating signs to points on the map, this produces a position and heading that are smoother than GPS (1 Hz, about 1 s late) and have no lag.

- **Heading**: the heading from integrating the gyro yaw rate is corrected by the GPS heading at low frequencies only. The yaw rate is about the bike's up axis, so while leaned over it is divided by cos(lean angle) to get the rate about the vertical axis. The correction is a forward-backward symmetric smoothing with σ = 3 s
- **Position**: the position accumulated from front wheel speed and the heading above (dead reckoning) is corrected by the GPS position in the same way
- **Result** (this sample): difference from GPS is 2.4 m RMS in position and 2.0° RMS in heading. Fine jitter in position (second difference) is about 1/12 of GPS

## Corners and curve radius (`core/corners.ts`)

- **Corner**: a cornering stretch of the riding state (lean angle > 15°)
- **Curve radius**: R = speed ÷ turn rate about the vertical axis. The median over the part where the turn is strongest (80% of the maximum or more) is rounded to 5 m. The turn rate includes mount vibration (around ±20°/s), so it is smoothed with σ = 0.3 s first (without smoothing it picks up vibration peaks and the radius comes out about 1/5)
- **Validation**: the median ratio to the radius from the curvature of the GPS track is 1.00. The ratio to R = v²/(g·tan L) is 1.16 (presumably because the rider's body position makes the bike's lean angle differ from the actual turn)
- **Results on this route**: 110 corners, median radius 175 m, most between 125 and 230 m
- **Sign position**: the route around the entry point (from 120 m before to 60 m after) is stored every 2 m, and the sign is placed at the point given by the view layer's "Sign position" (distance along the route from the entry; default −25 m) (distance is measured by integrating front wheel speed)

## Sign projection (`cameraInMap` in `engine/motion-model.ts`)

Signs are projected by transferring the same virtual camera orientation used to render the video (orientation in gyro coordinates) into map coordinates (east, down, north).
The rotation M from gyro coordinates to map coordinates is ideally almost constant (it only changes slowly with gyro drift), so

  M(t) = level bike in the map (fused heading) · (level bike in the gyro frame)⁻¹

is computed at 10 Hz and smoothed with σ = 2 s. "Level" in the gyro frame comes from gravity (`gravityTrack` / `gravityAt` in `core/motion.ts`):
the accelerometer reading moved into the gyro frame and averaged over ±30 s, plus the bike's own acceleration over the window, which adds up
to the change in velocity (logged speed along the body forward) ÷ the window. The level forward is the body forward with its vertical part removed.

- Leveling used to come from the grade of the GPS altitude (bike in the map = Ry(heading)·Rx(atan(grade))). On 0919 the pitch of the sign camera
  was then off from gravity by +1.3° on average, 2.7° RMS and up to 9° (roll 2.5° RMS), worst in corners. The error is an angle, so the
  sign drifts in proportion to its distance: 1.3° lifts a sign 200 m away by 4.5 m, which is why far signs floated while near ones stood on the
  road. With gravity it is 0.4° RMS in pitch and 0.3° in roll (`test/signtilt.test.ts`). Without taking out the bike's own acceleration it
  would be 1.8° RMS: in a hairpin the push outward does not cancel within the window (the correction is 2.2° median, up to 6.5°, on 0919).
  Without IMU acceleration the grade is used as before

- Signs used to be projected with "fused heading and grade + ideal view". The fused heading contains fine gyro vibration while the video is rendered with the smoothed attitude, so the signs alone seemed to jitter (in this sample, 1.7–2.3 px horizontal and 1 px vertical RMS relative to the video, at 1920 px width and 110° FOV)
- With the current method the fine shake in the video carries over to the signs as well, so they look stuck to the scenery. The slow component agrees with the old method to within 0.1° (`test/signview.test.ts`)

## Chassis disturbance (`core/disturb.ts`)

The following vehicle log columns are turned directly into 100 Hz channels: `SlipRate` (slip), `FrStroke` / `RrStroke` (frStroke / rrStroke), `RollRate` / `YawRate` (rollRate / yawRate), `X_Axis_G` / `Y_Axis_G` / `Z_Axis_G` (xG / latG / zG).

| Indicator | Computation | Floor |
|---|---|---|
| Slip ratio | Absolute deviation from a σ = 1 s smoothing. A deviation of 6% from the median of the whole ride counts the same as the floor (wheelspin, lock-up). Above 25 km/h | 1.5 % |
| Roll and yaw rate | 0.4 s RMS of the 1.5–12 Hz component | 3.5 / 2.0 °/s |
| Longitudinal, lateral and vertical G | Same as above (heavily smoothed in the log, so secondary) | 0.008 / 0.003 / 0.025 G |
| Suspension stroke | 0.3 s RMS of the velocity, differentiated after smoothing at 15 Hz | front 350 / rear 450 mm/s |

Each indicator is divided by max(the ride's 99.5th percentile, floor), and the largest becomes the strength at that time. In this sample, the strongest scene is the same as in the Python analysis (proto): log time 1281.8 s = video 21:28, where the front stroke tops out at 20 mm and the roll and yaw shake is about 3–4 times the top 0.5% level.
