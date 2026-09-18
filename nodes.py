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
import hashlib
import subprocess
import tempfile
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


def _get_input_dir():
    try:
        return str(Path(folder_paths.get_input_directory()).resolve())
    except Exception:
        return str(Path(os.path.join(os.path.dirname(NODE_DIR), "input")).resolve())


def _safe_resolve_input_path(filename=""):
    """Resolve a ComfyUI input-relative filename without allowing path escape."""
    base = Path(_get_input_dir()).resolve()
    target = (base / str(filename or "")).resolve()
    if target != base and base not in target.parents:
        raise ValueError("invalid input path")
    return str(target)


def _find_ffprobe():
    """Find a runnable ffprobe without depending on StabilityMatrix's PATH."""
    candidates = []

    def add(path):
        if path and path not in candidates:
            candidates.append(path)

    add(shutil.which("ffprobe"))
    for path in (os.environ.get("CSGLIDE_FFMPEG"),
                 os.environ.get("FFMPEG_BINARY"),
                 shutil.which("ffmpeg")):
        if path:
            add(os.path.join(os.path.dirname(path), "ffprobe.exe"))
            add(os.path.join(os.path.dirname(path), "ffprobe"))
    try:
        import imageio_ffmpeg as _iff
        path = _iff.get_ffmpeg_exe()
        if path:
            add(os.path.join(os.path.dirname(path), "ffprobe.exe"))
            add(os.path.join(os.path.dirname(path), "ffprobe"))
    except Exception:
        pass
    try:
        data_root = Path(NODE_DIR).resolve().parents[3]
        add(str(data_root / "Assets" / "ffmpeg" / "bin" / "ffprobe.exe"))
    except Exception:
        pass
    for pat in (r"%LOCALAPPDATA%\Microsoft\WinGet\Packages\Gyan.FFmpeg*\**\ffprobe.exe",
                r"%ProgramFiles%\ffmpeg\**\ffprobe.exe"):
        try:
            for path in glob.glob(os.path.expandvars(pat), recursive=True):
                add(path)
        except Exception:
            pass
    for path in candidates:
        try:
            if path and os.path.exists(path):
                result = subprocess.run([path, "-version"], capture_output=True,
                                        text=True, timeout=8)
                if result.returncode == 0:
                    return path
        except Exception:
            pass
    return None


def _find_ffmpeg():
    """Find a full, runnable ffmpeg without trusting StabilityMatrix's PATH.

    The One Node and CGlide are frequently launched with a stripped PATH.  The
    Studio seam path is intentionally ffmpeg-based (rather than decoding two
    finished 2K clips into Python tensors), so it needs the same robust lookup
    policy as Director.
    """
    candidates = []

    def add(path):
        if path and path not in candidates:
            candidates.append(path)

    for path in (os.environ.get("CSGLIDE_FFMPEG"),
                 os.environ.get("FFMPEG_BINARY"),
                 shutil.which("ffmpeg")):
        add(path)
    try:
        import imageio_ffmpeg as _iff
        add(_iff.get_ffmpeg_exe())
    except Exception:
        pass
    try:
        data_root = Path(NODE_DIR).resolve().parents[3]
        add(str(data_root / "Assets" / "ffmpeg" / "bin" / "ffmpeg.exe"))
    except Exception:
        pass
    for pat in (r"%LOCALAPPDATA%\Microsoft\WinGet\Packages\Gyan.FFmpeg*\**\ffmpeg.exe",
                r"%ProgramFiles%\ffmpeg\**\ffmpeg.exe"):
        try:
            for path in glob.glob(os.path.expandvars(pat), recursive=True):
                add(path)
        except Exception:
            pass
    for path in candidates:
        try:
            if path and os.path.exists(path):
                result = subprocess.run([path, "-version"], capture_output=True,
                                        text=True, timeout=8)
                if result.returncode == 0:
                    return path
        except Exception:
            pass
    return None


def _ratio_to_float(value, default=0.0):
    try:
        text = str(value or "").strip()
        if "/" in text:
            num, den = text.split("/", 1)
            den = float(den)
            return float(num) / den if den else float(default)
        return float(text)
    except Exception:
        return float(default)


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
        # Never claim a delete succeeded when the path was stale or resolved to a
        # different location.  The old success response made the frontend remove
        # the thumbnail temporarily, only for it to return after a gallery refresh.
        if not os.path.isfile(vpath):
            return web.json_response({
                "ok": False,
                "error": f"File not found in the H3 gallery: {filename}. Refresh the gallery and try again."
            }, status=404)
        try:
            os.remove(vpath)
        except PermissionError:
            return web.json_response({
                "ok": False,
                "error": "Windows still has this clip open. Close any player/editor using it, then try Delete again."
            }, status=409)
        except Exception as e:
            return web.json_response({"ok": False, "error": f"Could not delete {filename}: {e}"}, status=500)
        mp = _meta_path(vpath)
        warning = ""
        if os.path.exists(mp):
            try:
                os.remove(mp)
            except Exception as e:
                # The clip is gone either way.  Keep the sidecar warning visible
                # in the route response for a future cleanup, rather than lying.
                warning = f"Clip deleted, but its metadata sidecar could not be removed: {e}"
        _favorites_remove(filename)
        return web.json_response({"ok": True, "filename": filename, "warning": warning})
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


