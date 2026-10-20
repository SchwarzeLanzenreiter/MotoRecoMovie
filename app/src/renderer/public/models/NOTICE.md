# 同梱しているモデル

## yolox_nano.onnx

- 内容: YOLOX-Nano（COCO の 80 クラスの物体検出）。このアプリでは車・オートバイ・バス・トラックだけを使う（追い越しの判定）
- 出典: Megvii-BaseDetection/YOLOX のリリース 0.1.1rc0
  https://github.com/Megvii-BaseDetection/YOLOX/releases/download/0.1.1rc0/yolox_nano.onnx
- ライセンス: Apache License 2.0（Copyright (c) 2021-2022 Megvii Inc.）
  https://github.com/Megvii-BaseDetection/YOLOX/blob/main/LICENSE
- 変更: なし（ダウンロードしたファイルをそのまま使っている）

## neuflow_mixed.onnx

- 内容: NeuFlow v2（オプティカルフロー）。自車の継ぎ目の型で、2 つのレンズの像のずれを画素ごとに求める（render/bodymap）
- 出典: ibaiGorordo/ONNX-NeuFlowV2-Optical-Flow のリリース 0.1.0（neufieldrobotics/NeuFlow_v2 の重みを ONNX にしたもの。入力 2 枚の 1×3×432×768、0〜1）
  https://github.com/ibaiGorordo/ONNX-NeuFlowV2-Optical-Flow/releases/download/0.1.0/neuflow_mixed.onnx
- ライセンス: Apache License 2.0（NeuFlow v2）
  https://github.com/neufieldrobotics/NeuFlow_v2/blob/master/LICENSE 。変換のリポジトリは MIT
- 変更: なし

## migan_pipeline_v2.onnx

- 内容: MI-GAN（画像の補完）。どちらのレンズにも写らない所を埋める
- 出典: Hugging Face andraniksargsyan/migan（Picsart-AI-Research/MI-GAN の前処理・後処理込みの ONNX。入力は uint8 の画像と、255 = 残す / 0 = 埋めるのマスク）
  https://huggingface.co/andraniksargsyan/migan/resolve/main/migan_pipeline_v2.onnx
- ライセンス: MIT License（Copyright (c) 2023 Picsart AI Research (PAIR)）
  https://github.com/Picsart-AI-Research/MI-GAN/blob/main/LICENSE
- 変更: なし

## lama_fp32.onnx

- 内容: LaMa（big-lama、画像の補完）。MI-GAN と比べて良い方を使う
- 出典: Hugging Face Carve/LaMa-ONNX（入力 1×3×512×512 の 0〜1 と、1 = 埋めるのマスク。出力は 0〜255）
  https://huggingface.co/Carve/LaMa-ONNX/resolve/main/lama_fp32.onnx （SHA-256 1faef5301d78db7dda502fe59966957ec4b79dd64e16f03ed96913c7a4eb68d6）
- ライセンス: Apache License 2.0（advimman/lama）
  https://github.com/advimman/lama/blob/main/LICENSE
- 変更: なし
