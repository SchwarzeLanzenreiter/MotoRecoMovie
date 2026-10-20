# MotoReco の .dat を直接読む（.ddf の変換規則）

MotoRecoViewer で CSV に変換しなくても、ロガーが記録した `.dat` をそのまま読める。
変換規則は MotoRecoViewer と同じ `.ddf` を指定する。デコード結果は MotoRecoViewer の CSV（"TO Custom v1"）と同じ列名・同じ 10ms 刻みの表になり、
その後の同期・リーン角の融合・テレメトリーは CSV のときと同じ処理を通る。

実装: `app/src/renderer/src/core/motoreco-dat.ts`。組み込みの規則の式と、表にするまでの手順は MotoRecoViewer のソース（`E:\Claude\MotoRecoViewer`）の移植:

| MotoRecoViewer | 内容 |
|---|---|
| `DecodeRule.cs`（`FixedFormula`・`DecodeFormula`） | 組み込みの規則の式、手書きの式の置き換え |
| `FormMain.Data.cs`（`ReadCANData`） | レコードごとのデコード → 並べ替え → 平滑化 → 後処理 |
| `Model/ChData.cs`（`Sort`・`FilterData`・`Butterworth`・`FindLeftIndex`） | 並べ替え・平滑化・時刻の検索 |
| `Analysis/ChannelAnalyzer.cs` | 積算距離・消費燃料・燃費・走行可能距離 |
| `FormMain.Export.cs`（`ConvertDecodeData`） | 10ms ごとの CSV の表 |

確認: `app/test/motoreco-dat.test.ts`。2026-09-19 の 25 分の走行（`20260919_143356.dat` を BMW.ddf で変換した CSV）で、**40 列 × 150,093 行がすべて一致**（差は小数の丸めの 1e-13 程度）。

## .dat の形式

16 バイトのレコードが並んでいるだけ（ヘッダーなし）。数値はすべてリトルエンディアン。

| バイト | 内容 |
|---|---|
| 0–3 | 記録開始からの秒（u32） |
| 4–5 | ミリ秒（u16） |
| 6–7 | CAN ID（u16）。GPS は疑似 ID の 7FE（速度・標高）と 7FF（緯度・経度） |
| 8–15 | データ 8 バイト（Data1〜Data8） |

- 記録開始の時刻はファイル名（`YYYYMMDD_HHMMSS.dat`、ロガーの時計）
- GPS のレコードだけは少し遅れて書き込まれ、前のレコードより時刻が戻ることがある（最大 1.9 秒）
- ID ごとの周期: 10C・110・120・174・178・17C・290・293・29C・2D0 が 10ms、2BC・2B0 などが 100ms、3F8・3FA が 1 秒、GPS が 1 秒

## 表にするまでの手順（MotoRecoViewer と同じ）

1. レコードごとに、その CAN ID の規則（.ddf の行）で値を求める。時刻 = 秒 + ミリ秒/1000
2. 列ごとに時刻順に並べる（同じ時刻はファイルの順のまま。GPS の遅れたレコードもここで正しい位置に入る）
3. `.ddf` の 9 列目が True の列は、10 列目のカットオフ周波数 [Hz] で平滑化する（下記）
4. 積算距離・消費燃料・燃費・走行可能距離を、デコードした値から求める（下記）
5. ファイルの**最初のレコードの時刻**から 0.01 秒ずつ足した時刻ごとに（ファイルの最後のレコードの時刻の手前まで）、
   その時刻以下で最も新しいレコードの値を並べる。最初のレコードより前の行は最初の値。データの来ない ID の列は作らない
   - 時刻は 0.01 を足し続けるので、浮動小数の誤差で少しずつ小さくなる（200 秒の行は 199.99999…）。そのため行の時刻ちょうどのレコードは次の行から反映される。これも同じにしている
   - CSV の `time (ms)` は「時刻 × 1000 の整数」

### 平滑化

2 次バターワースを前向き・後ろ向きの 2 回かける（位相の遅れなし）。`ChData.Butterworth` の移植で、

- サンプルの間隔は、その列の先頭 100 レコードの間隔の平均
- 両端は端の値で 2 点ずつ延ばしてからかける。最後の 1 点は平滑化しない
- 10ms の表ではなく、レコードの列にかける

BMW.ddf では X/Y/Z の G とスリップ率が 1Hz。

## .ddf の形式

1 行が 1 列（CSV の列）。カンマ区切り。

```
名前, CAN ID（16進）, 規則, 色, 最小, 最大, サブチャートに表示, メインチャートに表示, 平滑化 True/False, カットオフ [Hz]
例: X_Axis_G,178,#BMW_XAxisG,-8355840,-2,2,False,True,True,1
```

古い .ddf は 8 列（平滑化の列なし）で、その場合は平滑化しない。

規則は 2 種類:

- **式**: `Data1`〜`Data8`（そのバイト）、`LoData1`〜`LoData8`（下位 4 ビット）、`HiData1`〜`HiData8`（上位 4 ビット）、数、`+ - * /`、括弧
  （例: `(LoData4*255+Data3)*4`、`Data5*90/128`）。割り算は実数（MotoRecoViewer の `DataTable.Compute` と同じ）
- **組み込み**: `#` で始まる名前（下の表）。`#Data1`〜`#Data8`・`#HiData1`〜・`#LoData1`〜 もある

## 組み込みの規則

`D1`〜`D8` はバイト、`Lo`/`Hi` は下位/上位 4 ビット、`U32(n)` は Dn から 4 バイトのリトルエンディアン。

