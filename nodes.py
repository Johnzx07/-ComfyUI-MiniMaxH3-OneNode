"""ComfyUI-MiniMaxH3-OneNode — server-side helper routes + node registration.

Mirrors the architecture of the One Node family (Krea-2 image, Wan 2.2 video,
LTX-2 video): resilient imports, a no-op PromptServer fallback, model-scan /
workflow-serve / config routes, and a single OUTPUT no-op node that hosts the
in-node UI panel (web/minimaxh3_one_node.js).

Fully namespaced under /minimaxh3/ and the MiniMaxH3OneNode class so it coexists
with the other One Node packages without any route / class collision.

MiniMax H3 is an omni-modal video model that generates video WITH native stereo
audio (voice, SFX, music) in a single forward pass. Two weight sets are used:
  * fl2va  -> text/image-to-video (+ first/last keyframes)   [MiniMaxH3ImageToVideo]
  * ref2va -> reference-to-video (images / videos / audio)   [MiniMaxH3ReferenceToVideo]
"""

import os
import glob
import json
import shutil
from pathlib import Path

import folder_paths

# ── Resilient imports ─────────────────────────────────────────────────────────
try:
    from aiohttp import web
except Exception:  # pragma: no cover
    web = None


def _make_noop_promptserver():
    class _NoopRoutes:
        def get(self, *a, **k):
            def deco(fn):
                return fn
            return deco
        post = get

        def static(self, *a, **k):
            return None

    class _NoopInstance:
        routes = _NoopRoutes()

    class _NoopPromptServer:
        instance = _NoopInstance()

    return _NoopPromptServer


try:
    from server import PromptServer
    if getattr(PromptServer, "instance", None) is None or web is None:
        raise RuntimeError("PromptServer.instance not ready")
    _ROUTES_LIVE = True
except Exception as _e:  # pragma: no cover
    print(f"[MMH3] HTTP routes disabled (PromptServer unavailable: {_e}). "
          f"Nodes will still load; in-node panel data routes are inactive.")
    PromptServer = _make_noop_promptserver()
    _ROUTES_LIVE = False


NODE_DIR = os.path.dirname(os.path.abspath(__file__))
CONFIG_PATH = os.path.join(NODE_DIR, "config.json")
SUBFOLDER = "ComfyUI-MiniMaxH3-OneNode"


# ── user config (survives reinstalls) ─────────────────────────────────────────
def _resolve_user_config_dir():
    try:
        base = folder_paths.get_user_directory()
    except Exception:
        try:
            base = os.path.join(os.path.dirname(folder_paths.__file__), "user")
        except Exception:
            base = os.path.join(NODE_DIR, "_user")
    return os.path.join(base, "default", SUBFOLDER)


USER_CONFIG_DIR = _resolve_user_config_dir()
USER_CONFIG_PATH = os.path.join(USER_CONFIG_DIR, "config.json")


