"""Temporary loopback-only browser fixture. Never used by the installed node."""
import asyncio
import json
from pathlib import Path
import sys
from aiohttp import web
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from creative_assistant import register_routes

ROOT = Path(__file__).resolve().parents[1]
async def main():
    async def mock(request):
        if request.path == "/v1/models":
            return web.json_response({"data": [{"id": "qwen-mock-no-gpu"}]})
        data = await request.json()
        user = json.loads(data["messages"][-1]["content"])
        answer = {"summary": "The pilot approaches a locked rooftop door.",
            "beats": [{"start": 0, "end": min(5,user["duration_seconds"]), "action": "She pauses at the door, keeping her face and costume unchanged."}],
            "prompt": "integrated_multimodal_description: [Shot 1] 2D anime. One pilot approaches the rooftop door, pauses and watches its indicator. Her lips stay closed and still.\noverall_soundscape: Continuous rooftop wind, distant traffic and a steady ventilation hum fill the whole clip.\nnon_diegetic_music: No music."}
        return web.json_response({"choices": [{"message": {"content": json.dumps(answer)}, "finish_reason": "stop"}]})
    model_app = web.Application();model_app.router.add_route("*", "/{rest:.*}", mock)
    app=web.Application();routes=web.RouteTableDef();register_routes(routes);app.add_routes(routes)
    async def html(_):return web.FileResponse(ROOT/"test"/"creative_ui.html")
    async def script(request):
        kind=request.match_info["kind"]
        return web.Response(text="export const %s = window.__ui%s;" % (kind, "App" if kind=="app" else "Api"),content_type="application/javascript")
    app.router.add_get("/",html);app.router.add_get("/scripts/{kind:app|api}.js",script)
    app.router.add_static("/extensions/mmh3/",ROOT/"web")
    runners=[]
    try:
        for application,port in ((app,18765),(model_app,18766)):
            runner=web.AppRunner(application);await runner.setup();runners.append(runner)
            await web.TCPSite(runner,"127.0.0.1",port).start()
        print("UI regression fixture http://127.0.0.1:18765 · mock AI on 18766 · no GPU",flush=True)
        await asyncio.Event().wait()
    finally:
        for runner in runners:await runner.cleanup()

if __name__=="__main__":asyncio.run(main())
