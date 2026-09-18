"""Explicit opt-in prompt-only smoke test. Never queues an H3 render."""
import argparse
import asyncio
import json
from pathlib import Path
import sys
import time
import uuid
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
import creative_assistant as ca

async def main(url,model):
    c=ca.connection({"url":url,"provider":"lmstudio","target":"local"})
    comfy=ca.connection({"url":"http://127.0.0.1:8188","target":"local"})
    queue=await ca.call(comfy,"GET","/queue")
    if queue.get("queue_running") or queue.get("queue_pending"):
        raise RuntimeError("No test: ComfyUI has queued/running work.")
    before=await ca.call(c,"GET","/api/v1/models")
    found=[m for m in before.get("models",[]) if m.get("key")==model]
    if len(found)!=1 or found[0].get("loaded_instances"):
        raise RuntimeError("No test: selected model absent or already used by another session.")
    data={"url":url,"provider":"lmstudio","target":"local","local_confirm":True,"auto_unload":True,
        "model":model,"request_id":uuid.uuid4().hex,"skill_mode":"official","task_focus":"dialogue","mode":"r2v",
        "brief":"A six-second 2D anime shot of exactly one adult female pilot in a blue jacket at a rooftop door. She says the supplied line 'Hold here.' once, then closes her lips and watches the door. Keep the same face, silver ring and jacket. A single static shot; no cuts or added characters.",
        "style":"2D anime, cel shading, clean inked outlines, painted background.","duration":6,"aspect":"16:9","noDialogue":False,
        "baseline":"integrated_multimodal_description: [Shot 1] A pilot at a door.\noverall_soundscape: Wind throughout the whole clip.\nnon_diegetic_music: N/A",
        "continuity":"<Picture 1> = the female pilot's face, blue jacket and thin silver ring. (S1) is the female pilot, the only speaker. <Audio 1> = her exact recorded English dialogue, 'Hold here.' at 1–2 seconds. Preserve those words and timing. No extra voices. No music.",
        "reference_mapping":"<Picture 1> = image slot 1. <Audio 1> = audio slot 1."}
    start=time.monotonic()
    original_parse=ca.parse_result
    def inspect_synthetic_answer(content,body):
        try:return original_parse(content,body)
        except ca.AssistantError:
            print("Synthetic test answer failed validation:",content,flush=True)
            raise
    ca.parse_result=inspect_synthetic_answer
    print("Starting one prompt-only official Ref2VA skill test; original model was unloaded.",flush=True)
    try:
        result=await ca.CreativeAssistant().enhance(data)
        print(json.dumps({"elapsed_seconds":round(time.monotonic()-start,2),**result},ensure_ascii=False,indent=2),flush=True)
        assert result["skill_mode"]=="official"
        assert "Hold here." in result["prompt"]
        assert "<Audio 1>" in result["prompt"]
        assert "<d>[English] Hold here.</d>" in result["prompt"], "Official spoken-line markup was not followed"
        assert "(S1)" in result["prompt"], "Speaker ID missing"
    finally:
        ca.parse_result=original_parse
        current=await ca.call(c,"GET","/api/v1/models")
        loaded=[m for m in current.get("models",[]) if m.get("key")==model and m.get("loaded_instances")]
        if loaded:
            print(await ca.unload(c,model),flush=True)
        final=await ca.call(c,"GET","/api/v1/models")
        print("Selected test model still loaded:",any(m.get("key")==model and m.get("loaded_instances") for m in final.get("models",[])),flush=True)

if __name__=="__main__":
    parser=argparse.ArgumentParser();parser.add_argument('--url',required=True);parser.add_argument('--model',required=True)
    args=parser.parse_args();asyncio.run(main(args.url,args.model))
