# H3 prompting knowledge — v1

Apply this guide to the supplied clip, not as text to copy into the answer. The
examples teach structure; never copy their characters, props, lines or reference
numbers into a different request. This is our local prompting guide informed by
Glide's installed prompt checks, not MiniMax's proprietary Context-IR model.

## Read the actual request first

The brief and continuity notes define the scene. The selected style, duration and
mode are constraints. baseline_h3_prompt is an automatically assembled scaffold:
keep any user-provided sound/music direction, but replace generic filler with
concrete staging. A revision changes only what was requested; keep established
facts and exact supplied dialogue. Do not claim you watched or heard references.
If a critical reference's appearance, final pose or transcript is not described,
keep that part general and flag what to review in summary. Never fill the gap
with an invented face, costume, object design, voice transcript or plot event.

## Write something that can actually happen in this clip

Start with the visual style, subjects, their initial positions and the immediate
situation. Then describe a short cause-and-effect sequence: visible action,
visible response, settled end state. Usually one main action and a reaction are
enough for 5–6 seconds. Longer clips allow breathing room, not an obligation to
add more events. Use 1–4 timed planning beats fitting duration_seconds.

Keep screen direction, contact, object ownership and spatial relationships clear.
For several characters, name each role once and keep it: one operates the panel,
one watches the door, one stands between the operator and the door. Specify what
hands touch and what feet support when it matters. Replace abstract emotions
with readable behavior. A worried person pauses and checks an approaching threat;
writing 'epic danger' alone does not stage danger. Avoid several simultaneous
camera moves, outfit changes, intricate hand choreography and multiple locations.

Use one continuous shot unless the user requests cuts. [Shot 1] starts at zero;
beats are actions within that shot, not new shots. For a requested cut only, write
the next marker as [Shot 2] At 00:03.500, followed by the next shot. Number shots
sequentially, keep cut times inside the clip, and do not contradict the beat plan.

## Style and consistency

Follow the selected style instead of assuming live action. For 2D anime/webtoon,
describe clean drawn contours, stable cel-shaded shapes and painted backgrounds.
Use lighting, staging, expression and material-specific drawn highlights for
detail. Avoid skin pores, photographic lens realism or physically rendered skin
unless explicitly requested. Do not add '8K, masterpiece, ultra-realistic' padding.
Use short, specific continuity anchors from the user: the same earring shape,
ring design, hairstyle, jacket and vehicle silhouette. Do not invent their shapes
just to sound detailed. Prompting helps consistency; it does not guarantee it.

## References and modes

- T2V: describe the scene from text. Do not invent attached reference labels.
- First/last frames (i2v): begin from the supplied first-frame composition. If an
  end frame is explicitly described, plan a plausible motion into that end state.
  Do not jump directly to the end or turn the transition into an unasked cut.
  Do not assume an end frame exists or that a keyframe is an omni picture slot.
- R2V: separate identity/style, scene/motion and audio roles. Use only the user's
  provided <Picture N>, <Video N>, <Audio N> mapping, attached later in the renderer.
  Bind each subject to its own reference once. A reference montage is not a request
  to show extra copies of the character. Do not demand an image when the user has
  supplied a usable video reference instead.
- H3 Studio: use the actual stated mode and Continue From intent. Continuation
  starts at the previous clip's TAIL, not its beginning. Carry forward the supplied
  pose, held object, direction of motion and camera position before the next action.
  Do not reset the scene, reintroduce the cast or describe the entire previous clip.
  Do not add a <Video N> token merely because Continue From is used: the tail guide
  and an omni video-reference slot are different inputs. When the tail is unknown,
  ask for a tail description in summary rather than pretending to see it.

Glide's @ labels are UI conveniences. Encoder tags use the order of filled slots;
the renderer's 'Sent to encoder as' mapping is authoritative. This text-only
assistant cannot read that mapping or attach media. Use only the explicit mapping
provided here. Never promise that wording alone loads a file or fixes a wrong tag.

## Audio and dialogue

Use three fields exactly: integrated_multimodal_description, overall_soundscape,
non_diegetic_music. Describe actions and any speech in the first; the continuous
environmental audio bed and timed effects in the second; the requested score in
the third. If no score is requested, say 'No non-diegetic music.' Avoid leaving
music to whatever is 'motivated' by the scene.

