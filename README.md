# MotoRecoMovie

A Windows app that reframes 360° videos (.insv) shot with an Insta360 X6 / X5 into regular videos, made for motorcycle onboard footage.
The app is available in English and Japanese (switch with the language selector in the toolbar).

Even with the video alone, the app estimates how you rode from the gyro and accelerometer data recorded by the camera, and can do the following.
If you also load a MotoReco vehicle log (.dat / CSV), the lean angle and speed become more accurate, and meters and maps become available.

| Feature | Video only | With vehicle log |
|---|---|---|
| Stabilization without horizon lock (choose how much of the lean to keep) | ✓ (lean estimated from the video) | ✓ |
| Switch views with keyframes, split screen | ✓ | ✓ |
| Align the seam between the front and back lenses | ✓ | ✓ |
| Auto camera (corners, cruise, stops, overtakes) | ✓ (riding state estimated from the video) | ✓ |
| Floating corner signs (curve radius) | ✓ (position estimated from the video) | ✓ |
| Clean up the riding sound (repair clipping, suppress non-engine noise, cut highs, compress loud parts) | ✓ | ✓ |
| Chronograph-style and cyber-style meters, data readout | – | ✓ |
| Map, elevation and compass (GPS) | – | ✓ |
| Automatic split screen on chassis disturbances | – | ✓ |

How to use it and how it works is described in [docs/app.md](docs/app.md).

## Installation

### Download (recommended)

1. Open the [Releases page](https://github.com/SchwarzeLanzenreiter/MotoRecoMovie/releases/latest)
2. Under "Assets", download one of these (420–490 MB)
   - **Install it**: open `MotoRecoMovie-Setup-<version>.exe` to start the installer. When it finishes, "MotoRecoMovie" appears on the desktop and in the Start menu
   - **Use it without installing**: right-click `MotoRecoMovie-<version>-win-x64.zip`, choose "Extract All", and open `MotoRecoMovie.exe` inside. You can move the whole folder anywhere you like

It runs on Windows 10 / 11 (64-bit) and takes about 850 MB once installed.
The integrated graphics of an ordinary PC works, but export and the AI processing are faster with a better GPU.

The first time you open it, Windows may show "Windows protected your PC" (the app is not signed with a publisher certificate).
In that case, click "More info" and then "Run anyway".

### Build it yourself

You can also build the app from source on your own PC (once, about 20–30 minutes).
If you follow the steps below, no programming knowledge is needed.

#### What you need

- Windows 10 / 11 (64-bit)
- About 4 GB of free disk space (including files used while building; the finished app is about 850 MB)
- An internet connection (about 1 GB of downloads)
- A GPU. The integrated graphics of an ordinary PC works, but export and the AI processing are faster with a better GPU

#### 1. Install Node.js

1. Open [https://nodejs.org/](https://nodejs.org/) and download the installer marked "LTS" (for Windows)
2. Open the downloaded file and click "Next" through the installer (the default settings are fine)

#### 2. Download this app's files

1. Click the green "Code" button at the top of this page and choose "Download ZIP"
2. Right-click the downloaded ZIP, choose "Extract All", and extract it to a place that is easy to find (for example `C:\MotoRecoMovie`)

(If you use Git, `git clone https://github.com/SchwarzeLanzenreiter/MotoRecoMovie.git` works too.)

#### 3. Build the app

1. Open the `app` folder inside the extracted folder
2. Click the address bar at the top of File Explorer (where the folder path is shown), type `cmd` and press Enter. A black window (Command Prompt) opens
3. Paste the following three commands one at a time and press Enter. Wait until each one finishes (until you can type again) before moving on

   ```bat
   npm ci
   ```

   Installs the parts the app needs (a few minutes).

   ```bat
   npm run fetch-assets
   ```

   Downloads the AI models and ffmpeg, which is used for audio processing (about 430 MB in total; it ends with "Done.").

   ```bat
   npm run dist
   ```

   Builds the app (a few minutes).

   Warnings in red may appear along the way; that is fine as long as it runs to the end. If it stops, copy the text it printed and let us know in Issues.

#### 4. Open the app

The `app\dist` folder now contains two things. Use whichever you like.

- **Install it**: open `MotoRecoMovie Setup 0.1.4.exe` to start the installer. When it finishes, "MotoRecoMovie" appears on the desktop and in the Start menu
- **Use it without installing**: open `MotoRecoMovie.exe` in the `win-unpacked` folder. You can move the whole folder anywhere you like

The first time you open it, Windows may show "Windows protected your PC" (the app is not signed with a publisher certificate).
In that case, click "More info" and then "Run anyway".

### Getting started

1. Open an .insv file with "File › Open…" (an X6 / X5 video whose file name contains `_00_`)
2. For a video opened for the first time, the app aligns the lens seam and cleans up the sound in the background (1–3 minutes depending on the length). You can preview and edit in the meantime
3. If you have a vehicle log, load it from "Vehicle log (MotoReco)" in the right-hand panel. CSV files in the same folder as the video are found automatically
4. Hover over an item in the right-hand panel to see what it does

### Updating to a new version

- **If you downloaded it**: download the new version from the Releases page and run the installer (for the zip, replace the extracted folder)
- **If you built it yourself**: download again from this page (or `git pull` if you use Git) and repeat "3. Build the app". `npm run fetch-assets` does not download files that are already there

## For developers

Run `npm run dev` in the `app` folder to start the app in development mode (the window updates when you change the source). Tests are in `app/test`.

| Folder | Contents |
|---|---|
| `app/` | The app (`src/main` Electron main process, `src/preload`, `src/renderer` UI and processing), `test/`, `tools/` |
| `docs/` | How things work and research notes. The .insv contents are in [insv-x6-format.md](docs/insv-x6-format.md); MotoReco logs in [telemetry.md](docs/telemetry.md), [motoreco-dat.md](docs/motoreco-dat.md) and [motoreco-lean.md](docs/motoreco-lean.md) |
| `proto/` | Python prototypes (.insv reading, lens model, sync, lean angle fusion) |

UI strings are written in English in the source and wrapped in `t('…')`; the Japanese translations are in `app/src/renderer/src/i18n/ja-*.ts`. `test/i18n.test.ts` checks for missing translations.

## License

The source code of this app is under the MIT License ([LICENSE](LICENSE)).

Licenses of software and data made by others (ffmpeg, AI models, npm packages, Electron, etc.) are collected in
"Help › License information…" in the app's menu (`THIRD-PARTY-NOTICES.txt`, generated by `npm run notices` and placed next to the app in the distribution).
Some of the AI models were trained on data licensed for research / non-commercial use only, so please use this app free of charge and non-commercially.