| 規則 | ID | 式 |
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
| `#BMW_SlipRate` | 293 | RrSpeed/FrSpeed1·100 − 100（前輪速 0 のときは 0） |
| `#BMW_Gear` | 2BC | Hi6 が 1, 4, 7, 8, 11, 13 → 1〜6 速、それ以外は 0 |
| `#BMW_RollRate` / `#BMW_YawRate` | 178 / 174 | D2·125/127 + D1/255 − 125 [deg/s]（−125 は無効値） |
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
| `#GPS_Speed` | 7FE | U32(5)/10⁶·3.6 [km/h]（ロガーは m/s の 10⁶ 倍で記録） |
| `#GPS_Altitude` | 7FE | (U32(1) − 10000000)/10⁴ [m]（旧仕様の「標高·10⁶ + 10⁹」で記録した .dat は正しく読めない） |

### 後処理で求める規則（積算など）

デコードの時点では 0 で、全レコードを並べた後に、同じ .ddf にある元の列から求める（元の列が .ddf に無ければ 0 のまま）。
いずれもレコードごと（10ms の表にする前）に計算する。

| 規則 | 元の列 | 計算 |
|---|---|---|
| `#GPS_Distance` | `#GPS_Speed` | レコードごとに「その速度 × 前のレコードからの時間」を足す [km] |
| `#BMW_DistFrSpeed1` | `#BMW_FrSpeed1` | 同上 [km] |
| `#BMW_AccumulatedDistCountFr` | `#BMW_DistCountFr` | カウンタの増分を足して ×0.000255 [km]。増分が −3900 未満なら 1 周（+3951）、それ以外の減少は 0 |
| `#BMW_AccumulatedDistCountRr` | `#BMW_DistCountRr` | 同様に ×0.004 [km]。−250 未満なら +255 |
| `#BMW_AccumulatedFuelCount` | `#BMW_FuelCount` | 同様に ÷10⁶ [L]。−65000 未満なら +65536 |
| `#BMW_FuelConsumption` | 上の 2 つ | 積算燃料のレコードの時刻ごとに、積算距離（前輪のカウンタ）/ 積算燃料 [km/L]（燃料 0 なら 0） |
| `#BMW_Range` | 燃費・`#BMW_FuelLevel` | 燃費のレコードの時刻ごとに、30L × 燃料残量/100 × 燃費 [km]（燃費 0 なら 0） |

### MotoRecoViewer との違い（意図したもの）

- `#K51_*` は `#BMW_*` と同じに扱う（古い .ddf の書き方。今の MotoRecoViewer では知らない規則として 0 になる）
- 知らない組み込みの規則は、0 の列を作らずに飛ばし、画面に「変換できない規則が n 個あります」と出す
- 後処理で求める列に平滑化を指定した場合、MotoRecoViewer では平滑化が後処理より前に行われるので 0 になるが、こちらは後処理の後の値を平滑化する
- 同じ名前の列が .ddf に 2 つあると、2 つ目以降は「名前 (2)」のように別の列にする
- `LeanAngle`（10C）と `RollRate`（178）は、映像との同期に必ず使うので、.ddf に無くても組み込みの規則で読む
- 組み込みの規則の列は、.ddf での名前が違っても BMW.ddf の列名（`lat (deg)`・`Speed` など）でも引けるようにしている（アプリはその名前で読む）

## 映像に合う .dat をフォルダから選ぶ

サイドパネルの「車両ログ」の「フォルダから探す」、または動画を開いたとき（プロジェクトにログが無く、動画と同じフォルダに CSV も無く、.dat のフォルダと .ddf が設定してあるとき）に自動で行う。

1. フォルダとその下 2 段までのフォルダの `.dat` を集める（`CAN Log\2026\…` のような年ごとのフォルダもそのまま指定できる）
2. 時刻で絞る: 動画のファイル名（`VID_YYYYMMDD_HHMMSS`、カメラの時計）の時刻と長さ、.dat のファイル名の時刻と長さ（ファイル末尾のレコードの時刻）から、時間の重なりのすき間を求め、近い順に並べる。
   ロガーとカメラの時計は数十分ずれることがある（実例: 25 分）ので、まず 2 時間以内の 8 件、見つからなければ 1 日以内の 12 件、さらに 6 件と広げる
3. 照合: 各 .dat のロールレートだけを読み、映像のジャイロのロール角速度との全範囲の相互相関をとる。目安は「主ピーク / 第 2 ピーク」（同期の信頼度と同じ）。
   3 以上ならその場で決め、それ以外は候補の中で最大のものを、1.5 以上なら採用する

実例（`VID_20260919_140847`、25 分の動画）: 同じ走行の `20260919_143356.dat` は 3.56、同じ日の別の走行は 1.00〜1.16、翌日の走行は 1.07。
この例では 2 件目で決まり、読み込みまで約 1 秒だった。

設定（.dat のフォルダと .ddf）はこのパソコンに覚えておく（localStorage の `reframe.logPrefs`）。
.dat を読んだときに使った .ddf はプロジェクトにも記録し（`ddfPath`）、次に開いたときはそれで読み直す。

## 確認の方法

```bash
cd app
npx tsx test/motoreco-dat.test.ts                                 # 式の確認 + 既定の実データ（あれば）で CSV と全列・全行を突き合わせ
npx tsx test/motoreco-dat.test.ts <dat> <ddf> <csv> <insv> [別の dat…]   # 照合の目安も出す
```

`proto/motoreco_check.py` は、ソースを見る前に CSV から式を推定したときの道具（`check(列名, ID, 式)` で一致率を出す）。
