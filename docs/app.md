# MotoRecoMovie (the app)

(Formerly called "Insta360 Reframe". History, settings, edits and settings files from the old name carry over as they are.)

A desktop app that opens Insta360 X6 `.insv` files directly and reframes them for motorcycle onboard footage.

- Stabilization without horizon lock (it follows the lean and removes only the vibration)
- Rolling shutter correction
- Roll correction from the MotoReco vehicle log, and "Keep lean", the share of lean kept on screen (0% = horizon level)
- Keyframes move the view (yaw, pitch, FOV, keep lean)
- Decoding, rendering and encoding run on the GPU (WebCodecs + WebGL2). Measured export speed is about 70 fps (1080p, RTX 3070)

## Running

Requirements: Node.js 24 or later, and ffmpeg on the PATH (used to mux the audio)

```bash
cd app
npm install
npm run build
npm start
```

During development use `npm run dev` (hot reload).

### Building the exe (installer)

```bash
cd app
npm run dist
```

electron-builder (`build` in `package.json`) creates the following in `app/dist/`.

- `MotoRecoMovie Setup <version>.exe`: the installer (about 115 MB). You can choose the install folder; it creates "MotoRecoMovie" shortcuts on the desktop and in the Start menu. Uninstall from Windows "Apps"
- `win-unpacked/`: a folder you can use without installing (about 400 MB). Run the `MotoRecoMovie.exe` inside it directly

Only `out/` (the build output, including the vehicle detection model and the onnxruntime wasm) and `package.json` go into the app. React and the other
dependencies are bundled into one file by the build, so `node_modules` is not included. The icon is `build/icon.png`.
The app is not code-signed, so Windows SmartScreen may show a warning on first launch ("More info" → "Run anyway").
Audio muxing needs ffmpeg on the PATH for the exe as well.

## Usage

On launch, "Recent videos" (up to 12) are listed. Click a card to open it; × removes it from the history (the video is not deleted).
Each card shows a thumbnail (the scene that was on screen when you closed it), duration, folder, recording date and time (from the file name), and whether there is a vehicle log and saved edits.
If the video has been moved or deleted, it shows "File not found". "Close" in the toolbar returns to this screen at any time (unsaved edits are saved before closing).
The history is saved in `recent.json` in Electron's user data folder (`%APPDATA%\MotoRecoMovie\recent.json`; if the old-name folder `%APPDATA%\insta360-reframe` exists, it is copied over on first launch).

1. Use "Open…" or drag and drop an `.insv` onto the window. The vehicle log (MotoReco) is searched for in the following order, loaded automatically and synced with the video
   - The log recorded in the project → a CSV in the same folder as the video (converted with MotoRecoViewer) → a matching file from the .dat folder
   - A `.dat` can be read directly without converting it in MotoRecoViewer. Point the app at the same `.ddf` decoding rules that MotoRecoViewer uses ("Vehicle log (MotoReco)" → "Rules (.ddf)" in the side panel)
   - "Find in folder" picks the file from the same ride out of the .dat folder (including the per-year folders under it), using the time in the file name and the correlation with the video's gyro.
     The format, formulas and matching are described in [motoreco-dat.md](motoreco-dat.md)
   - Forward (yaw 0°) and level are found automatically from the video's gyro and accelerometer, however the camera is mounted (`core/mount.ts`).
     Forward = the bike's direction of travel; up = the top of the bike when it is not leaning. With the bike upright, the forward view is level and points the way you are going.
     - Up = the time average of acceleration while riding (even when leaned over, the resultant force on a bike points along its vertical axis). Time spent stopped (before setting off, breaks, on the side stand) is not used
     - Fore-aft axis = in the plane perpendicular to up, combining three cues: the axis of the leaning rotation (principal component of the gyro; accurate when it is clear),
       the axis of acceleration and braking (principal component of the horizontal acceleration; works even on straights), and the relationship with yaw (yaw rate regressed on tilt; robust to a wobbling mount).
       If the leaning-rotation axis disagrees with the other cues by 30° or more, it is assumed to be picking up mount wobble and is not used
     - Front vs. back = decided from the fact that a bike leans toward the side it turns to (the lean angle about the forward axis is anti-correlated with the yaw rate about up), so
       the front is found even when the lens points sideways, up, down or backward. Only when there is little turning and the relationship is weak (correlation magnitude below 0.1) does it fall back to the side closer to lens 1's direction
     - If the camera's orientation relative to the bike changes during the ride (the mount rotates or works loose), it is solved over time (smoothed over a window of about 30 s).
       If it changes by less than 12° over the whole video, a single orientation is used
     - Once a vehicle log is loaded, the result is refined with the log (vehicle speed, lean angle, roll rate) (`refineMountWithLog`)
     - Error against ground truth derived from the log's roll rate and the acceleration while riding upright (mean per minute, `test/mount-log.test.ts`):
       | Video | Single orientation (before) | IMU only | Refined with log |
       |---|---|---|---|
       | 1011 Shiretoko, 2nd clip (camera rotated 75° during the ride) | up 10–47°, fwd 8–77° | up 1.9°, fwd 3.8° | up 0.9°, fwd 2.6° |
       | 1011 Shiretoko, 3rd clip (wobbling mount) | fwd 4–43° | up 1.1°, fwd 7.4° | up 0.9°, fwd 4.8° |
       | 0906 Shikaribetsu | up 2–15°, fwd 1–17° | up 2.3°, fwd 4.2° | up 1.4°, fwd 1.6° |
       | 0919 Soya Hills (fixed mount) | up 2.3°, fwd 3.6° | same (single orientation) | up 2.3°, fwd 2.9° |
       The ground truth itself scatters by 2–4°. Every X6 and X5 video on hand where front/back and level were checked by eye
       (mounted behind the top case, on a pole at the back of the bike, a mount that gradually rotates, and so on) came out right
     - Keyframes, auto-generated views, overtake detection, signs and so on all use this forward direction as their reference. Keyframe directions are angles from forward, so
       even if the forward estimate changes, the auto-generated views (forward, side, rear and so on) still point the right way
