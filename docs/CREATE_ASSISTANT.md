# Optional CREATE assistant

CREATE is a text-only prompt-planning tool inside One Node - MiniMax H3. It can
format a brief into an editable H3 prompt. It cannot inspect images, video, or audio,
cannot change render settings, and cannot submit a generation.

## Connect a local or LAN model server

1. Open **CREATE -> Qwen creative assistant**.
2. Select the local machine or another machine on your trusted LAN.
3. Choose LM Studio, Ollama, or an OpenAI-compatible server.
4. Enter the API address shown by that server.
5. Enter a token only when that server requires one.
6. Test the connection, select the model returned by the server, and create a draft.

Common examples are http://localhost:1234 for LM Studio and
http://localhost:11434 for Ollama. Use the address configured by your server. Do
not expose a local model server to the public internet merely to use this feature.

The token is held in memory for the active connection. It is not written to the
repository, browser storage, or the node's config file.

## Guidance modes

- **Official MiniMax H3 skill:** uses the pinned upstream prompt-writing material in
  prompt_guides/official_minimax/.
- **Existing local guide:** uses prompt_guides/h3_prompting.md.
- **Basic formatter:** does not contact a model server.

Review every draft before handoff. The assistant is a planning aid and cannot
guarantee identity, anatomy, lip sync, speech suppression, or continuity.

## Local GPU safety

When the assistant runs on the same machine as ComfyUI, do not start an H3 render at
the same time. The node blocks assistant startup when a ComfyUI task is already
queued, but it cannot prevent another application from taking VRAM afterward.

## Troubleshooting

- Restart ComfyUI after installing or updating Python routes.
- Hard-refresh the browser after restarting.
- Verify the server URL, port, authentication, and selected model.
- Shorten overly long briefs when a response is truncated.
- Disconnect to clear the in-memory token.
- Use the model server's own controls to stop or unload a model when necessary.

The normal T2V, I2V, R2V, Studio, and protected-HD features continue to work if the
optional assistant is unavailable.