@PromptServer.instance.routes.post("/minimaxh3/stage_repair")
async def mmh3_stage_repair(request):
    """Stage an output clip under a collision-proof input name for H3 Repair.

    The general Upscale path keeps its legacy staging behavior. Repair uses a
    content/version-derived name so selecting two same-named gallery clips can
    never silently overwrite the source plate that will be masked. On NTFS it
    uses a hard-link first, so an output-gallery clip becomes immediately
    available to LoadVideo without copying hundreds of MB into input; a normal
    byte-for-byte copy remains the safe fallback for other filesystems.
    """
    try:
        data = await request.json() or {}
        fn = str(data.get("filename") or "")
        sub = str(data.get("subfolder") or "")
        if not fn:
            return web.json_response({"ok": False, "error": "no filename"}, status=400)
        out = _get_output_dir()
        candidates = []
        for folder, name in ((sub, fn), (SUBFOLDER, os.path.basename(fn)), ("", fn)):
            try:
                candidates.append(_safe_resolve_output_path(out, folder, name))
            except ValueError:
                pass
        src = next((p for p in candidates if os.path.isfile(p)), None)
        if not src:
            return web.json_response({"ok": False, "error": "source not found"}, status=404)
        stat = os.stat(src)
        stamp = hashlib.sha1((str(Path(src).resolve()) + "|" + str(stat.st_size) + "|" + str(stat.st_mtime_ns)).encode("utf-8")).hexdigest()[:12]
        staged_name = "__mmh3_repair_%s_%s" % (stamp, os.path.basename(src))
        dest = _safe_resolve_input_path(staged_name)
        os.makedirs(_get_input_dir(), exist_ok=True)
        if not os.path.isfile(dest) or os.path.getsize(dest) != stat.st_size:
            # Write a temporary link/copy and atomically replace stale staging.  A hard-link is
            # ideal here: source and input are normally on the same ComfyUI NTFS volume, the
            # source is never altered, and the next UI step can start without a large duplicate
            # copy. Network/cross-volume installs simply take the copy fallback.
            tmp = dest + ".stage_tmp"
            try:
                if os.path.exists(tmp):
                    os.remove(tmp)
                try:
                    os.link(src, tmp)
                except OSError:
                    shutil.copy2(src, tmp)
                os.replace(tmp, dest)
            finally:
                if os.path.exists(tmp):
                    try:
                        os.remove(tmp)
                    except OSError:
                        pass
        return web.json_response({"ok": True, "name": staged_name})
    except ValueError as e:
        return web.json_response({"ok": False, "error": str(e)}, status=400)
    except Exception as e:
        return web.json_response({"ok": False, "error": str(e)}, status=500)


@PromptServer.instance.routes.post("/minimaxh3/stage_studio_asset")
async def mmh3_stage_studio_asset(request):
    """Stage a gallery clip for CGlide H3 Studio without filename collisions.

    CGlide deliberately resolves Studio assets from ComfyUI's input area.  A
    final Studio clip lives in output, so this bridge copies it under a
    version-derived input name before it is used as the next shot's tail guide.
    The original final clip remains untouched and is still the file used by the
    streaming seam encoder after the new render finishes.
    """
    try:
        data = await request.json() or {}
        fn = str(data.get("filename") or "")
        sub = str(data.get("subfolder") or "")
        if not fn:
            return web.json_response({"ok": False, "error": "no filename"}, status=400)
        out = _get_output_dir()
        candidates = []
        for folder, name in ((sub, fn), (SUBFOLDER, os.path.basename(fn)), ("", fn)):
            try:
                candidates.append(_safe_resolve_output_path(out, folder, name))
            except ValueError:
                pass
        src = next((p for p in candidates if os.path.isfile(p)), None)
        if not src:
            return web.json_response({"ok": False, "error": "source not found"}, status=404)
        stat = os.stat(src)
        stamp = hashlib.sha1(
            (str(Path(src).resolve()) + "|" + str(stat.st_size) + "|" + str(stat.st_mtime_ns)).encode("utf-8")
        ).hexdigest()[:12]
        staged_name = "__mmh3_studio_%s_%s" % (stamp, os.path.basename(src))
        dest = _safe_resolve_input_path(staged_name)
        os.makedirs(_get_input_dir(), exist_ok=True)
        if not os.path.isfile(dest) or os.path.getsize(dest) != stat.st_size:
            shutil.copy2(src, dest)
        return web.json_response({"ok": True, "name": staged_name})
    except ValueError as e:
        return web.json_response({"ok": False, "error": str(e)}, status=400)
    except Exception as e:
        return web.json_response({"ok": False, "error": str(e)}, status=500)


