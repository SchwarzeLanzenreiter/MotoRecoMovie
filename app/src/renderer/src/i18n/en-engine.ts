// 英語の辞書（engine）。キーは日本語の原文、値は英語。{名前} の差し込みは両方で同じ名前を使う
export const EN_ENGINE: Record<string, string> = {
  '設定ファイルではありません（JSON として読めません）': 'Not a settings file (not valid JSON)',
  '設定ファイルではありません': 'Not a settings file',
  '新しい版のアプリで保存された設定ファイルです': 'This settings file was saved by a newer version of the app',
  '車線を調べています {p}': 'Checking lanes {p}',
  '車を探しています {p}': 'Looking for vehicles {p}',
  '.dat を読むには、変換規則（.ddf）を指定してください': 'To read a .dat, choose the decoding rules (.ddf)',
  '映像に合う車両ログを探しています': 'Looking for a matching bike log',
  '車両ログを照合しています: {file}': 'Checking bike log: {file}',
  // session.ts
  'ファイルを開いています': 'Opening file',
  '映像トラックが {n} 本あります（X6 の .insv は2本）': 'Found {n} video tracks (an X6 .insv has 2)',
  'メタデータを読み込んでいます': 'Reading metadata',
  'ジャイロを読み込んでいます': 'Reading gyro data',
  // session.ts・analysis.worker.ts（解析スレッドは日本語のまま送る）
  'ログを読み込んでいます': 'Loading log',
  '映像とログを同期しています': 'Syncing video and log',
  'リーン角を推定しています': 'Estimating lean angle',
  'テレメトリーを整えています': 'Preparing telemetry',
  // analysis.ts
  '解析スレッドでエラー: {msg}': 'Error in analysis thread: {msg}',
  // decoder.ts
  'フレーム {i} がデコードされませんでした': 'Frame {i} was not decoded',
  'フレーム {i} のデコードがタイムアウトしました': 'Decoding frame {i} timed out',
  // exporter.ts
  '{w}×{h} を書き出せるエンコーダーが見つかりません': 'No encoder found that can export {w}×{h}',
  '中止しました': 'Canceled',
  'ffmpeg で音声を合成できませんでした。映像のみのファイル: {path}': 'ffmpeg could not add the audio. Video-only file: {path}',
  // places-fetch.ts
  // core（insv・mp4・motoreco。日本語のまま投げ、analysis.ts の localizeError で直す）
  'Insta360 のトレーラーが見つかりません（.insv ではない可能性があります）': 'Insta360 trailer not found (this may not be an .insv file)',
  '未対応の wire type {wt}': 'Unsupported wire type {wt}',
  '未対応のキャリブレーション形式 V{version}（V6のみ対応）': 'Unsupported calibration format V{version} (only V6 is supported)',
  'レコード 0x{id} がありません': 'Record 0x{id} is missing',
  'moov ボックスが見つかりません': 'moov box not found',
  'MotoReco の CSV ではありません（time 列が見つかりません）': 'Not a MotoReco CSV (no time column)',
  '列 {name} がありません': 'Column {name} is missing',
  '.ddf にチャンネルがありません': 'The .ddf has no channels',
  '式を読めません: {src}': 'Cannot read the formula: {src}',
  'MotoReco の .dat ではありません（大きさが 16 バイト単位ではありません）': 'Not a MotoReco .dat (size is not a multiple of 16 bytes)'
}
