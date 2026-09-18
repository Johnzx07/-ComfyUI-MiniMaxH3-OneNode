"""Official skill selection/validation tests; all model endpoints are mocked."""
import json
from pathlib import Path
import sys
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import creative_assistant as ca
import creative_skills as cs
from test_creative_assistant import HttpTests, PROMPT, ANSWER

REF = """subject_definitions:
<Subject 1> is the pilot in <Picture 1>, with the supplied blue jacket.
summary: [reference generation] <Subject 1> checks the doorway.
retention_analysis:
<Subject 1> (appears in [Shot 1]): fully_preserved - retain identity and jacket.
detailed_description: 2D anime, clean cel shading. [Shot 1] <Subject 1> pauses by the doorway. Her lips stay closed and still.
overall_soundscape: Wind and distant engines continue softly for the whole clip.
non_diegetic_music: N/A"""
DATA = {"skill_mode":"official", "task_focus":"continuity", "mode":"r2v",
    "brief":"One pilot checks a doorway.", "style":"2D anime", "baseline":PROMPT,
    "duration":5, "continuity":"<Picture 1> is the pilot; blue jacket."}


class SkillsTests(unittest.TestCase):
    def test_exact_upstream_files_loaded_for_selected_mode(self):
        for mode, flags, h3 in (
            ("t2v",{},"T2VA"),("i2v",{},"I2VA"),
            ("i2v",{"has_last_frame":True},"FL2VA"),
            ("studio",{"studio_mode":"fl2va","has_last_frame":True},"L2VA"),
            ("studio",{"studio_mode":"ref2va","is_continuation":True},"Ref2VA"),
            ("studio",{"studio_mode":"fl2va","is_continuation":True},"T2VA"),
            ("r2v",{},"Ref2VA")):
            with self.subTest(mode=mode, flags=flags):
                messages,body=ca.build_messages({**DATA,"mode":mode,**flags})
                text=messages[0]["content"]
                self.assertIn((cs.ROOT/"SKILL.md").read_text(encoding="utf-8"),text)
                self.assertIn((cs.ROOT/"references/base-en.txt").read_text(encoding="utf-8"),text)
                self.assertEqual(cs.h3_mode(body),h3)
                self.assertEqual("SOURCE FILE: references/ref-en.txt" in text,h3=="Ref2VA")
                self.assertEqual(len(cs.required_fields(body)),6 if h3=="Ref2VA" else 3)
                self.assertIn("User-selected visual style wins",text)

    def test_selected_local_focus_only(self):
        for focus,(_,instructions) in cs.FOCUSES.items():
            messages,_=ca.build_messages({**DATA,"task_focus":focus})
            self.assertIn(instructions,messages[0]["content"])
            for other,(_,text) in cs.FOCUSES.items():
                if other!=focus:self.assertNotIn(text,messages[0]["content"])

    def test_ref_six_fields_and_subjects(self):
        _,body=ca.build_messages(DATA)
        answer={**ANSWER,"prompt":REF}
        result=ca.parse_result(json.dumps(answer),body)
        self.assertEqual(result["prompt"],REF)
        self.assertEqual(result["h3_mode"],"Ref2VA")
        self.assertEqual(result["guide_sources"],list(cs.HASHES))
        for prompt in (PROMPT,REF+"\nsummary: Duplicate",REF.replace("<Subject 1> pauses","<Subject 2> pauses")):
            with self.subTest(prompt=prompt),self.assertRaises(ca.AssistantError):
                ca.parse_result(json.dumps({**answer,"prompt":prompt}),body)

    def test_examples_previous_draft_and_tail_are_not_reference_assets(self):
        _,body=ca.build_messages({**DATA,"continuity":"", "current_prompt":REF,
            "mode":"studio","is_continuation":True})
        with self.assertRaises(ca.AssistantError):ca.parse_result(json.dumps({**ANSWER,"prompt":REF}),body)
        empty=REF.replace(REF.split("summary:")[0],"subject_definitions: N/A\n")
        empty=empty.replace("<Subject 1>","The pilot")
        empty=empty[:empty.index("retention_analysis:")]+"retention_analysis: N/A\n"+empty[empty.index("detailed_description:"):]
        result=ca.parse_result(json.dumps({**ANSWER,"prompt":empty}),body)
        self.assertGreaterEqual(len(result["warnings"]),2)
        with self.assertRaises(ca.AssistantError):
            ca.parse_result(json.dumps({**ANSWER,"prompt":empty+" <Video 1>"}),body)

    def test_visible_text_is_not_spoken_and_silence_na_valid(self):
        _,body=ca.build_messages({**DATA,"mode":"t2v"})
        prompt='integrated_multimodal_description: [Shot 1] A sign reads "HELLO". Her lips stay closed.\noverall_soundscape: N/A\nnon_diegetic_music: N/A'
        result=ca.parse_result(json.dumps({**ANSWER,"prompt":prompt}),body)
        self.assertEqual(result["warnings"],[])

    def test_bad_selection_integrity_and_legacy_isolation(self):
        for data in ({"skill_mode":"../../secrets"},{"task_focus":[]},{"task_focus":"all"}):
            with self.assertRaises(ca.AssistantError):ca.build_messages({**DATA,**data})
        with patch.object(Path,"read_bytes",return_value=b"tampered"):
            with self.assertRaises(ca.AssistantError):ca.build_messages(DATA)
            self.assertIn("H3 prompting knowledge",ca.build_messages({**DATA,"skill_mode":"glide"})[0][0]["content"])

    def test_spoken_line_missing_markup_gets_review_warning(self):
        _,body=ca.build_messages({**DATA,"mode":"t2v","noDialogue":False,"task_focus":"dialogue"})
        prompt=PROMPT.replace("Drawn anime pilot enters the room.", "The pilot says 'Hold here.' then closes her lips.")
        result=ca.parse_result(json.dumps({**ANSWER,"prompt":prompt}),body)
        self.assertTrue(any("without official <d>" in w for w in result["warnings"]))


