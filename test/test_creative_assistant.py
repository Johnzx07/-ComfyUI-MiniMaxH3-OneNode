"""No-GPU integration tests using real HTTP against a local mock model server."""
import asyncio
import json
from pathlib import Path
import sys
import unittest
from unittest.mock import patch

from aiohttp import web
from aiohttp.test_utils import TestClient, TestServer

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import creative_assistant as ca

PROMPT = "integrated_multimodal_description: [Shot 1] Drawn anime pilot enters the room.\noverall_soundscape: Soft rain and distant engines continue throughout the whole clip.\nnon_diegetic_music: No music."
ANSWER = {"summary": "A cautious arrival", "beats": [{"start": 0, "end": 5, "action": "The pilot checks the doorway."}], "prompt": PROMPT}


class UnitTests(unittest.TestCase):
    def test_h3_guide_is_loaded_for_every_mode_and_request(self):
        for mode in ("t2v", "i2v", "r2v", "studio"):
            messages, body = ca.build_messages({"brief": "A pilot enters", "style": "Anime",
                "baseline": PROMPT, "duration": 6, "mode": mode})
            system = messages[0]["content"]
            self.assertIn(ca.GUIDE_PATH.read_text(encoding="utf-8").strip(), system)
            for fact in ("<Audio N>", "TAIL", "(S1,S2)", "cel-shaded", "Worked patterns"):
                self.assertIn(fact, system)
            self.assertEqual(body["mode"], mode)
        with patch.object(Path, "read_text", return_value="H3 refreshed guidance " * 30):
            self.assertIn("H3 refreshed guidance", ca.system_prompt())
        with patch.object(Path, "read_text", side_effect=FileNotFoundError), self.assertRaises(ca.AssistantError):
            ca.system_prompt()

    def test_empty_duplicate_fields_and_impossible_cuts_fail(self):
        for prompt in (PROMPT.replace("[Shot 1] Drawn anime pilot enters the room.", ""),
                       PROMPT + "\noverall_soundscape: Extra sound.",
                       PROMPT.replace("[Shot 1]", "[Shot 2]"),
                       PROMPT.replace("enters the room.", "enters. [Shot 2] At 00:06.000, she stops.")):
            with self.subTest(prompt=prompt), self.assertRaises(ca.AssistantError):
                ca.parse_result(json.dumps({**ANSWER,"prompt":prompt}), {"duration_seconds":5})

    def test_audio_review_checks_are_advisory(self):
        prompt=PROMPT.replace("[Shot 1] Drawn anime pilot enters the room.",
            '[Shot 1] The pilot says "A long line with far too many words for a second."')
        result=ca.parse_result(json.dumps({**ANSWER,"prompt":prompt,
            "beats":[{"start":0,"end":1,"action":"Talk"}]}), {"duration_seconds":1,"noDialogue":True})
        self.assertEqual(result["prompt"],prompt)
        self.assertEqual(len(result["warnings"]),4)
        self.assertEqual(result["guide_version"],ca.GUIDE_VERSION)

    def test_address_scope_and_credentials(self):
        for url in ("https://example.com/a", "http://8.8.8.8", "http://169.254.169.254", "file:///x", "http://u:p@127.0.0.1:1234", "http://127.0.0.1:1234?q=secret"):
            with self.subTest(url=url), self.assertRaises(ca.AssistantError):
                ca.connection({"url": url, "target": "local"})
        self.assertTrue(ca.allowed_address("192.168.1.44"))
        self.assertTrue(ca.allowed_address("100.77.5.4"))
        self.assertFalse(ca.allowed_address("169.254.169.254"))
        with self.assertRaises(ca.AssistantError):
            ca.connection({"url": "http://localhost:1234", "target": "remote"})
        self.assertEqual(ca.connection({"url": "http://10.0.0.2:1234/v1/"})["root"], "http://10.0.0.2:1234")

    def test_format_timing_references_and_hidden_reasoning(self):
        body = {"duration_seconds": 5}
        got = ca.parse_result("<think>private deliberation</think>\n```json\n" + json.dumps(ANSWER) + "\n```", body)
        self.assertEqual(got["prompt"], PROMPT)
        for answer in ({**ANSWER, "prompt": "free text"}, {**ANSWER, "prompt": PROMPT + " <Picture 4>"},
                       {**ANSWER, "beats": [{"start": 0, "end": 6, "action": "bad"}]},
                       {**ANSWER, "beats": [{"start": 4, "end": 3, "action": "bad"}]}):
            with self.assertRaises(ca.AssistantError):
                ca.parse_result(json.dumps(answer), body)


class HttpTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.calls = []
        self.response_mode = "normal"
        self.loaded = True
        self.native_available = True
        self.reasoning_off_supported = True
        self.entered = asyncio.Event()
        self.release = asyncio.Event()
        async def upstream(request):
            body = await request.json() if request.method == "POST" else None
            self.calls.append((request.path, body, request.headers.get("Authorization")))
            if request.path == "/v1/models":
                if self.response_mode == "auth":
                    return web.Response(status=401, text="secret-key-and-brief")
                if self.response_mode == "redirect":
                    return web.HTTPFound("http://8.8.8.8")
                return web.json_response({"data": [{"id": "qwen-test"}]})
            if request.path == "/api/tags":
                return web.json_response({"models": [{"name": "qwen-test"}]})
            if request.path == "/api/ps":
                return web.json_response({"models": [{"name": "qwen-test"}] if self.loaded else []})
            if request.path == "/api/v1/models":
                if not self.native_available:
                    return web.Response(status=404)
                return web.json_response({"models": [{"key": "qwen-test", "loaded_instances": [{"id": "qwen-instance"}] if self.loaded else [],
                    "capabilities": {"reasoning": {"allowed_options": ["off","on"] if self.reasoning_off_supported else ["on"]}}}]})
            if request.path in ("/api/v1/models/unload", "/api/generate"):
                self.loaded = False
                return web.json_response({"instance_id": "qwen-instance", "done": True})
            if request.path in ("/v1/chat/completions", "/api/chat", "/api/v1/chat"):
                self.entered.set()
                if self.response_mode == "slow":
                    await self.release.wait()
                content = "not JSON" if self.response_mode == "malformed" else json.dumps(ANSWER)
                if request.path == "/api/v1/chat":
                    return web.json_response({"output": [{"type":"reasoning","content":"not a final answer"},{"type":"message","content":content}]})
                if request.path == "/api/chat":
                    return web.json_response({"message": {"content": content}, "done_reason": "stop"})
                return web.json_response({"choices": [{"message": {"content": content}, "finish_reason": "length" if self.response_mode == "truncated" else "stop"}]})
            return web.Response(status=404)
        app = web.Application()
        app.router.add_route("*", "/{path:.*}", upstream)
        self.up = TestServer(app)
        await self.up.start_server()
        routes = web.RouteTableDef()
        self.queue_busy = False
        self.service = ca.register_routes(routes, lambda: self.queue_busy)
        api = web.Application()
        api.add_routes(routes)
        self.client = TestClient(TestServer(api))
        await self.client.start_server()
        self.data = {"url": str(self.up.make_url("")), "target": "local", "provider": "openai", "model": "qwen-test",
                     "local_confirm": True, "request_id": "a"*32, "brief": "Pilot enters", "style": "2D Anime",
                     "baseline": PROMPT, "duration": 5, "mode": "r2v", "token": "session-only-test"}

    async def asyncTearDown(self):
        self.release.set()
        await self.client.close()
        await self.up.close()

    async def post(self, action, data=None):
        r = await self.client.post("/minimaxh3/assistant/" + action, json=self.data if data is None else data)
        return r.status, await r.json()

    async def test_connect_does_not_infer_and_forwards_only_session_token(self):
        status, result = await self.post("connect")
        self.assertEqual(status, 200)
        self.assertEqual(result["models"][0]["id"], "qwen-test")
        self.assertEqual(self.calls, [("/v1/models", None, "Bearer session-only-test")])

    async def test_chat_and_plan(self):
        status, result = await self.post("enhance")
        self.assertEqual(status, 200, result)
        self.assertEqual(result["prompt"], PROMPT)
        self.assertEqual(self.calls[0][1]["model"], "qwen-test")
        self.assertNotIn("tools", self.calls[0][1])
        self.assertIn("# H3 prompting knowledge", self.calls[0][1]["messages"][0]["content"])
        # Example tokens are not allowed unless the user actually supplied them.
        self.assertNotIn("<Picture 1>", self.calls[0][1]["messages"][1]["content"])
        self.assertEqual(result["guide_version"], ca.GUIDE_VERSION)
        self.assertEqual(self.service.jobs, {})

    async def test_missing_guide_does_not_send_an_inference(self):
        with patch.object(Path, "read_text", side_effect=FileNotFoundError):
            status, result = await self.post("enhance")
        self.assertEqual(status,503,result)
        self.assertEqual(self.calls,[])

    async def test_lmstudio_native_concise_guide_no_storage_or_tools(self):
        status,result=await self.post("enhance",{**self.data,"provider":"lmstudio"})
        self.assertEqual(status,200,result)
        self.assertTrue(result["concise_mode"])
        path,payload,_=self.calls[-1]
        self.assertEqual(path,"/api/v1/chat")
        self.assertEqual(payload["reasoning"],"off")
        self.assertFalse(payload["store"])
        self.assertEqual(payload["integrations"],[])
        self.assertIn("# H3 prompting knowledge",payload["system_prompt"])
        self.assertEqual(result["prompt"],PROMPT)

    async def test_lmstudio_old_or_unsupported_retains_compatible_path(self):
        for available in (False,True):
            self.native_available=available
            self.reasoning_off_supported=False
            status,result=await self.post("enhance",{**self.data,"provider":"lmstudio"})
            self.assertEqual(status,200,result)
            self.assertFalse(result["concise_mode"])
            self.assertEqual(self.calls[-1][0],"/v1/chat/completions")

    async def test_native_malformed_output_is_not_retried(self):
        self.response_mode="malformed"
        status,_=await self.post("enhance",{**self.data,"provider":"lmstudio"})
        self.assertEqual(status,502)
        self.assertEqual([c[0] for c in self.calls], ["/api/v1/models","/api/v1/chat"])

    async def test_local_queue_and_consent_guards(self):
        self.queue_busy = True
        self.assertEqual((await self.post("enhance"))[0], 409)
        self.queue_busy = False
        self.assertEqual((await self.post("enhance", {**self.data, "local_confirm": False}))[0], 409)
        self.assertEqual(self.calls, [])

    async def test_auth_error_redaction_and_no_redirect(self):
        for mode in ("auth", "redirect"):
            self.response_mode = mode
            status, result = await self.post("connect")
            self.assertEqual(status, 502)
            self.assertNotIn("secret", str(result))

    async def test_invalid_and_truncated_outputs(self):
        for mode in ("malformed", "truncated"):
            self.response_mode = mode
            self.assertEqual((await self.post("enhance"))[0], 502)
            self.assertEqual(self.service.jobs, {})

    async def test_cancel_and_single_request_guard(self):
        self.response_mode = "slow"
        task = asyncio.create_task(self.post("enhance"))
        await asyncio.wait_for(self.entered.wait(), 3)
        self.assertEqual((await self.post("enhance", {**self.data, "request_id": "b"*32}))[0], 409)
        self.assertEqual((await self.post("cancel", {"request_id": "a"*32}))[0], 200)
        self.assertEqual((await task)[0], 409)
        self.assertEqual(self.service.jobs, {})
        self.assertEqual(self.service.busy_servers, set())

    async def test_unload_explicit_only_and_exact_lm_instance(self):
        self.assertEqual((await self.post("unload"))[0], 400)
        status, result = await self.post("unload", {**self.data, "provider": "lmstudio", "confirm_unload": True})
        self.assertEqual(status, 200, result)
        unload_calls = [x for x in self.calls if x[0].endswith("/unload")]
        self.assertEqual(unload_calls[0][1], {"instance_id": "qwen-instance"})

    async def test_ollama_native_and_automatic_local_unload(self):
        status, result = await self.post("enhance", {**self.data, "provider": "ollama", "auto_unload": True})
        self.assertEqual(status, 200, result)
        self.assertIn("confirmed", result["memory_message"])
        self.assertEqual(self.calls[0][0], "/api/chat")
        self.assertEqual(self.calls[0][1]["keep_alive"], 0)

    async def test_origin_and_input_limit(self):
        response = await self.client.post("/minimaxh3/assistant/connect", json=self.data, headers={"Origin": "https://evil.example"})
        self.assertEqual(response.status, 403)
        response = await self.client.post("/minimaxh3/assistant/connect", data="x"*(ca.LIMIT+2), headers={"Content-Type": "application/json"})
        self.assertEqual(response.status, 413)


if __name__ == "__main__":
    unittest.main(verbosity=2)
