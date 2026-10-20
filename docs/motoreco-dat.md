# Reading MotoReco .dat files directly (the .ddf conversion rules)

The `.dat` recorded by the logger can be read as is, without converting it to CSV in MotoRecoViewer.
Specify the same `.ddf` that MotoRecoViewer uses for the conversion rules. The decoded result is a table with the same column names and the same 10ms steps as MotoRecoViewer's CSV ("TO Custom v1"),
and from there synchronization, lean angle fusion and telemetry go through the same processing as with CSV.

Implementation: `app/src/renderer/src/core/motoreco-dat.ts`. The built-in rule formulas and the steps up to the table are ported from the MotoRecoViewer source (`E:\Claude\MotoRecoViewer`):

| MotoRecoViewer | contents |
|---|---|
| `DecodeRule.cs` (`FixedFormula`, `DecodeFormula`) | Built-in rule formulas, substitution in hand-written formulas |
| `FormMain.Data.cs` (`ReadCANData`) | Per-record decoding → sorting → smoothing → post-processing |
| `Model/ChData.cs` (`Sort`, `FilterData`, `Butterworth`, `FindLeftIndex`) | Sorting, smoothing, time lookup |
| `Analysis/ChannelAnalyzer.cs` | Accumulated distance, fuel consumed, fuel economy, range |
| `FormMain.Export.cs` (`ConvertDecodeData`) | The CSV table at every 10ms |

Verification: `app/test/motoreco-dat.test.ts`. On the 25-minute ride of 2026-09-19 (the CSV converted from `20260919_143356.dat` with BMW.ddf), **all 40 columns × 150,093 rows match** (the differences are decimal rounding of about 1e-13).

## .dat format

Just a sequence of 16-byte records (no header). All numbers are little-endian.

| bytes | contents |
|---|---|
| 0–3 | Seconds since the start of recording (u32) |
| 4–5 | Milliseconds (u16) |
| 6–7 | CAN ID (u16). GPS uses the pseudo IDs 7FE (speed, altitude) and 7FF (latitude, longitude) |
| 8–15 | 8 bytes of data (Data1 to Data8) |