class SkillHttpTests(HttpTests):
    # Reuse real loopback HTTP fixture without changing production endpoints.
    async def test_offline_catalog_does_not_touch_llm(self):
        status,result=await self.post("skills",{})
        self.assertEqual(status,200,result)
        self.assertTrue(result["official_available"])
        self.assertEqual(self.calls,[])
        with patch.object(Path,"read_bytes",side_effect=FileNotFoundError):
            status,result=await self.post("skills",{})
            self.assertEqual(status,200)
            self.assertFalse(result["official_available"])

    async def test_selected_official_skill_is_sent_and_wrong_format_rejected(self):
        # Mock intentionally returns legacy 3-field text; must NOT silently accept it.
        status,result=await self.post("enhance",{**self.data,**DATA})
        self.assertEqual(status,502,result)
        content=self.calls[0][1]["messages"][0]["content"]
        self.assertIn("SOURCE FILE: references/ref-en.txt",content)
        self.assertIn(cs.FOCUSES["continuity"][1],content)
        self.assertEqual(len(self.calls),1)

    async def test_official_missing_files_fail_before_inference(self):
        with patch.object(Path,"read_bytes",side_effect=FileNotFoundError):
            status,result=await self.post("enhance",{**self.data,**DATA})
            self.assertEqual(status,503,result)
            self.assertEqual(self.calls,[])

    async def test_official_six_field_success_over_http(self):
        with patch('test_creative_assistant.ANSWER',{**ANSWER,"prompt":REF}):
            status,result=await self.post("enhance",{**self.data,**DATA})
        self.assertEqual(status,200,result)
        self.assertEqual(result["prompt"],REF)
        self.assertEqual(result["skill_mode"],"official")
        body=json.loads(self.calls[0][1]["messages"][1]["content"])
        self.assertNotIn("baseline_h3_prompt",body)
        self.assertIn("subject_definitions:",body["required_prompt_structure"])
        self.assertIn("[Shot 1]",body["required_prompt_structure"])

    async def test_official_lmstudio_uses_one_constrained_request(self):
        sections=ca.prompt_fields(REF,DATA)
        answer={"summary":"A pilot","beats":ANSWER["beats"],"prompt_fields":sections,"alignment":""}
        with patch('test_creative_assistant.ANSWER',answer):
            status,result=await self.post("enhance",{**self.data,**DATA,"provider":"lmstudio"})
        self.assertEqual(status,200,result)
        self.assertTrue(result["structured_mode"])
        self.assertEqual(len(self.calls),1)
        self.assertEqual(self.calls[0][0],"/v1/chat/completions")
        schema=self.calls[0][1]["response_format"]["json_schema"]["schema"]
        self.assertEqual(schema["properties"]["prompt_fields"]["required"],list(cs.REF_FIELDS))
        self.assertEqual(ca.prompt_fields(result["prompt"],DATA),sections)


if __name__=="__main__":unittest.main(verbosity=2)
