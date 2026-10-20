# Bundled models

## yolox_nano.onnx

- Description: YOLOX-Nano (object detection over the 80 COCO classes). The app uses only car, motorcycle, bus and truck (for overtake detection)
- Source: release 0.1.1rc0 of Megvii-BaseDetection/YOLOX
  https://github.com/Megvii-BaseDetection/YOLOX/releases/download/0.1.1rc0/yolox_nano.onnx
- License: Apache License 2.0 (Copyright (c) 2021-2022 Megvii Inc.)
  https://github.com/Megvii-BaseDetection/YOLOX/blob/main/LICENSE
- Modifications: none (the downloaded file is used as is)

## neuflow_mixed.onnx

- Description: NeuFlow v2 (optical flow). For the own-bike seam pattern, it finds the per-pixel offset between the images of the two lenses (render/bodymap)
- Source: release 0.1.0 of ibaiGorordo/ONNX-NeuFlowV2-Optical-Flow (the weights of neufieldrobotics/NeuFlow_v2 converted to ONNX; input: two 1×3×432×768 images, 0 to 1)
  https://github.com/ibaiGorordo/ONNX-NeuFlowV2-Optical-Flow/releases/download/0.1.0/neuflow_mixed.onnx
- License: Apache License 2.0 (NeuFlow v2)
  https://github.com/neufieldrobotics/NeuFlow_v2/blob/master/LICENSE (the conversion repository is MIT)
- Modifications: none

## migan_pipeline_v2.onnx

- Description: MI-GAN (image inpainting). Fills the areas that neither lens captures
- Source: Hugging Face andraniksargsyan/migan (ONNX of Picsart-AI-Research/MI-GAN including pre- and post-processing; input: a uint8 image and a mask where 255 = keep / 0 = fill)
  https://huggingface.co/andraniksargsyan/migan/resolve/main/migan_pipeline_v2.onnx
- License: MIT License (Copyright (c) 2023 Picsart AI Research (PAIR))
  https://github.com/Picsart-AI-Research/MI-GAN/blob/main/LICENSE
- Modifications: none

## lama_fp32.onnx

- Description: LaMa (big-lama, image inpainting). Whichever of this and MI-GAN gives the better result is used
- Source: Hugging Face Carve/LaMa-ONNX (input: 1×3×512×512, 0 to 1, and a mask where 1 = fill; output: 0 to 255)
  https://huggingface.co/Carve/LaMa-ONNX/resolve/main/lama_fp32.onnx (SHA-256 1faef5301d78db7dda502fe59966957ec4b79dd64e16f03ed96913c7a4eb68d6)
- License: Apache License 2.0 (advimman/lama)
  https://github.com/advimman/lama/blob/main/LICENSE
- Modifications: none
