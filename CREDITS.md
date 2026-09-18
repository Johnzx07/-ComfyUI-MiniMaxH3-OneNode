# Credits and upstream projects

One Node - MiniMax H3 is an orchestration interface. It builds ComfyUI graphs and
calls node classes supplied by ComfyUI and optional companion extensions. It does
not bundle their weights or copy their runtime implementations.

Each upstream project retains its own copyright and license. Review the linked
repository and model card before use or redistribution.

## Core platform and model

| Project | Contribution |
| --- | --- |
| [ComfyUI](https://github.com/Comfy-Org/ComfyUI) | Graph runtime, loaders, samplers, video/audio nodes, masks, AV latent utilities, and native MiniMax H3 integration. |
| [MiniMax H3](https://github.com/MiniMax-AI/MiniMax-H3) by MiniMax | H3 architecture, task definitions, model release, documentation, and prompt-writing guidance. |
| [Comfy-Org/MiniMax-H3](https://huggingface.co/Comfy-Org/MiniMax-H3) | ComfyUI-ready model distribution. |
| [Qwen3-VL](https://github.com/QwenLM/Qwen3-VL) | Text/vision encoder family used by H3. |

## Companion nodes used by v3.24

| Upstream project | Node classes or feature used |
| --- | --- |
| [ckinpdx/ComfyUI-MMH3Tools](https://github.com/ckinpdx/ComfyUI-MMH3Tools) | MMH3ContextWindows, MMH3SplitAV, MMH3PackAV, and chunked pixel upscaling. |
| [LBH-123-AI/Comfyui_Minimax_h3_latent_Upscaler](https://github.com/LBH-123-AI/Comfyui_Minimax_h3_latent_Upscaler) | MinimaxH3LatentUpscaler3D for protected HD refinement. |
| [Larryvrh/ComfyUI-MiniMax-H3-Turbo](https://github.com/Larryvrh/ComfyUI-MiniMax-H3-Turbo) | H3 Turbo sampler and LoRA loader used for Turbo, LightX, and style LoRAs. |
| [CGlide/ComfyUI-CGlide](https://github.com/CGlide/ComfyUI-CGlide) | H3 Studio casting, previews, and temporary video handling. |
| [ethanfel/ComfyUI-MiniMaxH3-Contex-Loop](https://github.com/ethanfel/ComfyUI-MiniMaxH3-Contex-Loop) | Context-loop planning and protected target/mask operations. |
| [T8mars/comfyui-minimax-h3-audio-T8](https://github.com/T8mars/comfyui-minimax-h3-audio-T8) | H3 AV decode and optional speech/voice tools when available. |
| [ptmaster/ComfyUI-PT_H3ConcatAVLatent](https://github.com/ptmaster/ComfyUI-PT_H3ConcatAVLatent) | AV latent concatenation helper. |
| [kijai/ComfyUI-KJNodes](https://github.com/kijai/ComfyUI-KJNodes) | Memory-efficient Sage attention patch. |
| [Saganaki22/ComfyUI-sol-attn](https://github.com/Saganaki22/ComfyUI-sol-attn) | Sol attention and feed-forward chunking. |
| [Icyoung/ComfyUI-MiniMaxH3-TeaCache](https://github.com/Icyoung/ComfyUI-MiniMaxH3-TeaCache) | TeaCache acceleration. |
| [duckyshell/ComfyUI-MiniMaxH3-FirstBlockCache](https://github.com/duckyshell/ComfyUI-MiniMaxH3-FirstBlockCache) | FirstBlockCache acceleration. |
| [xmarre/ComfyUI-Spectrum-MiniMax-H3](https://github.com/xmarre/ComfyUI-Spectrum-MiniMax-H3) | Spectrum cache acceleration. |
| [Jalen-Brunson/ComfyUI-MiniMax-H3-PDD-Acc](https://github.com/Jalen-Brunson/ComfyUI-MiniMax-H3-PDD-Acc) | PDD acceleration loader and scheduler. |
| [Comfy-Org/Nvidia_RTX_Nodes_ComfyUI](https://github.com/Comfy-Org/Nvidia_RTX_Nodes_ComfyUI) | NVIDIA RTX Video Super Resolution. |
| [numz/ComfyUI-SeedVR2_VideoUpscaler](https://github.com/numz/ComfyUI-SeedVR2_VideoUpscaler) | SeedVR2 video restoration/upscaling. |
| [naxci1/ComfyUI-FlashVSR_Stable](https://github.com/naxci1/ComfyUI-FlashVSR_Stable) | FlashVSR video upscaling. |
| [drozbay/MaskVidExperiments](https://github.com/drozbay/MaskVidExperiments) | Optional tracked-mask cleanup. |

## Models and acceleration research

- MiniMax H3 weights and VAEs remain subject to the MiniMax H3 Community License.
- LightX/ModelTC H3 Turbo LoRAs remain subject to their model-card terms.
- Anime Motion LoRAs remain subject to the terms attached to their download source.
- PDD acceleration weights remain subject to the Alibaba PAI release terms and the
  companion project's documentation.
- Upscaler, restoration, segmentation, and speech model files are not included.

## Bundled prompt material

The files under prompt_guides/official_minimax/ are pinned copies of MiniMax's
portable H3 prompt-writing skill. Their source revision and hashes are recorded in
prompt_guides/official_minimax/SOURCES.md. They remain upstream MiniMax material
under applicable upstream terms. The local adapter in creative_skills.py is part of
this Apache-2.0 wrapper.

## One Node authorship

The One Node wrapper, panel, graph builder, server helpers, tests, documentation, and
release integration are by The New Game Plus and contributors. See LICENSE.

Thank you to every upstream maintainer and researcher whose work makes local H3
generation possible.