@PromptServer.instance.routes.post("/minimaxh3/probe_media")
async def mmh3_probe_media(request):
    """Return an H3-safe canvas/length plus audio presence for one input video."""
    try:
        data = await request.json() or {}
        rel = str(data.get("file") or "")
        if not rel:
            return web.json_response({"ok": False, "error": "no input video selected"}, status=400)
        path = _safe_resolve_input_path(rel)
        if not os.path.isfile(path):
            return web.json_response({"ok": False, "error": "input video not found"}, status=404)
        ffprobe = _find_ffprobe()
        if not ffprobe:
            return web.json_response({"ok": False, "error": "ffprobe was not found; install a full ffmpeg build or set FFMPEG_BINARY."}, status=500)
        result = subprocess.run(
            [ffprobe, "-v", "error", "-show_streams", "-show_format", "-of", "json", path],
            capture_output=True, text=True, timeout=30,
        )
        if result.returncode != 0:
            raise RuntimeError((result.stderr or "ffprobe failed").strip())
        probe = json.loads(result.stdout or "{}")
        streams = probe.get("streams") or []
        video = next((s for s in streams if s.get("codec_type") == "video"), None)
        if not video:
            return web.json_response({"ok": False, "error": "the selected file has no video stream"}, status=400)
        width, height = int(video.get("width") or 0), int(video.get("height") or 0)
        if width < 32 or height < 32:
            return web.json_response({"ok": False, "error": "the selected video has an invalid canvas"}, status=400)
        fps = _ratio_to_float(video.get("avg_frame_rate"), 0.0) or _ratio_to_float(video.get("r_frame_rate"), 24.0)
        fps = fps if fps > 0.0 else 24.0
        duration = _ratio_to_float(video.get("duration"), 0.0) or _ratio_to_float((probe.get("format") or {}).get("duration"), 0.0)
        try:
            source_frames = int(video.get("nb_frames") or 0)
        except Exception:
            source_frames = 0
        timeline_frames = int((source_frames * 24.0 / fps) + 1e-6) if source_frames > 0 else int((duration * 24.0) + 1e-6)
        h3_frames = 5 + 17 * ((timeline_frames - 5) // 17) if timeline_frames >= 5 else 0
        if h3_frames < 5:
            return web.json_response({"ok": False, "error": "the clip is too short for H3 repair (needs at least 5 frames)"}, status=400)
        # Keep repair inside H3's trained canvas. Larger source clips are deliberately
        # normalized here rather than passed through at 2K/4K and crashing a 16GB card.
        # Preserve a smaller source canvas exactly, apart from the required 32px alignment.
        max_pixels = 768 * 1344
        target_w = max(32, width - (width % 32))
        target_h = max(32, height - (height % 32))
        shortest = min(target_w, target_h)
        scale = min(
            1.0,
            768.0 / float(shortest),
            (max_pixels / float(target_w * target_h)) ** 0.5,
        )
        if scale < 0.999999:
            target_w = max(32, int((target_w * scale) // 32) * 32)
            target_h = max(32, int((target_h * scale) // 32) * 32)
        while target_w * target_h > max_pixels or min(target_w, target_h) > 768:
            if target_w >= target_h and target_w > 32:
                target_w -= 32
            elif target_h > 32:
                target_h -= 32
            else:
                break
        # H3 accepts frame counts 5 mod 17. This tab is intentionally one source
        # shot, so cap it at the normal 15-second H3 maximum instead of inventing
        # frames or making an unsafe multi-shot repair behind the user's back.
        h3_frames = min(362, h3_frames)
        has_audio = any(s.get("codec_type") == "audio" for s in streams)
        return web.json_response({
            "ok": True,
            "source_width": width,
            "source_height": height,
            "width": target_w,
            "height": target_h,
            "source_fps": fps,
            "source_duration": duration,
            "timeline_frames": timeline_frames,
            "h3_frames": h3_frames,
            "duration": h3_frames / 24.0,
            "has_audio": has_audio,
            "canvas_adjusted": (target_w != width or target_h != height),
            "trimmed_frames": max(0, timeline_frames - h3_frames),
            "max_h3_frames": 362,
        })
    except ValueError as e:
        return web.json_response({"ok": False, "error": str(e)}, status=400)
    except Exception as e:
        return web.json_response({"ok": False, "error": str(e)}, status=500)

@PromptServer.instance.routes.post("/minimaxh3/assemble")
async def mmh3_assemble(request):
    """H3 Director — assemble an ordered shot list into one master video with ffmpeg.
    Each shot is normalized to W×H / fps and trimmed to its duration (song-locked), then
    the shots are joined by hard cut (concat) or cross-dissolve (xfade). An optional master
    audio track is muxed over the top (clip audio dropped) — song-locked, so lip-synced
    shots stay aligned to the track. Mirrors the proven scratchpad MV-assembly pipeline."""
    import subprocess as _sp
    import tempfile
    try:
        data = await request.json() or {}
        shots = data.get("shots") or []
        audio = data.get("audio")
        W = int(data.get("width") or 3840)
        H = int(data.get("height") or 2160)
        fps = int(data.get("fps") or 24)
        crf = int(data.get("crf") or 16)
        prefix = (data.get("prefix") or "H3_Director").strip() or "H3_Director"
        if not shots:
            return web.json_response({"ok": False, "error": "no shots in the list"}, status=400)

        out = _get_output_dir()
        try:
            indir = folder_paths.get_input_directory()
        except Exception:
            indir = os.path.join(os.path.dirname(NODE_DIR), "input")
        # ── locate an ffmpeg with a usable H.264 encoder. shutil.which() can resolve to a
        # minimal build lacking libx264 (StabilityMatrix launches with its own PATH), so gather
        # candidates + probe -encoders, preferring libx264, then h264_nvenc (NVIDIA), then
        # libopenh264, then mpeg4 (built-in, universal). ──
        cands = []
        for _e in (os.environ.get("CSGLIDE_FFMPEG"), os.environ.get("FFMPEG_BINARY"), shutil.which("ffmpeg")):
            if _e and _e not in cands:
                cands.append(_e)
        try:
            import imageio_ffmpeg as _iff
            _p = _iff.get_ffmpeg_exe()
            if _p and _p not in cands:
                cands.append(_p)
        except Exception:
            pass
        for _pat in (r"%LOCALAPPDATA%\Microsoft\WinGet\Packages\Gyan.FFmpeg*\**\ffmpeg.exe",
                     r"%ProgramFiles%\ffmpeg\**\ffmpeg.exe"):
            try:
                for _p in glob.glob(os.path.expandvars(_pat), recursive=True):
                    if _p not in cands:
                        cands.append(_p)
            except Exception:
                pass
        if not cands:
            cands = ["ffmpeg"]

        def _encoders(binp):
            try:
                return _sp.run([binp, "-hide_banner", "-encoders"], capture_output=True, text=True).stdout or ""
            except Exception:
                return None

        _q = {
            "libx264":     ["-crf", str(crf), "-preset", "fast"],
            "h264_nvenc":  ["-rc", "vbr", "-cq", str(crf), "-b:v", "0", "-preset", "p5"],
            "libopenh264": ["-q:v", "22"],
            "mpeg4":       ["-q:v", "3"],
        }
        ff = None
        venc = None
        venc_args = None
        _probed = []
        for c in cands:
            e = _encoders(c)
            if e is None:
                continue
            _probed.append((c, e))
            if "libx264" in e:
                ff, venc, venc_args = c, "libx264", _q["libx264"]
                break
        if ff is None:
            if not _probed:
                return web.json_response({"ok": False, "error": "no runnable ffmpeg found — install ffmpeg (with libx264) or set FFMPEG_BINARY to a full build."}, status=500)
            c, e = _probed[0]
            ff = c
            for name in ("h264_nvenc", "libopenh264", "mpeg4"):
                if name in e:
                    venc, venc_args = name, _q[name]
                    break
            if venc is None:
                venc, venc_args = "mpeg4", _q["mpeg4"]
        ffprobe = shutil.which("ffprobe")
        if not ffprobe:
            _cand = os.path.join(os.path.dirname(ff), "ffprobe.exe")
            ffprobe = _cand if os.path.exists(_cand) else "ffprobe"

        # ── export format preset (pro delivery for DaVinci): 8-bit H.264 (default),
        # 10-bit H.264, ProRes 422 HQ (.mov), or FFV1 lossless (.mkv). Each falls back
        # to plain H.264 if the chosen ffmpeg lacks the encoder. ──
        _enc = next((e for (c, e) in _probed if c == ff), "")
        fmt = (data.get("fmt") or "h264").strip()
        pix = "yuv420p"
        ext = "mp4"
        aud_args = ["-c:a", "aac", "-b:a", "320k"]
        if fmt == "h264_10" and venc == "libx264":
            pix = "yuv420p10le"
        elif fmt == "prores" and "prores_ks" in _enc:
            venc, venc_args, pix, ext = "prores_ks", ["-profile:v", "3"], "yuv422p10le", "mov"
        elif fmt == "ffv1" and "ffv1" in _enc:
            venc, venc_args, pix, ext = "ffv1", ["-level", "3", "-g", "1"], "yuv420p", "mkv"
            aud_args = ["-c:a", "flac"]

        def _resolve(it):
            if not it:
                return None
            fn = it.get("filename")
            sub = it.get("subfolder", "") or ""
            if not fn:
                return None
            if it.get("input"):
                p = os.path.join(indir, os.path.basename(it.get("raw") or fn))
                return p if os.path.exists(p) else None
            cands = [
                os.path.join(out, sub, fn) if sub else os.path.join(out, fn),
                os.path.join(out, SUBFOLDER, os.path.basename(fn)),
                os.path.join(out, fn),
            ]
            return next((p for p in cands if os.path.exists(p)), None)

        work = tempfile.mkdtemp(prefix="mmh3dir_")
        try:
            vf = ("scale=%d:%d:force_original_aspect_ratio=increase,"
                  "crop=%d:%d,fps=%d,setsar=1" % (W, H, W, H, fps))
            # If no master track is set, each shot's OWN audio must survive the assembly —
            # the UI hint literally promises "No track — clip audio kept". Extract + duration-match
            # each clip's audio alongside its video segment; silence-pad any shot that genuinely
            # has no audio stream so every segment pair stays 1:1 for the concat/xfade step below.
            have_master_audio = bool(audio)
            segs = []
            asegs = []
            for i, sh in enumerate(shots):
                src = _resolve(sh)
                if not src:
                    return web.json_response({"ok": False, "error": "shot %d not found: %s" % (i + 1, sh.get("filename"))}, status=404)
                dur = sh.get("dur")
                seg = os.path.join(work, "seg_%03d.mp4" % i)
                cmd = [ff, "-y", "-i", src]
                if dur and float(dur) > 0:
                    cmd += ["-t", str(float(dur))]
                cmd += ["-vf", vf, "-an", "-c:v", venc] + venc_args + \
                       ["-pix_fmt", pix, seg, "-hide_banner", "-loglevel", "error"]
                r = _sp.run(cmd, capture_output=True, text=True)
                if r.returncode != 0 or not os.path.exists(seg):
                    return web.json_response({"ok": False, "error": "shot %d encode failed: %s" % (i + 1, (r.stderr or "")[-400:])}, status=500)
                segs.append(seg)

                if not have_master_audio:
                    shot_dur = float(dur) if (dur and float(dur) > 0) else None
                    if shot_dur is None:
                        pr = _sp.run([ffprobe, "-v", "error", "-show_entries", "format=duration",
                                      "-of", "csv=p=0", src], capture_output=True, text=True)
                        try:
                            shot_dur = float(pr.stdout.strip())
                        except Exception:
                            shot_dur = 1.0
                    hasa = _sp.run([ffprobe, "-v", "error", "-select_streams", "a", "-show_entries",
                                     "stream=index", "-of", "csv=p=0", src], capture_output=True, text=True)
                    aseg = os.path.join(work, "aseg_%03d.m4a" % i)
                    if (hasa.stdout or "").strip():
                        acmd = [ff, "-y", "-i", src, "-t", str(shot_dur), "-vn",
                                "-c:a", "aac", "-b:a", "320k", "-ar", "48000", "-ac", "2",
                                aseg, "-hide_banner", "-loglevel", "error"]
                    else:
                        # genuinely silent source clip — pad with true silence so timing still lines up
                        acmd = [ff, "-y", "-f", "lavfi", "-i", "anullsrc=r=48000:cl=stereo",
                                "-t", str(shot_dur), "-c:a", "aac", "-b:a", "320k",
                                aseg, "-hide_banner", "-loglevel", "error"]
                    ar = _sp.run(acmd, capture_output=True, text=True)
                    if ar.returncode != 0 or not os.path.exists(aseg):
                        return web.json_response({"ok": False, "error": "shot %d audio extract failed: %s" % (i + 1, (ar.stderr or "")[-400:])}, status=500)
                    asegs.append(aseg)

            silent = os.path.join(work, "video_silent.mkv")  # universal container: holds h264/prores/ffv1 for concat
            want_xfade = len(segs) > 1 and any((sh.get("seam") == "dissolve") for sh in shots[:-1])
            if want_xfade:
                fd = float(data.get("dissolve") or 0.4)
                durs = []
                for s in segs:
                    pr = _sp.run([ffprobe, "-v", "error", "-show_entries", "format=duration",
                                  "-of", "csv=p=0", s], capture_output=True, text=True)
                    try:
                        durs.append(float(pr.stdout.strip()))
                    except Exception:
                        durs.append(0.0)
                inputs = []
                for s in segs:
                    inputs += ["-i", s]
                fc = ""
                prev = "0:v"
                off = 0.0
                for i in range(1, len(segs)):
                    off += durs[i - 1] - fd
                    lbl = "x%d" % i
                    fc += "[%s][%d:v]xfade=transition=fade:duration=%s:offset=%.3f[%s];" % (prev, i, fd, off, lbl)
                    prev = lbl
                fc = fc.rstrip(";")
                cmd = [ff, "-y"] + inputs + ["-filter_complex", fc, "-map", "[%s]" % prev,
                       "-c:v", venc] + venc_args + \
                      ["-pix_fmt", pix, silent, "-hide_banner", "-loglevel", "error"]
                r = _sp.run(cmd, capture_output=True, text=True)
                if r.returncode != 0 or not os.path.exists(silent):
                    return web.json_response({"ok": False, "error": "dissolve/xfade failed: %s" % ((r.stderr or "")[-400:])}, status=500)

                # mirror the exact same crossfade timing for the per-clip audio track
                if not have_master_audio:
                    clip_audio = os.path.join(work, "clip_audio.m4a")
                    ainputs = []
                    for s in asegs:
                        ainputs += ["-i", s]
                    afc = ""
                    aprev = "0:a"
                    aoff = 0.0
                    for i in range(1, len(asegs)):
                        aoff += durs[i - 1] - fd
                        albl = "ax%d" % i
                        afc += "[%s][%d:a]acrossfade=d=%s[%s];" % (aprev, i, fd, albl)
                        aprev = albl
                    afc = afc.rstrip(";")
                    acmd = [ff, "-y"] + ainputs + ["-filter_complex", afc, "-map", "[%s]" % aprev,
                            "-c:a", "aac", "-b:a", "320k", clip_audio, "-hide_banner", "-loglevel", "error"]
                    ar = _sp.run(acmd, capture_output=True, text=True)
                    if ar.returncode != 0 or not os.path.exists(clip_audio):
                        return web.json_response({"ok": False, "error": "dissolve/acrossfade audio failed: %s" % ((ar.stderr or "")[-400:])}, status=500)
            else:
                # hard-cut concat via demuxer — relative paths + cwd=work (MSYS abs-path landmine)
                with open(os.path.join(work, "list.txt"), "w", encoding="utf-8") as f:
                    for s in segs:
                        f.write("file '%s'\n" % os.path.basename(s))
                cmd = [ff, "-y", "-f", "concat", "-safe", "0", "-i", "list.txt",
                       "-c", "copy", "video_silent.mkv", "-hide_banner", "-loglevel", "error"]
                r = _sp.run(cmd, cwd=work, capture_output=True, text=True)
                if r.returncode != 0 or not os.path.exists(silent):
                    return web.json_response({"ok": False, "error": "concat failed: %s" % ((r.stderr or "")[-400:])}, status=500)

                if not have_master_audio:
                    clip_audio = os.path.join(work, "clip_audio.m4a")
                    with open(os.path.join(work, "alist.txt"), "w", encoding="utf-8") as f:
                        for s in asegs:
                            f.write("file '%s'\n" % os.path.basename(s))
                    acmd = [ff, "-y", "-f", "concat", "-safe", "0", "-i", "alist.txt",
                            "-c:a", "aac", "-b:a", "320k", "clip_audio.m4a", "-hide_banner", "-loglevel", "error"]
                    ar = _sp.run(acmd, cwd=work, capture_output=True, text=True)
                    if ar.returncode != 0 or not os.path.exists(clip_audio):
                        return web.json_response({"ok": False, "error": "clip audio concat failed: %s" % ((ar.stderr or "")[-400:])}, status=500)

            outdir = os.path.join(out, SUBFOLDER)
            os.makedirs(outdir, exist_ok=True)
            n = 1
            while True:
                name = "%s_%05d.%s" % (prefix, n, ext)
                dst = os.path.join(outdir, name)
                if not os.path.exists(dst):
                    break
                n += 1

            # master track wins if set (song-locked MV path, clip audio intentionally dropped);
            # otherwise mux the per-clip audio track built above — "No track — clip audio kept"
            # is what the UI promises, so this path must never emit a silent file.
            apath = _resolve(audio) if audio else None
            if apath:
                cmd = [ff, "-y", "-i", silent, "-i", apath, "-map", "0:v", "-map", "1:a",
                       "-c:v", "copy"] + aud_args + ["-shortest",
                       dst, "-hide_banner", "-loglevel", "error"]
            elif not have_master_audio:
                cmd = [ff, "-y", "-i", silent, "-i", os.path.join(work, "clip_audio.m4a"),
                       "-map", "0:v", "-map", "1:a", "-c:v", "copy"] + aud_args + \
                      ["-shortest", dst, "-hide_banner", "-loglevel", "error"]
            else:
                cmd = [ff, "-y", "-i", silent, "-c", "copy", dst, "-hide_banner", "-loglevel", "error"]
            r = _sp.run(cmd, capture_output=True, text=True)
            if r.returncode != 0 or not os.path.exists(dst):
                return web.json_response({"ok": False, "error": "final mux failed: %s" % ((r.stderr or "")[-400:])}, status=500)

            return web.json_response({"ok": True, "name": name, "subfolder": SUBFOLDER, "type": "output"})
        finally:
            shutil.rmtree(work, ignore_errors=True)
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
class MMH3StudioSafeJoin:
    """Join an H3 Studio continuation without materialising both clips in RAM.

    CGlide's native Glide Join is excellent at the generation canvas, but it
    intentionally loads decoded source frames to perform its level matching.
    At 1080/2K that can turn one 15-second source into tens of GB of Python
    tensors.  This output node keeps CGlide's continuity anchor for sampling,
    then uses ffmpeg's streaming filters to perform the final replacement seam
    and audio join.  It is the safe bridge between CGlide Studio and the One
    Node's fused 16GB latent two-pass route.
    """

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "source_video": ("STRING", {
                    "default": "",
                    "tooltip": "Previous final Studio clip from H3 Studio. Empty = save one standalone shot.",
                }),
                "continuation_video": ("STRING", {
                    "default": "",
                    "tooltip": "The freshly encoded Studio result. Normally wired from Glide Video.",
                }),
                "overlap_frames": ("INT", {
                    "default": 22, "min": 0, "max": 4096,
                    "tooltip": "Must match H3 Studio's continuation overlap output.",
                }),
                "fps": ("FLOAT", {
                    "default": 24.0, "min": 1.0, "max": 240.0, "step": 0.001,
                }),
                "seam_mode": (["early_cut", "early_scurve", "hard_cut"], {
                    "default": "early_cut",
                    "tooltip": "early_cut replaces the old tail with H3's anchored head; hard_cut keeps the old tail.",
                }),
                "seam_blend_frames": ("INT", {
                    "default": 6, "min": 1, "max": 64,
                    "tooltip": "Soft-seam length for early_scurve. Ignored for the other modes.",
                }),
                "filename_prefix": ("STRING", {
                    "default": "H3_Studio",
                    "tooltip": "Final MP4 name under output/ComfyUI-MiniMaxH3-OneNode.",
                }),
            }
        }

    RETURN_TYPES = ("STRING",)
    RETURN_NAMES = ("filepath",)
    FUNCTION = "join"
    CATEGORY = "MiniMaxH3-OneNode/Studio"
    OUTPUT_NODE = True

    @staticmethod
    def _resolve_media(raw, label):
        text = str(raw or "").strip()
        if not text:
            return ""
        direct = Path(text)
        if direct.is_file():
            return str(direct.resolve())
        # CGlide Studio assets live in input.  Do not permit a relative path
        # to climb out of ComfyUI's input folder.
        try:
            staged = _safe_resolve_input_path(text)
            if os.path.isfile(staged):
                return staged
        except ValueError:
            pass
        raise ValueError("H3 Studio safe join: %s clip was not found: %s" % (label, text))

    @staticmethod
    def _probe(path, ffprobe):
        result = subprocess.run(
            [ffprobe, "-v", "error", "-show_streams", "-show_format", "-of", "json", path],
            capture_output=True, text=True, timeout=45,
        )
        if result.returncode != 0:
            raise RuntimeError((result.stderr or "ffprobe failed").strip())
        data = json.loads(result.stdout or "{}")
        streams = data.get("streams") or []
        video = next((s for s in streams if s.get("codec_type") == "video"), None)
        if not video:
            raise ValueError("H3 Studio safe join: %s has no video stream" % os.path.basename(path))
        width, height = int(video.get("width") or 0), int(video.get("height") or 0)
        fps = _ratio_to_float(video.get("avg_frame_rate"), 0.0) or _ratio_to_float(video.get("r_frame_rate"), 24.0)
        duration = _ratio_to_float(video.get("duration"), 0.0) or _ratio_to_float((data.get("format") or {}).get("duration"), 0.0)
        frames = 0
        try:
            counted = subprocess.run(
                [ffprobe, "-v", "error", "-select_streams", "v:0", "-count_frames",
                 "-show_entries", "stream=nb_read_frames", "-of", "csv=p=0", path],
                capture_output=True, text=True, timeout=60,
            ).stdout.strip()
            frames = int(counted) if counted.isdigit() else 0
        except Exception:
            frames = 0
        if frames < 1:
            try:
                frames = int(video.get("nb_frames") or 0)
            except Exception:
                frames = 0
        if frames < 1 and duration > 0 and fps > 0:
            frames = max(1, int(round(duration * fps)))
        if frames < 1:
            raise ValueError("H3 Studio safe join: could not count frames in %s" % os.path.basename(path))
        return {
            "width": width, "height": height, "fps": float(fps or 24.0),
            "duration": float(duration or (frames / float(fps or 24.0))),
            "frames": int(frames),
            "has_audio": any(s.get("codec_type") == "audio" for s in streams),
        }

    @staticmethod
    def _next_output(prefix):
        clean = "".join(c if (c.isalnum() or c in "-_.") else "_" for c in str(prefix or "H3_Studio"))
        clean = clean.strip("._") or "H3_Studio"
        outdir = os.path.join(_get_output_dir(), SUBFOLDER)
        os.makedirs(outdir, exist_ok=True)
        n = 1
        while True:
            name = "%s_%05d.mp4" % (clean, n)
            path = os.path.join(outdir, name)
            if not os.path.exists(path):
                return path, name
            n += 1

    @staticmethod
    def _encoders(ffmpeg):
        try:
            return subprocess.run([ffmpeg, "-hide_banner", "-encoders"], capture_output=True,
                                  text=True, timeout=30).stdout or ""
        except Exception:
            return ""

    @classmethod
    def _encode_attempts(cls, ffmpeg):
        encoders = cls._encoders(ffmpeg)
        attempts = []
        # NVENC is dramatically quicker on the 5070 Ti. CQ 16 is visually
        # transparent for this final mux; libx264 CRF 15 remains the robust
        # fallback on any other CUDA/CPU setup.
        if "h264_nvenc" in encoders:
            attempts.append(["-c:v", "h264_nvenc", "-preset", "p5", "-tune", "hq",
                             "-rc", "vbr", "-cq", "16", "-b:v", "0"])
        if "libx264" in encoders:
            attempts.append(["-c:v", "libx264", "-preset", "medium", "-crf", "15"])
        if "libopenh264" in encoders:
            attempts.append(["-c:v", "libopenh264", "-q:v", "18"])
        if not attempts:
            attempts.append(["-c:v", "mpeg4", "-q:v", "2"])
        return attempts

    def join(self, source_video, continuation_video, overlap_frames, fps,
             seam_mode, seam_blend_frames, filename_prefix):
        continuation = self._resolve_media(continuation_video, "continuation")
        if not continuation:
            raise ValueError("H3 Studio safe join: no continuation video was provided")
        source = self._resolve_media(source_video, "source") if str(source_video or "").strip() else ""
        dst, name = self._next_output(filename_prefix)
        ffmpeg = _find_ffmpeg()
        ffprobe = _find_ffprobe()
        if not ffmpeg or not ffprobe:
            raise RuntimeError("H3 Studio safe join needs a full ffmpeg + ffprobe build. "
                               "Set FFMPEG_BINARY to your Gyan ffmpeg executable if ComfyUI cannot find it.")
        cont = self._probe(continuation, ffprobe)

        # A first Studio shot still needs a real MP4 delivery file. CGlide writes
        # its temporary master as ProRes .mov; copying those bytes to a .mp4 name
        # creates a misleading extension that some players reject. Re-mux/re-encode
        # once through the same fast NVENC / robust x264 path used for a seam.
        if not source:
            errors = []
            for video_args in self._encode_attempts(ffmpeg):
                try:
                    if os.path.exists(dst):
                        os.remove(dst)
                    cmd = [
                        ffmpeg, "-y", "-i", continuation,
                        "-map", "0:v:0", "-map", "0:a?", "-r", "%.6f" % float(fps or cont["fps"]),
                    ] + video_args + [
                        "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "320k",
                        "-movflags", "+faststart", "-shortest", dst,
                        "-hide_banner", "-loglevel", "error",
                    ]
                    run = subprocess.run(cmd, capture_output=True, text=True, timeout=60 * 30)
                    if run.returncode == 0 and os.path.isfile(dst) and os.path.getsize(dst) > 0:
                        print("[MMH3 Studio] saved standalone shot -> %s (%s)" % (name, " ".join(video_args[0:2])))
                        return {
                            "ui": {"mmh3_studio_video": [{
                                "filename": name, "subfolder": SUBFOLDER, "type": "output",
                                "fps": float(fps or cont["fps"]), "frames": int(cont["frames"]),
                                "width": cont["width"], "height": cont["height"],
                            }]},
                            "result": (dst,),
                        }
                    errors.append((run.stderr or "ffmpeg failed").strip()[-700:])
                except Exception as exc:
                    errors.append(str(exc))
            raise RuntimeError("H3 Studio final encode failed after every encoder attempt:\n" + "\n---\n".join(errors))

        src = self._probe(source, ffprobe)
        if src["width"] != cont["width"] or src["height"] != cont["height"]:
            raise ValueError(
                "H3 Studio safe join: previous final clip is %dx%d but the new final clip is %dx%d. "
                "Continue from the previous FINAL Studio render at the same target canvas (not its low-res draft)."
                % (src["width"], src["height"], cont["width"], cont["height"])
            )
        target_fps = float(fps or 24.0)
        if abs(src["fps"] - target_fps) > 0.25 or abs(cont["fps"] - target_fps) > 0.25:
            raise ValueError(
                "H3 Studio safe join: both clips must be %s fps. Source is %.3f and continuation is %.3f."
                % (target_fps, src["fps"], cont["fps"])
            )

        overlap = max(0, int(overlap_frames or 0))
        if overlap >= src["frames"]:
            raise ValueError("H3 Studio safe join: overlap (%d frames) is longer than the previous clip (%d frames)." % (overlap, src["frames"]))
        if overlap >= cont["frames"]:
            raise ValueError("H3 Studio safe join: overlap (%d frames) is longer than the new clip (%d frames)." % (overlap, cont["frames"]))
        mode = seam_mode if seam_mode in ("early_cut", "early_scurve", "hard_cut") else "early_cut"
        cut = max(0, src["frames"] - overlap)
        src_seconds = src["frames"] / target_fps
        cont_seconds = cont["frames"] / target_fps
        cut_seconds = cut / target_fps
        blend = min(max(1, int(seam_blend_frames or 6)), max(1, overlap))
        blend_seconds = blend / target_fps

        def audio_filter(index, duration, label, start=0.0):
            duration = max(0.001, float(duration))
            start = max(0.0, float(start))
            if (src if index == 0 else cont)["has_audio"]:
                trim = "atrim=start=%.9f:duration=%.9f" % (start, duration)
                return "[%d:a]aformat=sample_rates=48000:channel_layouts=stereo,%s,asetpts=PTS-STARTPTS[%s]" % (index, trim, label)
            return "anullsrc=r=48000:cl=stereo,atrim=duration=%.9f,asetpts=PTS-STARTPTS[%s]" % (duration, label)

        if mode == "hard_cut":
            video = (
                "[0:v]trim=end_frame=%d,setpts=PTS-STARTPTS,format=yuv420p[v0];"
                "[1:v]trim=start_frame=%d,setpts=PTS-STARTPTS,format=yuv420p[v1];"
                "[v0][v1]concat=n=2:v=1:a=0[vout]" % (src["frames"], overlap)
            )
            audio = ";".join((
                audio_filter(0, src_seconds, "a0"),
                audio_filter(1, cont_seconds - (overlap / target_fps), "a1", overlap / target_fps),
                "[a0][a1]concat=n=2:v=0:a=1[aout]",
            ))
            expected_frames = src["frames"] + cont["frames"] - overlap
        elif mode == "early_scurve":
            src_tail = min(src["frames"], cut + blend)
            src_tail_seconds = src_tail / target_fps
            video = (
                "[0:v]trim=end_frame=%d,setpts=PTS-STARTPTS,format=yuv420p[v0];"
                "[1:v]setpts=PTS-STARTPTS,format=yuv420p[v1];"
                "[v0][v1]xfade=transition=fade:duration=%.9f:offset=%.9f[vout]"
                % (src_tail, blend_seconds, cut_seconds)
            )
            audio = ";".join((
                audio_filter(0, src_tail_seconds, "a0"),
                audio_filter(1, cont_seconds, "a1"),
                "[a0][a1]acrossfade=d=%.9f:c1=tri:c2=tri[aout]" % blend_seconds,
            ))
            expected_frames = cut + cont["frames"]
        else:  # early_cut: the continuous model trajectory owns the seam.
            video = (
                "[0:v]trim=end_frame=%d,setpts=PTS-STARTPTS,format=yuv420p[v0];"
                "[1:v]setpts=PTS-STARTPTS,format=yuv420p[v1];"
                "[v0][v1]concat=n=2:v=1:a=0[vout]" % cut
            )
            audio = ";".join((
                audio_filter(0, cut_seconds, "a0"),
                audio_filter(1, cont_seconds, "a1"),
                "[a0][a1]concat=n=2:v=0:a=1[aout]",
            ))
            expected_frames = cut + cont["frames"]

        filter_complex = video + ";" + audio
        errors = []
        for video_args in self._encode_attempts(ffmpeg):
            try:
                if os.path.exists(dst):
                    os.remove(dst)
                cmd = [
                    ffmpeg, "-y", "-i", source, "-i", continuation,
                    "-filter_complex", filter_complex, "-map", "[vout]", "-map", "[aout]",
                    "-r", "%.6f" % target_fps, "-frames:v", str(int(expected_frames)),
                ] + video_args + [
                    "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "320k",
                    "-movflags", "+faststart", "-shortest", dst,
                    "-hide_banner", "-loglevel", "error",
                ]
                run = subprocess.run(cmd, capture_output=True, text=True, timeout=60 * 30)
                if run.returncode == 0 and os.path.isfile(dst) and os.path.getsize(dst) > 0:
                    print("[MMH3 Studio] streamed %s seam: %df + %df -> %df (%s) -> %s"
                          % (mode, src["frames"], cont["frames"], expected_frames,
                             " ".join(video_args[0:2]), name))
                    return {
                        "ui": {"mmh3_studio_video": [{
                            "filename": name, "subfolder": SUBFOLDER, "type": "output",
                            "fps": target_fps, "frames": int(expected_frames),
                            "width": src["width"], "height": src["height"],
                        }]},
                        "result": (dst,),
                    }
                errors.append((run.stderr or "ffmpeg failed").strip()[-700:])
            except Exception as exc:
                errors.append(str(exc))
        raise RuntimeError("H3 Studio safe join failed after every encoder attempt:\n" + "\n---\n".join(errors))

    @classmethod
    def IS_CHANGED(cls, **kwargs):
        return float("nan")


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
    "MMH3StudioSafeJoin": MMH3StudioSafeJoin,
}
NODE_DISPLAY_NAME_MAPPINGS = {
    "MiniMaxH3OneNode": "One Node · MiniMax H3 (video + audio)",
    "MMH3StudioSafeJoin": "H3 Studio Safe Join (streaming 2K)",
}

# CREATE is optional and isolated: an import/registration failure must never
# remove the working render nodes or prevent their UI from opening.
if _ROUTES_LIVE:
    try:
        from .creative_assistant import register_routes as _register_creative_routes
        _creative_service = _register_creative_routes(
            PromptServer.instance.routes,
            lambda: PromptServer.instance.prompt_queue.get_tasks_remaining() > 0,
        )
    except Exception as _creative_error:
        print("[MMH3 CREATE] Optional assistant unavailable (%s); normal render tools remain available."
              % type(_creative_error).__name__)