2. Drag the video to change the direction; use the wheel to change the FOV (30–180°)
   - Up to 135° FOV it is a normal perspective projection. Wider than that, it blends continuously into a stereographic projection toward 180°, so the edges of the frame are not stretched even at wide angles (`render/projection.ts`).
     The closer to stereographic, the more straight lines away from the center bend into arcs. The blend used to run from 120° to 170°, and at 140° FOV the line of the top case reflector looked stepped
     (`1011-pannier-line` in testdata/seam), so it was changed so that 140° is almost pure perspective (k = 0.03)
   - The further the view turns sideways, the less lean tilt is kept on screen, down to level at 90° (a camera fixed to the bike and pointing sideways sees the lean as up-and-down motion, not as tilt of the image). Looking backward tilts the opposite way to looking forward (a rearward line of sight runs opposite to the bike's fore-aft axis, so this matches a camera fixed to the bike. It used to tilt the same way as forward)
   - With one keyframe, it sets the view for the whole video
   - With two or more, it changes the keyframe at the current time (one is added if there is none)
3. In the right panel, adjust the stabilization strength (pitch, yaw and roll separately) and Keep lean
   - **Lens seam alignment**: the first time a video is opened, the correction for lens 1 (edge angle and a small rotation) is estimated in the background so the front and back lenses match in the overlap band, and saved (about 10 s; a notification appears when it is done). This fixes the seam offset seen when looking sideways (about 2° in this sample). The Stabilization section has an on/off switch and "Re-estimate" ([insv-x6-format.md](insv-x6-format.md))
   - **Align the seam on near objects too (dynamic stitching)**: the front and back lenses are about 3.3 cm apart, so near objects such as railings, the road surface and the bike itself are misaligned at the seam. For each frame the distance to the scene near the seam is measured and the parallax is corrected (on by default). "Seam blend width" (default 12°) sets how wide the transition is
     - Objects at 0.3–0.7 m such as the number plate and top case cannot be made to overlap at any single distance (their parts are at different distances, and some are visible to only one lens).
       When they cross the seam, a wide transition shows them doubled and see-through. At those bearings, the cut is moved within ±8° to where the two images differ least (the road surface, for example),
       and the transition is narrowed to 1/4 (12° → 3°). Bearings where the images match well are handled as before (`chooseSeamCut` in `render/seamdepth.ts`; details in [insv-x6-format.md](insv-x6-format.md))
     - The parallax correction is applied only inside the band where the two lenses are blended (where only one lens sees the scene, it is drawn as that lens sees it). This keeps the edge of the top case near the seam from stepping
     - **Align the body seam with AI (experimental, off by default)**: for things that move with the camera, such as the top case and number plate, the two lenses are matched with AI optical flow (NeuFlow v2) on a template (median) built for every 30 s of video,
       and the cut is decided ahead of time. When it is on, the template is built in the background when the video opens (6–12 s per segment on the GPU)
       and saved to `.motorecomovie-body.bin` next to the video. Areas that neither lens sees are filled with AI inpainting (LaMa / MI-GAN). Details in [insv-x6-format.md](insv-x6-format.md)
     - The cut position is chosen from the time-smoothed image difference (so the cut does not flicker around on the case or plate, which move with the camera, while riding). Where the position changes, it avoids cutting across objects
     - In areas without texture, the cut is not placed on the boundary between objects of different brightness (such as the grey case and the black camera mount that only one lens sees), so the black edge of the mount does not show through the case
     - Scenes that caused problems are collected as short .insv clips in `testdata/seam/` ([testdata/seam/README.md](../testdata/seam/README.md)). After changing the stitching,
       run `npx tsx tools/seam-cases.ts render` to render them all and check that nothing got worse
4. Under "Screen layout", pick a template (Full screen, Picture-in-picture, Split left/right, Split top/bottom, 1 large + 2 small, Split into 3 rows, Split into 4)
   - Missing views are added automatically (the second and later ones face back, left and right). Extra views are hidden, and their keyframes are kept
   - Split panes and picture-in-picture windows get a border (width and color can be changed per layer)
5. Build the screen in detail under "Layers"
   - "+ View": adds a pane that cuts another direction out of the 360° video (picture-in-picture, split screen). Each one has its own keyframes
   - Overlays (choose a type and click "+ Add"). The gauge cluster and the individual gauges (speedometer, tachometer, gear, lean angle, longitudinal G, air temperature) were removed on 2026-10-20 (if a saved edit or settings file contains them, they are dropped on load)
     - **Cyber gauges**: the same layout and content as the chronograph gauges (no speed), with only the look changed to a HUD style. A translucent glass dial with scan lines, segmented neon arcs (tach, throttle, brake), a glowing lean arc with a triangular pointer, and hexagons for gear and temperature. Color schemes: BMW (M colors) and Neon
       - With the engine off, the whole gauge turns grey (lines, text and glow go to a grey of the same brightness). When the engine starts, the colors come back over 0.5 s.
         This is decided from the vehicle log's rpm (the share of the last 0.5 s above 300 rpm). With no vehicle log, or no rpm in the log, the effect is skipped and the normal colors are used from the start
       - When the gear or air temperature number changes, it rolls vertically into the new one (0.3 s). When the number goes up (upshift, temperature rising), the old number leaves upward and the new one comes in from below;
         when it goes down, the reverse. The new number grows while it comes in (up to 1.4×) and shrinks back to normal size over 0.35 s from the moment it takes over.
         So that the export looks the same, it is drawn from the telemetry at that time by finding "the most recent change of value and the time since it" (`gearShift` and `airShift` in `render/overlay.ts`)
       - Air temperature comes in 0.75 °C steps and flips between two values near a display boundary, so the display only changes once the value is 0.8 °C or more away from the integer shown (so the digits do not keep rolling)
       - Air temperature is shown as a bare number without the unit (°C) (it would not fit in the hexagon; the chronograph gauges do the same). Its color depends on the temperature: 5 °C or below light blue, 30 °C or above yellow, 35 °C or above orange, 40 °C or above red, otherwise white (`airTempColor` in `render/chrono.ts`; grey with the engine off)
       - All text is 1.5× its previous size (`TEXT_SCALE` in `render/cyber.ts`)
     - The gear signal sends 0 (neutral) for just 0.1–0.2 s in the middle of a shift, so a 0 shorter than 0.5 s between two gears keeps the previous gear (no "1 → N → 2" flicker.
       A long 0 after stopping and selecting neutral shows N. `holdThroughShift` in `core/telemetry.ts`)
     - **Chronograph gauges** (first in the Add menu). Color schemes: BMW (M colors: light blue, dark blue, red; no logos are drawn) and Standard. The upper half of the outer ring is the tachometer (with a redline zone); the lower half of the outer ring runs from 6 o'clock to the right for throttle opening and to the left for brake pressure. The upper half of the inner area is the lean meter, with the current lean angle and a MAX hold in the center (reset when the bike flicks more than 3° over to the other side). The lower half of the inner area shows the gear and air temperature. Speed is not shown. The tach and throttle light up while accelerating, the brake while braking, and the lean while cornering
     - **Map**: two displays, nearby (heading up, with a set range) and whole route (north up). The part already ridden is drawn bright and the current position is an arrow. Shape: circle or rounded rectangle. The background is just the track line (map tiles are not supported)
     - **Elevation profile**: a graph of elevation against distance, plus the current elevation and grade (▲ uphill / ▼ downhill). Either the whole route or a window of a set width around the current position
     - **Compass tape**: a horizontally scrolling heading scale and the current heading (e.g. 143° SE)
     - **Readout**
   - Selecting an overlay shows its type-specific settings in the side panel (map display, range and shape, elevation window width, compass tape width, tachometer max and redline for the chronograph and cyber gauges, and so on)
   - A riding state strip runs along the bottom of the timeline (14 px tall. Colors: cruise grey, accelerating green, braking red, cornering blue, stopped yellow)
   - The timeline graph overlays the lean angle (orange, 0° in the middle, ±45° at top and bottom) and vehicle speed (light blue, 0 km/h at the bottom, the video's maximum shown at top left)
   - The timeline zooms horizontally: the wheel zooms around the mouse position, and Shift+wheel (horizontal scroll on a touchpad) pans left and right.
     "−" and "+" at the top right of the graph zoom around the playhead, and "All" goes back to the whole video. The scrollbar at the bottom shows which part of the whole you are looking at;
     while zoomed in, drag the thumb to pan (clicking outside the thumb jumps there and you can keep dragging). If the playhead leaves the visible range, the view follows it.
     Tick spacing adapts to the visible length, from 0.1 s to 10 min
   - Keyframe (◆) colors: auto-generated keyframes are colored by shot type: forward white, corner entry green, side purple, rear pink, overtake yellow.
     Hand-placed keyframes and markers are blue. Stops use the forward color, and side scenery while cruising uses the side color.
     A legend of the types present in the layer appears at the top left of the graph. Hover over a ◆ to see its type
   - Clicking on the preview selects that layer; dragging and the wheel change that layer's view
   - Resize the selected layer with the handles on its frame, and move it with the grip at the top (or Shift+drag). It snaps to the edges, center and thirds of the frame and to the edges of other layers. Overlay layers can also be moved by dragging inside them
   - Layout guides: "┼ Crosshair" and "╳ Diagonals" at the top right of the preview overlay the vertical and horizontal center lines and the lines joining the corners (the G key toggles both). They appear in the preview only, not in the export. The setting is remembered for the next launch
   - Position and size can also be entered as numbers (% of the output)
   - Signs can look like a "Road sign" or "AR style". AR style shows "CURVE LEFT / R165 / ▸ 70 m (distance left to the entry)" on a translucent hologram-like panel, drops a line of light down to the point on the ground and draws a circular marker on the road. The color depends on the radius (under 60 m red, under 120 m orange, otherwise blue)
   - Turning on "Corner signs" for a view layer draws the radius of the corner you are about to enter as a sign floating in the air (a yellow diamond with a curve arrow and an "R=165" plate). The sign is fixed on the outside of the curve, 6 m above the road, grows as you approach and goes past you (without a vehicle log, corners estimated from the video motion are used; see "Without a vehicle log" below).
     Its placement is set by "Sign position", as the distance along the route from the corner entry (default −25 m = 25 m before the entry; positive values move it into the corner).
   - Only signs ahead that can be seen from where you are now are shown (`core/sightline.ts`). There is no terrain data, so this is judged from the position and elevation of the road you ride:
     if the line of sight to the sign strays 10 m or more from the road in between, the sign fades, and at 25 m or more it is hidden (so on a twisty mountain road you do not see signs for road on the far side of the hill).
     If the road under the line of sight is 2 m or more above it (beyond a crest), the sign also fades, and it is hidden at 6 m or more. Even on open flat ground, signs whose line of sight passes far from the road are not shown
   - Signs you have passed are not shown (they fade out starting 0.3 s before you reach the sign's point). They do not appear even in views that show the rear or your own bike after passing.
     Signs are drawn with the same camera orientation and the same projection as the video, so they move with the small shake left in the video and look stuck to the scenery ([telemetry.md](telemetry.md))
6. "Auto camera" creates keyframes for the selected view layer automatically (over the export range or the whole video)
   - Without a vehicle log, the riding state estimated from the video motion is used (see "Without a vehicle log" below)
   - Shots by riding state: side scenery inserted on long cruises, and wide scenery when stopped (looking down ahead when braking and zooming ahead when accelerating were removed on 2026-10-20)
   - Corner entry: normally ① turns slightly into the corner (max lean × amount). Every few long corners (default 2.5 s or longer; default every 2 corners), it inserts in turn ② show yourself (facing back, FOV 165°, horizon level, so the bike is seen leaning), ③ sideways, inside, and ④ sideways, outside (90°, FOV 165°, horizon level; the corner entry and the road already ridden in one frame). ②–④ can each be turned on or off
   - Default views: the four views it switches between (forward, corner entry ①, side ③④, rear ②) are changed from the menu "Settings → Auto-generated views…"
     (or "Default views (front, corner entry, side, rear)…" under "Auto camera"). They are stored as app settings on this PC and used from the next generation
     (existing keyframes do not change; they are not part of projects or settings files)
     - Forward: yaw, pitch, FOV, keep lean. The stopped scenery and cruise scenery are derived from this
     - Corner entry: inward amount (lean angle × ratio, default 60%) and maximum angle (default 35°), pitch, FOV, keep lean
     - Side: sideways angle (default 90°, toward the inside or outside of the corner), pitch, FOV, keep lean (defaults 165° and horizon level)
     - Rear: yaw (default 180°), pitch, FOV, keep lean (defaults 165° and horizon level)
     - The dialog opens over the right panel and previews the chosen view directly in the selected view layer (current frame; it reverts when you close the dialog).
       Corner entry and side are shown for a right-hand corner at 30° lean as an example (for side you can pick ③ inside / ④ outside)
     - "Reset this view" and "Reset all to app defaults" go back to the app defaults (the defaults listed above)
     - The base view used to be taken from the layer's view before generation. Now the forward default is used
   - Markers: add one with the B key during preview, and set the direction (left, right, back, sky, or an angle) and the hold time. Markers take priority over every rule except overtakes
   - Overtake (optional, off by default): while overtaking a vehicle across the center line, the view looks up (sky and scenery; default 40° up, FOV 80°, horizon level) so the road is not shown.
     It starts early by the transition time, so the switch is finished before you start crossing the line. Overtakes are found by analyzing the video
     (the stretches where you cross the lane are found from the center line and the road in the forward view, and a stretch counts as an overtake when a vehicle passes right beside you on the overtaking side during it.
     Vehicles are detected with YOLOX-Nano. `core/lanes.ts`, `core/overtake.ts`, `core/vehicles.ts`.
     The analysis takes about a minute during the first auto generation, and the result is kept in the project. "Rescan" analyzes the video again on the next generation)
     Overtakes slower than "Min. speed to switch" (default 40 km/h; the average vehicle speed during the overtake) do not switch. 0 always switches.
     The speed comes from the vehicle log (or the estimate from the video motion when there is none); if it is unknown, it switches
   - At each moment the shot with the highest priority (overtake > marker > braking > accelerating > corner > stopped > cruise scenery > forward) is chosen and the view pans to it over the set time. Shots shorter than the shortest shot (including brief returns to forward) are dropped
   - So that the line of sight does not drop toward the ground when you look sideways while leaned over, the sideways rotation is referenced to the horizon (gravity). The screen tilt is "Keep lean × cos(yaw) × lean angle" (+ facing forward, 0 sideways, − facing back; when there is a vehicle log. `test/view.test.ts` checks that 100% keep lean tilts the same way as a camera fixed to the bike, both facing forward and facing back)
   - The result is ordinary keyframes, so you can adjust it by hand. Keyframes inside the range are replaced
7. Turning on "Chassis disturbance" finds the moments in the vehicle log where the bike got unsettled, and automatically splits the screen to show your own bike just for those moments
   - Inputs: slip ratio (sudden changes, and sustained offsets such as wheelspin or lock-up; above 25 km/h), the bike's 6-axis sensor (1.5–12 Hz shake in roll and yaw rate and in longitudinal, lateral and vertical G), and front and rear suspension stroke speed (kicks, extension, bottoming out). Only while riding above 15 km/h
   - Each is divided by "the top 0.5% magnitude in that ride" (with a floor, so quiet rides do not trigger too often), and the largest becomes the disturbance strength. Scenes above the threshold (default 1.5×) become events (`core/disturb.ts`)
   - For each event plus margins (defaults 1 s before and 2.5 s after, at least 4 s), the full-screen main view shrinks to half and the "Own bike (disturbance)" pane slides into the free half over 0.4 s. Split: left/right (ahead on the left or right) or top/bottom
   - The "Own bike (disturbance)" view layer is created automatically when you turn this on (facing back, FOV 165°, horizon level). Select this layer to change its direction and FOV. It only works when the main view is full screen
   - The own-bike pane shows "Disturbance" and the strongest indicator (e.g. yaw rate) at the top left (can be turned off)
   - The list lets you choose for each event whether to split the screen, and jump to its time. The split ranges are shown as red bars on the timeline
   - In this sample, a threshold of 1.5× gives 9 events and 8 split-screen intervals (36 s in total out of 25 min). The strongest is at 21:28: yaw shake right after the front suspension topped out (20 mm)
8. Settings files ("Save settings…" / "Load settings…" at the top of the right panel, `*.motorecomovie-settings.json`; `*.reframe-settings.json` from the old name can also be read): the right-panel settings and the position and size of gauges and other items on screen go into one file that you can reuse with other videos (`engine/settings-file.ts`)
   - Included: stabilization, seam blend width and similar settings; all layers (draw order, position, size, visibility, name, border, signs, own-bike pane role, overlay type and settings);
     the direction of view layers (those with a single keyframe); Auto camera; Chassis disturbance; export size, codec, bitrate and the language of text in the video
   - Not included (per video): the motion of views with two or more keyframes, markers, overtake results, lens seam alignment estimates, export range, per-event "don't split" for disturbances, the vehicle log
   - On load, the layers are replaced by the ones in the file. Each view layer takes over the matching layer in the target (the own-bike pane by its role, others by name; default names count as the same whether they were created in Japanese or English;
     if nothing matches, in order from the top), and layers whose direction moves (such as Main) keep their keyframes. Ctrl+Z undoes it
9. Choose the export range (I / O keys), size and codec, then click "Export…". Export uses the same compositing as the preview, so you get exactly what you see
   - The encoder is the first one that works, trying HEVC then H.264, in three tiers (`pickEncoder` in `engine/exporter.ts`; the one used is printed to the console):
     ① hardware at the video's frame rate, ② hardware told the frame rate is 30 fps, ③ software (slow)
   - ②: Windows hardware encoders (WebCodecs → Media Foundation) are only registered up to 30 fps above 1920×1080 (confirmed on an RTX 3070).
     Because of that, exporting a 50 fps video at 4K and similar sizes failed with "No encoder found". The frame rate is only a hint for bitrate allocation, so
     the app reports 30 fps with the bitrate scaled by 30/50, and actually feeds 50 fps. 10 s of 4K (3840×2160) HEVC at 50 fps exported in 8 s
   - The final bitrate comes out 20–30% higher than requested (40 Mbps requested at 1080p → about 51 Mbps; about 50 Mbps at 4K; an encoder quirk)
   - The encoder configurations this PC supports can be probed with the autotest's `encprobe` mode (combinations of size, codec, hardware, bitrate and frame rate)

Edits are saved automatically to `<video name>.insv.motorecomovie.json` in the same folder as the video and restored the next time you open it (if only `<video name>.insv.reframe.json` from the old name exists, that is read and saving goes to the new name. The old file is not deleted).

### Keyboard shortcuts

| Key | Action |
|---|---|
| Space | Play / pause (with audio; during playback the video follows the audio clock) |
| M | Mute |
| ← / → | Step one frame (one second with Shift) |
| ↑ / ↓ | Next / previous keyframe |
| K / Delete | Add / delete keyframe |
| I / O | Set export start / end to the current position |
| Home / End | Go to start / end |
| B | Add a marker |
| G | Show / hide the layout guides (crosshair and diagonals) together |
| Ctrl+Z / Ctrl+Y | Undo / redo (continuous changes within 0.5 s, such as a drag, count as one step) |

## Audio (cleaning up riding sound)

"Audio" in the right panel. It cleans up the sound for preview and export (on by default. `core/audiofx.ts`, `engine/audiofx.ts`).
The Insta360 microphones hit the amplitude ceiling at full throttle (X6, 2026-10-11 at 15:04 and elsewhere), and pick up broadband hiss from rain, spray and wind
(on a rainy day with the X5, 2026-08-13, the engine harmonics are barely visible). Left and right are the same signal (mono).

1. Repair clipping: ffmpeg's `adeclip` (rebuilds the clipped parts from the waveform on either side)
2. Reduce non-engine noise: a 4096-point (85 ms) short-time Fourier transform. Anything that sticks out 2.5× or more above the floor along the frequency axis (geometric mean of the magnitudes over ±8 bins × 1.11 = an estimate of the noise median)
   (the engine harmonic lines) is kept, and anything 1.2× or less (noise) is lowered by the set dB. Nothing below 200 Hz is lowered (at low rpm the harmonics are closer together than one bin).
   To reduce warbling (musical noise), the gain is smoothed over time as a 3-frame maximum followed by a 3-frame mean. On a synthetic signal with a 12 dB setting, the harmonics change by −0.4 dB and the noise between them by −7.7 dB
   (`test/audiofx.test.ts`). ffmpeg's `afftdn` was tried too, but on the rainy-day X5 footage it removed the engine harmonics as well
3. Cut high frequencies (default 2000 Hz, 0 = off; chosen by listening against 1500 Hz): two stages of a 2nd-order lowpass (4th order in total). When cruising with a quiet exhaust, the 2–8 kHz hiss from wind and road noise
   (it sounds like running water) stands out. The exhaust sound sits at 120–500 Hz and its harmonics are visible only up to 1.5 kHz (X6, 2026-09-19 at 13:49; the 2–4 kHz band was stronger than 1–2 kHz)
4. Tame loud parts: compressor (3:1 above the threshold) → limiter (peak −1 dBFS)

20 s around 15:04 on the X6: per-second level −13 to −1.6 dBFS (peak 1.06) → −16 to −9.9 dBFS (peak 0.55). Offset from the video 5 ms.
Audio for comparison: `testdata/audio/` (original / cleaned up. 0919 from 13:39 (lowpass at 1500 Hz and 2000 Hz) and 1011 from 14:55).

"Cut high frequencies" and "Tame loud parts" are applied during playback (`Dynamics` in `core/audiofx.ts`: two-stage 2nd-order Butterworth lowpass → RMS 50 ms compressor
(3:1, attack 10 ms, release 250 ms, 40% of the gain reduction made up) → 5 ms look-ahead limiter (the minimum required gain over the last 5 ms, averaged over 5 ms, so peaks always stay at −1 dBFS or below)).
In the preview they are applied to the decoded audio (0.5 s look-ahead, so setting changes are heard within 0.5 s); on export the same processing is applied to the audio of the range and encoded to AAC (the same sound as the preview).
Only "Repair clipping" and "Reduce non-engine noise" are heavy, so they are built in the background after a video opens and after their settings change (about 2 min for a 23-min video: extraction and declipping 67 s,
noise 20 s, AAC 31 s) and stored in the app cache (`cache/audio-<video>-<settings>.m4a` in the user data folder, saved at 0.5× so declipping does not push it above 1).
Until it is ready, the video's own audio is played with only "Cut high frequencies" and "Tame loud parts" applied.
Noise suppression runs on the analysis thread in 20 s chunks (with margins on both sides). Chunk boundaries are multiples of the Fourier transform hop size, so the sound does not change at the joins.

## Help text in the right panel

The help text for an item appears just below it, only while the mouse is over that item (row or slider) (`.side div.note`). Status messages such as progress and "There is no vehicle log, so…" use
`.note.status` and warnings use `.note.warn`; both are always shown.

## Distribution (licenses)

The app is meant to be distributed free of charge for non-commercial use. `npm run dist` puts the following into the package (`build` in `package.json`).

- **ffmpeg**: `app/resources/ffmpeg` (`ffmpeg-n9.0-latest-win64-lgpl-shared-9.0.zip` from BtbN/FFmpeg-Builds, 2026-10-19, SHA-256 c1d4b629…, LGPL v3.
  Only ffmpeg.exe and the DLLs; ffplay and ffprobe are left out) goes into `resources/ffmpeg` in the package. The app runs the bundled copy as a separate process
  (falling back to ffmpeg on the PATH if it is missing; `ffmpegPath` in `src/main/index.ts`). The gyan.dev essentials build used locally (GPL, includes x264 and others) is not distributed
- **License notices**: `tools/notices.ts` generates `build/THIRD-PARTY-NOTICES.txt`, which is placed in the same folder as the app in the package. Open it from "Help › License information…" in the menu.
  Contents: ffmpeg (version, source location, full texts of LGPL v3 and GPL v3), the AI models (`models/NOTICE.md`, notes on training data, full texts of MIT and Apache 2.0),
  MotoRecoViewer (MIT), the npm packages bundled into the app (20, excluding type-definition-only packages), Electron and Chromium (LICENSE.electron.txt and LICENSES.chromium.html in the same folder)
- **Version**: "Help › About MotoRecoMovie…" shows the app's version (`version` in `app/package.json`), the Electron / Chromium / Node.js versions it runs on, the license and a button that opens the GitHub repository.
- **AI models**: the code and weights are MIT and Apache 2.0, but much of the training data (Places2, KITTI, Sintel and others) is restricted to research or non-commercial use. Review this before any commercial distribution

Package size: win-unpacked 842 MB, installer 418 MB (including ffmpeg 150 MB and the AI models 280 MB).

## Without a vehicle log

Auto camera, floating signs and the horizon correction (Keep lean) work without a vehicle log, using values estimated from the video's IMU (gyro and accelerometer)
(`core/imu-telemetry.ts`; 0.3–0.5 s on the analysis thread when the video opens). Even when there is a log, this estimate is used if the log is disabled.
It is not used for gauges, the map or Chassis disturbance (so that estimated speed and the like are not presented as if measured; these still show "no log" as before).

| Value | How it is estimated |
|---|---|
| Lean angle | Integrate the rotation about the forward axis (gyro), and find and subtract the drift where the bike runs straight (not turning = lean should be 0) |
| Turn rate | Rotation about up ÷ cos(lean) |
| Vehicle speed | In corners, v = g·tan(lean)·0.86 / turn rate (a bike leans in the direction of the resultant of the cornering force and gravity; because of the tire width the bike leans a little deeper than the theory, hence the factor 0.86). In between, it is accumulated from the longitudinal acceleration, and set to 0 while stopped (forward-backward symmetric Kalman smoothing) |
| Longitudinal G | The forward component of the camera's acceleration × 0.87 (for the mount's give), minus the slow 20 s trend (slopes) |
| Stopped | Gyro including vibration (2 s RMS) at or below 16°/s, fine shake (0.3 s mean) at or below 4.5°/s, and not turning |
| Path ridden | Heading from the integrated turn rate and position accumulated from the speed (without GPS it does not line up with a map; used only to place signs) |

The riding state (`core/riding.ts`) has no throttle record to go on, so acceleration is judged from the longitudinal G alone. Corners and curve radius (`core/corners.ts`) use the same processing as with a log.

Compared with telemetry built from the vehicle log (`test/imu-telemetry.test.ts`):

| Video | Lean angle error | Speed error | Riding state agreement | Corners (found) | Curve radius ratio (median) |
|---|---|---|---|---|---|
| 0919 Soya Hills | 1.6° | 12 km/h | 84% | 109/110 | 1.03 |
| 1011 Shiretoko, 2nd clip | 1.6° | 8 km/h | 85% | 83/92 | 1.00 |
| 0906 Shikaribetsu | 1.6° | 7 km/h | 80% | 164/172 | 1.09 |
| 1011 Shiretoko, 3rd clip | 1.1° | 19 km/h | 71% | 14/17 | 1.00 |

- Most riding state mismatches come from gentle acceleration (0.05–0.08 G) being counted as accelerating or not, and from slow riding (under 20 km/h) being counted as stopped.
  Most of the "stopped instead of cruise" cases in the 1011 Shiretoko 3rd clip are stretches the log did not record (where the ground truth cannot be judged)
- On long straights, speed drifts off because errors accumulate in the integrated acceleration. Floating sign positions (25 m before the corner entry and so on) shift by the same amount
- There is no GPS elevation, so signs beyond a crest are not hidden (the sightline check only covers lines of sight that pass far from the path ridden)

## Layout

```
app/src/
  main/        Electron main process (dialogs, running ffmpeg, recent.json history of opened videos, main menu)
  preload/     random access to huge files, file saving
  renderer/src/
    core/      computation (no DOM dependency; can be tested in Node from test/)
      mp4.ts        MP4 demuxer (reads only the sample tables in moov)
      insv.ts       trailer (metadata, IMU, frame timestamps, calibration)
      lens.ts       lens model (Mei + RadtanPro, 13 terms)
      motion.ts     gyro integration, mount estimate (one for the whole video), per-axis smoothing, rotation during readout
      mount.ts      camera mount orientation over time (forward = direction of travel, up = top of the upright bike; refined with the log)
      motoreco.ts   vehicle log loading, sync (FFT cross-correlation + per-window refinement), lean fusion (RTS)
      motoreco-dat.ts  decodes MotoReco .dat with .ddf rules (port of MotoRecoViewer; produces the same table as the CSV), roll rate for matching against the video
      telemetry.ts  100 Hz telemetry aligned to video time (docs/telemetry.md)
      imu-telemetry.ts  telemetry estimated from the video IMU when there is no vehicle log (lean angle, vehicle speed, longitudinal G, path ridden)
      riding.ts     riding state detection (cruise, accelerating, braking, cornering, stopped) and weights for switching the look
      nav.ts        heading and position fusion (gyro + front wheel speed + GPS)
      corners.ts    corner detection and curve radius estimation (route before and after the entry; chooses sign positions)
      sightline.ts  whether a floating sign can be seen from the current position (from the position and elevation of the road ridden)
      lanes.ts      which side of the center line you are riding on, from the video (yellow line, spread of the road), and lane-crossing stretches
      vehicles.ts   pre- and post-processing for vehicle detection (YOLOX-Nano), and direction as seen from the bike
      overtake.ts   lane-crossing stretches where a vehicle passes right beside you on the overtaking side = overtakes
      seamfit.ts    lens seam alignment (estimates lens 1's edge angle and rotation in the overlap band)
      bodymap.ts    body seam template (median of band images, parts that do not change over time, cut, storage format)
      audiofx.ts    cleaning up riding sound (noise suppression that keeps the harmonics, taming loud parts, ffmpeg filters)
      disturb.ts    chassis disturbance strength (slip ratio, 6-axis, suspension stroke) and events
      dsp.ts / quat.ts
    engine/    decoder, per-frame view computation, player, audio, export, project (layers),
               director.ts (auto camera: shots → keyframes), incident.ts (split screen during disturbances),
               detector.ts (runs the vehicle detection model with onnxruntime-web; the model is public/models/yolox_nano.onnx),
               analysis Web Worker (analysis.worker.ts: log loading, sync, fusion, telemetry)
    render/    WebGL2 shaders (stitching, RS correction, blending), compositor.ts (compositing view layers + overlays;
               shared by preview and export), overlay.ts (overlay widgets),
               meters.ts (shared types and colors for overlays; the individual gauges and the gauge cluster were removed on 2026-10-20), chrono.ts (chronograph gauges), cyber.ts (cyber gauges),
               gps.ts (map, elevation, compass tape), signs.ts (floating corner signs), projection.ts (output projection: perspective → stereographic)
    ui/        React UI
  test/        core.test.ts (checked against the Python version on real data), project.test.ts
```

For the reasoning behind the calculations and the validation results, see [insv-x6-format.md](insv-x6-format.md), [motoreco-lean.md](motoreco-lean.md), [motoreco-dat.md](motoreco-dat.md) and [telemetry.md](telemetry.md).

Project files are v2 (layer structure). v1 files (a single view) are converted automatically to a single full-screen view layer when opened.
`proto/` holds the Python prototypes used for validation.

## Tests

```bash
npx tsx test/project.test.ts
npx tsx test/layout.test.ts
npx tsx test/director.test.ts [<.insv> <MotoReco .csv>]
npx tsx test/view.test.ts <.insv> <MotoReco .csv>
npx tsx test/corners.test.ts <.insv> <MotoReco .csv>
npx tsx test/signview.test.ts <.insv> <MotoReco .csv>
npx tsx test/seamfit.test.ts <.insv>          # reads frames with ffmpeg
npx tsx test/seamdepth.test.ts
npx tsx test/sightline.test.ts
npx tsx test/overtake.test.ts
npx tsx test/cyber.test.ts [<.insv> <MotoReco .csv>]
npx tsx test/settings.test.ts
npx tsx test/mount.test.ts
npx tsx test/mount-log.test.ts <.insv> <.dat> <.ddf>   # REFINE=1 for the log-refined result
npx tsx test/imu-telemetry.test.ts <.insv> <.dat|.csv> [<.ddf>]   # compares the no-log estimate with the log
npx tsx test/signtilt.test.ts <.insv> <.dat|.csv> [<.ddf>]   # floating sign tilt vs. the gravity direction from the accelerometer
npx tsx test/i18n.test.ts
npx tsx test/disturb.test.ts [<.insv> <MotoReco .csv>]
npx tsx test/core.test.ts <.insv> <MotoReco .csv>
npx tsx test/telemetry.test.ts <.insv> <MotoReco .csv>
npx tsx test/riding.test.ts <.insv> <MotoReco .csv>
npx tsx test/motoreco-dat.test.ts [<.dat> <.ddf> <MotoReco .csv> [<.insv> more .dat…]]
npm run typecheck
```

Tools (`app/tools/`):

```bash
npx tsx tools/cut-insv.ts <source .insv> <start [s]> <length [s]> <output .insv>   # cuts a short clip from an .insv (opens in the app as is)
npx tsx tools/seam-cases.ts make|render [id...]                         # builds / renders the seam scene collection (testdata/seam)
```

In jobs of the render autotest (`REFRAME_AUTOTEST=render`), the view can be given directly as a matrix in rig coordinates (`rigView`) and a gravity direction (`rigDown`) (printed by `printView`).
This is used to render the same view from a cut clip as from the original video. Other options: `rs: false` (no rolling shutter correction), `cut: false` (do not move the cut),
`debug: 1/2/3/4` (lens 0 only, lens 1 only, blend band, seam distance), `seamQ` (fixed seam distance), `seamIters` (number of seam re-solves, e.g. 1 as right after a seek).
The render argument `imuLean: true` uses the no-log estimated lean angle, and `logOff: true` simulates "log loaded but disabled".
The `ui` mode steps `{ seamDebug: n }` and `{ seamCut: false }` apply the same debug views and switches to the app's own rendering (from the next frame drawn).

The UI can be driven automatically with the environment variable `REFRAME_AUTOTEST` (`src/renderer/src/autotest.ts`). Example: in `ui` mode, open, seek, edit, close, export and take screenshots in sequence.
During an autotest the user data folder is switched to a temporary folder, so your normal history is not touched. Edits next to the video (`.motorecomovie.json`, `.reframe.json`) are only read, never written.
In `render` mode, `gyroShiftMs` shifts the correction from frame time to gyro time (for checking stabilization timing). `body: { source, from, to, offset }` builds and uses a body seam template (job option `bodyOff: true` disables it). `band` mode writes out band images (`ranges: [[start, end, count]…]`). In `ui` mode, `{bodyRange: [start, end]}` limits the range the template is built from, and `{until: 'body'}` waits until the template is ready.
`render` mode renders the given times to PNG. To inspect the seam, use the job options `debug: 4` (seam band and distance colors), `groundDump: true` (ground distance, texture and match per bin),
`probeBins: [bin…]` (mismatch of every candidate for those bins), and `pixelBins: [[x, y]…]` (which seam bin an output pixel falls in and how many degrees it is from the seam).

## Display language (Japanese / English)

- Switch between Japanese and English at the right end of the toolbar. The choice is remembered on this PC (the OS language is used the first time). The main menu (File, Edit, View, Window, Settings, Help) follows the same language
- Text drawn into the video (the disturbance label and indicator names, "No vehicle log", readout labels, and the no-data messages for map, elevation and compass tape) is chosen with "Text in video" in the Export section (Same as app / Japanese / English). You can make an English video while keeping the UI in Japanese
- Layer names: default names (Main, Back, Cyber gauges, View 2 and so on) are shown in the current language whichever language they were created in. Names you typed yourself stay as they are
- How it works: UI strings are written in English in the source and wrapped in `t('English')` (UI language) or `tr(lang, 'English')` (text in the video). Japanese comes from the dictionaries in `src/renderer/src/i18n/ja-*.ts` (English → Japanese). Interpolation looks like `t('{n} items', { n })`. Name tables (widgets, shots, disturbance indicators and so on) hold the English names and are translated where they are displayed (the table rows carry `// i18n-ignore`)
- `test/i18n.test.ts` checks for missing dictionary entries, mismatched placeholder names, Japanese left in keys, and Japanese left anywhere in the source outside the Japanese dictionaries

## Export speed

- 10 s (500 frames) at 1920×1080 HEVC takes about 6 s (about 1.7× real time). Per frame: decoding about 3.5 ms, rendering about 3 ms (including about 1.3 ms for dynamic stitching)
- At the end of an export, a per-frame time breakdown and decoder statistics (how many times decoding restarted from a keyframe, why, and how many frames were decoded but discarded) are written to the log
- Exports used to become extremely slow now and then (235 ms per frame). The cause was the decoder discarding frames "two or more before the position just output" too early: hardware decoders sometimes output several frames at once, and when the consumer fell slightly behind (shader warm-up during the first export after opening a video, for example) it discarded frames that were still needed, setting off a chain of restarts from keyframes. Now only frames "before the requested position" are discarded (`engine/decoder.ts`)

## Known limitations

- Supports the X6 (calibration V6; the IMU axis mapping was measured on the X6). Axis and timing corrections may not match on other models
- Output is perspective projection only (projections such as little planet are not supported)
- MotoReco logs were tested with "TO Custom v1" CSV files and with .dat files from an R1200GS (K51) with BMW.ddf. The .dat decoder is a port of the MotoRecoViewer source, and its output matches the CSV that MotoRecoViewer produces from the same .dat in every column and row

## Removed features

- Route commentary (captions gathered from Wikipedia and geological maps) was removed because it will be added by a separate tool (2026-10-19). Commentary and "route commentary (captions)" layers left in old projects are discarded when the project is opened
