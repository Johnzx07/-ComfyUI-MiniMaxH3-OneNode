# Installation guide

This guide installs One Node - MiniMax H3 v3.24 for local ComfyUI. The release is
optimized for NVIDIA RTX GPUs with 16 GB VRAM. An 8 GB edition is in development.

## 1. Hardware and software

Recommended for the protected 15-second workflow:

- NVIDIA RTX GPU with 16 GB VRAM
- Current NVIDIA driver and a CUDA-enabled ComfyUI/PyTorch installation
- 32 GB system RAM minimum; 48-64 GB is preferable when large weights are offloaded
- Enough storage for the selected FL2VA and Ref2VA weights, text encoder, VAEs,
  LoRAs, and upscaler models
- A current ComfyUI build containing the native MiniMax H3 nodes

The interface can load on other hardware, but the protected recipe and performance
claims apply to the 16 GB NVIDIA RTX target.

## 2. Update ComfyUI

Update ComfyUI before installing the node. The following native classes must exist:

- `MiniMaxH3ImageToVideo`
- `MiniMaxH3ReferenceToVideo`
- `MiniMaxH3SigmaShift`
- `CreateVideo` and `SaveVideo`
- `LTXVSeparateAVLatent` and `LTXVConcatAVLatent`

In ComfyUI Manager, update ComfyUI and restart. For a Git installation:

```bash
cd ComfyUI
git pull
```

Use the Python environment that belongs to that ComfyUI installation when installing
any companion node requirements.

## 3. Install One Node

From `ComfyUI/custom_nodes`:

```bash
git clone https://github.com/Johnzx07/ComfyUI-MiniMaxH3-OneNode.git
```

The wrapper has no extra Python packages of its own. Restart ComfyUI after cloning.

### Windows portable Python

Run companion requirements with the portable interpreter:

```powershell
python_embeded\python.exe -m pip install -r ComfyUI\custom_nodes\PACKAGE\requirements.txt
```

### Standard Windows or Linux virtual environment

Activate the ComfyUI environment, then run:

```bash
python -m pip install -r ComfyUI/custom_nodes/PACKAGE/requirements.txt
```

Replace `PACKAGE` with the companion node directory.

## 4. Install the required model files

Download compatible ComfyUI weights from:

- https://huggingface.co/Comfy-Org/MiniMax-H3
- https://github.com/MiniMax-AI/MiniMax-H3

Follow the model card and MiniMax H3 Community License Agreement.

```text
ComfyUI/models/
|-- diffusion_models/
|   |-- minimax_h3_fl2va_pruned_fp8_scaled.safetensors
|   `-- minimax_h3_ref2va_pruned_fp8_scaled.safetensors
|-- text_encoders/
|   `-- qwen3vl_32b_minimax_h3_int8_convrot.safetensors
`-- vae/
    |-- minimax_h3_video_vae_fp16.safetensors
    `-- minimax_h3_audio_vae_fp32.safetensors
```

The FL2VA model is used for T2V and I2V. Ref2VA is used for Reference mode. Supported
INT8 alternatives can be used instead of FP8. RTX 50-series users can select a
compatible Blackwell-oriented text-encoder quantization when installed.

After copying models, open **Models** in the node and choose **Rescan models**.

## 5. Protected 1080p and 2K recipe

The protected 15-second route requires these companion repositories:

```bash
cd ComfyUI/custom_nodes
git clone https://github.com/ckinpdx/ComfyUI-MMH3Tools.git
git clone https://github.com/LBH-123-AI/Comfyui_Minimax_h3_latent_Upscaler.git
```

Install each package's requirements with the ComfyUI Python environment, then restart
ComfyUI.

Place a supported MiniMax H3 latent-upscaler model in:

```text
ComfyUI/models/latent_upscale_models/
```

The protected production preset was verified with:

```text
minimax_h3_latent_upscaler_3d_fp32.pth
```

Open **Advanced -> Two-pass HD -> Protected 15s / 16GB recipe** and select:

- **1080p:** 2 MP target; ratio-aware, such as 1920 x 1088 or 1088 x 1920
- **2K:** 4 MP target; ratio-aware, such as approximately 2688 x 1504

The button keeps the currently selected aspect ratio.

## 6. Turbo, LightX, and Anime Motion

Install the H3 Turbo loader:

```bash
cd ComfyUI/custom_nodes
git clone https://github.com/Larryvrh/ComfyUI-MiniMax-H3-Turbo.git
```

Place H3 LoRAs in:

```text
ComfyUI/models/loras/
```

Supported examples include the official/third-party H3 Turbo and LightX files named
inside their model cards, plus:

```text
MiniMax-H3-I2V-Anime-Motion-LoRA-1000.safetensors
MiniMax-H3-I2V-Anime-Motion-LoRA-1400.safetensors
```

The node pins LightX recipes to the exact selected filename. Do not rename different
4-step and 8-step releases to the same name.

Anime Motion is intended for H3 video generation. It is not a text-to-image LoRA.
Reference-mode use is beta; begin at 0.65 and verify identity and audio.

## 7. Optional companion features

Install only the features you plan to use. The panel probes for each class and keeps
unavailable options disabled.

| Feature | Repository |
| --- | --- |
| H3 Studio and continuation | https://github.com/CGlide/ComfyUI-CGlide |
| Context masking, repair, finish | https://github.com/ethanfel/ComfyUI-MiniMaxH3-Contex-Loop |
| H3 audio/AV utilities | https://github.com/T8mars/comfyui-minimax-h3-audio-T8 |
| Sage attention | https://github.com/kijai/ComfyUI-KJNodes |
| Sol attention and FFN chunking | https://github.com/Saganaki22/ComfyUI-sol-attn |
| TeaCache | https://github.com/Icyoung/ComfyUI-MiniMaxH3-TeaCache |
| FirstBlockCache | https://github.com/duckyshell/ComfyUI-MiniMaxH3-FirstBlockCache |
| Spectrum cache | https://github.com/xmarre/ComfyUI-Spectrum-MiniMax-H3 |
| PDD acceleration | https://github.com/Jalen-Brunson/ComfyUI-MiniMax-H3-PDD-Acc |
| RTX Video Super Resolution | https://github.com/Comfy-Org/Nvidia_RTX_Nodes_ComfyUI |
| SeedVR2 | https://github.com/numz/ComfyUI-SeedVR2_VideoUpscaler |
| FlashVSR | https://github.com/naxci1/ComfyUI-FlashVSR_Stable |
| Tracked-mask cleanup | https://github.com/drozbay/MaskVidExperiments |
| PT AV latent helper | https://github.com/ptmaster/ComfyUI-PT_H3ConcatAVLatent |

See [CREDITS.md](CREDITS.md) before redistributing any companion package or model.

## 8. Add and use the node

1. Restart ComfyUI.
2. Refresh the browser.
3. Double-click the canvas and search for **One Node MiniMax H3**.
4. Add **MiniMaxH3-OneNode -> One Node - MiniMax H3 (video + audio)**.
5. Open **Models**, select the FL2VA or Ref2VA weights, text encoder, and VAEs.
6. Select T2V, I2V, or R2V.
7. Set aspect ratio, duration, and prompt.
8. For I2V, upload a first frame. For R2V, attach and tag references.
9. Press **Generate**.

Finished videos are written to:

```text
ComfyUI/output/ComfyUI-MiniMaxH3-OneNode/
```

## 9. Updating

```bash
cd ComfyUI/custom_nodes/ComfyUI-MiniMaxH3-OneNode
git pull
```

Update required companion nodes and ComfyUI at the same time, then restart ComfyUI
and hard-refresh the browser.

## 10. Troubleshooting

### Node does not appear

- Confirm the folder is directly under `ComfyUI/custom_nodes/`.
- Check the ComfyUI console for an import error.
- Remove nested duplicate folders created by ZIP extraction.
- Restart ComfyUI and hard-refresh the browser.

### Models do not appear

- Confirm each file is in the matching model folder.
- Open **Models -> Rescan models**.
- Keep the original file extension and a unique filename.
- Confirm the model download completed and is not an HTML error page.

### Protected preset is unavailable

Install and restart after adding both `ComfyUI-MMH3Tools` and
`Comfyui_Minimax_h3_latent_Upscaler`. Confirm the FP32 upscaler model is visible.

### CUDA out of memory

- Use the protected 16 GB preset instead of a native full-resolution render.
- Keep the draft at 0.5 MP.
- Use **Ultra Safe** windows.
- Leave model offload and force-unload enabled.
- Close other GPU applications.
- Do not combine Turbo, PDD, and cache systems unless the selected recipe calls for it.

### Generated audio is missing or quiet

Confirm the audio VAE is selected and the prompt contains explicit sound instructions.
For two-pass work, use the protected route so stage-1 audio is carried into refinement.
Always review the exported file in a player with audio enabled.

### Blank panel after an update

Restart ComfyUI, then hard-refresh the browser. If the problem remains, check the
console for the first JavaScript or Python error and include it in a bug report.

## 11. Uninstall

Remove `ComfyUI-MiniMaxH3-OneNode` from `custom_nodes` and restart ComfyUI. Model
files and optional companion nodes are independent and are not removed automatically.