- The recording start time is in the file name (`YYYYMMDD_HHMMSS.dat`, the logger's clock)
- Only GPS records are written a little late, so the time can go backward relative to the previous record (up to 1.9 seconds)
- Period per ID: 10C, 110, 120, 174, 178, 17C, 290, 293, 29C and 2D0 are 10ms; 2BC, 2B0 and others are 100ms; 3F8 and 3FA are 1 second; GPS is 1 second

## Steps up to the table (same as MotoRecoViewer)

1. For each record, compute the value with the rule for its CAN ID (a row of the .ddf). Time = seconds + milliseconds/1000
2. Sort each column by time (equal times keep the file order; late GPS records also fall into the right place here)
3. Columns whose 9th field in the `.ddf` is True are smoothed with the cutoff frequency [Hz] in the 10th field (see below)
4. Compute accumulated distance, fuel consumed, fuel economy and range from the decoded values (see below)
5. For each time obtained by adding 0.01 seconds at a time from the time of the **first record** in the file (up to just before the time of the last record in the file),
   list the value of the latest record at or before that time. Rows before the first record take the first value. Columns for IDs that never send data are not created
   - Since the time is built by repeatedly adding 0.01, floating-point error makes it slightly smaller (the 200-second row is 199.99999…). So a record at exactly a row's time is reflected from the next row. This is reproduced too
   - The CSV's `time (ms)` is "an integer of time × 1000"

### Smoothing

A 2nd-order Butterworth applied twice, forward and backward (no phase delay). A port of `ChData.Butterworth`:

- The sample interval is the average interval of the first 100 records of that column
- Both ends are extended by 2 points with the end values before filtering. The last point is not smoothed
- It is applied to the record sequence, not to the 10ms table

In BMW.ddf, the X/Y/Z G values and the slip rate are at 1Hz.

## .ddf format

One line is one column (a CSV column). Comma-separated.

```
name, CAN ID (hex), rule, color, min, max, show in sub chart, show in main chart, smoothing True/False, cutoff [Hz]
Example: X_Axis_G,178,#BMW_XAxisG,-8355840,-2,2,False,True,True,1
```

Old .ddf files have 8 columns (no smoothing column), in which case no smoothing is applied.

There are two kinds of rules:

- **Formula**: `Data1` to `Data8` (that byte), `LoData1` to `LoData8` (low 4 bits), `HiData1` to `HiData8` (high 4 bits), numbers, `+ - * /`, parentheses
  (e.g. `(LoData4*255+Data3)*4`, `Data5*90/128`). Division is real-valued (same as MotoRecoViewer's `DataTable.Compute`)
- **Built-in**: a name starting with `#` (table below). `#Data1` to `#Data8`, `#HiData1` and up, and `#LoData1` and up also exist

## Built-in rules

`D1` to `D8` are bytes, `Lo`/`Hi` are the low/high 4 bits, and `U32(n)` is 4 little-endian bytes starting at Dn.

| rule | ID | formula |
|---|---|---|
| `#BMW_RPM` | 10C | (Lo4·256 + D3)·5 |
| `#BMW_ThrottelValvePosition` | 10C | D6/255·100 |
| `#BMW_ThrottelPosition` | 10C | D8/255·100 |
| `#BMW_ThrottelGripPosition` | 110 | D6/255·100 |
| `#BMW_LeanAngle` | 10C | D5·90/127 − 90 |
| `#BMW_FrBrake1` / `#BMW_FrBrake2` | 120 | D3/4 / D5/4 |
| `#BMW_RrBrake1` / `#BMW_RrBrake2` | 120 | D4/2 / D6/2 |
| `#BMW_FrStroke` | 29C | (Lo7·256 + D6)/5 |
| `#BMW_RrStroke` | 29C | (D8·16 + Hi7)/3 |
| `#BMW_FrSpeed1` | 293 | (Lo5·256 + D4)/8 |
| `#BMW_FrSpeed2` | 293 | (D3·16 + Hi2)/8 |
| `#BMW_RrSpeed` | 293 | (Lo2·256 + D1)/8 |
| `#BMW_SlipRate` | 293 | RrSpeed/FrSpeed1·100 − 100 (0 when the front wheel speed is 0) |
| `#BMW_Gear` | 2BC | Hi6 of 1, 4, 7, 8, 11, 13 → gears 1 to 6; anything else is 0 |
| `#BMW_RollRate` / `#BMW_YawRate` | 178 / 174 | D2·125/127 + D1/255 − 125 [deg/s] (−125 is an invalid value) |
| `#BMW_XAxisG` / `#BMW_YAxisG` / `#BMW_ZAxisG` | 178 / 174 / 17C | (D6 + D5/255 − 128)/32 [G] |
| `#BMW_AirTemp` | 3FA | D1·0.75 − 48 |
| `#BMW_OilTemp` | 3FA | D2 − 25 |
| `#BMW_WaterTemp` | 2BC | D3·0.76 − 25 |
| `#BMW_FuelLevel` | 2D0 | (D2·256 + D1)/562·100 [%] |
| `#BMW_OdMeter` | 3F8 | D4·65536 + D3·256 + D2 [km] |
| `#BMW_DistCountFr` | 2B0 | Lo5·253 + D4 |
| `#BMW_DistCountRr` | 2B0 | D3 |
| `#BMW_FuelCount` | 2BC | D5·256 + D4 |
| `#GPS_Latitude` | 7FF | (U32(5) − 90000000)/10⁶ |
| `#GPS_Longitude` | 7FF | (U32(1) − 180000000)/10⁶ |
| `#GPS_Speed` | 7FE | U32(5)/10⁶·3.6 [km/h] (the logger records m/s × 10⁶) |
| `#GPS_Altitude` | 7FE | (U32(1) − 10000000)/10⁴ [m] (a .dat recorded with the old spec "altitude·10⁶ + 10⁹" can't be read correctly) |

### Rules computed in post-processing (accumulations etc.)

At decode time they are 0; after all the records are lined up, they are computed from the source columns in the same .ddf (if the source column is not in the .ddf they stay 0).
All of them are computed per record (before building the 10ms table).

| rule | source column | calculation |
|---|---|---|
| `#GPS_Distance` | `#GPS_Speed` | For each record, add "that speed × time since the previous record" [km] |
| `#BMW_DistFrSpeed1` | `#BMW_FrSpeed1` | Same [km] |
| `#BMW_AccumulatedDistCountFr` | `#BMW_DistCountFr` | Add the counter increments and multiply by 0.000255 [km]. If the increment is below −3900 it is a wraparound (+3951); any other decrease is 0 |
| `#BMW_AccumulatedDistCountRr` | `#BMW_DistCountRr` | Same, ×0.004 [km]. +255 if below −250 |
| `#BMW_AccumulatedFuelCount` | `#BMW_FuelCount` | Same, ÷10⁶ [L]. +65536 if below −65000 |
| `#BMW_FuelConsumption` | the two above | At each time of an accumulated fuel record, accumulated distance (front wheel counter) / accumulated fuel [km/L] (0 if fuel is 0) |
| `#BMW_Range` | fuel economy, `#BMW_FuelLevel` | At each time of a fuel economy record, 30L × fuel remaining/100 × fuel economy [km] (0 if fuel economy is 0) |

### Intentional differences from MotoRecoViewer

- `#K51_*` is treated the same as `#BMW_*` (an old way of writing .ddf; the current MotoRecoViewer doesn't know it and gives 0)
- Unknown built-in rules are skipped without creating a column of 0s, and the screen shows "{n} rules cannot be decoded (those columns are skipped)"
- If smoothing is specified for a column computed in post-processing, MotoRecoViewer smooths before post-processing and gets 0, but here the value after post-processing is smoothed
- If the .ddf has two columns with the same name, the second and later ones become separate columns such as "name (2)"
- `LeanAngle` (10C) and `RollRate` (178) are always needed for synchronizing with the video, so they are read with the built-in rules even if the .ddf lacks them
- Columns of built-in rules can be looked up both by the name in the .ddf and by the BMW.ddf column names (`lat (deg)`, `Speed`, etc.) (the app reads them by those names)

## Choosing the .dat that matches the video from a folder

Done with "Find in folder" under "Vehicle log (MotoReco)" in the side panel, or automatically when a video is opened (the project has no log, there is no CSV in the same folder as the video, and the .dat folder and .ddf are set).

1. Collect the `.dat` files in the folder and in folders up to 2 levels below it (a per-year folder such as `CAN Log\2026\…` can be specified as is)
2. Narrow by time: from the time and length of the video file name (`VID_YYYYMMDD_HHMMSS`, the camera's clock) and the time and length of the .dat file name (the time of the last record in the file),
   compute the gap in time overlap and order by closeness.
   The logger and camera clocks can differ by tens of minutes (an actual case: 25 minutes), so first take 8 within 2 hours, then 12 within 1 day if none is found, and widen by another 6
3. Matching: read only the roll rate of each .dat and take the full-range cross-correlation with the roll angular velocity of the video's gyro. The guide is "main peak / second peak" (same as the sync confidence).
   If it is 3 or more, decide on the spot; otherwise take the largest among the candidates and accept it if it is 1.5 or more

Actual example (`VID_20260919_140847`, a 25-minute video): `20260919_143356.dat` of the same ride gives 3.56, other rides on the same day 1.00 to 1.16, and the next day's ride 1.07.
In this example it was decided at the 2nd file, and loading took about 1 second.

The settings (the .dat folder and .ddf) are remembered on this PC (localStorage `reframe.logPrefs`).
The .ddf used when the .dat was read is also recorded in the project (`ddfPath`) and used to read it again the next time it is opened.

## How to verify

```bash
cd app
npx tsx test/motoreco-dat.test.ts                                 # checks the formulas + compares CSV on every column and row against the default real data (if present)
npx tsx test/motoreco-dat.test.ts <dat> <ddf> <csv> <insv> [other dat…]   # also prints the matching guide
```

`proto/motoreco_check.py` is a tool from when the formulas were inferred from the CSV before looking at the source (`check(column name, ID, formula)` prints the match rate).