def _load_builtin_config():
    try:
        with open(CONFIG_PATH, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return {}


def _load_user_config():
    try:
        with open(USER_CONFIG_PATH, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return {}


def _load_config():
    merged = dict(_load_builtin_config())
    merged.update(_load_user_config())
    return merged


def _save_config(patch):
    user = _load_user_config()
    for k, v in patch.items():
        user[k] = v
    os.makedirs(USER_CONFIG_DIR, exist_ok=True)
    with open(USER_CONFIG_PATH, "w", encoding="utf-8") as f:
        json.dump(user, f, ensure_ascii=False, indent=2)


def _get_output_dir():
    try:
        return str(Path(folder_paths.get_output_directory()).resolve())
    except Exception:
        return str(Path(os.path.join(os.path.dirname(NODE_DIR), "output")).resolve())


# ── per-video metadata (settings sidecars) + favorites index ───────────────────
# Videos can't carry a tEXt chunk like PNGs, so generation settings live in a JSON
# sidecar next to the clip: <output>/ComfyUI-MiniMaxH3-OneNode/metadata/<name>.json.
# Favorites are also mirrored into a fast index (favorites.json in the node dir) so
# the gallery can filter to favorites without reading every sidecar.
def _safe_resolve_output_path(output_dir, subfolder="", filename=""):
    base = Path(output_dir).resolve()
    target = base
    if subfolder:
        target = target / subfolder
    if filename:
        target = target / filename
    target = target.resolve()
    try:
        target.relative_to(base)
    except Exception:
        raise ValueError("invalid path")
    return str(target)


def _meta_dir(video_path):
    return os.path.join(os.path.dirname(video_path), "metadata")


def _meta_path(video_path):
    fname = os.path.splitext(os.path.basename(video_path))[0] + ".json"
    return os.path.join(_meta_dir(video_path), fname)


def _read_json_meta(video_path):
    mp = _meta_path(video_path)
    if not os.path.exists(mp):
        return None
    try:
        with open(mp, "r", encoding="utf-8") as f:
            data = json.load(f)
        return data if isinstance(data, dict) else None
    except Exception as e:
        print(f"[MMH3] read_json_meta error: {e}")
        return None


def _write_json_meta(video_path, meta_dict):
    mp = _meta_path(video_path)
    tmp = mp + ".tmp"
    try:
        os.makedirs(os.path.dirname(mp), exist_ok=True)
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(meta_dict, f, ensure_ascii=False, indent=2)
        os.replace(tmp, mp)
        return True
    except Exception as e:
        print(f"[MMH3] write_json_meta error: {e}")
        if os.path.exists(tmp):
            try:
                os.remove(tmp)
            except Exception:
                pass
        return False


def _favorites_path():
    return os.path.join(NODE_DIR, "favorites.json")


def _load_favorites():
    path = _favorites_path()
    if os.path.exists(path):
        try:
            with open(path, "r", encoding="utf-8") as f:
                data = json.load(f)
            return set(data) if isinstance(data, list) else set()
        except Exception:
            return set()
    # First run: rebuild the index from any sidecars that were flagged favorite.
    favs = set()
    try:
        d = os.path.join(_get_output_dir(), SUBFOLDER, "metadata")
        if os.path.isdir(d):
            for jf in glob.glob(os.path.join(d, "*.json")):
                try:
                    with open(jf, "r", encoding="utf-8") as f:
                        md = json.load(f)
                    if md.get("favorite") is True:
                        favs.add(os.path.splitext(os.path.basename(jf))[0])
                except Exception:
                    pass
    except Exception:
        pass
    return favs


def _save_favorites(favset):
    path = _favorites_path()
    try:
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "w", encoding="utf-8") as f:
            json.dump(sorted(favset), f, ensure_ascii=False, indent=2)
    except Exception as e:
        print(f"[MMH3] save_favorites error: {e}")


def _fav_key(filename):
    """Favorites are keyed by basename-without-extension so a clip and its sidecar match."""
    return os.path.splitext(os.path.basename(filename))[0]


def _favorites_add(filename):
    favs = _load_favorites()
    favs.add(_fav_key(filename))
    _save_favorites(favs)


def _favorites_remove(filename):
    favs = _load_favorites()
    favs.discard(_fav_key(filename))
    _save_favorites(favs)


# ── model scanning ────────────────────────────────────────────────────────────
def _scan(folder_key, extensions=None):
    exts = extensions or [".safetensors", ".ckpt", ".pt", ".pth", ".sft"]
    try:
        bases = folder_paths.get_folder_paths(folder_key)
    except Exception:
        return []
    found = []
    for base in bases:
        if not os.path.isdir(base):
            continue
        for root, _, files in os.walk(base, followlinks=True):
            for fn in files:
                if any(fn.lower().endswith(e) for e in exts):
                    found.append(os.path.relpath(os.path.join(root, fn), base))
    return sorted(set(found))


@PromptServer.instance.routes.get("/minimaxh3/models")
async def mmh3_get_models(request):
    def safe(key):
        try:
            return _scan(key) or ["none"]
        except Exception:
            return ["none"]
    return web.json_response({
        # H3 diffusion weights (fl2va + ref2va) live under models/diffusion_models/
        "diffusion_models": safe("diffusion_models"),
        # Qwen3-VL-32B minimax text encoder under models/text_encoders/
        "text_encoders": safe("text_encoders"),
        # video + audio VAE under models/vae/
        "vaes": safe("vae"),
        # ESRGAN-style upscale models for the Upscale tab
        "upscale_models": safe("upscale_models"),
        # LoRAs (Turbo 4-step lives here)
        "loras": safe("loras"),
    })


def _serve_json(rel):
    async def handler(request):
        path = os.path.join(NODE_DIR, rel)
        if not os.path.exists(path):
            return web.Response(status=404, text=f"{rel} not found")
        with open(path, "r", encoding="utf-8") as f:
            data = json.load(f)
        return web.json_response(data)
    return handler


try:
    # iv.json  -> MiniMaxH3ImageToVideo (T2V / I2V / first+last-frame)
    # r2v.json -> MiniMaxH3ReferenceToVideo (reference images / videos / audio)
    PromptServer.instance.routes.get("/minimaxh3/workflow_iv")(_serve_json("workflows/iv.json"))
    PromptServer.instance.routes.get("/minimaxh3/workflow_r2v")(_serve_json("workflows/r2v.json"))
except Exception as _e:  # pragma: no cover
    print(f"[MMH3] could not register workflow routes: {_e}")


@PromptServer.instance.routes.get("/minimaxh3/config")
async def mmh3_get_config(request):
    cfg = _load_config()
    return web.json_response({
        "prompt_templates": cfg.get("prompt_templates", []),
        "r2v_prompt_templates": cfg.get("r2v_prompt_templates", []),
    })


@PromptServer.instance.routes.post("/minimaxh3/config")
async def mmh3_save_config(request):
    try:
        patch = await request.json()
        if not isinstance(patch, dict):
            return web.json_response({"ok": False, "error": "invalid payload"}, status=400)
        _save_config(patch)
        return web.json_response({"ok": True})
    except Exception as e:
        return web.json_response({"ok": False, "error": str(e)}, status=500)


@PromptServer.instance.routes.get("/minimaxh3/outputs")
async def mmh3_outputs(request):
    """List recent rendered videos in the package's output subfolder (newest first)
    so the in-node gallery can show past generations. Each item carries mtime plus
    favorite / has_meta flags so the detail view + favorites filter work. Pass
    favonly=1 to return only favorited clips."""
    try:
        favonly = request.query.get("favonly", "0") == "1"
        base = _get_output_dir()
        d = os.path.join(base, SUBFOLDER)
        meta_dir = os.path.join(d, "metadata")
        fav_set = _load_favorites()
        items = []
        if os.path.isdir(d):
            for fn in os.listdir(d):
                if fn.lower().endswith((".mp4", ".webm", ".mov", ".mkv", ".gif")):
                    key = os.path.splitext(fn)[0]
                    is_fav = key in fav_set
                    if favonly and not is_fav:
                        continue
                    p = os.path.join(d, fn)
                    try:
                        mt = os.path.getmtime(p)
                    except Exception:
                        mt = 0
                    has_meta = os.path.exists(os.path.join(meta_dir, key + ".json"))
                    items.append((mt, fn, is_fav, has_meta))
            items.sort(reverse=True)
        return web.json_response({
            "videos": [
                {"filename": fn, "subfolder": SUBFOLDER, "type": "output",
                 "mtime": mt, "favorite": is_fav, "has_meta": has_meta}
                for mt, fn, is_fav, has_meta in items[:400]
            ]
        })
    except Exception as e:
        return web.json_response({"videos": [], "error": str(e)})


@PromptServer.instance.routes.post("/minimaxh3/save_meta")
async def mmh3_save_meta(request):
    """Store the generation settings (prompt, refs, LoRA, sampler…) for a rendered clip
    so the gallery detail view can show them and 'Load settings into UI' can restore them."""
    try:
        data = await request.json()
        filename = (data or {}).get("filename", "")
        subfolder = (data or {}).get("subfolder", "") or SUBFOLDER
        meta = (data or {}).get("meta", {})
        if not filename:
            return web.json_response({"ok": False, "error": "no filename"})
        out = _get_output_dir()
        try:
            vpath = _safe_resolve_output_path(out, subfolder, filename)
        except ValueError:
            return web.json_response({"ok": False, "error": "invalid path"}, status=400)
        if not os.path.exists(vpath):
            return web.json_response({"ok": False, "error": f"not found: {filename}"})
        ok = _write_json_meta(vpath, meta)
        if ok and meta.get("favorite") is True:
            _favorites_add(filename)
        return web.json_response({"ok": ok, "filename": filename})
    except Exception as e:
        print(f"[MMH3] save_meta error: {e}")
        return web.json_response({"ok": False, "error": str(e)})


@PromptServer.instance.routes.get("/minimaxh3/meta")
async def mmh3_get_meta(request):
    """Read a clip's stored settings sidecar (favorite flag merged from the fast index)."""
    filename = request.query.get("filename", "")
    subfolder = request.query.get("subfolder", "") or SUBFOLDER
    if not filename:
        return web.json_response({"ok": False, "error": "no filename"})
    out = _get_output_dir()
    try:
        vpath = _safe_resolve_output_path(out, subfolder, filename)
    except ValueError:
        return web.json_response({"ok": False, "error": "invalid path"}, status=400)
    meta = _read_json_meta(vpath)
    fav = _fav_key(filename) in _load_favorites()
    if meta is None:
        # No settings saved, but still report favorite state so the heart is correct.
        return web.json_response({"ok": False, "error": "no metadata", "favorite": fav})
    meta = dict(meta)
    meta["favorite"] = fav or (meta.get("favorite") is True)
    return web.json_response({"ok": True, "meta": meta})


@PromptServer.instance.routes.post("/minimaxh3/update_meta")
async def mmh3_update_meta(request):
    """Patch a clip's sidecar (used for the favorite toggle). Keeps the fast index in sync."""
    try:
        data = await request.json()
        filename = (data or {}).get("filename", "")
        subfolder = (data or {}).get("subfolder", "") or SUBFOLDER
        patch = (data or {}).get("patch", {})
        if not filename or not isinstance(patch, dict):
            return web.json_response({"ok": False, "error": "bad request"})
        out = _get_output_dir()
        try:
            vpath = _safe_resolve_output_path(out, subfolder, filename)
        except ValueError:
            return web.json_response({"ok": False, "error": "invalid path"}, status=400)
        existing = _read_json_meta(vpath) or {}
        existing.update(patch)
        ok = _write_json_meta(vpath, existing)
        if "favorite" in patch:
            if patch["favorite"] is True:
                _favorites_add(filename)
            else:
                _favorites_remove(filename)
            ok = True  # favorite state is tracked even if there's no sidecar to write
        return web.json_response({"ok": ok})
    except Exception as e:
        print(f"[MMH3] update_meta error: {e}")
        return web.json_response({"ok": False, "error": str(e)})


@PromptServer.instance.routes.post("/minimaxh3/delete")
async def mmh3_delete(request):
    """Delete a rendered clip and its settings sidecar; drop it from favorites."""
    try:
        data = await request.json()
        filename = (data or {}).get("filename", "")
        subfolder = (data or {}).get("subfolder", "") or SUBFOLDER
        if not filename:
            return web.json_response({"ok": False, "error": "no filename"})
        out = _get_output_dir()
        try:
            vpath = _safe_resolve_output_path(out, subfolder, filename)
        except ValueError:
            return web.json_response({"ok": False, "error": "invalid path"}, status=400)
        if os.path.exists(vpath):
            try:
                os.remove(vpath)
            except Exception as e:
                return web.json_response({"ok": False, "error": str(e)}, status=500)
        mp = _meta_path(vpath)
        if os.path.exists(mp):
            try:
                os.remove(mp)
            except Exception:
                pass
        _favorites_remove(filename)
        return web.json_response({"ok": True})
    except Exception as e:
        return web.json_response({"ok": False, "error": str(e)})


@PromptServer.instance.routes.post("/minimaxh3/stage")
async def mmh3_stage(request):
    """Copy a rendered video from the output dir into the input dir so LoadVideo (which
    only reads the input directory) can consume it for the Upscale tab."""
    try:
        data = await request.json()
        fn = (data or {}).get("filename")
        sub = (data or {}).get("subfolder", "") or ""
        if not fn:
            return web.json_response({"ok": False, "error": "no filename"}, status=400)
        out = _get_output_dir()
        candidates = [
            os.path.join(out, sub, fn) if sub else os.path.join(out, fn),
            os.path.join(out, SUBFOLDER, os.path.basename(fn)),
            os.path.join(out, fn),
        ]
        src = next((p for p in candidates if os.path.exists(p)), None)
        if not src:
            return web.json_response({"ok": False, "error": "source not found"}, status=404)
        try:
            indir = folder_paths.get_input_directory()
        except Exception:
            indir = os.path.join(os.path.dirname(NODE_DIR), "input")
        os.makedirs(indir, exist_ok=True)
        base = os.path.basename(fn)
        import shutil
        shutil.copy2(src, os.path.join(indir, base))
        return web.json_response({"ok": True, "name": base})
    except Exception as e:
        return web.json_response({"ok": False, "error": str(e)}, status=500)


@PromptServer.instance.routes.post("/minimaxh3/open_folder")
async def mmh3_open_folder(request):
    """Open the MiniMax H3 output folder in the OS file browser. If a filename is given,
    reveal (select) that specific clip instead of just opening the folder."""
    try:
        try:
            data = await request.json()
        except Exception:
            data = {}
        filename = (data or {}).get("filename", "")
        subfolder = (data or {}).get("subfolder", "") or SUBFOLDER
        out = os.path.join(_get_output_dir(), SUBFOLDER)
        os.makedirs(out, exist_ok=True)
        reveal = None
        if filename:
            try:
                cand = _safe_resolve_output_path(_get_output_dir(), subfolder, filename)
                if os.path.exists(cand):
                    reveal = cand
            except ValueError:
                reveal = None
        import platform
        import subprocess as _sp
        system = platform.system()
        if system == "Windows":
            if reveal:
                _sp.Popen(["explorer", "/select,", reveal.replace("/", "\\")])
            else:
                _sp.Popen(["explorer", out.replace("/", "\\")])
        elif system == "Darwin":
            _sp.Popen(["open", "-R", reveal] if reveal else ["open", out])
        else:
            _sp.Popen(["xdg-open", os.path.dirname(reveal) if reveal else out])
        return web.json_response({"ok": True})
    except Exception as e:
        return web.json_response({"ok": False, "error": str(e)})


# ── Node registration ─────────────────────────────────────────────────────────
class MiniMaxH3OneNode:
    """Output no-op host for the in-node MiniMax H3 video+audio panel
    (web/minimaxh3_one_node.js)."""
    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {}, "hidden": {"unique_id": "UNIQUE_ID"}}
    RETURN_TYPES = ()
    FUNCTION = "noop"
    CATEGORY = "MiniMaxH3-OneNode"
    OUTPUT_NODE = True

    def noop(self, **kwargs):
        return {}

    @classmethod
    def IS_CHANGED(cls, **kwargs):
        return float("nan")


NODE_CLASS_MAPPINGS = {
    "MiniMaxH3OneNode": MiniMaxH3OneNode,
}
NODE_DISPLAY_NAME_MAPPINGS = {
    "MiniMaxH3OneNode": "One Node · MiniMax H3 (video + audio)",
}