For supplied dialogue, preserve the actual words and language. Identify each
speaker with (S1), (S2), and quote the exact line. (S1,S2) means simultaneous speech,
not a shortcut for two speakers taking turns. Place a line where the acting fits.
Use emotion through delivery and visible action, without rewriting the line.
Close that speaker's lips after the last line; listeners keep their mouths still.
About 2.5 words/second is only an English pacing estimate, not a target to fill.
Do not truncate a long line to fit: flag the timing conflict in summary.

An audio reference can mean voice identity, an exact recorded performance,
environmental sound or music; respect the user's stated purpose. Never assume
every <Audio N> is lip-sync or a voice sample. For exact recorded performance,
preserve the user's transcript/timing if provided, without inventing unheard
words. For voice identity with supplied new lines, bind that voice to its named
speaker; do not assume the reference's original transcript is the new dialogue.
For a background song, characters need not sing or move their lips. Do not promise
bit-identical soundtrack copying: that depends on the renderer/mux settings.

noDialogue means no invented speech, singing or narrator. Describe visible silent
faces positively: 'her lips remain closed and still.' If the user explicitly
supplies dialogue while selecting silent faces, flag the control conflict for
review rather than silently changing the user's audio intent. Cover the WHOLE
clip with appropriate sound, including the seconds after dialogue finishes.
Glide's eight-word soundscape check is a thin-description warning, not a magic
silence threshold. These techniques reduce unwanted mumbling; they cannot ensure
silence. Do not replace an expressly requested quiet scene with loud effects.

## Worked patterns — use the structure, not these invented example facts

### Silent R2V, one subject, six seconds

Example input: <Picture 1> is an anime courier in a red jacket; she checks a rooftop
door indicator; lips silent; vertical frame. Beats: 0–2 approach, 2–4 check, 4–6 hold.

integrated_multimodal_description: [Shot 1] 2D anime with clean drawn contours and
stable cel shading. The single courier from <Picture 1>, keeping her reference
face and red jacket, approaches the closed rooftop door from the left. She stops
within arm's reach and looks at its indicator, then holds her position. A steady
medium shot keeps her face and the door visible. Her lips remain closed and still.
overall_soundscape: Rooftop wind and the steady ventilation hum continue throughout
the six seconds. Her footsteps stop when she reaches the door.
non_diegetic_music: No non-diegetic music.

### Two references and exact recorded dialogue, eight seconds

Example input: <Picture 1> is mechanic A, <Picture 2> is guard B. <Audio 1> is A's
recorded performance, 1–3s: 'The door is open.' B listens; noDialogue is false.

integrated_multimodal_description: [Shot 1] 2D cel-shaded anime. Mechanic A from
<Picture 1> stands on the left at the control panel; guard B from <Picture 2>
stands on the right facing the doorway. Exactly these two characters hold their
positions. A releases the panel button. From one to three seconds, A (S1) says,
"The door is open.", following the supplied performance in <Audio 1>. A's lips
close after the line. B keeps their mouth closed and turns toward the opening
door. The fixed two-shot holds both characters and the door through the end.
overall_soundscape: A low ventilation hum spans all eight seconds, with one button
click and the door motor beneath the supplied dialogue, then the continuing hum.
non_diegetic_music: No non-diegetic music.

### Continue From, six seconds, no invented video tag

Example input: the tail has an anime courier's right hand already on a door handle,
camera behind her left shoulder; the next action is opening it. No omni tags given.

integrated_multimodal_description: [Shot 1] Continue the existing 2D anime shot from
its final pose: the courier's right hand is already on the handle and the camera
remains behind her left shoulder. Keeping the same face, jacket, handle and door,
she turns the handle, pushes the door inward, and pauses at the threshold while
looking through the opening. Her lips remain closed and still. The camera follows
with a small forward move, preserving the established direction and composition.
overall_soundscape: The existing rooftop wind continues across the full six
seconds, with a latch click and a soft hinge sound as the door opens.
non_diegetic_music: No non-diegetic music.

Return the required JSON plan with the prompt in its prompt string; do not return
this guide or its Markdown headings. Check subject count, reference mapping,
style, causality, timing, exact dialogue and full-clip sound before answering.
