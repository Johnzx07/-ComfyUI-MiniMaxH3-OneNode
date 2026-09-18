# Official MiniMax H3 prompt-writing sources

Downloaded unchanged from [MiniMax-AI/MiniMax-H3](https://github.com/MiniMax-AI/MiniMax-H3/tree/d21241f0a4b3acbb34c97dae47fa417b7065e438/skills/h3-prompt-writing), revision `d21241f0a4b3acbb34c97dae47fa417b7065e438`, on 2026-09-05.

| File | SHA-256 |
| --- | --- |
| SKILL.md | a7000443588ca3f145e3b3fd8900f14e0325dc460bd811268fac89a9dc8e56d0 |
| references/base-en.txt | 2cfebc096a6e08370f288d468d90b60f7f9bcb938f94bf090816e910e48e75fc |
| references/ref-en.txt | 1e574f356716ad55612247ffb7bbccbcdb484ad96599d63c7dca1af186b1fab7 |

These three files are upstream material, attributed to MiniMax. No ownership or new license is asserted. Review upstream terms before public redistribution. This is a local, pinned integration; it does not automatically pull newer upstream instructions.

`creative_skills.py` is our application adapter. Its task-focus cards are locally authored, NOT the full production skills from MiniMax Design's Plaza or Hub runtime. Only the portable **h3-prompt-writing** skill is loaded. The adapter keeps the user's chosen style, local renderer capabilities, text-only limitation and JSON response contract. It does not execute document commands, download models, access a MiniMax account, or implement proprietary Context-IR.

Base modes load SKILL.md + base-en.txt. Ref2VA also loads ref-en.txt, whose six-section format overrides the base three-section format. Files stay offline in this node folder and are checked before sending any AI request.
