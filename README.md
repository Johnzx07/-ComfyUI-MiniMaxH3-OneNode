# One Node · MiniMax H3 (video + audio)

A single‑node ComfyUI front end for **MiniMax H3** — MiniMax's omni‑modal generator that
produces video **with native stereo audio** (voice, SFX, music) in one forward pass. Drop
**one** node and everything — modes, prompt, references, resolution, sampling, speed, and a
two‑pass HD path — lives in its in‑panel UI. On **Generate** it injects a real ComfyUI graph
and submits it to `/prompt`; there are no wires to manage.

> **Made by The New Game Plus.** If this saves you time, a coffee is hugely appreciated —
> ☕ **[Ko‑fi](https://ko-fi.com/thenewgameplus)** · ▶ **[YouTube](https://www.youtube.com/@TheNewGamePluss)**
> _(Believed to be the first "one‑node" wrapper for MiniMax H3.)_

> Add the node: right‑click → Add Node → **MiniMaxH3‑OneNode → One Node · MiniMax H3**
> (or double‑click the canvas and search "MiniMax H3").

---

## Three modes

| Pill | Node under the hood | What it does |
|------|---------------------|--------------|
| **T2V** | `MiniMaxH3ImageToVideo` (fl2va) | Text → video + audio. Describe shots, camera, **and** sound. |
| **I2V** | `MiniMaxH3ImageToVideo` (fl2va) | Animate a still (first frame), or bridge **first → last** frame (FL2V). |
| **R2V** | `MiniMaxH3ReferenceToVideo` (ref2va) | Reference **editor**: lock a character / style / motion / camera / voice from up to **9 images, 3 videos, 3 audio clips**, then describe the target scene. |

MiniMax H3 is **guidance‑distilled**: `BasicGuider`, positive‑only — **no CFG, no negative
prompt.** Put everything (including what you *don't* want, phrased positively) in the prompt.

---

## Install

**1. The node**
```bash
cd ComfyUI/custom_nodes
git clone https://github.com/Johnzx07/ComfyUI-MiniMaxH3-OneNode
```
Requires a current **ComfyUI** with the native MiniMax H3 nodes (Comfy‑Org/ComfyUI **PR #15224**).
No extra Python deps of its own.

**2. The models** — from [🤗 Comfy‑Org/MiniMax‑H3](https://huggingface.co/Comfy-Org/MiniMax-H3).
Pick **one** quant per model (fp8 / int8 ≈ 21 GB — good for a 16–24 GB card):
```
ComfyUI/models/
├── diffusion_models/
│   ├── minimax_h3_fl2va_pruned_fp8_scaled.safetensors    (T2V / I2V)
│   └── minimax_h3_ref2va_pruned_fp8_scaled.safetensors   (R2V)
├── text_encoders/
│   └── qwen3vl_32b_minimax_h3_int8_convrot.safetensors   (or nvfp4_awq on 50‑series)
└── vae/
    ├── minimax_h3_video_vae_fp16.safetensors
    └── minimax_h3_audio_vae_fp32.safetensors
```
The node **auto‑detects** these — open **Models** → **↻ Rescan** after copying (no restart
needed for a rescan). H3's sweet spot is a **768 short edge, ≤ 1344 × 768** canvas.

---

## Settings, combinations & recipes

The node exposes real controls, but you only need a few combinations. Think in **three tiers**:

| Tier | Turbo | 2‑pass HD | TeaCache | Use for |
|------|-------|-----------|----------|---------|
| **Draft / test** | on | off | **on** | checking motion, framing, prompt |
| **Fast final** | preset on | **on** | off | volume shots, social, most work |
| **Hero final** | off | **on** | off | the money shots / complex fast motion |

### Non‑Turbo (hero) — the quality baseline
- **Sampler** `euler` · **Steps** `20` · **CFG** none (H3 is CFG‑less)
- **Scheduler** `simple` for T2V/I2V, `beta` for R2V — the node **auto‑sets this per mode**, just leave it.
- **Sigma shift** off (model's built‑in 12/3) · **TeaCache** off · **audio** on

### 2‑pass HD (generate cheap, deliver sharp)
Generate at a **low draft** resolution, then upscale + lightly refine to HD. It's a **quality
pass, not a speed trick** — but it's far cheaper than diffusing HD natively.

- **DRAFT** box = the **generation** resolution (the pass that decides motion). Keep it low:
  **0.4–0.5 MP** normally, ~**768p (≈1 MP)** for the FL2V Turbo preset (its trained res).
- **Resolution slider** = the **final / target** size. Set it **higher** than the draft:
  **1.6 MP** for ~10–15 s clips, up to **2.0 MP (1080p)** for short (≤ 8 s) clips.
- **Refine** `4 steps · 0.2 denoise` (drop to `0.15` if fast motion shimmers). Leave these.
- **The one rule:** the panel's own sentence must show **two different numbers**
  (`generate low → output high`). If they're equal, you're getting no upscale — raise the target.
- **Panels flip label by mode:** if the box says **DRAFT** it's the generation res; if it says
  **REFINE** the *Resolution slider* is the generation res instead. Read the label.
- The HD pass adds **spatial** detail, not **motion** quality — it sharpens, it can't un‑jank
  a bad 4‑step motion.

### 1‑click Turbo presets (Advanced ▸ Speed)
Distilled 4‑step LoRAs (lightx2v/ModelTC). Pick a preset and **everything** — LoRA, sigma
shift, sampler, steps — locks to the trained recipe; you only touch **render quality**.

| Preset | Locks to | Use in mode |
|--------|----------|-------------|
| **FL2V 768p** | 4 steps · shift 6/3 · euler/simple · str 1.0 · ~768p | T2V / I2V (first→last‑frame) |
| **R2V lip‑sync** | 4 steps · shift 12/3 · euler/simple · str 1.0 · ~0.5 MP · **keeps audio** | R2V |

Turbo trades some motion nuance for ~5× speed — great for volume, keep **non‑Turbo for hero
shots**. (The R2V preset is designed to preserve audio‑ref lip‑sync at 4 steps; confirm on
your first clip.) Set the preset to **Off** to return to the full non‑Turbo path.

### TeaCache (speed) — when
**On** for drafts and calm/low‑motion shots (it reuses steps between near‑identical frames).
**Off** for finals, fast motion, and any lip‑sync (it smears exactly the frames that change).

### Sample recipes

**Cinematic hero shot (I2V, non‑Turbo)**
`I2V · euler · 20 · simple · shift off · TeaCache off · audio on · DRAFT 0.4 → slider 1.6 · refine 4/0.2 · ~5 s`

**Fast keyframe animation (FL2V, Turbo)**
`I2V + end frame · FL2V 768p preset · DRAFT ~768p → slider 1.6–2.0 · TeaCache off · ~3–4 s`
_Panel A → Panel B should be the same shot with a change (a turn / expression / small action), not two unrelated compositions._

**Character / idol lip‑sync (R2V, Turbo)**
`R2V · R2V lip‑sync preset · reference image + reference audio · DRAFT 0.5 → slider 0.9 · TeaCache off · ~8–15 s`

**Duration guidance:** FL2V transitions want **3–4 s** (both ends are fixed — long clips
drift). Talking / lip‑sync and full scenes: **8–15 s** (H3's trained range).

---

## The panel

- **Prompt** — one block covering picture *and* audio. "Load example…" drops in tuned
  starters (mode‑aware). In **R2V**, tag chips insert `<Picture N>` / `<Video N>` / `<Audio N>`.
- **Frames** (I2V) — first frame (sets geometry) + optional last frame (animates toward it).
- **Reference editor** (R2V) — up to **9** image slots (MiniMax recommends **≤ 5**), 3 reference
  videos (each with optional paired soundtrack), 3 standalone audio clips, and a **Reference
  detail** dial (`match` = fast, `max` = stronger identity).
- **Video** — aspect ratio + megapixels → live `W × H`, with a collapsible **Size table**.
- **Sampling** — steps, sampler, scheduler (auto per mode), seed.
- **Advanced** — the **1‑click Turbo presets**, manual Turbo LoRA, Style/character LoRA,
  custom sigma shift, and **Speed** toggles (Sage attention, Sol‑attn, Blackwell fast FP8).
- **Upscale tab** — post‑process a finished clip (ESRGAN model / SeedVR2 / FlashVSR / RTX‑VSR).
- **Models** — the auto‑detected dropdowns + rescan.

**Resizable** (drag the corner, size remembered) · **full‑screen** button · a **progress bar**
(percent · step · elapsed) · a **Gallery** of finished renders. Output lands in
`output/ComfyUI-MiniMaxH3-OneNode/`; the 📁 button opens it. **Unmute the preview** — the audio is real.

---

## Optional add‑ons (speed & upscale)

Everything below is **optional** — the node detects each one and greys the toggle (with an
install note) if it's missing, so nothing ever breaks the graph. Install via **ComfyUI Manager**
or `git clone` into `custom_nodes`, then restart ComfyUI. **All credit to their authors.**

**Turbo (4‑step distilled) —** `ComfyUI-MiniMax-H3-Turbo` node pack (`MiniMaxH3TurboLoRA`,
`MiniMaxH3TurboSampler`) + the LoRAs:
- larryvrh / drbaph / Abiray — `minimax_h3_turbo_*` (general 4‑step)
- **lightx2v / ModelTC** — [Minimax‑h3‑Turbo](https://huggingface.co/lightx2v/Minimax-h3-Turbo):
  `minimax_h3_fl2v_turbo_4step_v1.0_768p_comfyui_bf16.safetensors` (FL2V preset) and
  `minimax_h3_ref2v_turbo_4step_v0.1_comfyui_bf16.safetensors` (R2V preset) → `models/loras/`.

**Attention / memory —**
- **KJNodes** (`ComfyUI-KJNodes`) — Sage attention kernel (~7 % faster, lower peak VRAM).
- **Sol‑Attn** (NVIDIA sparse attention patch) + FFN chunking — lower MLP peak VRAM.

**Cache accelerators (pick one) —**
- **TeaCache** — `MiniMaxH3TeaCache` (Icyoung).
- **Spectrum** — `SpectrumApplyMiniMaxH3` (xmarre).
- **FirstBlockCache** — `ApplyMiniMaxH3FirstBlockCache` (duckyshell).

**Two‑pass helpers —**
- **PT_H3ConcatAVLatent** (ptmaster) · **MiniMaxH3AVDecodeT8** (T8mars).

**Upscalers (Upscale tab) —**
- **RTX Video Super Resolution** — `RTXVideoSuperResolution`
  ([Comfy‑Org/Nvidia_RTX_Nodes_ComfyUI](https://github.com/comfyanonymous/ComfyUI)) — hardware
  upscaler, RTX only.
- **SeedVR2** — diffusion restorer (best on stylized / AI footage).
- **FlashVSR** (`ComfyUI-FlashVSR_Stable`) — fast diffusion upscaler (best on real footage).
- Any standard ESRGAN model in `models/upscale_models/`.

> Node class names are stable; find each pack by name in **ComfyUI Manager** if a link moves.

---

## Design notes

- **Direct API graph** — hand‑authors a flat API graph (`workflows/iv.json`, `workflows/r2v.json`)
  and patches it; robust and reviewable. Reference inputs use the exact dotted
  `COMFY_AUTOGROW_V3` keys the backend expects (`ref_images.ref_image_0`, etc.).
- **Fully namespaced** so it coexists with other nodes: routes `/minimaxh3/*`, class
  `MiniMaxH3OneNode`, `window.__mmh3_nodes`, localStorage `minimaxh3_one_node_state`, CSS `mmh3-`.
- **Headless test** (`node test/headless_build.mjs`) drives Generate across T2V / I2V / FLF / R2V
  and asserts model routing, res/length math, the dotted reference keys, and sigma‑shift
  injection — no GPU needed.

## Tips

- **Everything in the prompt** — no negative prompt exists; describe the shot list, camera
  language, and the full soundtrack (dialogue in quotes, SFX, score).
- **R2V ≤ 5 images** — more references dilute identity and slow generation. Use `max` detail
  only when identity matters.
- **VRAM** — the 32B encoder + diffusion weights offload to system RAM on smaller cards; it
  runs, just not instantly. Keep Sage attention on.
- **Legible on‑screen text** works best when you spell the exact words and add "clearly legible,
  do not misspell, no subtitle bars."

---

## License & credits

MIT‑style **Apache‑2.0** for this wrapper (see `LICENSE`). See `NOTICE` for full attribution.
This node **injects and runs** ComfyUI's built‑in MiniMax H3 nodes — it does **not** reimplement
the model, and **bundles no weights**. MiniMax H3 by **MiniMax**; ComfyUI integration and models
by **Comfy‑Org**. Optional add‑ons credited to their authors above.

Not affiliated with MiniMax or Comfy‑Org. **Use responsibly** — H3 renders native speech; do not
impersonate real people without consent or generate deceptive media.

Made with ❤️ by **[The New Game Plus](https://www.youtube.com/@TheNewGamePluss)** ·
☕ **[Ko‑fi](https://ko-fi.com/thenewgameplus)**
