// ComfyUI-MiniMaxH3-OneNode — single-node MiniMax H3 video + audio panel.
//
// Ported from the One Node family (Krea-2 image / Wan 2.2 video / LTX-2 video):
// the same lime-on-black in-panel UI, workflow-injection + /prompt submission,
// scanned model dropdowns, in-node download docs, and a headless build test.
// Retargeted to the native ComfyUI MiniMax H3 pipeline (PR #15224):
//
//   T2V / I2V / FLF  -> MiniMaxH3ImageToVideo  (fl2va weights)
//   R2V (references) -> MiniMaxH3ReferenceToVideo (ref2va weights)
//
// H3 generates video WITH native stereo audio in one pass, so there is no
// separate audio step. It is guidance-distilled: BasicGuider (positive-only),
// NO CFG and NO negative prompt. Sampler res_multistep + BasicScheduler.
//
// FULLY NAMESPACED so it coexists with the other One Node packages:
// extension "MiniMaxH3OneNode.v1", node class "MiniMaxH3OneNode",
// window.__mmh3_nodes, localStorage "minimaxh3_one_node_state",
// CSS keyframe prefix "mmh3-", routes "/minimaxh3/*", log tag "[MMH3]".
import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";

const VERSION = "v3.24";
const LIME = "#f0ff41";
const C = {
  bg0:"#0a0a0a", bg1:"#111", bg2:"#161616", bg3:"#1d1d1d",
  border:"#2a2a2a", text:"#e8e8e8", muted:"#888", accent:LIME,
};
const NODE_W = 1040;
// Taller than 16:9 on purpose: the left control column is dense (prompt + mode
// inputs + video + sampling + collapsibles), so a short node buried half of it
// behind an internal scrollbar. This height shows the everyday controls at once
// and gives the video preview real estate on the right.
const NODE_H = 720;
// The node is user-resizable. ComfyUI forces a freshly-created node to computeSize's
// floor, so these double as the default open size — chosen to show the everyday
// controls comfortably; the user can drag the node LARGER for a bigger preview.
const MIN_W = 1000, MIN_H = 700;
// Height litegraph reserves for the node title bar; the DOM panel gets the rest.
const TITLE_H = 30;
// Megapixel steps for the resolution preview table (mirrors the official workflow's
// size-reference note, but computed live for the chosen aspect ratio).
const MP_STEPS = [0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 0.98, 1.2, 1.5, 1.8, 2.0];

const LS_KEY = "minimaxh3_one_node_state";
// CREATE deliberately has its own saved draft.  It must never be able to poison
// the established renderer state (or make the renderer fail while opening).
const DESIGN_LS_KEY = "minimaxh3_one_node_create_draft_v1";

// H3 canvas / timing constants (from comfy_extras/nodes_minimax_h3.py)
const FPS = 24;
const MULTIPLE = 32;
const BASE_SHORT_EDGE = 768;
const MAX_PIXELS = 768 * 1344;      // model's area cap for the trained canvas
const LEN_MIN = 124;                 // ~5s  (trained low end)
const LEN_MAX = 362;                 // ~15s (trained high end)

// ResolutionSelector aspect ratios (exact list from comfy_extras/nodes_resolution.py)
const ASPECT = {
  "1:1 (Square)":[1,1],
  "2:3 (Portrait Photo)":[2,3],
  "3:2 (Photo)":[3,2],
  "3:4 (Portrait Standard)":[3,4],
  "4:3 (Standard)":[4,3],
  "9:16 (Portrait Widescreen)":[9,16],
  "16:9 (Widescreen)":[16,9],
  "21:9 (Ultrawide)":[21,9],
};
const ASPECT_KEYS = Object.keys(ASPECT);

const SAMPLERS = ["res_multistep","res_2m","euler","dpmpp_2m","dpmpp_2m_sde","uni_pc","deis","gradient_estimation"];
const SCHEDULERS = ["simple","beta","normal","karras","sgm_uniform","ddim_uniform","kl_optimal","linear_quadratic"];

const MAX_REF_IMAGES = 9;
const REF_IMAGES_SAFE = 5;   // MiniMax's recommended maximum for best identity
const MAX_REF_VIDEOS = 3;
const MAX_REF_AUDIOS = 3;

// ── math helpers (mirror the python exactly) ──────────────────────────────────
// ResolutionSelector: width/height from aspect + megapixels, rounded to `multiple`.
function calcRes(aspectKey, megapixels, multiple){
  const [wr,hr] = ASPECT[aspectKey] || [16,9];
  const total = megapixels * 1024 * 1024;
  const scale = Math.sqrt(total / (wr * hr));
  const w = Math.max(multiple, Math.round(wr * scale / multiple) * multiple);
  const h = Math.max(multiple, Math.round(hr * scale / multiple) * multiple);
  return { w, h };
}
// align_frame_count: smallest n>=input with n%17==5 (the model re-aligns anyway).
function alignLen(n){ n = Math.max(5, Math.round(n)); while(n % 17 !== 5) n++; return n; }
function durToLen(sec){ return alignLen(Math.max(5, Math.round(sec * FPS))); }

// ── DOM helpers (ported) ──────────────────────────────────────────────────────
const mk = (tag,css={},props={}) => { const e=document.createElement(tag); Object.assign(e.style,css); Object.assign(e,props); return e; };
const tx = (e,t) => { e.textContent=t; return e; };
const cap = (t) => tx(mk("div",{fontSize:"9px",fontWeight:"700",letterSpacing:".1em",textTransform:"uppercase",color:C.muted,margin:"0 0 5px"}),t);
function fmtErr(v){ if(v==null)return"unknown error"; if(typeof v==="string")return v; if(v instanceof Error)return v.message||String(v);
  try{ if(v.message)return v.message; return JSON.stringify(v); }catch(e){ return String(v); } }
function link(text,href){ return `<a href="${href}" target="_blank" style="color:${LIME};text-decoration:none">${text}</a>`; }

function Toggle(labelTxt,checked,onChange,activeColor){
  const wrap=mk("label",{display:"flex",alignItems:"center",gap:"8px",cursor:"pointer",fontSize:"11px",color:C.text,userSelect:"none"});
  const track=mk("div",{width:"34px",height:"18px",borderRadius:"10px",background:checked?(activeColor||LIME):C.bg3,position:"relative",transition:"background .15s",flex:"0 0 auto",border:"1px solid "+C.border});
  const knob=mk("div",{width:"12px",height:"12px",borderRadius:"50%",background:checked?"#000":"#777",position:"absolute",top:"2px",left:checked?"18px":"3px",transition:"left .15s"});
  track.appendChild(knob);
  const lbl=tx(mk("span"),labelTxt);
  let val=checked;
  wrap.append(track,lbl);
  wrap.onclick=()=>{ val=!val; track.style.background=val?(activeColor||LIME):C.bg3; knob.style.left=val?"18px":"3px"; knob.style.background=val?"#000":"#777"; onChange(val); };
  wrap._set=(v)=>{ val=v; track.style.background=v?(activeColor||LIME):C.bg3; knob.style.left=v?"18px":"3px"; knob.style.background=v?"#000":"#777"; };
  return wrap;
}

function DD(items,selected,onChange){
  const wrap=mk("div",{position:"relative",width:"100%"});
  const btn=mk("div",{display:"flex",alignItems:"center",justifyContent:"space-between",gap:"6px",padding:"6px 9px",background:C.bg2,border:"1px solid "+C.border,borderRadius:"7px",cursor:"pointer",fontSize:"11px",color:C.text,whiteSpace:"nowrap",overflow:"hidden"});
  const lbl=tx(mk("span",{overflow:"hidden",textOverflow:"ellipsis"}),selected||"none");
  const car=tx(mk("span",{color:C.muted,fontSize:"9px"}),"▾"); btn.append(lbl,car);
  const panel=mk("div",{position:"absolute",top:"calc(100% + 3px)",left:"0",right:"0",maxHeight:"260px",overflowY:"auto",background:C.bg1,border:"1px solid "+C.border,borderRadius:"7px",zIndex:"1000",display:"none",boxShadow:"0 8px 24px rgba(0,0,0,.6)"});
  let cur=selected, list=items.slice();
  const render=()=>{ panel.innerHTML=""; list.forEach(it=>{ const row=tx(mk("div",{padding:"6px 9px",fontSize:"11px",cursor:"pointer",color:it===cur?LIME:C.text,whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis"}),it);
    row.onmouseenter=()=>row.style.background=C.bg3; row.onmouseleave=()=>row.style.background="";
    row.onclick=()=>{ cur=it; lbl.textContent=it; panel.style.display="none"; onChange(it); }; panel.appendChild(row); }); };
  const close=()=>panel.style.display="none";
  btn.onclick=(e)=>{ e.stopPropagation(); const open=panel.style.display==="none"; render(); panel.style.display=open?"block":"none"; };
  document.addEventListener("click",(e)=>{ if(!wrap.contains(e.target))close(); });
  wrap.append(btn,panel);
  wrap.set=(v)=>{ cur=v; lbl.textContent=v; };
  wrap.updateItems=(arr)=>{ list=arr.slice(); };
  return wrap;
}

function Pill(txt,active,onClick){
  const b=tx(mk("button",{padding:"7px 16px",borderRadius:"8px",border:"1px solid "+(active?LIME:C.border),background:active?"rgba(240,255,65,.12)":C.bg2,color:active?LIME:C.muted,fontSize:"11px",fontWeight:"700",letterSpacing:".05em",cursor:"pointer",textTransform:"uppercase"}),txt);
  b.onclick=onClick;
  b._set=(a)=>{ b.style.border="1px solid "+(a?LIME:C.border); b.style.background=a?"rgba(240,255,65,.12)":C.bg2; b.style.color=a?LIME:C.muted; };
  return b;
}

function _pf(v){ return parseFloat(String(v).replace(",",".")); }
function NI(val,min,max,step,onChange,width="64px"){
  const inp=mk("input",{width,textAlign:"center",background:C.bg2,border:"1px solid "+C.border,borderRadius:"6px",color:LIME,fontSize:"11px",fontWeight:"700",padding:"5px 0",outline:"none"},{type:"number",value:String(val)});
  if(step!=null)inp.step=String(step); if(min!=null)inp.min=String(min); if(max!=null)inp.max=String(max);
  const commit=()=>{ let v=_pf(inp.value); if(isNaN(v))v=min!=null?min:0; if(min!=null)v=Math.max(min,v); if(max!=null)v=Math.min(max,v); inp.value=String(v); onChange(v); };
  inp.addEventListener("change",commit);
  inp.addEventListener("wheel",e=>e.stopPropagation(),{passive:true});
  const w={_inp:inp,set:(v)=>{inp.value=String(v);}};
  return w;
}

function Slider(val,min,max,step,onInput){
  const inp=mk("input",{width:"100%",accentColor:LIME,cursor:"pointer"},{type:"range",min:String(min),max:String(max),step:String(step),value:String(val)});
  inp.addEventListener("input",()=>onInput(_pf(inp.value)));
  inp.addEventListener("wheel",e=>e.stopPropagation(),{passive:true});
  const w={_inp:inp,set:(v)=>{inp.value=String(v);}};
  return w;
}

function sectionTitle(t){
  return tx(mk("div",{fontSize:"10px",fontWeight:"800",letterSpacing:".12em",textTransform:"uppercase",color:LIME,margin:"0 0 8px",borderBottom:"1px solid "+C.border,paddingBottom:"6px"}),t);
}

// ── file upload slots ─────────────────────────────────────────────────────────
// Generic uploader: posts to /upload/image (overwrite=true => raw bytes, no image
// validation), works for images, audio and video alike. Returns "subfolder/name".
async function uploadFile(file){
  const fd=new FormData(); fd.append("image",file,file.name); fd.append("overwrite","true");
  const r=await api.fetchApi("/upload/image",{method:"POST",body:fd});
  const d=await r.json();
  return d.subfolder?`${d.subfolder}/${d.name}`:d.name;
}

// Large image slot (first/last frame). onName(name|null).
function ImgSlot(hintTxt,onName){
  const wrap=mk("div",{position:"relative",width:"100%",minHeight:"110px",border:"1px dashed "+C.border,borderRadius:"9px",background:C.bg2,display:"flex",alignItems:"center",justifyContent:"center",cursor:"pointer",overflow:"hidden"});
  const hint=tx(mk("div",{fontSize:"10px",color:C.muted,textAlign:"center",padding:"14px"}),hintTxt);
  const img=mk("img",{maxWidth:"100%",maxHeight:"200px",display:"none",objectFit:"contain"});
  const clr=tx(mk("div",{position:"absolute",top:"4px",right:"6px",fontSize:"14px",color:"#ff6b6b",cursor:"pointer",display:"none",background:"rgba(0,0,0,.5)",borderRadius:"4px",padding:"0 5px",lineHeight:"18px"}),"×");
  const fileInput=mk("input",{display:"none"},{type:"file",accept:"image/*"});
  wrap.append(hint,img,clr,fileInput);
  let storedName=null;
  const upload=async(file)=>{
    try{ storedName=await uploadFile(file); img.src=URL.createObjectURL(file); img.style.display="block"; hint.style.display="none"; clr.style.display="block"; onName(storedName); }
    catch(e){ console.warn("[MMH3] upload:",e); }
  };
  wrap.onclick=(e)=>{ if(e.target===clr)return; fileInput.click(); };
  clr.onclick=(e)=>{ e.stopPropagation(); wrap.clear(); };
  fileInput.onchange=()=>{ if(fileInput.files[0])upload(fileInput.files[0]); };
  wrap.addEventListener("dragover",e=>{e.preventDefault();wrap.style.borderColor=LIME;});
  wrap.addEventListener("dragleave",()=>wrap.style.borderColor=C.border);
  wrap.addEventListener("drop",e=>{ e.preventDefault(); wrap.style.borderColor=C.border; const f=e.dataTransfer.files[0]; if(f)upload(f); });
  wrap.hasFile=()=>!!storedName;
  wrap.getName=()=>storedName;
  wrap.setName=(n)=>{ storedName=n||null; if(n){ img.style.display="none"; hint.textContent=n.split("/").pop(); hint.style.display="block"; clr.style.display="block"; } };
  wrap.clear=()=>{ storedName=null; img.style.display="none"; hint.textContent=hintTxt; hint.style.display="block"; clr.style.display="none"; onName(null); };
  return wrap;
}

// Compact square image slot (reference grid). tagLabel like "P1".
function RefImgSlot(tagLabel,onName){
  const wrap=mk("div",{position:"relative",width:"100%",aspectRatio:"1/1",border:"1px dashed "+C.border,borderRadius:"8px",background:C.bg2,display:"flex",alignItems:"center",justifyContent:"center",cursor:"pointer",overflow:"hidden"});
  const plus=tx(mk("div",{fontSize:"20px",color:C.muted}),"+");
  const img=mk("img",{width:"100%",height:"100%",display:"none",objectFit:"cover"});
  const tag=tx(mk("div",{position:"absolute",bottom:"2px",left:"3px",fontSize:"9px",fontWeight:"800",color:"#000",background:LIME,borderRadius:"3px",padding:"0 4px"}),tagLabel);
  const clr=tx(mk("div",{position:"absolute",top:"2px",right:"3px",fontSize:"12px",color:"#fff",cursor:"pointer",display:"none",background:"rgba(0,0,0,.55)",borderRadius:"3px",padding:"0 4px",lineHeight:"16px"}),"×");
  const fileInput=mk("input",{display:"none"},{type:"file",accept:"image/*"});
  wrap.append(plus,img,tag,clr,fileInput);
  let storedName=null;
  const upload=async(file)=>{
    try{ storedName=await uploadFile(file); img.src=URL.createObjectURL(file); img.style.display="block"; plus.style.display="none"; clr.style.display="block"; onName(storedName); }
    catch(e){ console.warn("[MMH3] ref upload:",e); }
  };
  wrap.onclick=(e)=>{ if(e.target===clr)return; fileInput.click(); };
  clr.onclick=(e)=>{ e.stopPropagation(); wrap.clear(); };
  fileInput.onchange=()=>{ if(fileInput.files[0])upload(fileInput.files[0]); };
  wrap.addEventListener("dragover",e=>{e.preventDefault();wrap.style.borderColor=LIME;});
  wrap.addEventListener("dragleave",()=>wrap.style.borderColor=C.border);
  wrap.addEventListener("drop",e=>{ e.preventDefault(); wrap.style.borderColor=C.border; const f=e.dataTransfer.files[0]; if(f)upload(f); });
  wrap.hasFile=()=>!!storedName;
  wrap.getName=()=>storedName;
  wrap.setTag=(t)=>{ tag.textContent=t; };
  wrap.setName=(n)=>{ storedName=n||null; if(n){ plus.style.display="none"; img.style.display="none"; clr.style.display="block"; } };
  wrap.clear=()=>{ storedName=null; img.style.display="none"; img.src=""; plus.style.display="block"; clr.style.display="none"; onName(null); };
  return wrap;
}

// Thin file-name slot for audio / video refs.
function FileRow(hintTxt,accept,onName){
  const wrap=mk("div",{position:"relative",display:"flex",alignItems:"center",gap:"6px",padding:"7px 9px",border:"1px dashed "+C.border,borderRadius:"7px",background:C.bg2,cursor:"pointer",fontSize:"10px",color:C.muted,minHeight:"20px"});
  const label=tx(mk("span",{overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap",flex:"1"}),hintTxt);
  const clr=tx(mk("span",{color:"#ff6b6b",cursor:"pointer",display:"none",fontSize:"13px"}),"×");
  const fileInput=mk("input",{display:"none"},{type:"file",accept});
  wrap.append(label,clr,fileInput);
  let storedName=null;
  const upload=async(file)=>{
    try{ storedName=await uploadFile(file); label.textContent=file.name; label.style.color=C.text; clr.style.display="inline"; onName(storedName); }
    catch(e){ console.warn("[MMH3] file upload:",e); }
  };
  wrap.onclick=(e)=>{ if(e.target===clr)return; fileInput.click(); };
  clr.onclick=(e)=>{ e.stopPropagation(); wrap.clear(); };
  fileInput.onchange=()=>{ if(fileInput.files[0])upload(fileInput.files[0]); };
  wrap.addEventListener("dragover",e=>{e.preventDefault();wrap.style.borderColor=LIME;});
  wrap.addEventListener("dragleave",()=>wrap.style.borderColor=C.border);
  wrap.addEventListener("drop",e=>{ e.preventDefault(); wrap.style.borderColor=C.border; const f=e.dataTransfer.files[0]; if(f)upload(f); });
  wrap.hasFile=()=>!!storedName;
  wrap.getName=()=>storedName;
  wrap.setName=(n)=>{ storedName=n||null; if(n){ label.textContent=n.split("/").pop(); label.style.color=C.text; clr.style.display="inline"; } };
  wrap.clear=()=>{ storedName=null; label.textContent=hintTxt; label.style.color=C.muted; clr.style.display="none"; onName(null); };
  return wrap;
}

// ── state ─────────────────────────────────────────────────────────────────────
function loadState(){ try{ return JSON.parse(localStorage.getItem(LS_KEY)||"{}"); }catch(e){ return {}; } }
function saveState(s){ try{ localStorage.setItem(LS_KEY,JSON.stringify(s)); }catch(e){} }
function loadDesignDraft(){ try{ const d=JSON.parse(localStorage.getItem(DESIGN_LS_KEY)||"{}"); return d&&typeof d==="object"?d:{}; }catch(e){ return {}; } }
function saveDesignDraft(d){ try{ localStorage.setItem(DESIGN_LS_KEY,JSON.stringify(d||{})); }catch(e){} }

// ── active refs for API events ────────────────────────────────────────────────
let _activeSetProgress=()=>{};
let _activeShowVideo=()=>{};
let _activeShowError=()=>{};
let _activeReset=()=>{};
let _activeSetPreview=()=>{};   // Stage 3 live preview — routes b_preview frames to the running node
let _activeRefreshGallery=()=>{};
let _activePromptId=null;
// true only between submitting our /prompt and its completion — so the shared
// "queue idle" signals only reset THIS node's button when it was actually running.
let _activeRunning=false;

// treat this prompt as done: re-enable the button, stop the timer, refresh the gallery.
function _finishActive(){ if(!_activeRunning) return; _activeRunning=false; _activeReset(); _activeRefreshGallery(); }

api.addEventListener("progress",(evt)=>{
  const d=evt.detail||{}; if(d.value!=null&&d.max){ _activeSetProgress(d.value/d.max, d.value, d.max); }
});
// Stage 3 — live preview: ComfyUI streams sampler previews as "b_preview" (a Blob). Show it on the running node.
let _prevBlobUrl=null;
api.addEventListener("b_preview",(evt)=>{ if(!_activeRunning)return; const b=evt.detail; if(b&&b.size){ try{ const u=URL.createObjectURL(b); _activeSetPreview(u); if(_prevBlobUrl)URL.revokeObjectURL(_prevBlobUrl); _prevBlobUrl=u; }catch(_e){} } });
api.addEventListener("executed",(evt)=>{
  const d=evt.detail||{};
  // ignore other graphs' outputs once we know our own prompt id
  if(_activePromptId && d.prompt_id && d.prompt_id!==_activePromptId) return;
  const out=d.output||{};
    // H3 Studio's safe streaming join emits its own output key.  Keep it first
    // so the final joined 1080p/2K clip is previewed, never the temporary master.
    const pick=out.mmh3_studio_video||out.images||out.video||out.videos||out.gifs||out.animated||null;
  let item=null;
  if(Array.isArray(pick)&&pick.length) item=pick[0];
  else if(pick&&pick.filename) item=pick;
  if(item&&item.filename){
    _activeShowVideo(item);   // shows in the preview + drops it into the gallery
    _finishActive();          // SaveVideo is the terminal node → we're done, re-enable now
  }
});
api.addEventListener("execution_success",()=>{ _finishActive(); });
api.addEventListener("execution_interrupted",()=>{ _finishActive(); });
api.addEventListener("execution_error",(evt)=>{
  const d=evt.detail||{};
  if(_activePromptId && d.prompt_id && d.prompt_id!==_activePromptId) return;
  _activeShowError(fmtErr(d.exception_message||d.exception_type||d)); _activeRunning=false; _activeReset();
});

// ──────────────────────────────────────────────────────────────────────────────
app.registerExtension({
  name:"MiniMaxH3OneNode.v1",
  async beforeRegisterNodeDef(nodeType,nodeData){
    if(nodeData.name!=="MiniMaxH3OneNode") return;

    nodeType.prototype.onNodeCreated=function(){
      this.color=C.bg0; this.bgcolor=C.bg0; this.resizable=true;  // user-resizable
      this.outputs=[]; if(this.widgets)this.widgets=[];
      if(!window.__mmh3_nodes) window.__mmh3_nodes={};
      const cached=window.__mmh3_nodes[this.id];
      if(cached){
        const _w=this.addDOMWidget("mmh3_ui","div",cached.root,{getValue(){return null;},setValue(){},serialize:false});
        // computeSize must be set ON the widget (options.computeSize is ignored by this
        // ComfyUI frontend). It returns the PERSISTED target size (floored at the min) so
        // the node holds its size; onResize updates that target when the user drags.
        _w.computeSize=function(){ const t=(cached.S&&cached.S.nodeSize)||[NODE_W,NODE_H]; return [Math.max(MIN_W,t[0]),Math.max(MIN_H-TITLE_H,t[1]-TITLE_H)]; };
        this.setSize((cached.S&&cached.S.nodeSize)?cached.S.nodeSize.slice():[NODE_W,NODE_H]);
        _bindActive(cached);
        return;
      }
      this._buildUI();
    };
    // clamp to the usable floor and remember the size the user drags to
    nodeType.prototype.onResize=function(size){
      const s=size||this.size;
      if(s[0]<MIN_W)s[0]=MIN_W;
      if(s[1]<MIN_H)s[1]=MIN_H;
      // Only persist genuine user drags. ComfyUI fires onResize during the initial add/
      // layout pass; the time-guard (>700ms after build) drops that noise so it can't
      // clobber the default target size stored in S.nodeSize.
      const c=window.__mmh3_nodes&&window.__mmh3_nodes[this.id];
      if(c&&c.S&&(Date.now()-(c._t0||0)>700)){ c.S.nodeSize=[s[0],s[1]]; if(c.fns&&c.fns.persist)c.fns.persist(); }
    };
    nodeType.prototype.getSlotMenuOptions=function(){ return []; };

    nodeType.prototype._buildUI=function(){
      const self=this;
      const saved=loadState();
      const S=self._mmh3_S||(self._mmh3_S={
        mode:        saved.mode||"t2v",          // "t2v" | "i2v" | "r2v" | "studio"
        // models (auto-detected, overridable)
        unetFl:      saved.unetFl||"", unetRef:saved.unetRef||"",
        textEncoder: saved.textEncoder||"", videoVae:saved.videoVae||"", audioVae:saved.audioVae||"",
        // saved character voice profiles (comfyui-minimax-h3-audio-T8) — described_voice, no audio needed.
        // Mirrors what's actually saved to disk under user/default/minimax_h3_t8/voice_profiles/<name>/
        voiceLibrary: Array.isArray(saved.voiceLibrary) ? saved.voiceLibrary : [
          {name:"mio",    language:"English", description:"young adult female voice, calm and controlled, precise and economical diction, low-key understated delivery with a slight cool detachment, unhurried even under pressure, close conversational mic distance, natural human breath and micro-pauses"},
          {name:"kairos", language:"English", description:"adult male voice, low and even, minimal inflection, clipped and deliberate delivery, speaks rarely and says exactly what is needed, calm and unshaken under stress, close conversational mic distance, natural human breath"},
          {name:"marlo",  language:"English", description:"adult male voice, warm but rough-edged with a slight rasp, louder and more expressive energy, confident swagger, quick to laugh or shout, close conversational mic distance, natural human breath and micro-pauses"}
        ],
        // prompt
        prompt:      saved.prompt||"",
        // resolution / duration
        aspect:      saved.aspect||"16:9 (Widescreen)",
        megapixels:  saved.megapixels!==undefined?saved.megapixels:0.4,
        duration:    saved.duration!==undefined?saved.duration:5.0,
        // two-pass HD: draft(stage1Mp) → independently chosen refine target (stage2Mp).
        // Existing T2V/I2V state follows Resolution until its new Refine field is changed.
        twoPass:     saved.twoPass||false,
        stage1Mp:    saved.stage1Mp!==undefined?saved.stage1Mp:0.4,
        stage2Mp:    saved.stage2Mp!==undefined?saved.stage2Mp:1.2,
        stage2MpOverride: !!saved.stage2MpOverride,
        stage2Steps: saved.stage2Steps!==undefined?saved.stage2Steps:4,
        stage2Denoise: saved.stage2Denoise!==undefined?saved.stage2Denoise:0.2,
        // two-pass upscale engine: "pixel" = decode→RTX-VSR/Lanczos→re-encode (default, unchanged);
        // "latent" = split AV → MinimaxH3LatentUpscaler3D (latent-space) → rejoin (no decode round trip)
        twoPassEngine: saved.twoPassEngine||"pixel",
        latentUpModel: saved.latentUpModel||"",
        // Memory-safe stage 2: VAE/pixel upscale one H3 group at a time, then fuse H3's
        // overlapping latent windows internally. This is deliberately OFF by default so
        // existing two-pass jobs keep their exact behavior.
        twoPassWindowed: saved.twoPassWindowed||false,
        twoPassWindowProfile: saved.twoPassWindowProfile||"safe",
        // sampling
        steps:       saved.steps||20,
        sampler:     saved.sampler||"res_multistep",
        scheduler:   saved.scheduler||"simple",
        seed:        saved.seed||0, randomizeSeed:saved.randomizeSeed!==undefined?saved.randomizeSeed:true,
        // advanced: sigma shift (model has good internal defaults 12 / 3)
        sigmaShiftOn:saved.sigmaShiftOn||false, shiftVideo:saved.shiftVideo!==undefined?saved.shiftVideo:12.0, shiftAudio:saved.shiftAudio!==undefined?saved.shiftAudio:3.0,
        // speed: sage attention (KJNodes, experimental) + Blackwell fast-fp8 load
        sageAttn:    saved.sageAttn||false, fastFp8:saved.fastFp8||false, solAttn: saved.solAttn||false,
        livePreview: saved.livePreview||false,   // Stage 3 — CGlide Glide Preview patch
        // cache accelerator (step reuse) — mutually exclusive: "off"|"teacache"|"spectrum"|"fbc"
        cacheEngine: saved.cacheEngine||"off",
        teaThresh:   saved.teaThresh!==undefined?saved.teaThresh:0.15,
        spectrumBlend: saved.spectrumBlend!==undefined?saved.spectrumBlend:0.5,
        fbcMode:     saved.fbcMode||"H3 Fast — 0.10 / max 2",
        easyThresh:  saved.easyThresh!==undefined?saved.easyThresh:0.2,
        // turbo 4-step LoRA (larryvrh) — ~5x faster; works on pruned bases
        turboOn:     saved.turboOn||false, turboSteps: saved.turboSteps||6, turboLora: saved.turboLora||"", turboStrength: saved.turboStrength!==undefined?saved.turboStrength:1.0, turboLowVram: saved.turboLowVram||false,
        // Alibaba PDD acceleration is NOT a normal LoRA: it carries a trunk LoRA plus a
        // per-step final-layer head bank. Keep it in its own official loader / selector.
        pddOn: saved.pddOn||false, pddNfe:["8","6","4"].includes(String(saved.pddNfe))?String(saved.pddNfe):"8",
        pddFlFile:saved.pddFlFile||"", pddRefFile:saved.pddRefFile||"",
        styleOn: saved.styleOn||false, styleLora: saved.styleLora||"", styleStrength: saved.styleStrength!==undefined?saved.styleStrength:1.0, styleLowVram: saved.styleLowVram||false,
        // stackable style/character LoRA list — {lora,strength} entries, applied in order. Migrates
        // a pre-existing single styleLora/styleStrength pair into a one-item array on first load.
        styleLoras: Array.isArray(saved.styleLoras) ? saved.styleLoras : (saved.styleLora ? [{lora:saved.styleLora,strength:saved.styleStrength!==undefined?saved.styleStrength:1.0}] : []),
        lxTurbo: saved.lxTurbo||"off",   // distilled-turbo preset: "off" | "fl2v" | "r2v" (lightx2v LoRAs, locked recipe)
        // Pin the exact LightX files. This keeps installing a newer checkpoint from silently
        // changing a saved workflow's recipe; older state migrates to the same files it used.
        lxTurboFlFile:saved.lxTurboFlFile||"", lxTurboRefFile:saved.lxTurboRefFile||"",
        // upscale tab
      upscaleEngine: (saved.upscaleEngine==="ltx"?"model":saved.upscaleEngine)||"model",   // "model" (ESRGAN) | "rtxvsr" | "h3finish" | "seedvr2" | "flashvsr"
        upscaleModel: saved.upscaleModel||"", upscaleScale: saved.upscaleScale||2,
        upscaleSource: saved.upscaleSource||null,   // {filename,subfolder,type}
        // H3 Finish lives inside Upscale but is intentionally independent from new-generation
        // Two-pass HD. It accepts a finished video, re-encodes it as a protected H3 source plate,
        // then does a conservative latent upscale + source-locked refinement.
        finishSourceMode: ["auto","h3","generic"].includes(saved.finishSourceMode)?saved.finishSourceMode:"auto",
        finishTargetMp: [1,2,4].includes(+saved.finishTargetMp)?+saved.finishTargetMp:2,
        finishPrompt: saved.finishPrompt||"", finishReference: saved.finishReference||null,
        finishUseSavedPrompt: saved.finishUseSavedPrompt!==undefined?!!saved.finishUseSavedPrompt:true,
        finishStrength: ["conservative","balanced","strong"].includes(saved.finishStrength)?saved.finishStrength:"balanced",
        finishSteps: Math.max(4,Math.min(20,+saved.finishSteps||8)),
        finishSeed: +saved.finishSeed||0, finishRandomize: saved.finishRandomize!==undefined?!!saved.finishRandomize:false,
        finishInfo: saved.finishInfo||null,
        // isolated masked-video repair tab — source, static or SAM 3.1 tracked mask, optional replacement reference
        repairSource: saved.repairSource||null, repairMask: saved.repairMask||null, repairRef: saved.repairRef||null,
        // Repair stays deliberately separate from normal Turbo generation.  These presets only
        // select a conservative full-H3 step count; the mask/source lock stays intact.
        repairPrompt: saved.repairPrompt||"", repairSteps: saved.repairSteps!==undefined?saved.repairSteps:16,
        repairPreset: ["fast","balanced","quality","custom"].includes(saved.repairPreset)
          ? saved.repairPreset : (saved.repairSteps===undefined?"balanced":(+saved.repairSteps===12?"fast":(+saved.repairSteps===16?"balanced":(+saved.repairSteps===20?"quality":"custom")))),
        // Optional source-locked HD finish: repair at H3's native canvas, then use the same
        // 16GB-safe latent upscale + internally fused low-denoise windows as Two-pass HD.
        repairHd: !!saved.repairHd,
        repairTargetMp: [1,2,4].includes(+saved.repairTargetMp)?+saved.repairTargetMp:2,
        repairHdSteps: Math.max(2,Math.min(8,+saved.repairHdSteps||4)),
        repairHdDenoise: saved.repairHdDenoise!==undefined?Math.max(0.05,Math.min(0.25,+saved.repairHdDenoise||0.20)):0.20,
        repairSeed: saved.repairSeed||0, repairRandomize: saved.repairRandomize!==undefined?saved.repairRandomize:true,
        repairInfo: saved.repairInfo||null,
        // "static" keeps the original hand-painted white mask. "sam3" turns a short object
        // description into a temporally tracked mask before the H3 source plate is masked.
        repairMaskMode: saved.repairMaskMode==="sam3"?"sam3":"static",
        repairSamPrompt: saved.repairSamPrompt||"", repairSamThreshold: saved.repairSamThreshold!==undefined?Math.max(0.1,Math.min(0.9,+saved.repairSamThreshold||0.5)):0.5,
        repairSamCleanup: saved.repairSamCleanup!==undefined?!!saved.repairSamCleanup:true,
        svrRes: saved.svrRes||1080, svrBlockSwap: (saved.svrBlockSwap===undefined||saved.svrBlockSwap===16)?0:saved.svrBlockSwap,
        svrDitModel: saved.svrDitModel||"seedvr2_ema_3b_fp8_e4m3fn.safetensors",
        svrCompile: saved.svrCompile||false, svrBatch: saved.svrBatch||5,
        // FlashVSR (fast diffusion upscaler)
        fvsrMode: saved.fvsrMode||"tiny", fvsrScale: saved.fvsrScale||2, fvsrVae: saved.fvsrVae||(saved.fvsrLightVae?"LightVAE_W2.1":"Wan2.1"),
        // RTX Video Super Resolution (NVIDIA hardware upscaler)
        rtxScale: saved.rtxScale||2, rtxQuality: saved.rtxQuality||"ULTRA",
        // node size (user-resizable)
        nodeSize:    saved.nodeSize||[NODE_W,NODE_H],
        // I2V frames
        firstFrame:  saved.firstFrame||null, lastFrame:saved.lastFrame||null, useLastFrame:saved.useLastFrame||false, reframe: saved.reframe||"match",
        dirShots:    Array.isArray(saved.dirShots)?saved.dirShots:[], dirAudio: saved.dirAudio||null, dirOutRes: saved.dirOutRes||"4k", dirAspect: saved.dirAspect||"9:16", dirFps: saved.dirFps||24, dirFmt: saved.dirFmt||"h264",   // H3 Director (assembler tab)
        // R2V references
        refImages:   saved.refImages||new Array(MAX_REF_IMAGES).fill(null),
        allow9:      saved.allow9||false,
        refVideos:   saved.refVideos||[{file:null,useAudio:true},{file:null,useAudio:true},{file:null,useAudio:true}],
        refAudios:   saved.refAudios||new Array(MAX_REF_AUDIOS).fill(null),
        refAudioTrim: saved.refAudioTrim||new Array(MAX_REF_AUDIOS).fill(null),  // parallel {start,end} per audio slot
        refImageSize:saved.refImageSize||"match",
        // low-VRAM: cap how many seconds of each reference VIDEO are decoded/encoded (heavy on 16 GB).
        // Toggle off (or raise) on 24 GB+ cards. Off still caps to output length (never decodes waste).
        refVidCap:   saved.refVidCap!==undefined?saved.refVidCap:true,
        refVidCapSec:saved.refVidCapSec!==undefined?saved.refVidCapSec:4,
        // H3 Studio tab (native CGlide conditioning + our One Node render/refine path).
        // `studioContinue` is always an INPUT-relative staged filename so CGlide can
        // safely resolve it; the final high-res join streams from that same source.
        studioMode: saved.studioMode==="fl2va"?"fl2va":"ref2va",
        studioContinue: saved.studioContinue||null,
        studioContinueFrames:[22,39].includes(+saved.studioContinueFrames)?+saved.studioContinueFrames:22,
        studioContinueAudio:saved.studioContinueAudio!==undefined?!!saved.studioContinueAudio:true,
        studioContinueFlatten:saved.studioContinueFlatten!==undefined?Math.max(0,Math.min(1,+saved.studioContinueFlatten||0.5)):0.5,
        studioSeamMode:["early_cut","early_scurve","hard_cut"].includes(saved.studioSeamMode)?saved.studioSeamMode:"early_cut",
        studioSeamBlend:Math.max(1,Math.min(12,+saved.studioSeamBlend||6)),
        generating:false,
      });
      // migrate arrays to fixed length (in case an older state was shorter)
      while(S.refImages.length<MAX_REF_IMAGES)S.refImages.push(null);
      while(S.refAudios.length<MAX_REF_AUDIOS)S.refAudios.push(null);
      while(S.refVideos.length<MAX_REF_VIDEOS)S.refVideos.push({file:null,useAudio:true});
      // trim (start/end seconds): videos inline, audios in a parallel array — default 0/0 = full clip
      while(S.refAudioTrim.length<MAX_REF_AUDIOS)S.refAudioTrim.push(null);
      S.refAudioTrim=S.refAudioTrim.map(t=>t||{start:0,end:0});
      S.refVideos.forEach(v=>{ if(v.start===undefined)v.start=0; if(v.end===undefined)v.end=0; });
      // Old saved states used the 39-frame profile. Latent safe mode defaults to the
      // smallest valid H3 window instead, because that is the VRAM lever at 2K on 16GB.
      if(S.twoPassEngine==="latent"&&S.twoPassWindowed&&S.twoPassWindowProfile==="safe")S.twoPassWindowProfile="ultra";

      const persist=()=>saveState({
        mode:S.mode,unetFl:S.unetFl,unetRef:S.unetRef,textEncoder:S.textEncoder,videoVae:S.videoVae,audioVae:S.audioVae,
        prompt:S.prompt,aspect:S.aspect,megapixels:S.megapixels,duration:S.duration,
        twoPass:S.twoPass,stage1Mp:S.stage1Mp,stage2Mp:S.stage2Mp,stage2MpOverride:S.stage2MpOverride,stage2Steps:S.stage2Steps,stage2Denoise:S.stage2Denoise,twoPassEngine:S.twoPassEngine,latentUpModel:S.latentUpModel,twoPassWindowed:S.twoPassWindowed,twoPassWindowProfile:S.twoPassWindowProfile,
        steps:S.steps,sampler:S.sampler,scheduler:S.scheduler,seed:S.seed,randomizeSeed:S.randomizeSeed,
        sigmaShiftOn:S.sigmaShiftOn,shiftVideo:S.shiftVideo,shiftAudio:S.shiftAudio,
        sageAttn:S.sageAttn,fastFp8:S.fastFp8,solAttn:S.solAttn,livePreview:S.livePreview,nodeSize:S.nodeSize,
        cacheEngine:S.cacheEngine,teaThresh:S.teaThresh,spectrumBlend:S.spectrumBlend,fbcMode:S.fbcMode,easyThresh:S.easyThresh,
        styleLoras:S.styleLoras, voiceLibrary:S.voiceLibrary,
        turboOn:S.turboOn,turboSteps:S.turboSteps,turboLora:S.turboLora,turboStrength:S.turboStrength,turboLowVram:S.turboLowVram,
        pddOn:S.pddOn,pddNfe:S.pddNfe,pddFlFile:S.pddFlFile,pddRefFile:S.pddRefFile,
        styleOn:S.styleOn,styleLora:S.styleLora,styleStrength:S.styleStrength,styleLowVram:S.styleLowVram,lxTurbo:S.lxTurbo,lxTurboFlFile:S.lxTurboFlFile,lxTurboRefFile:S.lxTurboRefFile,
        upscaleEngine:S.upscaleEngine,upscaleModel:S.upscaleModel,upscaleScale:S.upscaleScale,upscaleSource:S.upscaleSource,
        finishSourceMode:S.finishSourceMode,finishTargetMp:S.finishTargetMp,finishPrompt:S.finishPrompt,finishReference:S.finishReference,
        finishUseSavedPrompt:S.finishUseSavedPrompt,finishStrength:S.finishStrength,finishSteps:S.finishSteps,
        finishSeed:S.finishSeed,finishRandomize:S.finishRandomize,finishInfo:S.finishInfo,
        repairSource:S.repairSource,repairMask:S.repairMask,repairRef:S.repairRef,repairPrompt:S.repairPrompt,
        repairSteps:S.repairSteps,repairPreset:S.repairPreset,repairHd:S.repairHd,repairTargetMp:S.repairTargetMp,repairHdSteps:S.repairHdSteps,repairHdDenoise:S.repairHdDenoise,
        repairSeed:S.repairSeed,repairRandomize:S.repairRandomize,repairInfo:S.repairInfo,
        repairMaskMode:S.repairMaskMode,repairSamPrompt:S.repairSamPrompt,repairSamThreshold:S.repairSamThreshold,repairSamCleanup:S.repairSamCleanup,
        svrRes:S.svrRes,svrBlockSwap:S.svrBlockSwap,svrDitModel:S.svrDitModel,svrCompile:S.svrCompile,svrBatch:S.svrBatch,
        fvsrMode:S.fvsrMode,fvsrScale:S.fvsrScale,fvsrVae:S.fvsrVae,rtxScale:S.rtxScale,rtxQuality:S.rtxQuality,
        firstFrame:S.firstFrame,lastFrame:S.lastFrame,useLastFrame:S.useLastFrame,reframe:S.reframe,
        dirShots:S.dirShots,dirAudio:S.dirAudio,dirOutRes:S.dirOutRes,dirAspect:S.dirAspect,dirFps:S.dirFps,dirFmt:S.dirFmt,
        refImages:S.refImages,allow9:S.allow9,refVideos:S.refVideos,refAudios:S.refAudios,refAudioTrim:S.refAudioTrim,refImageSize:S.refImageSize,
        refVidCap:S.refVidCap,refVidCapSec:S.refVidCapSec,
        studioMode:S.studioMode,studioContinue:S.studioContinue,studioContinueFrames:S.studioContinueFrames,studioContinueAudio:S.studioContinueAudio,studioContinueFlatten:S.studioContinueFlatten,studioSeamMode:S.studioSeamMode,studioSeamBlend:S.studioSeamBlend,
      });

      let _sigmaShiftAvailable=true; // MiniMaxH3SigmaShift ships with the H3 nodes
      let _sageAvailable=false;      // MiniMaxH3MemoryEfficientSageAttentionPatch (KJNodes) — probed on init
      let _solAvailable=false;       // MiniMaxH3MemoryEfficientSolAttentionPatch (ComfyUI-sol-attn) — probed on init
      let _svrAvailable=false;       // SeedVR2VideoUpscaler — probed on init
      let _fvsrAvailable=false;      // FlashVSRNode (ComfyUI-FlashVSR_Stable) — probed on init
      let _rtxAvailable=false;       // RTXVideoSuperResolution (Comfy-Org Nvidia_RTX_Nodes) — probed on init
      let _turboNode=false;          // MiniMaxH3TurboSampler present — probed on init
      let _pddApplyAvail=false;      // MiniMaxH3PDDAccApply (official PDD trunk + heads)
      let _pddSchedulerAvail=false;  // MiniMaxH3PDDAccScheduler (trained partial-denoise blocks)
      let _pddFiles=[], _pddFlFiles=[], _pddRefFiles=[];
      let _teaAvailable=false;       // MiniMaxH3TeaCache (Icyoung) — probed on init
      let _spectrumAvailable=false;  // SpectrumApplyMiniMaxH3 (xmarre) — probed on init
      let _fbcAvailable=false;       // ApplyMiniMaxH3FirstBlockCache (duckyshell) — probed on init
      let _easycacheAvailable=false; // EasyCache (native ComfyUI core, comfy_extras/nodes_easycache.py) — probed on init
      let _ptConcatAvail=false;      // PT_H3ConcatAVLatent (ptmaster) — two-pass, probed on init
      let _t8DecodeAvail=false;      // MiniMaxH3AVDecodeT8 (T8mars) — two-pass, probed on init
      let _latentUpAvail=false;      // MinimaxH3LatentUpscaler3D (LBH-123-AI) — latent-space two-pass engine
      let _mmh3ChunkUpAvail=false;   // MMH3Tools: VAE/pixel upscale one H3 group at a time
      let _mmh3WindowAvail=false;    // MMH3Tools: fused low-denoise H3 context windows
      let _mmh3SplitAvail=false;     // MMH3Tools: split packed AV latent for audio pinning
      let _mmh3PackAvail=false;      // MMH3Tools: re-pack the audio-pinned AV latent
      let _noiseMaskAvail=false;     // core SetLatentNoiseMask + SolidMask (lock audio during stage 2)
      let _vramGB=null;              // detected GPU VRAM (rounded GB) - probed on init via /system_stats
      let _latentUpModels=[];        // model files found in models/latent_upscale_models
      let _cglidePrevAvail=false;    // CSGlidePreviewCS (CGlide) — Stage 3 live preview patch
      let _studioCastAvail=false;    // CSGlideCastCS — native H3 Studio conditioning
      let _studioVideoAvail=false;   // CSGlideVideoCS — high quality temporary AV encode
      let _studioSafeJoinAvail=false;// MMH3StudioSafeJoin — streaming final 2K seam / audio join
      let _lxFl2vLora="", _lxR2vLora="";
      let _lxFl2vLoras=[], _lxR2vLoras=[], _animeMotionLoras=[];
      let _repairAvail=false;          // maintained H3 masked-video repair extension — probed on init
      let _repairMissing=[];
      let _sam3Avail=false;            // Core SAM 3.1 video tracker + installed checkpoint
      let _sam3CleanupAvail=false;     // MaskVidExperiments temporal cleanup (optional but preferred)
      let _sam3Missing=[];
      let _sam3Checkpoint="";
      let _finishAvail=false;           // all nodes required for standalone H3 Finish
      let _finishMissing=[];
      let _finishDetected=null;         // {kind:"h3"|"likely_h3"|"unknown", reason, meta}

      // This is intentionally an internal H3 window/fuse pass, not "make MP4 chunks then
      // crossfade them". Keeping the stage-1 latent whole gives every stage-2 window the
      // same source identity; the pack pyramid-fuses their overlap before decoding once.
      function _windowedPixelTwoPassReady(){
        return _mmh3ChunkUpAvail&&_mmh3WindowAvail&&_mmh3SplitAvail&&_mmh3PackAvail&&_noiseMaskAvail;
      }
      function _windowedLatentTwoPassReady(){
        return _latentUpAvail&&!!(S.latentUpModel||_latentUpModels.length)&&_mmh3WindowAvail&&_mmh3SplitAvail&&_mmh3PackAvail&&_noiseMaskAvail;
      }
      function _windowedTwoPassReady(){
        return S.twoPassEngine==="latent" ? _windowedLatentTwoPassReady() : _windowedPixelTwoPassReady();
      }
      function _twoPassWindowConfig(){
        if(S.twoPassWindowProfile==="balanced") return {contextLength:17,contextOverlap:7,label:"58-frame windows"};
        if(S.twoPassWindowProfile==="safe") return {contextLength:12,contextOverlap:7,label:"39-frame windows"};
        return {contextLength:7,contextOverlap:2,label:"20-frame windows"};
      }
      // R2V has always used its dedicated Stage-2 value. For older T2V/I2V/First+Last
      // saved states, keep the former "Resolution above is the target" behavior until the
      // user deliberately edits the newly visible Refine MP field.
      function _isReferenceMode(){ return S.mode==="r2v" || (S.mode==="studio"&&S.studioMode==="ref2va"); }
      function _stage2TargetMp(){
        return (_isReferenceMode()||S.stage2MpOverride) ? (+S.stage2Mp||1.2) : (+S.megapixels||0.4);
      }
      function _pddReady(){ return _pddApplyAvail&&_pddSchedulerAvail; }
      function _pddFileForMode(){ return _isReferenceMode() ? (S.pddRefFile||"") : (S.pddFlFile||""); }

      // ── style ─────────────────────────────────────────────────────────────
      if(!document.getElementById("mmh3-style")){
        const st=mk("style",{},{id:"mmh3-style"});
        st.textContent=`@keyframes mmh3-grad{0%{background-position:0% 50%}50%{background-position:100% 50%}100%{background-position:0% 50%}}
        @keyframes mmh3-spin{to{transform:rotate(360deg)}}
        .mmh3-scroll::-webkit-scrollbar{width:8px;height:8px}.mmh3-scroll::-webkit-scrollbar-thumb{background:#333;border-radius:4px}`;
        document.head.appendChild(st);
      }

      const root=mk("div",{width:"100%",height:"100%",boxSizing:"border-box",background:C.bg0,color:C.text,position:"relative",
        borderRadius:"12px",overflow:"hidden",display:"flex",flexDirection:"column",
        fontFamily:"system-ui,-apple-system,Segoe UI,Roboto,sans-serif",border:"1px solid "+C.border});

      // ── header ────────────────────────────────────────────────────────────
      const header=mk("div",{display:"flex",alignItems:"center",gap:"10px",padding:"10px 14px",borderBottom:"1px solid "+C.border,background:C.bg1});
      const dot=mk("div",{width:"10px",height:"10px",borderRadius:"50%",background:LIME,boxShadow:"0 0 8px "+LIME});
      const title=tx(mk("div",{fontSize:"13px",fontWeight:"800",letterSpacing:".04em"}),"ONE NODE · MINIMAX H3");
      const subtitle=tx(mk("div",{fontSize:"10px",color:C.muted}),"video + native audio");
      const titleWrap=mk("div",{display:"flex",flexDirection:"column"}); titleWrap.append(title,subtitle);
      const verBadge=tx(mk("div",{fontSize:"9px",fontWeight:"800",color:"#000",background:LIME,borderRadius:"4px",padding:"1px 6px"}),VERSION);
      const pillT2V=Pill("T2V",false,()=>setMode("t2v"));
      const pillI2V=Pill("I2V",false,()=>setMode("i2v"));
      const pillR2V=Pill("R2V",false,()=>setMode("r2v"));
      const pillStudio=Pill("🎞 H3 STUDIO",false,()=>setMode("studio"));
      // CREATE is intentionally a lazy overlay.  Nothing from it runs while the
      // normal renderer is building, so a bad draft can never blank the node UI.
      const pillCreate=Pill("✦ CREATE",false,()=>openCreativeStudio());
      const pillUp=Pill("UPSCALE",false,()=>setMode("upscale"));
      const pillRepair=Pill("🩹 REPAIR",false,()=>setMode("repair"));
      const pillDir=Pill("🎬 DIRECTOR",false,()=>setMode("director"));
      // ── node-level fullscreen (whole panel, like Krea2) ──
      const _fsExpandIco=`<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7"/></svg>`;
      const _fsCollapseIco=`<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M8 3v5H3M16 3v5h5M8 21v-5H3M16 21v-5h5"/></svg>`;
      const fsNodeBtn=mk("button",{background:"transparent",border:"1.5px solid "+C.border,borderRadius:"6px",padding:"3px 7px",cursor:"pointer",color:C.muted,display:"flex",alignItems:"center",flexShrink:"0",outline:"none",transition:"border-color .15s,color .15s"});
      fsNodeBtn.title="Fullscreen (F)"; fsNodeBtn.innerHTML=_fsExpandIco;
      fsNodeBtn.onmouseenter=()=>{fsNodeBtn.style.borderColor=LIME;fsNodeBtn.style.color=LIME;};
      fsNodeBtn.onmouseleave=()=>{fsNodeBtn.style.borderColor=C.border;fsNodeBtn.style.color=C.muted;};
      let _nodeFS=false,_fsNodeOverlay=null,_rootOrigParent=null,_rootOrigNext=null;
      const _enterNodeFS=()=>{
        if(_nodeFS) return;
        if(!_fsNodeOverlay){ _fsNodeOverlay=mk("div",{position:"fixed",inset:"0",zIndex:"99990",background:"rgba(6,6,8,.97)",display:"none",alignItems:"center",justifyContent:"center",boxSizing:"border-box",overflow:"hidden"}); document.body.appendChild(_fsNodeOverlay); }
        _rootOrigParent=root.parentNode; _rootOrigNext=root.nextSibling;
        const vw=window.innerWidth,vh=window.innerHeight, sc=Math.min(vw/NODE_W,vh/NODE_H)*0.97;
        root.style.width=NODE_W+"px"; root.style.height=NODE_H+"px"; root.style.borderRadius="0"; root.style.transformOrigin="top left"; root.style.transform="scale("+sc+")";
        const wrap=mk("div",{width:Math.round(NODE_W*sc)+"px",height:Math.round(NODE_H*sc)+"px",position:"relative",flexShrink:"0",overflow:"hidden"});
        wrap.appendChild(root); _fsNodeOverlay.appendChild(wrap); _fsNodeOverlay._wrap=wrap;
        _fsNodeOverlay.style.display="flex"; fsNodeBtn.innerHTML=_fsCollapseIco; _nodeFS=true;
      };
      const _exitNodeFS=()=>{
        if(!_nodeFS) return;
        if(_rootOrigParent){ if(_rootOrigNext)_rootOrigParent.insertBefore(root,_rootOrigNext); else _rootOrigParent.appendChild(root); }
        root.style.width="100%"; root.style.height="100%"; root.style.borderRadius="12px"; root.style.transform=""; root.style.transformOrigin="";
        if(_fsNodeOverlay&&_fsNodeOverlay._wrap){_fsNodeOverlay._wrap.remove();_fsNodeOverlay._wrap=null;}
        if(_fsNodeOverlay)_fsNodeOverlay.style.display="none"; fsNodeBtn.innerHTML=_fsExpandIco; _nodeFS=false;
      };
      const _toggleNodeFS=()=>{ _nodeFS?_exitNodeFS():_enterNodeFS(); };
      fsNodeBtn.onclick=_toggleNodeFS;
      const pillRow=mk("div",{display:"flex",gap:"6px",marginLeft:"auto",alignItems:"center",flexWrap:"wrap"}); pillRow.append(pillT2V,pillI2V,pillR2V,pillStudio,pillCreate,pillUp,pillRepair,pillDir,fsNodeBtn);
      header.append(dot,titleWrap,verBadge,pillRow);

      // ── body: two columns ─────────────────────────────────────────────────
      const body=mk("div",{flex:"1",display:"flex",minHeight:"0"});
      const left=mk("div",{width:"440px",flex:"0 0 440px",borderRight:"1px solid "+C.border,overflowY:"auto",padding:"12px"},{className:"mmh3-scroll"});
      const right=mk("div",{flex:"1",display:"flex",flexDirection:"column",padding:"12px",minWidth:"0"});
      body.append(left,right);

      // ===== LEFT: PROMPT =====
      const promptHdr=mk("div",{display:"flex",alignItems:"center",justifyContent:"space-between",margin:"0 0 8px"});
      promptHdr.append(sectionTitle("Prompt"));
      const tmplDD=mk("div",{width:"150px"}); const tmplSel=DD(["Load example…"],"Load example…",v=>applyTemplate(v)); tmplDD.appendChild(tmplSel);
      promptHdr.appendChild(tmplDD); promptHdr.lastChild.style.marginBottom="0";
      left.appendChild(promptHdr);

      const modeHint=tx(mk("div",{fontSize:"9.5px",color:C.muted,margin:"0 0 6px",lineHeight:"1.45"}),"");
      left.appendChild(modeHint);

      const posTA=mk("textarea",{width:"100%",minHeight:"96px",resize:"vertical",background:C.bg2,border:"1px solid "+C.border,borderRadius:"8px",color:C.text,fontSize:"12px",padding:"8px",outline:"none",boxSizing:"border-box",fontFamily:"inherit"},{placeholder:"Describe the shots, camera moves, AND the audio (dialogue, SFX, music) in one block. H3 renders sound jointly with the picture.",value:S.prompt});
      posTA.addEventListener("input",()=>{S.prompt=posTA.value;persist();try{updatePromptChecks();}catch(_e){}});
      posTA.addEventListener("wheel",e=>e.stopPropagation(),{passive:true});
      left.appendChild(posTA);

      // ── CREATE: isolated local Creative Context Builder ────────────────────
      // This is deliberately constructed only after the user presses CREATE.
      // It owns a separate localStorage draft and only hands a plain H3 prompt
      // back to a trusted existing renderer.  It never owns uploads, model
      // settings, continuation state, or the /prompt graph.
      const _createDraft=Object.assign({
        name:"", style:"", customStyle:"", brief:"", soundscape:"", music:"", noDialogue:true
      },loadDesignDraft());
      let creativeOverlay=null, creativeAssistant=null, refreshCreativeStudio=()=>{};
      const _createStyleSentence=(d)=>{
        if(d.style==="2D Anime")return "2D hand-drawn anime visual language, clean intentional linework, stable cel shading, expressive but anatomically believable faces, consistent costume and prop design.";
        if(d.style==="Webtoon / comic")return "premium vertical-webtoon visual language, crisp graphic linework, deliberate cel shading, readable silhouettes, stable character design and cinematic panel-like framing.";
        if(d.style==="Cinematic live action")return "cinematic live-action visual language, natural material detail, physically grounded lighting, stable facial identity and realistic camera behavior.";
        if(d.style==="Stylized 3D")return "high-end stylized 3D animation visual language, polished materials, coherent lighting, stable character proportions and clean motion.";
        if(d.style==="Custom"&&(d.customStyle||"").trim())return (d.customStyle||"").trim().replace(/[. ]+$/,"")+".";
        return "";
      };
      function _compileCreativeContext(destination){
        const d=_createDraft, brief=(d.brief||"").trim(), style=_createStyleSentence(d);
        if(!style)return {error:"Choose a visual language before building the H3 context."};
        if(!brief)return {error:"Describe what happens in the shot first."};
        const destinationLock={
          t2v:"Create the scene directly from this description.",
          r2v:"Use the reference images, videos and audio you attach in the Reference editor as binding identity, wardrobe, prop, style and voice anchors.",
          i2v:"Treat the first frame and optional last frame you attach in the Frames editor as exact composition and style anchors.",
          studio:"Use the existing H3 Studio reference or Continue From clip as the binding continuity guide; preserve its identity, styling and motion language."
        }[destination]||"";
        const continuity="Across the full shot, keep every character, face, hairstyle, clothing detail, accessory, prop, environment and camera logic coherent. Do not duplicate characters or redesign established details.";
        const speech=d.noDialogue
          ? "No spoken dialogue. On-screen characters' lips stay closed and still unless supplied audio explicitly requires lip-synced dialogue."
          : "Dialogue is allowed only when clearly motivated by supplied audio and the scene.";
        const sound=(d.soundscape||"").trim() || (d.noDialogue
          ? "A continuous natural environmental soundscape fills the entire clip with no spoken dialogue."
          : "A continuous natural environmental soundscape fills the entire clip.");
        const music=(d.music||"").trim() || "No non-diegetic music unless it is naturally motivated by the scene.";
        const label=(d.name||"").trim();
        const prompt="integrated_multimodal_description: [Shot 1] "+[label?"Project: "+label+".":"",destinationLock,style,brief,continuity,speech].filter(Boolean).join(" ")+"\noverall_soundscape: "+sound+"\nnon_diegetic_music: "+music;
        return {prompt};
      }
      function closeCreativeStudio(){
        if(!creativeOverlay)return;
        creativeOverlay.style.display="none";
        pillCreate._set(false);
      }
      function openCreativeStudio(){
        try{
          if(creativeOverlay){ creativeOverlay.style.display="flex"; pillCreate._set(true); refreshCreativeStudio(); return; }
          creativeOverlay=mk("div",{position:"absolute",inset:"0",zIndex:"300",display:"flex",flexDirection:"column",background:"linear-gradient(145deg,#071015 0%,#0a0a0a 54%,#101109 100%)",color:C.text,overflow:"hidden"});
          const top=mk("div",{display:"flex",alignItems:"center",gap:"10px",padding:"12px 15px",borderBottom:"1px solid #36515a",background:"rgba(12,24,29,.95)",flex:"0 0 auto"});
          const createMark=tx(mk("div",{width:"28px",height:"28px",borderRadius:"8px",display:"flex",alignItems:"center",justifyContent:"center",background:"linear-gradient(135deg,#a9f4ff,#f0ff41)",color:"#071014",fontWeight:"900",fontSize:"16px",boxShadow:"0 0 16px rgba(123,227,255,.25)"}),"✦");
          const createHead=mk("div",{display:"flex",flexDirection:"column",gap:"2px",flex:"1"});
          createHead.append(tx(mk("div",{fontSize:"14px",fontWeight:"850",letterSpacing:".04em"}),"H3 CREATIVE STUDIO"),tx(mk("div",{fontSize:"9px",color:"#8bb3bf"}),"Brief → optional Qwen planning → review → your trusted H3 renderer"));
          const closeCreate=tx(mk("button",{padding:"6px 10px",borderRadius:"7px",border:"1px solid "+C.border,background:C.bg2,color:C.text,fontSize:"10px",fontWeight:"750",cursor:"pointer"}),"← Return to H3 tools");
          closeCreate.onclick=closeCreativeStudio;
          top.append(createMark,createHead,closeCreate);
          const work=mk("div",{display:"flex",flex:"1",minHeight:"0"});
          const form=mk("div",{width:"440px",flex:"0 0 440px",padding:"14px",overflowY:"auto",borderRight:"1px solid #284049",boxSizing:"border-box"},{className:"mmh3-scroll"});
          const preview=mk("div",{flex:"1",minWidth:"0",display:"flex",flexDirection:"column",padding:"14px",boxSizing:"border-box"});
          work.append(form,preview); creativeOverlay.append(top,work); root.appendChild(creativeOverlay);

          const info=tx(mk("div",{fontSize:"10px",color:"#b0c4c9",lineHeight:"1.5",padding:"9px 10px",border:"1px solid #284049",background:"rgba(109,210,245,.055)",borderRadius:"8px",marginBottom:"12px"}),"Build a clear, structured H3 shot prompt here, then open the proven renderer you need. References and continuation stay in their existing safe tabs—no duplicate upload areas or hidden graph changes.");
          form.appendChild(info);
          const nameBox=mk("div",{marginBottom:"10px"}); nameBox.appendChild(cap("Project / shot name · optional"));
          const nameIn=mk("input",{width:"100%",boxSizing:"border-box",background:C.bg2,border:"1px solid "+C.border,borderRadius:"7px",color:C.text,fontSize:"11px",padding:"7px 9px",outline:"none"},{type:"text",value:_createDraft.name||"",placeholder:"Example: Ghost Protocol · rooftop breach"});
          nameIn.oninput=()=>{_createDraft.name=nameIn.value;saveDesignDraft(_createDraft);refreshCreate();}; nameBox.appendChild(nameIn); form.appendChild(nameBox);
          const styleGrid=mk("div",{display:"grid",gridTemplateColumns:"1fr 1fr",gap:"9px",marginBottom:"10px"});
          const styleBox=mk("div"); styleBox.appendChild(cap("Visual language · required"));
          const styleDD=DD(["Choose style…","2D Anime","Webtoon / comic","Cinematic live action","Stylized 3D","Custom"],_createDraft.style||"Choose style…",v=>{_createDraft.style=v==="Choose style…"?"":v;saveDesignDraft(_createDraft);refreshCreate();}); styleBox.appendChild(styleDD);
          const customIn=mk("input",{display:"none",width:"100%",boxSizing:"border-box",marginTop:"6px",background:C.bg2,border:"1px solid "+C.border,borderRadius:"7px",color:C.text,fontSize:"10px",padding:"6px 8px",outline:"none"},{type:"text",value:_createDraft.customStyle||"",placeholder:"Describe your visual language"});
          customIn.oninput=()=>{_createDraft.customStyle=customIn.value;saveDesignDraft(_createDraft);refreshCreate();}; styleBox.appendChild(customIn);
          const setupBox=mk("div"); setupBox.appendChild(cap("Current render setup"));
          const setupReadout=mk("div",{minHeight:"35px",boxSizing:"border-box",padding:"7px 8px",border:"1px solid "+C.border,borderRadius:"7px",background:C.bg2,color:C.muted,fontSize:"9px",lineHeight:"1.4"}); setupBox.appendChild(setupReadout);
          styleGrid.append(styleBox,setupBox); form.appendChild(styleGrid);
          const briefBox=mk("div",{marginBottom:"10px"}); briefBox.appendChild(cap("What happens in this shot · required"));
          const briefIn=mk("textarea",{width:"100%",boxSizing:"border-box",minHeight:"114px",resize:"vertical",background:C.bg2,border:"1px solid "+C.border,borderRadius:"8px",color:C.text,fontSize:"11px",lineHeight:"1.5",padding:"8px 9px",outline:"none",fontFamily:"inherit"},{placeholder:"Describe action, character intent, location, camera movement, and what changes during this shot…",value:_createDraft.brief||""});
          briefIn.oninput=()=>{_createDraft.brief=briefIn.value;saveDesignDraft(_createDraft);refreshCreate();}; briefBox.appendChild(briefIn); form.appendChild(briefBox);
          const audioGrid=mk("div",{display:"grid",gridTemplateColumns:"1fr 1fr",gap:"9px",marginBottom:"9px"});
          const soundBox=mk("div"); soundBox.appendChild(cap("Full-clip soundscape"));
          const soundIn=mk("textarea",{width:"100%",boxSizing:"border-box",minHeight:"66px",resize:"vertical",background:C.bg2,border:"1px solid "+C.border,borderRadius:"7px",color:C.text,fontSize:"10px",lineHeight:"1.4",padding:"7px 8px",outline:"none",fontFamily:"inherit"},{placeholder:"Rain, traffic, footsteps, machinery…",value:_createDraft.soundscape||""});
          soundIn.oninput=()=>{_createDraft.soundscape=soundIn.value;saveDesignDraft(_createDraft);refreshCreate();}; soundBox.appendChild(soundIn);
          const musicBox=mk("div"); musicBox.appendChild(cap("Music direction · optional"));
          const musicIn=mk("textarea",{width:"100%",boxSizing:"border-box",minHeight:"66px",resize:"vertical",background:C.bg2,border:"1px solid "+C.border,borderRadius:"7px",color:C.text,fontSize:"10px",lineHeight:"1.4",padding:"7px 8px",outline:"none",fontFamily:"inherit"},{placeholder:"Tense low synth pulse, no vocals…",value:_createDraft.music||""});
          musicIn.oninput=()=>{_createDraft.music=musicIn.value;saveDesignDraft(_createDraft);refreshCreate();}; musicBox.appendChild(musicIn);
          audioGrid.append(soundBox,musicBox); form.appendChild(audioGrid);
          const silentTgl=Toggle("Silent faces / no invented dialogue",_createDraft.noDialogue!==false,v=>{_createDraft.noDialogue=v;saveDesignDraft(_createDraft);refreshCreate();},"#82cfff");
          silentTgl.style.margin="2px 0 12px"; form.appendChild(silentTgl);
          const assistantHost=mk("div"); form.appendChild(assistantHost);
          const handoffTitle=sectionTitle("Choose the trusted renderer"); handoffTitle.style.marginTop="2px"; form.appendChild(handoffTitle);
          const handoffHint=tx(mk("div",{fontSize:"9px",lineHeight:"1.45",color:C.muted,margin:"0 0 9px"}),"CREATE writes the structured context into the normal prompt box and opens the matching tab. It does not submit a render by itself; you remain in control of references, audio and the final Generate button."); form.appendChild(handoffHint);
          const handoffRow=mk("div",{display:"grid",gridTemplateColumns:"1fr 1fr",gap:"7px"});
          const makeHandoff=(label,mode,color)=>{ const b=tx(mk("button",{padding:"8px",borderRadius:"7px",border:"1px solid "+color,background:"rgba(255,255,255,.025)",color,fontSize:"10px",fontWeight:"800",cursor:"pointer",textAlign:"left"}),label); b.onclick=()=>handoffCreative(mode); return b; };
          handoffRow.append(makeHandoff("T2V · text scene","t2v",LIME),makeHandoff("R2V · add refs / audio","r2v","#9de3ff"),makeHandoff("FIRST / LAST · add frames","i2v","#ffcf5a"),makeHandoff("H3 STUDIO · refs / continue","studio","#d6b5ff")); form.appendChild(handoffRow);

          preview.append(sectionTitle("Review your H3 prompt"));
          const previewNote=tx(mk("div",{fontSize:"10px",lineHeight:"1.5",color:C.muted,marginBottom:"10px"}),"Basic formatting is always available. Optional Qwen planning runs on the server you select; this is our own assistant, not MiniMax's hosted Context-IR."); preview.appendChild(previewNote);
          const status=mk("div",{display:"none",padding:"8px 9px",borderRadius:"7px",fontSize:"10px",lineHeight:"1.42",marginBottom:"9px"}); preview.appendChild(status);
          const assistantPlan=mk("div",{flex:"0 0 auto"});preview.appendChild(assistantPlan);
          const context=mk("textarea",{margin:"0",flex:"1",width:"100%",boxSizing:"border-box",minHeight:"150px",resize:"none",overflowY:"auto",whiteSpace:"pre-wrap",fontFamily:"ui-monospace,SFMono-Regular,Consolas,monospace",fontSize:"10px",lineHeight:"1.55",color:"#c3e8f2",padding:"12px",border:"1px solid #36515a",borderRadius:"9px",background:"rgba(0,0,0,.36)"},{className:"mmh3-scroll",readOnly:true});context.setAttribute("aria-label","H3 prompt preview / AI draft editor"); preview.appendChild(context);
          const previewFooter=tx(mk("div",{fontSize:"9px",lineHeight:"1.45",color:C.muted,marginTop:"9px"}),"No hidden change is made to Turbo, LoRA, Two-pass HD, latent upscaling, or the 16GB safety controls. Those remain exactly where you already use them."); preview.appendChild(previewFooter);
          function refreshCreate(){
            styleDD.set(_createDraft.style||"Choose style…");
            customIn.style.display=_createDraft.style==="Custom"?"block":"none";
            setupReadout.textContent="Current: "+S.aspect+" · "+S.duration+"s · "+(+S.megapixels||0.4)+" MP"+(S.twoPass?" · Two-pass HD stays on":" · single pass")+". Change the final target in the renderer after handoff.";
            const built=_compileCreativeContext("t2v");
            if(built.error){ if(!creativeAssistant)context.value="Waiting for: "+built.error; status.style.display="block"; status.textContent="Choose a style and write the shot brief to unlock the handoff buttons."; status.style.color="#ffcf5a"; status.style.background="rgba(255,207,90,.08)"; status.style.border="1px solid rgba(255,207,90,.28)"; }
            else { if(!creativeAssistant)context.value=built.prompt; status.style.display="block"; status.textContent="Review the prompt before handoff. Nothing here automatically queues a video render."; status.style.color="#8ee4b1"; status.style.background="rgba(80,190,125,.08)"; status.style.border="1px solid rgba(80,190,125,.25)"; }
            if(creativeAssistant)creativeAssistant.refresh();
          }
          function handoffCreative(mode){
            const built=(creativeAssistant&&creativeAssistant.getPrompt(mode))||_compileCreativeContext(mode);
            if(built.error){ status.style.display="block"; status.textContent=built.error; status.style.color="#ff8b72"; status.style.background="rgba(255,110,90,.08)"; status.style.border="1px solid rgba(255,110,90,.28)"; return; }
            S.prompt=built.prompt; posTA.value=built.prompt; persist();
            try{updatePromptChecks();}catch(_e){}
            closeCreativeStudio(); setMode(mode); try{posTA.focus();}catch(_e){}
          }
          refreshCreativeStudio=refreshCreate; refreshCreate(); pillCreate._set(true);
          // Lazy module and separate error boundary: AI failure cannot blank the node.
          import("./creative_assistant.js?v=3.23-h3skills2").then(({mountCreativeAssistant})=>{
            creativeAssistant=mountCreativeAssistant({host:assistantHost,planHost:assistantPlan,editor:context,api,draft:_createDraft,saveDraft:saveDesignDraft,
              getInput:(mode)=>{
                const built=_compileCreativeContext(mode), mapping=[];
                // Only structural reference labels, never filenames or media content.
                if(mode==="r2v"||(mode==="studio"&&S.studioMode!=="fl2va")){
                  let p=1,v=1,a=1;
                  S.refImages.slice(0,S.allow9?MAX_REF_IMAGES:REF_IMAGES_SAFE).forEach((file,i)=>{if(file)mapping.push(`<Picture ${p++}> = image slot ${i+1}`+(mode==="studio"?` (@image${i+1})`:""));});
                  S.refVideos.forEach((item,i)=>{if(item.file){mapping.push(`<Video ${v++}> = video slot ${i+1}`+(mode==="studio"?` (@video${i+1})`:""));if(item.useAudio)mapping.push(`<Audio ${a++}> = enabled soundtrack of video slot ${i+1}`+(mode==="studio"?` (@videoaudio${i+1})`:""));}});
                  S.refAudios.forEach((file,i)=>{if(file)mapping.push(`<Audio ${a++}> = audio slot ${i+1}`+(mode==="studio"?` (@audio${i+1})`:""));});
                }
                return {error:built.error,baseline:built.prompt||"",brief:_createDraft.brief||"",style:_createStyleSentence(_createDraft),duration:S.duration,aspect:S.aspect,noDialogue:_createDraft.noDialogue!==false,
                  studio_mode:S.studioMode,has_first_frame:(mode==="i2v"||mode==="studio")&&!!S.firstFrame,
                  has_last_frame:(mode==="i2v"||mode==="studio")&&!!(S.useLastFrame&&S.lastFrame),is_continuation:mode==="studio"&&!!S.studioContinue,reference_mapping:mapping.join("\n")};
              }
            });
          }).catch(err=>{console.error("[MMH3 CREATE assistant]",err);assistantHost.textContent="Optional assistant could not load. The basic formatter and all H3 render tabs remain available. Hard-refresh after updating.";});
        }catch(err){
          console.error("[MMH3 CREATE]",err);
          if(creativeOverlay)creativeOverlay.remove(); creativeOverlay=null;
          // Keep the normal node usable even if this optional workspace ever fails.
          _activeShowError("CREATE could not open; the normal H3 tabs are still safe.\n"+fmtErr(err));
        }
      }
      // Stage 2 — live speech-budget + soundscape (prompt) check, right under the prompt
      const promptChecks=mk("div",{fontSize:"9px",lineHeight:"1.55",margin:"6px 0 0",display:"none"});
      left.appendChild(promptChecks);
      const updatePromptChecks=()=>{
        const p=(S.prompt||""); const dur=durToLen(S.duration)/FPS; let html="";
        const q=(p.match(/["'“”‘’]([^"'“”‘’]{2,}?)["'“”‘’]/g)||[]).map(s=>s.replace(/["'“”‘’]/g,"")).join(" ");
        const spoken=(q.trim().match(/\S+/g)||[]).length;
        if(spoken>0){ const wps=spoken/Math.max(1,dur);
          const lab=wps<=2.6?["comfortable","#7fd0a0"]:wps<=3.3?["a bit tight","#ffcf5a"]:["too fast to land clearly","#ff7a5a"];
          html+="🗣 <span style='color:"+C.muted+"'>Speech budget:</span> <b style='color:"+lab[1]+"'>"+spoken+" words in "+dur.toFixed(1)+"s = "+wps.toFixed(1)+"/s — "+lab[0]+"</b>"; }
        const hasSound=/\b(music|song|sing|sings|singing|vocal|voice|speak|speaks|says?|whisper|shout|scream|sound|audio|sfx|ambient|ambience|noise|rain|thunder|wind|footsteps|silence|score|beat|melody|hum|breath|chant|choir|bell|echo)\b/i.test(p);
        if(p.trim().length>=4 && !hasSound){ html+=(html?"<br>":"")+"🔊 <span style='color:#ffcf5a'>No sound described — H3 invents the audio. Add dialogue / music / SFX cues for control.</span>"; }
        promptChecks.innerHTML=html; promptChecks.style.display=html?"block":"none";
      };
      try{updatePromptChecks();}catch(_e){}

      // R2V tag helper (insert <Picture N> / <Video N> / <Audio N> at cursor)
      const tagRow=mk("div",{display:"none",flexWrap:"wrap",gap:"4px",marginTop:"6px"});
      const insertTag=(t)=>{ const el=posTA; const s=el.selectionStart??el.value.length; const e=el.selectionEnd??el.value.length;
        el.value=el.value.slice(0,s)+t+el.value.slice(e); S.prompt=el.value; persist(); el.focus(); const p=s+t.length; el.selectionStart=el.selectionEnd=p; };
      const tagChip=(t)=>{ const b=tx(mk("button",{padding:"3px 7px",borderRadius:"5px",border:"1px solid "+C.border,background:C.bg2,color:LIME,fontSize:"9px",fontWeight:"700",cursor:"pointer"}),t); b.onclick=()=>insertTag(t+" "); return b; };
      const rebuildTagRow=()=>{
        tagRow.innerHTML="";
        const lim=S.allow9?MAX_REF_IMAGES:REF_IMAGES_SAFE;
        for(let i=0;i<lim;i++) if(S.refImages[i]) tagRow.appendChild(tagChip(`<Picture ${i+1}>`));
        S.refVideos.forEach((v,i)=>{ if(v.file) tagRow.appendChild(tagChip(`<Video ${i+1}>`)); });
        // audio ordinals count video soundtracks (that are enabled) then standalone audios
        let a=1;
        S.refVideos.forEach((v)=>{ if(v.file&&v.useAudio){ tagRow.appendChild(tagChip(`<Audio ${a}>`)); a++; } });
        S.refAudios.forEach((f)=>{ if(f){ tagRow.appendChild(tagChip(`<Audio ${a}>`)); a++; } });
        if(!tagRow.children.length) tagRow.appendChild(tx(mk("span",{fontSize:"9px",color:C.muted}),"Add references below to get insertable tags."));
        try{rebuildStudioTagRow();}catch(_e){}
      };
      left.appendChild(tagRow);

      // CGlide H3 Studio uses stable @slot tokens and translates them to the
      // final <Picture>/<Video>/<Audio> order itself.  That avoids a prompt
      // silently breaking when a user clears reference slot 1 but keeps slot 2.
      const studioTagRow=mk("div",{display:"none",flexWrap:"wrap",gap:"4px",marginTop:"6px"});
      const rebuildStudioTagRow=()=>{
        studioTagRow.innerHTML="";
        if(S.studioMode==="fl2va"){
          if(S.firstFrame)studioTagRow.appendChild(tagChip("@first"));
          if(S.useLastFrame&&S.lastFrame)studioTagRow.appendChild(tagChip("@last"));
          if(!studioTagRow.children.length)studioTagRow.appendChild(tx(mk("span",{fontSize:"9px",color:C.muted}),"Add a first and/or last frame below to get insertable Studio tags."));
          return;
        }
        const lim=S.allow9?MAX_REF_IMAGES:REF_IMAGES_SAFE;
        for(let i=0;i<lim;i++)if(S.refImages[i])studioTagRow.appendChild(tagChip(`@image${i+1}`));
        S.refVideos.forEach((v,i)=>{ if(v.file){ studioTagRow.appendChild(tagChip(`@video${i+1}`)); if(v.useAudio)studioTagRow.appendChild(tagChip(`@videoaudio${i+1}`)); } });
        S.refAudios.forEach((f,i)=>{ if(f)studioTagRow.appendChild(tagChip(`@audio${i+1}`)); });
        if(!studioTagRow.children.length)studioTagRow.appendChild(tx(mk("span",{fontSize:"9px",color:C.muted}),"Add reference slots below to get Studio @tokens."));
      };
      left.appendChild(studioTagRow);

      // ===== LEFT: mode inputs (I2V frames / R2V references) =====
      const inputsWrap=mk("div",{marginTop:"16px"});
      left.appendChild(inputsWrap);

      // Reframe control (shared across panels): center-crop (match) / stretch / off — applied to
      // the first, last, and all reference images so they match the first frame's aspect (output canvas).
      let reframeDDiv=null, reframeDDr2v=null;
      const _setReframe=v=>{ S.reframe=v; try{reframeDDiv&&reframeDDiv.set(v);}catch(_e){} try{reframeDDr2v&&reframeDDr2v.set(v);}catch(_e){} persist(); };

      // -- I2V frame panel --
      const ivPanel=mk("div",{display:"none"});
      ivPanel.appendChild(sectionTitle("Frames"));
      ivPanel.appendChild(cap("First frame — the animation starts here"));
      const firstSlot=ImgSlot("Click or drop the FIRST frame",n=>{S.firstFrame=n;persist();});
      ivPanel.appendChild(firstSlot);
      const flfTgl=Toggle("Add an end frame (first→last bridge)",S.useLastFrame,v=>{S.useLastFrame=v;lastWrap.style.display=v?"block":"none";persist();},LIME);
      const flfRow=mk("div",{margin:"9px 0 0"}); flfRow.appendChild(flfTgl); ivPanel.appendChild(flfRow);
      const lastWrap=mk("div",{display:S.useLastFrame?"block":"none",marginTop:"8px"});
      lastWrap.appendChild(cap("Last frame — the model animates toward this"));
      const lastSlot=ImgSlot("Click or drop the LAST frame",n=>{S.lastFrame=n;persist();});
      lastWrap.appendChild(lastSlot);
      ivPanel.appendChild(lastWrap);
      const ivNote=tx(mk("div",{fontSize:"9px",color:C.muted,marginTop:"8px",lineHeight:"1.45"}),"With Reframe = match (default) every input is center-cropped to your output size, so the last frame perfectly matches the first — set your size to the first frame's aspect (9:16 or 16:9). Leave frames empty on T2V.");
      ivPanel.appendChild(ivNote);
      const rfRowIv=mk("div",{margin:"9px 0 0"});
      rfRowIv.appendChild(cap("Reframe last frame → match first (center-crop)"));
      reframeDDiv=DD(["match","stretch","off"],S.reframe,_setReframe);
      rfRowIv.appendChild(reframeDDiv); ivPanel.appendChild(rfRowIv);
      inputsWrap.appendChild(ivPanel);

      // -- R2V reference editor --
      const r2vPanel=mk("div",{display:"none"});
      r2vPanel.appendChild(sectionTitle("Reference editor"));
      const refIntro=mk("div",{fontSize:"9.5px",color:C.muted,lineHeight:"1.45",marginBottom:"8px"});
      refIntro.innerHTML="Lock a <b>character</b>, <b>style</b>, <b>motion/camera</b>, or <b>voice</b> from references, then describe the target scene. Tag each reference in the prompt in the order shown (<code>&lt;Picture 1&gt;</code>, <code>&lt;Video 1&gt;</code>, <code>&lt;Audio 1&gt;</code>).";
      r2vPanel.appendChild(refIntro);

      // images
      const imgHdr=mk("div",{display:"flex",alignItems:"center",justifyContent:"space-between",margin:"4px 0 6px"});
      imgHdr.append(cap("Reference images"));
      const allow9Tgl=Toggle("up to 9",S.allow9,v=>{S.allow9=v;renderRefImages();warnRefImages();rebuildTagRow();persist();},"#ff9f43");
      allow9Tgl.style.fontSize="9px"; imgHdr.appendChild(allow9Tgl);
      r2vPanel.appendChild(imgHdr);
      const imgGrid=mk("div",{display:"grid",gridTemplateColumns:"repeat(5,1fr)",gap:"6px"});
      const _refImgSlots=[];
      r2vPanel.appendChild(imgGrid);
      const refImgWarn=tx(mk("div",{fontSize:"9px",color:"#ff9f43",margin:"6px 0 0",lineHeight:"1.4",display:"none"}),"");
      r2vPanel.appendChild(refImgWarn);
      const rfRowR2v=mk("div",{margin:"9px 0 4px"});
      rfRowR2v.appendChild(cap("Reframe references → match first frame (center-crop)"));
      reframeDDr2v=DD(["match","stretch","off"],S.reframe,_setReframe);
      rfRowR2v.appendChild(reframeDDr2v); r2vPanel.appendChild(rfRowR2v);
      const renderRefImages=()=>{
        imgGrid.innerHTML=""; _refImgSlots.length=0;
        const lim=S.allow9?MAX_REF_IMAGES:REF_IMAGES_SAFE;
        for(let i=0;i<lim;i++){
          const slot=RefImgSlot("P"+(i+1),(n)=>{S.refImages[i]=n;warnRefImages();rebuildTagRow();persist();});
          if(S.refImages[i]) slot.setName(S.refImages[i]);
          imgGrid.appendChild(slot); _refImgSlots.push(slot);
        }
        // clear any hidden slots (6-9) when collapsing back to 5
        if(!S.allow9){ for(let i=REF_IMAGES_SAFE;i<MAX_REF_IMAGES;i++) S.refImages[i]=null; }
      };
      const warnRefImages=()=>{
        const n=S.refImages.filter((x,i)=>x&&(S.allow9||i<REF_IMAGES_SAFE)).length;
        if(n>REF_IMAGES_SAFE){ refImgWarn.style.display="block"; refImgWarn.textContent=`⚠ ${n} reference images — MiniMax recommends ≤${REF_IMAGES_SAFE}. More than ${REF_IMAGES_SAFE} tends to dilute identity/quality and slows generation (every ref rides through all sampling steps).`; }
        else refImgWarn.style.display="none";
      };

      // ref image size
      const risRow=mk("div",{display:"flex",alignItems:"center",gap:"8px",margin:"10px 0 4px"});
      risRow.append(cap("Reference detail")); risRow.lastChild.style.margin="0";
      const risDD=mk("div",{width:"150px"}); const risSel=DD(["match","max"],S.refImageSize,v=>{S.refImageSize=v;persist();risNote.textContent=risHint();});
      risDD.appendChild(risSel); risRow.appendChild(risDD);
      r2vPanel.appendChild(risRow);
      const risHint=()=>S.refImageSize==="match"?"match — scale refs down to the output resolution (faster).":"max — keep up to a 2048px short edge for stronger identity, several× slower.";
      const risNote=tx(mk("div",{fontSize:"9px",color:C.muted,margin:"0 0 6px",lineHeight:"1.4"}),risHint());
      r2vPanel.appendChild(risNote);

      // start/end trim sub-row (seconds) — shared by ref videos + audios
      const trimRow=(gs,ge,ss,se)=>{
        const r=mk("div",{display:"flex",alignItems:"center",gap:"5px",margin:"3px 0 0 4px"});
        r.append(tx(mk("span",{fontSize:"9px",color:C.muted}),"trim ⏱ start"));
        const s=NI(gs(),0,3600,0.5,ss,"46px"); r.appendChild(s._inp);
        r.append(tx(mk("span",{fontSize:"9px",color:C.muted}),"end"));
        const e=NI(ge(),0,3600,0.5,se,"46px"); r.appendChild(e._inp);
        r.append(tx(mk("span",{fontSize:"9px",color:C.muted}),"s · 0 end = to finish"));
        return r;
      };
      // videos
      r2vPanel.appendChild(cap("Reference videos (motion / camera · optional)"));
      // Low-VRAM cap: only the first N seconds of each reference video are decoded/encoded.
      // Reference videos are the heaviest input (every frame is VAE-encoded up front + rides
      // all sampling steps), so on 16 GB a full 10–15s ref can overflow to shared memory and
      // crawl. Default ON @ 4s (plenty for motion). Turn off / raise it on 24 GB+ cards.
      const refCapRow=mk("div",{display:"flex",alignItems:"center",gap:"8px",flexWrap:"wrap",margin:"2px 0 4px"});
      const refCapSecWrap=mk("div",{display:"flex",alignItems:"center",gap:"4px"});
      const refCapTgl=Toggle("Cap reference length (low VRAM)",S.refVidCap,(on)=>{S.refVidCap=on;refCapSecWrap.style.opacity=on?"1":".4";refCapNote.textContent=refCapHintTxt();persist();},"#ff9f43");
      refCapTgl.style.fontSize="9px";
      const refCapSec=NI(S.refVidCapSec,1,15,0.5,(val)=>{S.refVidCapSec=val;refCapNote.textContent=refCapHintTxt();persist();},"48px");
      refCapSecWrap.append(tx(mk("span",{fontSize:"9px",color:C.muted}),"max"),refCapSec._inp,tx(mk("span",{fontSize:"9px",color:C.muted}),"s / ref"));
      refCapSecWrap.style.opacity=S.refVidCap?"1":".4";
      refCapRow.append(refCapTgl,refCapSecWrap);
      r2vPanel.appendChild(refCapRow);
      const refCapHintTxt=()=>S.refVidCap
        ? `On — each reference video uses its first ~${(+S.refVidCapSec||4)}s (enough for motion; keeps 16 GB safe). Trims to fewer frames, never changes your output length.`
        : "Off — reference videos use up to the full output length (for 24 GB+ cards). Heaviest setting.";
      const refCapNote=tx(mk("div",{fontSize:"9px",color:C.muted,margin:"0 0 8px",lineHeight:"1.4"}),refCapHintTxt());
      r2vPanel.appendChild(refCapNote);
      const _refVidRows=[];
      const vidHost=mk("div"); r2vPanel.appendChild(vidHost);
      const renderRefVideos=()=>{
        vidHost.innerHTML=""; _refVidRows.length=0;
        S.refVideos.forEach((v,i)=>{
          const wrap=mk("div",{marginBottom:"7px"});
          const row=mk("div",{display:"flex",alignItems:"center",gap:"6px"});
          const fr=FileRow(`Video ${i+1} — click or drop (mp4/webm/mov, 2–15s)`,"video/*",(n)=>{S.refVideos[i].file=n;rebuildTagRow();persist();});
          if(v.file) fr.setName(v.file);
          const frBox=mk("div",{flex:"1"}); frBox.appendChild(fr);
          const aud=Toggle("+sound",v.useAudio,(on)=>{S.refVideos[i].useAudio=on;rebuildTagRow();persist();},LIME);
          aud.style.fontSize="9px";
          row.append(frBox,aud);
          wrap.appendChild(row);
          wrap.appendChild(trimRow(()=>v.start||0,()=>v.end||0,(val)=>{S.refVideos[i].start=val;persist();},(val)=>{S.refVideos[i].end=val;persist();}));
          vidHost.appendChild(wrap); _refVidRows.push(fr);
        });
      };
      const vidNote=mk("div",{fontSize:"9px",color:C.muted,margin:"2px 0 8px",lineHeight:"1.4"});
      vidNote.innerHTML="Read at 24 fps, ≥5 frames. Reference videos are the <b>heaviest</b> input — every frame is VAE-encoded up front and rides all sampling steps (the cap above keeps that in check on limited VRAM). Prefer <b>one</b> strong ref over several. “+sound” feeds its soundtrack as a paired &lt;Audio&gt; reference — turn it off only when you don't want it shaping the output audio. <b>Turbo R2V can keep +sound with an audio-compatible H3 Turbo LoRA</b> (Larry v4-600 EMA is supported).";
      r2vPanel.appendChild(vidNote);

      // audios
      r2vPanel.appendChild(cap("Reference audio (voice / music · optional)"));
      const _refAudRows=[];
      const audHost=mk("div"); r2vPanel.appendChild(audHost);
      const renderRefAudios=()=>{
        audHost.innerHTML=""; _refAudRows.length=0;
        for(let i=0;i<MAX_REF_AUDIOS;i++){
          const wrap=mk("div",{marginBottom:"7px"});
          const fr=FileRow(`Audio ${i+1} — click or drop (wav/mp3/m4a)`,"audio/*",(n)=>{S.refAudios[i]=n;rebuildTagRow();persist();});
          if(S.refAudios[i]) fr.setName(S.refAudios[i]);
          wrap.appendChild(fr);
          const t=S.refAudioTrim[i]||(S.refAudioTrim[i]={start:0,end:0});
          wrap.appendChild(trimRow(()=>t.start||0,()=>t.end||0,(val)=>{t.start=val;persist();},(val)=>{t.end=val;persist();}));
          audHost.appendChild(wrap); _refAudRows.push(fr);
        }
      };
      const audNote=tx(mk("div",{fontSize:"9px",color:C.muted,margin:"2px 0 2px",lineHeight:"1.4"}),"Standalone clips are resampled to 32 kHz. Clone a voice or set a musical style; reference the clip as <Audio N> in the prompt.");
      r2vPanel.appendChild(audNote);
      inputsWrap.appendChild(r2vPanel);

      // -- H3 Studio: CGlide's native slot / continuation logic, rendered through
      // our One Node model, LoRA, safe-latent and internally fused window pipeline. --
      const studioPanel=mk("div",{display:"none",marginTop:"12px",padding:"10px",border:"1px solid #315c78",borderRadius:"8px",background:"rgba(72,165,220,.055)"});
      studioPanel.appendChild(sectionTitle("H3 Studio · CGlide + 16GB Safe"));
      const studioIntro=mk("div",{fontSize:"9.5px",color:C.muted,lineHeight:"1.48",marginBottom:"9px"});
      studioIntro.innerHTML="Native CGlide Studio references and <b>Continue From</b>, using this node’s model choices, audio-compatible Turbo/LoRAs, Sol-Attn and 16GB-safe latent refine. <b>A continuation by itself is valid — do not add the same clip again as a Reference.</b> Stage 2 stays one internally fused H3 timeline — <b>not</b> separate high-res render chunks.";
      studioPanel.appendChild(studioIntro);
      studioPanel.appendChild(cap("Studio mode"));
      const studioModeRow=mk("div",{display:"flex",gap:"6px",flexWrap:"wrap",marginBottom:"8px"});
      const _studioModeDefs=[["ref2va","References + audio"],["fl2va","First / Last"]];
      const studioModePills=_studioModeDefs.map(([mode,label])=>Pill(label,S.studioMode===mode,()=>{
        S.studioMode=mode; studioModePills.forEach((p,i)=>p._set(_studioModeDefs[i][0]===mode));
        rebuildStudioTagRow(); refreshStudioUI(); updateTwoPassUI(); updateSpeedNotes(); persist();
      }));
      studioModeRow.append(...studioModePills); studioPanel.appendChild(studioModeRow);

      const studioTokenHelp=tx(mk("div",{fontSize:"9px",color:C.muted,lineHeight:"1.42",margin:"0 0 10px"}),"");
      studioPanel.appendChild(studioTokenHelp);

      const studioContinueTitle=cap("Continue From · optional"); studioPanel.appendChild(studioContinueTitle);
      const studioContBox=mk("div",{display:"flex",gap:"7px",alignItems:"stretch",marginBottom:"5px"});
      const studioContInfo=mk("div",{flex:"1",minHeight:"46px",display:"flex",alignItems:"center",padding:"7px 8px",border:"1px dashed "+C.border,borderRadius:"7px",background:C.bg2,fontSize:"9px",color:C.muted,overflow:"hidden",lineHeight:"1.35"});
      const studioPickBtn=tx(mk("button",{width:"108px",padding:"7px",borderRadius:"7px",border:"1px solid "+C.border,background:C.bg2,color:LIME,fontSize:"9px",fontWeight:"700",cursor:"pointer"}),"⤢ From gallery");
      studioContBox.append(studioContInfo,studioPickBtn); studioPanel.appendChild(studioContBox);
      const studioContFile=FileRow("…or drop the previous FINAL Studio clip","video/*",n=>{ S.studioContinue=n||null; refreshStudioContinue(); persist(); });
      studioPanel.appendChild(studioContFile);
      const studioContCtl=mk("div",{display:"flex",gap:"8px",alignItems:"center",flexWrap:"wrap",margin:"8px 0 0"});
      studioContCtl.append(cap("Anchor tail")); studioContCtl.lastChild.style.margin="0";
      const studioContFramesDD=DD(["22 frames · ~0.9s","39 frames · ~1.6s"],S.studioContinueFrames===39?"39 frames · ~1.6s":"22 frames · ~0.9s",v=>{S.studioContinueFrames=v.startsWith("39")?39:22;persist();refreshStudioContinue();});
      studioContFramesDD.style.width="128px"; studioContCtl.append(studioContFramesDD);
      const studioContAudioTgl=Toggle("carry its sound guide",S.studioContinueAudio,v=>{S.studioContinueAudio=v;persist();},"#82cfff"); studioContAudioTgl.style.fontSize="9px"; studioContCtl.append(studioContAudioTgl);
      const studioFlat=NI(S.studioContinueFlatten,0,1,0.05,v=>{S.studioContinueFlatten=Math.max(0,Math.min(1,+v||0));persist();},"48px");
      studioContCtl.append(tx(mk("span",{fontSize:"9px",color:C.muted}),"level tail"),studioFlat._inp); studioPanel.appendChild(studioContCtl);
      const studioContNote=tx(mk("div",{fontSize:"9px",color:C.muted,lineHeight:"1.42",margin:"6px 0 0"}),"Choose the previous <b>final Studio result</b> at the same target canvas. CGlide uses its tail as the low-res guide; the final 1080/2K seam is streamed and audio-aligned without holding both clips in RAM.");
      studioContNote.innerHTML="Choose the previous <b>final Studio result</b> at the same target canvas. CGlide uses its tail as the low-res guide; the final 1080/2K seam is streamed and audio-aligned without holding both clips in RAM.";
      studioPanel.appendChild(studioContNote);
      const studioClearBtn=tx(mk("button",{marginTop:"6px",padding:"4px 8px",borderRadius:"6px",border:"1px solid "+C.border,background:"transparent",color:C.muted,fontSize:"9px",cursor:"pointer"}),"Clear continuation");
      studioClearBtn.onclick=()=>{S.studioContinue=null;studioContFile.clear();refreshStudioContinue();persist();}; studioPanel.appendChild(studioClearBtn);

      studioPanel.appendChild(cap("Final seam"));
      const _studioSeamDefs=[["early_cut","Continuous · recommended"],["early_scurve","Soft seam"],["hard_cut","Keep old tail"]];
      const studioSeamRow=mk("div",{display:"flex",gap:"6px",flexWrap:"wrap",marginBottom:"5px"});
      const studioSeamPills=_studioSeamDefs.map(([mode,label])=>Pill(label,S.studioSeamMode===mode,()=>{S.studioSeamMode=mode;studioSeamPills.forEach((p,i)=>p._set(_studioSeamDefs[i][0]===mode));persist();}));
      studioSeamRow.append(...studioSeamPills); studioPanel.appendChild(studioSeamRow);
      const studioBlendRow=mk("div",{display:"flex",gap:"5px",alignItems:"center",marginBottom:"10px"});
      const studioBlend=NI(S.studioSeamBlend,1,12,1,v=>{S.studioSeamBlend=Math.max(1,Math.min(12,+v||6));persist();},"46px");
      studioBlendRow.append(tx(mk("span",{fontSize:"9px",color:C.muted}),"Soft-seam blend"),studioBlend._inp,tx(mk("span",{fontSize:"9px",color:C.muted}),"frames")); studioPanel.appendChild(studioBlendRow);

      studioPanel.appendChild(cap("One-click 16GB safe targets"));
      const studioSafeRow=mk("div",{display:"flex",gap:"6px",flexWrap:"wrap"});
      const _studioTargetDefs=[[2.0,"1080p · 1920×1088"],[4.0,"2K · ~2688×1504"]];
      const studioSafePills=[];
      const refreshStudioSafe=()=>{
        studioSafePills.forEach((p,i)=>p._set(!!S.twoPass&&S.twoPassEngine==="latent"&&S.twoPassWindowed&&Math.abs((+S.stage2Mp||0)-_studioTargetDefs[i][0])<0.01));
        const draft=calcRes(S.aspect,Math.min(+S.stage1Mp||0.5,+S.stage2Mp||2),MULTIPLE);
        const final=calcRes(S.aspect,Math.max(+S.stage2Mp||2,+S.stage1Mp||0.5),MULTIPLE);
        studioSafeReadout.innerHTML=(S.twoPass&&S.twoPassEngine==="latent"&&S.twoPassWindowed)
          ? "Ready: <b>"+draft.w+"×"+draft.h+" draft</b> → <b>"+final.w+"×"+final.h+" fused latent refine</b> · audio locked · denoise "+(+S.stage2Denoise||0.20).toFixed(2)
          : "Choose a preset to set the proven route: 0.5 MP draft → neural latent upscale → internally fused low-denoise H3 refine.";
      };
      const applyStudioSafe=(target)=>{
        S.twoPass=true; S.twoPassEngine="latent"; S.twoPassWindowed=true; S.twoPassWindowProfile="ultra";
        S.stage1Mp=0.5; S.stage2Mp=target; S.stage2MpOverride=true; S.stage2Steps=4; S.stage2Denoise=0.20;
        try{tpTgl._set(true);tpBody.style.display="block";tpS1.set(S.stage1Mp);tpS2.set(S.stage2Mp);tpSteps.set(S.stage2Steps);tpDen.set(S.stage2Denoise);}catch(_e){}
        try{updateTwoPassUI();}catch(_e){} refreshStudioSafe(); persist();
      };
      _studioTargetDefs.forEach(([target,label])=>studioSafePills.push(Pill(label,!!S.twoPass&&S.twoPassEngine==="latent"&&S.twoPassWindowed&&Math.abs((+S.stage2Mp||0)-target)<0.01,()=>applyStudioSafe(target))));
      studioSafeRow.append(...studioSafePills); studioPanel.appendChild(studioSafeRow);
      const studioSafeReadout=mk("div",{fontSize:"9px",color:C.muted,lineHeight:"1.45",marginTop:"7px"}); studioPanel.appendChild(studioSafeReadout);

      const refreshStudioContinue=()=>{
        const src=S.studioContinue;
        if(src){ studioContInfo.style.color=C.text; studioContInfo.textContent="✓ "+String(src).split("/").pop()+" · tail anchor: "+S.studioContinueFrames+" frames"; studioClearBtn.style.display="inline-block"; }
        else { studioContInfo.style.color=C.muted; studioContInfo.textContent="No continuation — this saves one standalone Studio shot."; studioClearBtn.style.display="none"; }
      };
      const refreshStudioUI=()=>{
        studioModePills.forEach((p,i)=>p._set(_studioModeDefs[i][0]===S.studioMode));
        const ref=S.studioMode==="ref2va";
        studioTokenHelp.innerHTML=ref
          ? (S.studioContinue
            ? "<b>Continue From is already your motion/seam guide.</b> Top reference slots are optional; use them only for an additional character, look, or audio reference. Do not upload the continuation clip a second time."
            : "Use the <b>@image1</b>, <b>@video1</b>, <b>@videoaudio1</b> and <b>@audio1</b> chips under the prompt. CGlide renumbers the real H3 tags automatically, so empty slots never scramble your prompt.")
          : "Use <b>@first</b> and <b>@last</b> in a structured Studio prompt when you supply those frames. Leave both empty for pure Studio T2V.";
        refreshStudioContinue(); refreshStudioSafe();
      };
      studioPickBtn.onclick=()=>openGalleryModal(async it=>{
        try{
          const r=await api.fetchApi("/minimaxh3/stage_studio_asset",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({filename:it.filename,subfolder:it.subfolder||""})});
          const d=await r.json(); if(!d.ok)throw new Error(d.error||"could not stage that Studio clip");
          S.studioContinue=d.name; studioContFile.setName(d.name); refreshStudioContinue(); persist();
        }catch(e){_activeShowError("Couldn't prepare that Studio continuation:\n"+fmtErr(e));}
      });
      if(S.studioContinue)studioContFile.setName(S.studioContinue);
      refreshStudioUI();
      inputsWrap.appendChild(studioPanel);

      // -- UPSCALE panel (render fast/low-res, then enlarge the finished video) --
      const upPanel=mk("div",{display:"none"});
      upPanel.appendChild(sectionTitle("Upscaler · Enhancer Pro"));
      const upIntro=mk("div",{fontSize:"9.5px",color:C.muted,lineHeight:"1.45",marginBottom:"10px"});
      upIntro.innerHTML="Render fast at a low resolution, then enlarge the finished clip here — the <b>original audio</b> is re-muxed back, no re-generation.";
      upPanel.appendChild(upIntro);
      // engine selector
      upPanel.appendChild(cap("Engine"));
      const upEngRow=mk("div",{display:"flex",gap:"6px",marginBottom:"4px",flexWrap:"wrap"});
      const upEngModel=Pill("Model (fast)",S.upscaleEngine==="model",()=>setUpEngine("model"));
      const upEngRTX=Pill("RTX VSR (hardware) ⚡",S.upscaleEngine==="rtxvsr",()=>setUpEngine("rtxvsr"));
      const upEngFinish=Pill("H3 Finish · detail",S.upscaleEngine==="h3finish",()=>setUpEngine("h3finish"));
      const upEngSVR=Pill("SeedVR2 (max quality)",S.upscaleEngine==="seedvr2",()=>setUpEngine("seedvr2"));
      const upEngFVSR=Pill("FlashVSR (fast AI)",S.upscaleEngine==="flashvsr",()=>setUpEngine("flashvsr"));
      upEngRow.append(upEngModel,upEngRTX,upEngFinish,upEngSVR,upEngFVSR); upPanel.appendChild(upEngRow);
      const upEngHint=tx(mk("div",{fontSize:"9px",color:C.muted,margin:"0 0 10px",lineHeight:"1.4"}),"");
      upPanel.appendChild(upEngHint);
      // source picker
      upPanel.appendChild(cap("Source video"));
      const upSrcBox=mk("div",{display:"flex",gap:"8px",alignItems:"stretch",marginBottom:"4px"});
      const upSrcInfo=mk("div",{flex:"1",minHeight:"66px",border:"1px dashed "+C.border,borderRadius:"8px",background:C.bg2,display:"flex",alignItems:"center",justifyContent:"center",overflow:"hidden",position:"relative"});
      const upSrcThumb=mk("video",{width:"100%",height:"66px",objectFit:"cover",display:"none"},{muted:true,preload:"metadata"});
      const upSrcHint=tx(mk("div",{fontSize:"10px",color:C.muted,textAlign:"center",padding:"8px"}),"No video chosen");
      upSrcInfo.append(upSrcThumb,upSrcHint);
      const upPickBtn=tx(mk("button",{width:"120px",padding:"8px",borderRadius:"8px",border:"1px solid "+C.border,background:C.bg2,color:LIME,fontSize:"10px",fontWeight:"700",cursor:"pointer"}),"⤢ From gallery");
      upSrcBox.append(upSrcInfo,upPickBtn);
      upPanel.appendChild(upSrcBox);
      const upUpload=FileRow("…or click / drop a video file to upscale","video/*",(n)=>{ if(n){ S.upscaleSource={filename:n.split("/").pop(),subfolder:n.indexOf("/")>=0?n.slice(0,n.lastIndexOf("/")):"",type:"input",_input:true,_raw:n}; S.finishInfo=null; _finishDetected=null; refreshUpSource(); persist(); try{probeFinishSource();detectFinishSource();}catch(_e){} } });
      upUpload.style.marginTop="6px"; upPanel.appendChild(upUpload);
      const refreshUpSource=()=>{
        const s=S.upscaleSource;
        if(s&&s.filename){ upSrcHint.style.display="none"; upSrcThumb.style.display="block";
          upSrcThumb.src=(s._input? `/view?filename=${encodeURIComponent(s._raw||s.filename)}&type=input` : _viewUrl(s))+"#t=0.12"; _thumbFrame(upSrcThumb);
          upSrcHint.textContent=s.filename; }
        else { upSrcThumb.style.display="none"; upSrcThumb.removeAttribute("src"); upSrcHint.style.display="block"; upSrcHint.textContent="No video chosen"; }
      };
      upPickBtn.onclick=()=>openGalleryModal((it)=>{ S.upscaleSource={filename:it.filename,subfolder:it.subfolder||"",type:it.type||"output",has_meta:!!it.has_meta}; S.finishInfo=null; _finishDetected=null; refreshUpSource(); persist(); try{probeFinishSource();detectFinishSource();}catch(_e){} });
      // ===== Model-engine controls (ESRGAN) =====
      const upModelBox=mk("div");
      const upModRow=mk("div",{marginTop:"12px"}); upModRow.appendChild(cap("Upscale model (models/upscale_models)"));
      const upModDD=DD(["none"],"none",v=>{S.upscaleModel=v==="none"?"":v;persist();}); upModRow.appendChild(upModDD);
      upModelBox.appendChild(upModRow);
      const upScaleRow=mk("div",{marginTop:"12px"}); upScaleRow.appendChild(cap("Target scale"));
      const upScaleBtns=mk("div",{display:"flex",gap:"6px"});
      const _upScalePills=[2,3,4].map(x=>{ const p=Pill(x+"×",S.upscaleScale===x,()=>{ S.upscaleScale=x; _upScalePills.forEach((pp,i)=>pp._set([2,3,4][i]===x)); persist(); }); return p; });
      upScaleBtns.append(..._upScalePills); upScaleRow.appendChild(upScaleBtns);
      upModelBox.appendChild(upScaleRow);
      upPanel.appendChild(upModelBox);

      // ===== SeedVR2 controls (diffusion AI upscaler) =====
      const upSvrBox=mk("div",{display:"none"});
      const svrBanner=mk("div",{display:"none",margin:"6px 0 0",padding:"7px",borderRadius:"6px",border:"1px solid #cc7a00",background:"rgba(255,150,0,.08)",fontSize:"9px",color:"#ffb84d",lineHeight:"1.4"});
      svrBanner.innerHTML="<b>SeedVR2</b> is installed but not detected yet — <b>restart ComfyUI</b> so its nodes register. First run auto-downloads the chosen model to <code>models/SEEDVR2/</code>.";
      upSvrBox.appendChild(svrBanner);
      // model quality (lower = less VRAM → the OOM escape hatch on 16 GB)
      const SVR_DITS=[
        {label:"3B · GGUF Q4 — fastest / lowest VRAM", file:"seedvr2_ema_3b-Q4_K_M.gguf"},
        {label:"3B · GGUF Q8 — low VRAM", file:"seedvr2_ema_3b-Q8_0.gguf"},
        {label:"3B · FP8 — default (fast)", file:"seedvr2_ema_3b_fp8_e4m3fn.safetensors"},
        {label:"3B · FP16 — best 3B (heavy)", file:"seedvr2_ema_3b_fp16.safetensors"},
        {label:"7B Sharp · GGUF Q4 — ★ MAX detail, fits 16 GB", file:"seedvr2_ema_7b_sharp-Q4_K_M.gguf"},
        {label:"7B · GGUF Q4 — 7B quality, fits 16 GB", file:"seedvr2_ema_7b-Q4_K_M.gguf"},
        {label:"7B Sharp · FP8 — max detail (heavier)", file:"seedvr2_ema_7b_sharp_fp8_e4m3fn_mixed_block35_fp16.safetensors"},
        {label:"7B · FP16 — absolute best (heavy offload)", file:"seedvr2_ema_7b_fp16.safetensors"},
      ];
      const _svrLabel=(f)=>(SVR_DITS.find(m=>m.file===f)||SVR_DITS[2]).label;
      const svrModRow=mk("div",{marginTop:"12px"}); svrModRow.appendChild(cap("Model quality (3B = fast · 7B = max detail)"));
      // picking a 7B model auto-raises block-swap (7B won't fit 16 GB at swap 0) so it can't OOM out of the box.
      const svrModDD=DD(SVR_DITS.map(m=>m.label),_svrLabel(S.svrDitModel),(lbl)=>{ const m=SVR_DITS.find(x=>x.label===lbl); if(m){ S.svrDitModel=m.file; if(/7b/i.test(m.file)&&(+S.svrBlockSwap||0)<8){ S.svrBlockSwap=20; try{svrSwapIn.set(20);}catch(_e){} } persist(); } });
      svrModRow.appendChild(svrModDD); upSvrBox.appendChild(svrModRow);
      const svrResRow=mk("div",{marginTop:"12px"}); svrResRow.appendChild(cap("Target resolution (short edge)"));
      const svrResBtns=mk("div",{display:"flex",gap:"6px"});
      const _svrResPills=[720,1080,1440,2160].map(x=>{ const p=Pill(x+"p",S.svrRes===x,()=>{ S.svrRes=x; _svrResPills.forEach((pp,i)=>pp._set([720,1080,1440,2160][i]===x)); persist(); }); return p; });
      svrResBtns.append(..._svrResPills); svrResRow.appendChild(svrResBtns);
      upSvrBox.appendChild(svrResRow);
      const svrSwapRow=mk("div",{display:"flex",alignItems:"center",gap:"8px",marginTop:"12px",flexWrap:"wrap"});
      svrSwapRow.append(cap("Block swap (0 = fastest)")); svrSwapRow.lastChild.style.margin="0";
      const svrSwapIn=NI(S.svrBlockSwap,0,36,1,v=>{S.svrBlockSwap=v;persist();},"52px"); svrSwapRow.appendChild(svrSwapIn._inp);
      svrSwapRow.append(cap("Batch (higher = faster)")); svrSwapRow.lastChild.style.margin="0 0 0 8px";
      const svrBatchIn=NI(S.svrBatch,5,25,1,v=>{S.svrBatch=v;persist();},"52px"); svrSwapRow.appendChild(svrBatchIn._inp);
      upSvrBox.appendChild(svrSwapRow);
      const svrCompileTgl=Toggle("torch.compile — faster runs (first run warms up ~1–3 min)",S.svrCompile,v=>{S.svrCompile=v;persist();},"#5fd0ff");
      svrCompileTgl.style.marginTop="10px"; upSvrBox.appendChild(svrCompileTgl);
      const svrNote=mk("div",{fontSize:"9px",color:C.muted,margin:"7px 0 0",lineHeight:"1.45"});
      svrNote.innerHTML="Diffusion upscaler (best quality, temporally stable), <b>SageAttention 2</b> on your 5070 Ti. <b>3B</b> = fast (keep <b>block swap 0</b>). <b>7B / 7B-Sharp</b> = the 'insane detail' tier — heavier, so block swap auto-raises to ~20 for 16 GB; models <b>auto-download</b> on first use (big; first run is slow). Push <b>Batch</b> to <b>9–13</b> (5/9/13 = 4n+1) if VRAM holds, and flip <b>torch.compile</b> on for +20–40% after a one-time warmup. VAE decode auto-tiled.";
      upSvrBox.appendChild(svrNote);
      upPanel.appendChild(upSvrBox);

      // ===== FlashVSR controls (fast diffusion upscaler) =====
      const upFvsrBox=mk("div",{display:"none"});
      const fvsrBanner=mk("div",{display:"none",margin:"6px 0 0",padding:"7px",borderRadius:"6px",border:"1px solid #cc7a00",background:"rgba(255,150,0,.08)",fontSize:"9px",color:"#ffb84d",lineHeight:"1.4"});
      fvsrBanner.innerHTML="<b>FlashVSR</b> is installed but not detected — <b>restart ComfyUI</b> so its nodes register. First run auto-downloads its models.";
      upFvsrBox.appendChild(fvsrBanner);
      const fvsrModeRow=mk("div",{marginTop:"12px"}); fvsrModeRow.appendChild(cap("Mode (VRAM ↔ quality)"));
      const fvsrModeBtns=mk("div",{display:"flex",gap:"6px",flexWrap:"wrap"});
      const _fvsrModes=[["tiny","Tiny (16 GB)"],["tiny-long","Tiny-long (long clips)"],["full","Full (max, heavy)"]];
      const _fvsrModePills=_fvsrModes.map(([v,lbl])=>{ const p=Pill(lbl,S.fvsrMode===v,()=>{ S.fvsrMode=v; _fvsrModePills.forEach((pp,i)=>pp._set(_fvsrModes[i][0]===v)); persist(); }); return p; });
      fvsrModeBtns.append(..._fvsrModePills); fvsrModeRow.appendChild(fvsrModeBtns); upFvsrBox.appendChild(fvsrModeRow);
      const fvsrScaleRow=mk("div",{marginTop:"12px"}); fvsrScaleRow.appendChild(cap("Scale"));
      const fvsrScaleBtns=mk("div",{display:"flex",gap:"6px"});
      const _fvsrScalePills=[2,4].map(x=>{ const p=Pill(x+"×",S.fvsrScale===x,()=>{ S.fvsrScale=x; _fvsrScalePills.forEach((pp,i)=>pp._set([2,4][i]===x)); persist(); }); return p; });
      fvsrScaleBtns.append(..._fvsrScalePills); fvsrScaleRow.appendChild(fvsrScaleBtns); upFvsrBox.appendChild(fvsrScaleRow);
      const fvsrVaeRow=mk("div",{marginTop:"12px"}); fvsrVaeRow.appendChild(cap("VAE (quality ↔ VRAM)"));
      const _fvsrVaes=[["Wan2.2","Wan2.2 — best quality"],["Wan2.1","Wan2.1 — balanced (default)"],["LightVAE_W2.1","LightVAE — ≈50% less VRAM"]];
      const _fvsrVaeLbl=(f)=>(_fvsrVaes.find(m=>m[0]===f)||_fvsrVaes[1])[1];
      const fvsrVaeDD=DD(_fvsrVaes.map(m=>m[1]),_fvsrVaeLbl(S.fvsrVae),(lbl)=>{ const m=_fvsrVaes.find(x=>x[1]===lbl); if(m){S.fvsrVae=m[0];persist();} });
      fvsrVaeRow.appendChild(fvsrVaeDD); upFvsrBox.appendChild(fvsrVaeRow);
      const fvsrNote=mk("div",{fontSize:"9px",color:C.muted,margin:"7px 0 0",lineHeight:"1.45"});
      fvsrNote.innerHTML="<b>FlashVSR</b> — fast diffusion upscaler, best on <b>real footage</b>. On stylized / AI-generated clips <b>SeedVR2 usually looks better</b> — use that for H3 output. <b>16 GB:</b> use <b>Tiny / Tiny-long</b> and <b>avoid Full</b> (it spills to shared memory and crawls). Models auto-download on first use; audio re-muxed automatically.";
      upFvsrBox.appendChild(fvsrNote);
      upPanel.appendChild(upFvsrBox);

      // ===== RTX Video Super Resolution (NVIDIA hardware upscaler) =====
      const upRtxBox=mk("div",{display:"none"});
      const rtxBanner=mk("div",{display:"none",margin:"6px 0 0",padding:"7px",borderRadius:"6px",border:"1px solid #cc7a00",background:"rgba(255,150,0,.08)",fontSize:"9px",color:"#ffb84d",lineHeight:"1.4"});
      rtxBanner.innerHTML="<b>RTX VSR</b> isn't detected — install <b>Comfy-Org/Nvidia_RTX_Nodes_ComfyUI</b> into custom_nodes and <b>restart ComfyUI</b>. NVIDIA RTX GPU only (your 5070 Ti qualifies).";
      upRtxBox.appendChild(rtxBanner);
      const rtxScaleRow=mk("div",{marginTop:"12px"}); rtxScaleRow.appendChild(cap("Scale"));
      const rtxScaleBtns=mk("div",{display:"flex",gap:"6px"});
      const _rtxScalePills=[2,3,4].map(x=>{ const p=Pill(x+"×",S.rtxScale===x,()=>{ S.rtxScale=x; _rtxScalePills.forEach((pp,i)=>pp._set([2,3,4][i]===x)); persist(); }); return p; });
      rtxScaleBtns.append(..._rtxScalePills); rtxScaleRow.appendChild(rtxScaleBtns); upRtxBox.appendChild(rtxScaleRow);
      const rtxQRow=mk("div",{marginTop:"12px"}); rtxQRow.appendChild(cap("Quality"));
      const rtxQBtns=mk("div",{display:"flex",gap:"6px",flexWrap:"wrap"});
      const _rtxQ=["LOW","MEDIUM","HIGH","ULTRA"];
      const _rtxQPills=_rtxQ.map(q=>{ const p=Pill(q==="MEDIUM"?"MED":q,S.rtxQuality===q,()=>{ S.rtxQuality=q; _rtxQPills.forEach((pp,i)=>pp._set(_rtxQ[i]===q)); persist(); }); return p; });
      rtxQBtns.append(..._rtxQPills); rtxQRow.appendChild(rtxQBtns); upRtxBox.appendChild(rtxQRow);
      const rtxNote=mk("div",{fontSize:"9px",color:C.muted,margin:"7px 0 0",lineHeight:"1.45"});
      rtxNote.innerHTML="<b>RTX Video Super Resolution</b> — NVIDIA <b>hardware</b> upscaler on your RTX card: <b>very fast (up to ~30×), low VRAM</b>, great for a quick 4K finish. It <b>cleans &amp; sharpens</b> (kills compression artifacts) but <b>doesn't invent new detail</b> — for stylized H3 output that's usually exactly right; use <b>SeedVR2</b> when you need hallucinated detail. Audio re-muxed automatically.";
      upRtxBox.appendChild(rtxNote);
      upPanel.appendChild(upRtxBox);

      // ===== H3 Finish Video (any finished AI video -> H3 latent recovery/refine) =====
      // This is deliberately a fifth UPSCALE ENGINE, not a generation-mode mutation. It lets
      // older H3 renders and outside AI clips use the same source-lock + neural latent-upscale
      // topology while keeping the normal T2V/I2V/R2V routes exactly as they are.
      const upFinishBox=mk("div",{display:"none"});
      const finishBanner=mk("div",{margin:"8px 0 0",padding:"8px",borderRadius:"7px",border:"1px solid #745d16",background:"rgba(255,184,77,.08)",color:"#ffcf5a",fontSize:"9px",lineHeight:"1.45"});
      finishBanner.textContent="Choose a source video above. H3 Finish preserves its original audio and performs one conservative H3 recovery/refine pass.";
      upFinishBox.appendChild(finishBanner);
      upFinishBox.appendChild(cap("Source type"));
      const finishSourceRow=mk("div",{display:"flex",gap:"6px",flexWrap:"wrap",marginBottom:"5px"});
      const _finishSourceDefs=[["auto","Auto detect"],["h3","H3 source"],["generic","Other AI video"]];
      const finishSourcePills=[];
      const setFinishSourceMode=(mode)=>{ S.finishSourceMode=mode; finishSourcePills.forEach((p,i)=>p._set(_finishSourceDefs[i][0]===mode)); persist(); refreshFinishUI(); };
      _finishSourceDefs.forEach(([v,label])=>finishSourcePills.push(Pill(label,S.finishSourceMode===v,()=>setFinishSourceMode(v))));
      finishSourceRow.append(...finishSourcePills); upFinishBox.appendChild(finishSourceRow);
      const finishDetectNote=mk("div",{fontSize:"9px",color:C.muted,lineHeight:"1.42",margin:"0 0 10px"});
      finishDetectNote.textContent="Auto only confirms H3 when this node finds the clip’s saved One Node metadata. A filename alone is never treated as proof; choose H3 source yourself for older H3 exports.";
      upFinishBox.appendChild(finishDetectNote);

      upFinishBox.appendChild(cap("Target finish size"));
      const _finishTargetDefs=[[1,"DETAIL · 1 MP"],[2,"1080 · 2 MP"],[4,"2K · 4 MP"]];
      const finishTargetRow=mk("div",{display:"flex",gap:"6px",flexWrap:"wrap"});
      const finishTargetPills=[];
      const setFinishTarget=(mp)=>{ S.finishTargetMp=mp; finishTargetPills.forEach((p,i)=>p._set(+_finishTargetDefs[i][0]===mp)); persist(); refreshFinishUI(); };
      _finishTargetDefs.forEach(([v,label])=>finishTargetPills.push(Pill(label,+S.finishTargetMp===+v,()=>setFinishTarget(+v))));
      finishTargetRow.append(...finishTargetPills); upFinishBox.appendChild(finishTargetRow);
      const finishResNote=mk("div",{fontSize:"9px",color:C.muted,lineHeight:"1.42",margin:"6px 0 10px"});
      finishResNote.textContent="Pick a source video to see the exact aligned output canvas. 2K uses internal H3 temporal windows for a 16GB card and is the slowest option.";
      upFinishBox.appendChild(finishResNote);

      const finishRefRow=mk("div",{marginTop:"2px"}); finishRefRow.appendChild(cap("Optional identity / object reference"));
      const finishRefSlot=ImgSlot("Optional reference image\n(use when a face, outfit, object, or style must stay exact)",n=>{S.finishReference=n;persist();refreshFinishUI();});
      finishRefRow.appendChild(finishRefSlot); if(S.finishReference)finishRefSlot.setName(S.finishReference); upFinishBox.appendChild(finishRefRow);

      const finishPromptRow=mk("div",{marginTop:"10px"}); finishPromptRow.appendChild(cap("Detail direction · optional"));
      const finishPromptTA=mk("textarea",{width:"100%",minHeight:"66px",resize:"vertical",background:C.bg2,border:"1px solid "+C.border,borderRadius:"8px",color:C.text,fontSize:"10.5px",lineHeight:"1.45",padding:"8px",boxSizing:"border-box",fontFamily:"inherit",outline:"none"},{placeholder:"Leave blank for conservative source recovery. Or say what must be preserved / enhanced, e.g. preserve her face, jewelry, anime linework, and the city materials; recover fine texture without redesigning anything.",value:S.finishPrompt||""});
      finishPromptTA.addEventListener("input",()=>{S.finishPrompt=finishPromptTA.value;persist();refreshFinishUI();}); finishPromptTA.addEventListener("wheel",e=>e.stopPropagation(),{passive:true});
      finishPromptRow.appendChild(finishPromptTA); upFinishBox.appendChild(finishPromptRow);
      const finishUseSavedTgl=Toggle("Use saved H3 prompt when this field is blank",!!S.finishUseSavedPrompt,v=>{S.finishUseSavedPrompt=v;persist();refreshFinishUI();},LIME);
      finishUseSavedTgl.style.marginTop="7px"; upFinishBox.appendChild(finishUseSavedTgl);
      const finishSavedPromptNote=mk("div",{fontSize:"8.5px",color:C.muted,lineHeight:"1.4",margin:"4px 0 8px"}); upFinishBox.appendChild(finishSavedPromptNote);

      upFinishBox.appendChild(cap("Recovery strength"));
      const _finishStrengthDefs=[["conservative","Conservative"],["balanced","Balanced"],["strong","Strong"]];
      const finishStrengthRow=mk("div",{display:"flex",gap:"6px",flexWrap:"wrap"});
      const finishStrengthPills=[];
      const setFinishStrength=(v)=>{S.finishStrength=v;finishStrengthPills.forEach((p,i)=>p._set(_finishStrengthDefs[i][0]===v));persist();refreshFinishUI();};
      _finishStrengthDefs.forEach(([v,label])=>finishStrengthPills.push(Pill(label,S.finishStrength===v,()=>setFinishStrength(v))));
      finishStrengthRow.append(...finishStrengthPills); upFinishBox.appendChild(finishStrengthRow);
      const finishStrengthNote=mk("div",{fontSize:"9px",color:C.muted,lineHeight:"1.42",margin:"6px 0 8px"}); upFinishBox.appendChild(finishStrengthNote);

      const finishSettings=mk("div",{display:"flex",alignItems:"center",gap:"8px",flexWrap:"wrap",marginTop:"4px"});
      finishSettings.appendChild(tx(mk("div",{fontSize:"10px",color:C.muted}),"Refine steps"));
      const finishStepsIn=NI(+S.finishSteps||8,4,20,1,v=>{S.finishSteps=+v||8;persist();},"54px"); finishSettings.appendChild(finishStepsIn._inp);
      finishSettings.appendChild(tx(mk("div",{fontSize:"10px",color:C.muted,marginLeft:"3px"}),"Seed"));
      const finishSeedIn=NI(+S.finishSeed||0,0,999999999999999,1,v=>{S.finishSeed=+v||0;persist();},"100px"); finishSettings.appendChild(finishSeedIn._inp);
      const finishRand=Toggle("Random seed",!!S.finishRandomize,v=>{S.finishRandomize=v;finishSeedIn._inp.disabled=v;finishSeedIn._inp.style.opacity=v?".45":"1";persist();},LIME);
      finishSeedIn._inp.disabled=!!S.finishRandomize; finishSeedIn._inp.style.opacity=S.finishRandomize?".45":"1"; finishSettings.appendChild(finishRand);
      upFinishBox.appendChild(finishSettings);
      const finishModelNote=mk("div",{fontSize:"8.5px",color:C.muted,lineHeight:"1.42",margin:"8px 0 0"}); upFinishBox.appendChild(finishModelNote);

      const _finishTargetRes=(info)=>{
        if(!info||!(+info.width>0)||!(+info.height>0))return null;
        const ratio=(+info.width)/(+info.height), total=(+S.finishTargetMp||2)*1024*1024;
        const w=Math.max(32,Math.round(Math.sqrt(total*ratio)/32)*32);
        const h=Math.max(32,Math.round(Math.sqrt(total/ratio)/32)*32);
        return {w,h,mp:(w*h/1048576)};
      };
      const _finishEffectiveSource=()=>{
        if(S.finishSourceMode==="h3")return "h3";
        if(S.finishSourceMode==="generic")return "generic";
        return _finishDetected&&_finishDetected.kind==="h3"?"h3":"generic";
      };
      const refreshFinishUI=()=>{
        const src=S.upscaleSource, info=S.finishInfo, det=_finishDetected, h3=_finishEffectiveSource();
        const target=_finishTargetRes(info);
        if(!_finishAvail){
          finishBanner.style.borderColor="#745d16"; finishBanner.style.background="rgba(255,184,77,.08)"; finishBanner.style.color="#ffcf5a";
          finishBanner.textContent="H3 Finish needs "+(_finishMissing.length?_finishMissing.join(", "):"the H3 source-lock nodes to finish checking")+". Your other Upscale engines remain unchanged.";
        } else if(!src||!src.filename){
          finishBanner.style.borderColor="#745d16"; finishBanner.style.background="rgba(255,184,77,.08)"; finishBanner.style.color="#ffcf5a";
          finishBanner.textContent="Choose a source video above. It will be copied under a collision-proof input name, read automatically, and its original audio will be preserved.";
        } else if(det&&det.kind==="h3"&&S.finishSourceMode==="auto"){
          finishBanner.style.borderColor="#356b44"; finishBanner.style.background="rgba(80,180,105,.08)"; finishBanner.style.color="#9be7ab";
          finishBanner.textContent="✓ H3 source detected from saved One Node settings. H3-matched recovery is selected"+(det.meta&&det.meta.prompt?"; its saved prompt is available as a fallback.":".");
        } else if(det&&det.kind==="likely_h3"&&S.finishSourceMode==="auto"){
          finishBanner.style.borderColor="#745d16"; finishBanner.style.background="rgba(255,184,77,.08)"; finishBanner.style.color="#ffcf5a";
          finishBanner.textContent="This filename looks H3-like, but no saved H3 metadata was found. Auto stays conservative; choose H3 source above if you know this is an older H3 export.";
        } else {
          finishBanner.style.borderColor="#356b44"; finishBanner.style.background="rgba(80,180,105,.08)"; finishBanner.style.color="#9be7ab";
          finishBanner.textContent=(h3?"H3 source selected — ":"Other AI video selected — ")+"source frames and original audio are protected; only a low-denoise detail recovery is sampled.";
        }
        finishResNote.textContent=target
          ? `Source → H3 canvas ${info.width}×${info.height}; finish target ${target.w}×${target.h} (${target.mp.toFixed(2)} MP). ${(+info.trimmed_frames||0)>0?`Only the first ${(+info.duration||0).toFixed(2)}s can be finished in one H3 run.`:"Original audio is re-muxed exactly."}`
          : "Pick a source video to see the exact aligned output canvas. 2K uses internal H3 temporal windows for a 16GB card and is the slowest option.";
        const hasSaved=!!(det&&det.kind==="h3"&&det.meta&&String(det.meta.prompt||"").trim());
        finishUseSavedTgl.style.display=hasSaved?"flex":"none";
        finishSavedPromptNote.textContent=hasSaved?(S.finishUseSavedPrompt&&!(S.finishPrompt||"").trim()?"The saved H3 prompt will be used automatically. Type above to override it.":"The original H3 prompt was found but will not be used unless you turn this on and leave the field blank."):"No saved H3 prompt was found. Blank means conservative source recovery.";
        const d=S.finishStrength==="conservative"?0.14:S.finishStrength==="strong"?0.24:0.20;
        finishStrengthNote.textContent=S.finishStrength==="conservative"?"Lowest change (0.14 denoise) — safest for faces, logos, accessories, and linework; adds the least new detail.":S.finishStrength==="strong"?"Most detail (0.24 denoise) — use only when the source is soft; it has the highest redesign/drift risk.":"Balanced (0.20 denoise) — the normal recovery setting: adds detail while keeping the source identity anchored.";
        const modelOk=!!(S.unetFl&&S.textEncoder&&S.videoVae&&S.audioVae);
        finishModelNote.textContent=modelOk?"Uses your selected H3 FL2VA model, MiniMax text encoder, and H3 video/audio VAEs. Add a reference image only when identity or an object must be locked harder.":"H3 model selections are missing. Switch once to T2V → Models → ↻ Rescan, then return here; the Finish route will use those same selected H3 files.";
      };
      upPanel.appendChild(upFinishBox);

      const setUpEngine=(e)=>{
        S.upscaleEngine=e; upEngModel._set(e==="model"); upEngRTX._set(e==="rtxvsr"); upEngFinish._set(e==="h3finish"); upEngSVR._set(e==="seedvr2"); upEngFVSR._set(e==="flashvsr");
        upModelBox.style.display=e==="model"?"block":"none";
        upRtxBox.style.display=e==="rtxvsr"?"block":"none";
        upFinishBox.style.display=e==="h3finish"?"block":"none";
        upSvrBox.style.display=e==="seedvr2"?"block":"none";
        upFvsrBox.style.display=e==="flashvsr"?"block":"none";
        svrBanner.style.display=(e==="seedvr2"&&!_svrAvailable)?"block":"none";
        fvsrBanner.style.display=(e==="flashvsr"&&!_fvsrAvailable)?"block":"none";
        rtxBanner.style.display=(e==="rtxvsr"&&!_rtxAvailable)?"block":"none";
        upEngHint.innerHTML=e==="model"
          ? "ESRGAN — fast, per-frame. It holds every frame in RAM, so <b>4× on a 10s+ clip can run out of memory</b> — prefer <b>2×</b> for long clips."
          : e==="rtxvsr"
          ? "RTX VSR — NVIDIA <b>hardware</b> upscaler. The <b>fastest</b> path to 4K, low VRAM; cleans &amp; sharpens without inventing detail. Great for a quick finish on H3 clips."
          : e==="h3finish"
          ? "H3 Finish — <b>source-locked H3 latent recovery</b> for older H3 output or another AI video. It keeps the original audio, uses conservative low denoise, and can finish at 1MP / 1080-class / 2K-class without changing the working generation tabs."
          : e==="seedvr2"
          ? "SeedVR2 — AI diffusion, <b>max quality</b> &amp; temporal stability (try the 7B models). Batched; handles long clips but slower."
          : "FlashVSR — AI diffusion, <b>~2× faster</b> than SeedVR2 at near-equal quality. Best speed/quality balance for most clips.";
        genBtn.textContent=S.mode==="upscale"?(e==="h3finish"?"▶ Finish video":"▶ Upscale video"):genBtn.textContent;
        if(e==="h3finish"){ try{probeFinishSource();detectFinishSource();refreshFinishUI();}catch(_e){} }
        persist();
      };
      inputsWrap.appendChild(upPanel);

      // ── H3 REPAIR — static or SAM 3.1 tracked-mask video inpaint ────────────
      // This intentionally has its own graph and does not share Turbo, LoRA, cache, or
      // two-pass controls with the stable render modes above. It uses the installed
      // Contex Loop masking nodes to preserve the source AV plate outside the white mask.
      const repairPanel=mk("div",{display:"none"});
      repairPanel.appendChild(sectionTitle("Inpaint / Repair · 16GB tuned"));
      const repairIntro=mk("div",{fontSize:"9.5px",color:C.muted,lineHeight:"1.5",marginBottom:"10px"});
      repairIntro.innerHTML="Repair or replace a small part of an existing video without <b>redesigning</b> the whole shot. H3 still analyzes the full timeline so motion stays coherent, but only white mask pixels are redrawn; black pixels and the source soundtrack remain protected. Choose a <b>static painted mask</b> or let <b>SAM 3.1 track a moving object</b>. This tab does <b>not</b> generate new voices or music.";
      repairPanel.appendChild(repairIntro);
      const repairBanner=mk("div",{fontSize:"9px",lineHeight:"1.45",padding:"7px 8px",borderRadius:"7px",border:"1px solid #745d16",background:"rgba(255,184,77,.08)",color:"#ffcf5a",marginBottom:"10px"});
      repairBanner.textContent="Checking the installed H3 masking nodes…";
      repairPanel.appendChild(repairBanner);

      repairPanel.appendChild(cap("1. Source video"));
      const repairSrcBox=mk("div",{display:"flex",gap:"8px",alignItems:"stretch",marginBottom:"4px"});
      const repairSrcInfo=mk("div",{flex:"1",minHeight:"72px",border:"1px dashed "+C.border,borderRadius:"8px",background:C.bg2,display:"flex",alignItems:"center",justifyContent:"center",overflow:"hidden",position:"relative"});
      const repairSrcThumb=mk("video",{width:"100%",height:"72px",objectFit:"cover",display:"none"},{muted:true,preload:"metadata"});
      const repairSrcHint=tx(mk("div",{fontSize:"10px",color:C.muted,textAlign:"center",padding:"8px"}),"No source video chosen");
      repairSrcInfo.append(repairSrcThumb,repairSrcHint);
      const repairPickBtn=tx(mk("button",{width:"120px",padding:"8px",borderRadius:"8px",border:"1px solid "+C.border,background:C.bg2,color:LIME,fontSize:"10px",fontWeight:"700",cursor:"pointer"}),"⤢ From gallery");
      repairSrcBox.append(repairSrcInfo,repairPickBtn); repairPanel.appendChild(repairSrcBox);
      const repairSrcMeta=tx(mk("div",{fontSize:"9px",color:C.muted,lineHeight:"1.45",margin:"2px 0 6px"}),"The selected video is read as the source plate. Its audio will be preserved.");
      repairPanel.appendChild(repairSrcMeta);
      const refreshRepairSource=()=>{
        const s=S.repairSource, info=S.repairInfo;
        if(s&&s.filename){
          const isInput=!!(s._input||s.input);
          repairSrcHint.style.display="none"; repairSrcThumb.style.display="block";
          repairSrcThumb.src=(isInput?`/view?filename=${encodeURIComponent(s._raw||s.raw||s.filename)}&type=input`:_viewUrl(s))+"#t=0.12";
          _thumbFrame(repairSrcThumb);
          let detail=s.filename;
          if(info&&info.ok){
            detail+=` · ${info.width}×${info.height} · ${info.h3_frames} H3 frames (${(+info.duration||0).toFixed(2)}s)`;
            detail+=info.has_audio?" · source audio locked":" · silent source → silent output";
            const changes=[];
            if(info.canvas_adjusted)changes.push("canvas normalized for H3");
            if((+info.trimmed_frames||0)>0)changes.push(`first ${(+info.duration||0).toFixed(2)}s used`);
            if(changes.length)detail+=" · "+changes.join(", ");
          } else detail+=" · reading source…";
          repairSrcMeta.textContent=detail;
        } else {
          repairSrcThumb.style.display="none"; repairSrcThumb.removeAttribute("src"); repairSrcHint.style.display="block"; repairSrcHint.textContent="No source video chosen";
          repairSrcMeta.textContent="The selected video is read as the source plate. Its audio will be preserved.";
        }
      };
      const _repairInputName=async(src)=>{
        if(src&& (src._input||src.input)) return src._raw||src.raw||src.filename;
        const r=await api.fetchApi("/minimaxh3/stage_repair",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({filename:(src&&src.filename)||"",subfolder:(src&&src.subfolder)||""})});
        const d=await r.json(); if(!d.ok)throw new Error(d.error||"source staging failed"); return d.name;
      };
      const stageAndProbeRepair=async()=>{
        const src=S.repairSource;
        if(!src||!src.filename)throw new Error("Choose a source video first.");
        const inName=await _repairInputName(src);
        const r=await api.fetchApi("/minimaxh3/probe_media",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({file:inName})});
        const d=await r.json(); if(!d.ok)throw new Error(d.error||"could not read the selected video");
        S.repairInfo=d; refreshRepairSource(); try{refreshRepairHDUI();}catch(_e){} persist();
        return {inName,info:d};
      };
      const probeRepairSource=async()=>{
        try{ await stageAndProbeRepair(); }
        catch(e){ S.repairInfo=null; refreshRepairSource(); console.warn("[MMH3] repair source probe:",e); }
      };

      // Finish Video deliberately reuses the collision-proof Repair staging route: selecting two
      // identical filenames from different output folders can never overwrite the wrong source.
      // The public UI calls it Finish; the internal staging prefix is invisible to the user.
      const stageAndProbeFinish=async()=>{
        const src=S.upscaleSource;
        if(!src||!src.filename)throw new Error("Choose a source video first.");
        const inName=await _repairInputName(src);
        const r=await api.fetchApi("/minimaxh3/probe_media",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({file:inName})});
        const d=await r.json(); if(!d.ok)throw new Error(d.error||"could not read the selected video");
        S.finishInfo=d; persist(); try{refreshFinishUI();}catch(_e){}
        return {inName,info:d};
      };
      const probeFinishSource=async()=>{
        if(!S.upscaleSource||!S.upscaleSource.filename){ S.finishInfo=null; try{refreshFinishUI();}catch(_e){} return; }
        try{ await stageAndProbeFinish(); }
        catch(e){ S.finishInfo=null; console.warn("[MMH3] finish source probe:",e); try{refreshFinishUI();}catch(_e){} }
      };
      const detectFinishSource=async()=>{
        const src=S.upscaleSource;
        if(!src||!src.filename){ _finishDetected=null; try{refreshFinishUI();}catch(_e){} return; }
        const sourceKey=[src._input||src.input?"input":"output",src.subfolder||"",src.filename].join("|");
        _finishDetected={kind:"checking",reason:"Reading source origin…"}; try{refreshFinishUI();}catch(_e){}
        let det={kind:"unknown",reason:"No saved One Node metadata was found.",meta:null};
        try{
          if(!(src._input||src.input)){
            const q="/minimaxh3/meta?filename="+encodeURIComponent(src.filename)+"&subfolder="+encodeURIComponent(src.subfolder||"");
            const r=await api.fetchApi(q); const d=await r.json().catch(()=>({})); const m=d&&d.ok&&d.meta?d.meta:null;
            const h3Modes=["t2v","i2v","r2v","repair","finish_h3"];
            if(m&&h3Modes.includes(String(m.mode||""))){ det={kind:"h3",reason:"Saved One Node H3 settings found.",meta:m}; }
          }
        }catch(_e){}
        if(det.kind!=="h3"&&/(?:minimax[_ -]?h3|\bh3[_ -]?)/i.test(String(src.filename||""))){
          det={kind:"likely_h3",reason:"Filename looks like an H3 export, but no saved settings prove it.",meta:null};
        }
        const now=S.upscaleSource;
        const nowKey=now?[now._input||now.input?"input":"output",now.subfolder||"",now.filename].join("|"):"";
        if(nowKey!==sourceKey)return; // source changed while metadata was loading
        _finishDetected=det; try{refreshFinishUI();}catch(_e){}
      };
      repairPickBtn.onclick=()=>openGalleryModal((it)=>{
        S.repairSource={filename:it.filename,subfolder:it.subfolder||"",type:it.type||"output"}; S.repairInfo=null; repairUpload.setName(it.filename); refreshRepairSource(); persist(); probeRepairSource();
      });
      const repairUpload=FileRow("…or click / drop a video file to repair","video/*",(n)=>{
        if(n){ S.repairSource={filename:n.split("/").pop(),subfolder:n.indexOf("/")>=0?n.slice(0,n.lastIndexOf("/")):"",type:"input",_input:true,_raw:n}; S.repairInfo=null; refreshRepairSource(); persist(); probeRepairSource(); }
        else { S.repairSource=null; S.repairInfo=null; refreshRepairSource(); persist(); }
      });
      repairUpload.style.marginTop="4px"; repairPanel.appendChild(repairUpload);

      repairPanel.appendChild(cap("2. Mask method"));
      const repairMaskModeRow=mk("div",{display:"flex",gap:"6px",alignItems:"center",flexWrap:"wrap",marginBottom:"6px"});
      const repairStaticPill=Pill("Static painted mask",S.repairMaskMode!=="sam3",()=>setRepairMaskMode("static"));
      const repairSamPill=Pill("SAM 3.1 · track object",S.repairMaskMode==="sam3",()=>setRepairMaskMode("sam3"));
      repairMaskModeRow.append(repairStaticPill,repairSamPill); repairPanel.appendChild(repairMaskModeRow);
      const repairMaskModeHint=mk("div",{fontSize:"9px",color:C.muted,lineHeight:"1.45",margin:"0 0 8px"}); repairPanel.appendChild(repairMaskModeHint);
      const repairStaticBlock=mk("div",{});
      let repairSamBlock=null;
      const updateRepairMaskMode=()=>{
        const sam=S.repairMaskMode==="sam3";
        repairStaticPill._set(!sam); repairSamPill._set(sam);
        repairStaticBlock.style.display=sam?"none":"block";
        if(repairSamBlock)repairSamBlock.style.display=sam?"block":"none";
        repairMaskModeHint.innerHTML=sam
          ? "<b>SAM 3.1 tracked mask:</b> describe one specific moving object. SAM follows it through every frame, then H3 redraws only that moving region."
          : "<b>Static painted mask:</b> white is regenerated across the whole shot. Use this for a fixed logo, wall detail, or an area that does not move.";
        try{updateRepairUI();}catch(_e){}
      };
      const setRepairMaskMode=(mode)=>{
        S.repairMaskMode=mode==="sam3"?"sam3":"static";
        persist(); updateRepairMaskMode();
      };

      repairStaticBlock.appendChild(cap("Static mask"));
      const repairMaskSlot=ImgSlot("Click / drop a black-and-white mask\nWHITE = redraw · BLACK = keep",n=>{S.repairMask=n;persist();try{updateRepairUI();}catch(_e){}});
      repairStaticBlock.appendChild(repairMaskSlot);
      if(S.repairMask)repairMaskSlot.setName(S.repairMask);
      const repairMaskTools=mk("div",{display:"flex",alignItems:"center",gap:"7px",marginTop:"6px",flexWrap:"wrap"});
      const paintMaskBtn=tx(mk("button",{padding:"7px 9px",borderRadius:"7px",border:"1px solid "+LIME,background:"rgba(240,255,65,.10)",color:LIME,fontSize:"10px",fontWeight:"800",cursor:"pointer"}),"🖌 Paint mask using source video");
      repairMaskTools.appendChild(paintMaskBtn);
      repairMaskTools.appendChild(tx(mk("div",{fontSize:"9px",color:C.muted,flex:"1",minWidth:"180px"}),"No mask file needed — draw white over the part you want H3 to change."));
      repairStaticBlock.appendChild(repairMaskTools);
      const _repairVideoUrl=()=>{
        const s=S.repairSource; if(!s||!s.filename)return "";
        const isInput=!!(s._input||s.input);
        return isInput?`/view?filename=${encodeURIComponent(s._raw||s.raw||s.filename)}&type=input`:_viewUrl(s);
      };
      const openMaskPainter=async()=>{
        if(!S.repairSource||!S.repairSource.filename){ _activeShowError("Choose the source video first, then click Paint mask."); return; }
        let prep;
        try{ prep=await stageAndProbeRepair(); }
        catch(e){ _activeShowError("Couldn't read the source video for mask painting:\n"+fmtErr(e)); return; }
        const info=prep.info, sourceUrl=_repairVideoUrl();
        if(!sourceUrl){ _activeShowError("The source video could not be opened for mask painting."); return; }
        const overlay=mk("div",{position:"fixed",inset:"0",zIndex:"99995",background:"rgba(0,0,0,.88)",display:"flex",alignItems:"center",justifyContent:"center",padding:"15px",boxSizing:"border-box"});
        const card=mk("div",{width:"min(880px, calc(100vw - 30px))",maxHeight:"calc(100vh - 30px)",overflowY:"auto",background:C.bg1,border:"1px solid "+C.border,borderRadius:"12px",padding:"14px",boxSizing:"border-box",boxShadow:"0 14px 44px rgba(0,0,0,.75)"},{className:"mmh3-scroll"});
        const titleRow=mk("div",{display:"flex",alignItems:"center",justifyContent:"space-between",gap:"10px",marginBottom:"5px"});
        titleRow.appendChild(tx(mk("div",{fontSize:"13px",fontWeight:"800",color:LIME}),"Paint Repair Mask"));
        const closeBtn=tx(mk("button",{padding:"5px 9px",borderRadius:"6px",border:"1px solid "+C.border,background:C.bg2,color:C.muted,fontSize:"10px",cursor:"pointer"}),"Close");
        titleRow.appendChild(closeBtn); card.appendChild(titleRow);
        card.appendChild(tx(mk("div",{fontSize:"10px",color:C.muted,lineHeight:"1.45",marginBottom:"10px"}),"The video is only a visual guide. Paint white over what should change. Everything black remains protected. For a moving object, paint the full area it crosses during the shot."));
        const loading=tx(mk("div",{fontSize:"10px",color:C.muted,padding:"20px",textAlign:"center",border:"1px dashed "+C.border,borderRadius:"8px"}),"Loading source frame…"); card.appendChild(loading);
        overlay.appendChild(card); document.body.appendChild(overlay);
        const dismiss=()=>{ try{overlay.remove();}catch(_e){} };
        closeBtn.onclick=dismiss; overlay.addEventListener("click",e=>{ if(e.target===overlay)dismiss(); });
        try{
          const video=document.createElement("video"); video.muted=true; video.playsInline=true; video.preload="auto"; video.crossOrigin="anonymous";
          await new Promise((resolve,reject)=>{ const ok=()=>resolve(); const bad=()=>reject(new Error("the source frame could not be decoded")); video.addEventListener("loadeddata",ok,{once:true}); video.addEventListener("error",bad,{once:true}); video.src=sourceUrl; video.load(); });
          const frameTime=Math.min(0.10,Math.max(0,(Number.isFinite(video.duration)?video.duration:0)-0.02));
          if(frameTime>0){ await new Promise((resolve)=>{ video.addEventListener("seeked",resolve,{once:true}); video.currentTime=frameTime; }); }
          const W=Math.max(32,+info.width||video.videoWidth), H=Math.max(32,+info.height||video.videoHeight);
          const preview=document.createElement("canvas"); preview.width=W; preview.height=H;
          Object.assign(preview.style,{display:"block",width:"100%",height:"auto",maxHeight:"calc(100vh - 270px)",objectFit:"contain",background:"#000",border:"1px solid "+C.border,borderRadius:"8px",touchAction:"none",cursor:"crosshair"});
          const mask=document.createElement("canvas"); mask.width=W; mask.height=H;
          const mctx=mask.getContext("2d",{willReadFrequently:false}); mctx.fillStyle="#000"; mctx.fillRect(0,0,W,H);
          const pctx=preview.getContext("2d");
          const scrubRow=mk("div",{display:"flex",gap:"7px",alignItems:"center",flexWrap:"wrap",margin:"10px 0 5px"});
          const skipBack=tx(mk("button",{padding:"6px 8px",borderRadius:"6px",border:"1px solid "+C.border,background:C.bg2,color:C.text,fontSize:"10px",fontWeight:"700",cursor:"pointer"}),"◀ 1s");
          const timeline=mk("input",{flex:"1",minWidth:"180px",accentColor:LIME},{type:"range",min:"0",max:String(Math.max(.05,Number.isFinite(video.duration)?video.duration:(+info.source_duration||+info.duration||.05))),step:"0.05",value:String(Math.max(0,frameTime))});
          const skipForward=tx(mk("button",{padding:"6px 8px",borderRadius:"6px",border:"1px solid "+C.border,background:C.bg2,color:C.text,fontSize:"10px",fontWeight:"700",cursor:"pointer"}),"1s ▶");
          const timeLabel=tx(mk("div",{fontSize:"10px",fontWeight:"800",color:LIME,width:"64px",textAlign:"right"}),"0.00s");
          scrubRow.append(skipBack,timeline,skipForward,timeLabel);
          const scrubNote=tx(mk("div",{fontSize:"9px",color:C.muted,lineHeight:"1.4",marginBottom:"5px"}),"Scrub to the exact moment you want to inspect, then paint. The chosen frame is only a guide; the saved mask remains static across the full clip." );
          const toolbar=mk("div",{display:"flex",gap:"7px",alignItems:"center",flexWrap:"wrap",margin:"7px 0 8px"});
          const brushLabel=tx(mk("div",{fontSize:"10px",color:C.muted}),"Brush 64 px");
          const brush=mk("input",{width:"150px",accentColor:LIME},{type:"range",min:"8",max:"280",step:"4",value:"64"});
          const drawBtn=tx(mk("button",{padding:"6px 9px",borderRadius:"6px",border:"1px solid "+LIME,background:"rgba(240,255,65,.12)",color:LIME,fontSize:"10px",fontWeight:"700",cursor:"pointer"}),"White brush");
          const eraseBtn=tx(mk("button",{padding:"6px 9px",borderRadius:"6px",border:"1px solid "+C.border,background:C.bg2,color:C.muted,fontSize:"10px",fontWeight:"700",cursor:"pointer"}),"Black eraser");
          const clearBtn=tx(mk("button",{padding:"6px 9px",borderRadius:"6px",border:"1px solid "+C.border,background:C.bg2,color:C.muted,fontSize:"10px",fontWeight:"700",cursor:"pointer"}),"Clear all");
          const saveBtn=tx(mk("button",{padding:"6px 10px",borderRadius:"6px",border:"1px solid "+LIME,background:LIME,color:"#000",fontSize:"10px",fontWeight:"800",cursor:"pointer",marginLeft:"auto"}),"Use this mask");
          toolbar.append(brushLabel,brush,drawBtn,eraseBtn,clearBtn,saveBtn);
          loading.replaceWith(preview); card.insertBefore(scrubRow,preview); card.insertBefore(scrubNote,preview); card.insertBefore(toolbar,preview);
          let erase=false, down=false, last=null, brushPx=64, seekToken=0;
          const toolStyle=()=>{ drawBtn.style.borderColor=erase?C.border:LIME; drawBtn.style.background=erase?C.bg2:"rgba(240,255,65,.12)"; drawBtn.style.color=erase?C.muted:LIME; eraseBtn.style.borderColor=erase?LIME:C.border; eraseBtn.style.background=erase?"rgba(240,255,65,.12)":C.bg2; eraseBtn.style.color=erase?LIME:C.muted; };
          const render=()=>{ pctx.globalCompositeOperation="source-over"; pctx.globalAlpha=1; pctx.drawImage(video,0,0,W,H); pctx.fillStyle="rgba(0,0,0,.62)"; pctx.fillRect(0,0,W,H); pctx.globalCompositeOperation="screen"; pctx.globalAlpha=.96; pctx.drawImage(mask,0,0,W,H); pctx.globalCompositeOperation="source-over"; pctx.globalAlpha=1; };
          const fmtTime=(s)=>{ const v=Math.max(0,+s||0), m=Math.floor(v/60), sec=v-m*60; return (m?m+":":"")+sec.toFixed(2).padStart(m?5:4,"0")+"s"; };
          const seekTo=(raw)=>{ const max=+timeline.max||0, next=Math.max(0,Math.min(max,+raw||0)), token=++seekToken; timeline.value=String(next); timeLabel.textContent=fmtTime(next); if(Math.abs((+video.currentTime||0)-next)<.012){ render(); return; } const done=()=>{ if(token===seekToken)render(); }; video.addEventListener("seeked",done,{once:true}); try{video.currentTime=next;}catch(_e){render();} };
          timeline.oninput=()=>seekTo(+timeline.value||0); skipBack.onclick=()=>seekTo((+video.currentTime||0)-1); skipForward.onclick=()=>seekTo((+video.currentTime||0)+1);
          seekTo(frameTime);
          const point=(e)=>{ const r=preview.getBoundingClientRect(); return {x:(e.clientX-r.left)*W/r.width,y:(e.clientY-r.top)*H/r.height}; };
          const dab=(p)=>{ mctx.fillStyle=erase?"#000":"#fff"; mctx.beginPath(); mctx.arc(p.x,p.y,brushPx/2,0,Math.PI*2); mctx.fill(); };
          const stroke=(a,b)=>{ mctx.strokeStyle=erase?"#000":"#fff"; mctx.lineCap="round"; mctx.lineJoin="round"; mctx.lineWidth=brushPx; mctx.beginPath(); mctx.moveTo(a.x,a.y); mctx.lineTo(b.x,b.y); mctx.stroke(); };
          brush.oninput=()=>{ brushPx=+brush.value||64; brushLabel.textContent="Brush "+brushPx+" px"; };
          drawBtn.onclick=()=>{erase=false;toolStyle();}; eraseBtn.onclick=()=>{erase=true;toolStyle();};
          clearBtn.onclick=()=>{mctx.fillStyle="#000";mctx.fillRect(0,0,W,H);render();};
          preview.addEventListener("pointerdown",e=>{ down=true; last=point(e); try{preview.setPointerCapture(e.pointerId);}catch(_e){} dab(last);render();e.preventDefault(); });
          preview.addEventListener("pointermove",e=>{ if(!down)return; const next=point(e); stroke(last,next); last=next; render(); e.preventDefault(); });
          const stopPaint=(e)=>{ down=false; last=null; try{preview.releasePointerCapture(e.pointerId);}catch(_e){} };
          preview.addEventListener("pointerup",stopPaint); preview.addEventListener("pointercancel",stopPaint);
          saveBtn.onclick=()=>{ saveBtn.disabled=true; saveBtn.textContent="Saving…"; mask.toBlob(async blob=>{ try{ if(!blob)throw new Error("mask export failed"); const name=await uploadFile(new File([blob],"H3_repair_mask_"+Date.now()+".png",{type:"image/png"})); S.repairMask=name; repairMaskSlot.setName(name); persist(); try{updateRepairUI();}catch(_e){} dismiss(); }catch(e){ saveBtn.disabled=false; saveBtn.textContent="Use this mask"; _activeShowError("Couldn't save the painted mask: "+fmtErr(e)); } },"image/png"); };
          render(); toolStyle();
        }catch(e){ loading.textContent="Couldn't load this video frame: "+fmtErr(e); loading.style.color="#ff8a8a"; }
      };
      paintMaskBtn.onclick=openMaskPainter;
      repairStaticBlock.appendChild(tx(mk("div",{fontSize:"9px",color:C.muted,lineHeight:"1.45",margin:"5px 0 10px"}),"Use a simple static mask for this mode. Keep it tight around the object/area you want changed; the mask is snapped to H3’s exact latent grid before sampling."));
      repairPanel.appendChild(repairStaticBlock);

      repairSamBlock=mk("div",{marginBottom:"10px"});
      repairSamBlock.appendChild(cap("SAM 3.1 target to track"));
      const repairSamTA=mk("textarea",{width:"100%",minHeight:"58px",resize:"vertical",background:C.bg2,border:"1px solid "+C.border,borderRadius:"8px",color:C.text,fontSize:"11px",padding:"8px",outline:"none",boxSizing:"border-box",fontFamily:"inherit"},{placeholder:"Describe one specific moving object to mask. Example: the woman's silver ring on her right hand",value:S.repairSamPrompt||""});
      repairSamTA.addEventListener("input",()=>{S.repairSamPrompt=repairSamTA.value;persist();try{updateRepairUI();}catch(_e){}}); repairSamTA.addEventListener("wheel",e=>e.stopPropagation(),{passive:true}); repairSamBlock.appendChild(repairSamTA);
      const samSetRow=mk("div",{display:"flex",alignItems:"center",gap:"8px",marginTop:"8px",flexWrap:"wrap"});
      samSetRow.appendChild(tx(mk("div",{fontSize:"10px",color:C.muted}),"Track confidence"));
      const samThreshIn=NI(+S.repairSamThreshold||0.5,0.1,0.9,0.05,v=>{S.repairSamThreshold=Math.max(0.1,Math.min(0.9,+v||0.5));persist();},"54px"); samSetRow.appendChild(samThreshIn._inp);
      const samCleanTgl=Toggle("Clean flicker / specks",!!S.repairSamCleanup,v=>{S.repairSamCleanup=v;persist();},LIME); samSetRow.appendChild(samCleanTgl);
      repairSamBlock.appendChild(samSetRow);
      repairSamBlock.appendChild(tx(mk("div",{fontSize:"9px",color:C.muted,lineHeight:"1.45",marginTop:"7px"}),"SAM runs before H3 and creates one moving white mask for the exact source timeline. MaskVid cleanup removes short-lived specks; source audio remains locked. Use a precise object phrase, not a broad word like ‘woman’ or ‘car’."));
      repairPanel.appendChild(repairSamBlock);

      repairPanel.appendChild(cap("3. What should replace it?"));
      const repairRefSlot=ImgSlot("Optional replacement reference image\n(e.g. the object / character appearance to insert)",n=>{S.repairRef=n;persist();});
      repairPanel.appendChild(repairRefSlot);
      if(S.repairRef)repairRefSlot.setName(S.repairRef);
      const repairPromptTA=mk("textarea",{width:"100%",minHeight:"78px",resize:"vertical",background:C.bg2,border:"1px solid "+C.border,borderRadius:"8px",color:C.text,fontSize:"11px",padding:"8px",outline:"none",boxSizing:"border-box",fontFamily:"inherit",marginTop:"7px"},{placeholder:"Describe only what should appear inside the white mask. Example: Replace the logo with a clean glowing Ovan Tech symbol that matches the scene lighting.",value:S.repairPrompt||""});
      repairPromptTA.addEventListener("input",()=>{S.repairPrompt=repairPromptTA.value;persist();}); repairPromptTA.addEventListener("wheel",e=>e.stopPropagation(),{passive:true});
      repairPanel.appendChild(repairPromptTA);

      const repairSetRow=mk("div",{display:"flex",alignItems:"center",gap:"9px",marginTop:"9px",flexWrap:"wrap"});
      repairSetRow.appendChild(tx(mk("div",{fontSize:"10px",color:C.muted}),"Steps"));
      const _repairPresetDefs=[["fast","Fast · 12",12],["balanced","Balanced · 16",16],["quality","Max · 20",20]];
      let repairPresetPills=[];
      const syncRepairPreset=(preset)=>{ repairPresetPills.forEach((p,i)=>p._set(_repairPresetDefs[i][0]===preset)); };
      const repairStepsIn=NI(+S.repairSteps||16,12,30,1,v=>{S.repairSteps=+v||16;S.repairPreset="custom";syncRepairPreset("custom");persist();},"54px"); repairSetRow.appendChild(repairStepsIn._inp);
      repairSetRow.appendChild(tx(mk("div",{fontSize:"10px",color:C.muted,marginLeft:"4px"}),"Seed"));
      const repairSeedIn=NI(+S.repairSeed||0,0,999999999999999,1,v=>{S.repairSeed=+v||0;persist();},"104px"); repairSetRow.appendChild(repairSeedIn._inp);
      const repairRand=Toggle("Random seed",!!S.repairRandomize,v=>{S.repairRandomize=v;repairSeedIn._inp.disabled=v;repairSeedIn._inp.style.opacity=v?".45":"1";persist();},LIME);
      repairSeedIn._inp.disabled=!!S.repairRandomize; repairSeedIn._inp.style.opacity=S.repairRandomize?".45":"1"; repairSetRow.appendChild(repairRand);
      repairPanel.appendChild(repairSetRow);

      repairPanel.appendChild(cap("Repair speed / quality"));
      const repairPresetRow=mk("div",{display:"flex",gap:"6px",flexWrap:"wrap",marginBottom:"6px"});
      const setRepairPreset=(preset)=>{
        const found=_repairPresetDefs.find(x=>x[0]===preset); if(!found)return;
        S.repairPreset=preset; S.repairSteps=found[2]; repairStepsIn.set(found[2]); syncRepairPreset(preset); persist();
      };
      repairPresetPills=_repairPresetDefs.map(([id,label])=>Pill(label,S.repairPreset===id,()=>setRepairPreset(id)));
      repairPresetRow.append(...repairPresetPills); repairPanel.appendChild(repairPresetRow);
      repairPanel.appendChild(tx(mk("div",{fontSize:"9px",color:C.muted,lineHeight:"1.45",marginTop:"1px"}),"Balanced · 16 is the recommended 16GB setting. Fast · 12 is for small, simple masks; Max · 20 is only for difficult replacements. Repair keeps Turbo, caches, and style LoRAs off so they cannot redesign the protected shot."));

      repairPanel.appendChild(cap("Final output · optional"));
      const repairHdTgl=Toggle("✨ HD finish after repair · 16GB-safe",!!S.repairHd,v=>{S.repairHd=v;repairHdBody.style.display=v?"block":"none";persist();refreshRepairHDUI();},"#82cfff");
      repairPanel.appendChild(repairHdTgl);
      const repairHdBody=mk("div",{display:S.repairHd?"block":"none",margin:"7px 0 0",padding:"8px",border:"1px solid #315c78",borderRadius:"7px",background:"rgba(72,165,220,.07)"});
      const _repairTargetDefs=[[1,"DETAIL · 1 MP"],[2,"1080 · 2 MP"],[4,"2K · 4 MP"]];
      const repairHdPills=[];
      const setRepairHdTarget=(mp)=>{S.repairTargetMp=mp;repairHdPills.forEach((p,i)=>p._set(+_repairTargetDefs[i][0]===mp));persist();refreshRepairHDUI();};
      const repairHdTargetRow=mk("div",{display:"flex",gap:"6px",flexWrap:"wrap"});
      _repairTargetDefs.forEach(([mp,label])=>repairHdPills.push(Pill(label,+S.repairTargetMp===+mp,()=>setRepairHdTarget(+mp))));
      repairHdTargetRow.append(...repairHdPills); repairHdBody.appendChild(repairHdTargetRow);
      const repairHdSetRow=mk("div",{display:"flex",alignItems:"center",gap:"8px",flexWrap:"wrap",marginTop:"8px"});
      repairHdSetRow.appendChild(tx(mk("div",{fontSize:"10px",color:C.muted}),"Finish"));
      const repairHdStepsIn=NI(+S.repairHdSteps||4,2,8,1,v=>{S.repairHdSteps=Math.max(2,Math.min(8,+v||4));persist();refreshRepairHDUI();},"48px"); repairHdSetRow.appendChild(repairHdStepsIn._inp);
      repairHdSetRow.appendChild(tx(mk("div",{fontSize:"10px",color:C.muted}),"steps · denoise"));
      const repairHdDenoiseIn=NI(+S.repairHdDenoise||0.20,0.05,0.25,0.05,v=>{S.repairHdDenoise=Math.max(0.05,Math.min(0.25,+v||0.20));persist();refreshRepairHDUI();},"52px"); repairHdSetRow.appendChild(repairHdDenoiseIn._inp);
      repairHdBody.appendChild(repairHdSetRow);
      const repairHdBanner=mk("div",{fontSize:"9px",lineHeight:"1.45",marginTop:"7px",color:C.muted}); repairHdBody.appendChild(repairHdBanner);
      repairPanel.appendChild(repairHdBody);
      const _repairTargetRes=(info)=>{
        if(!info||!(+info.width>0)||!(+info.height>0))return null;
        const ratio=(+info.width)/(+info.height), total=(+S.repairTargetMp||2)*1024*1024;
        const w=Math.max(32,Math.round(Math.sqrt(total*ratio)/32)*32);
        const h=Math.max(32,Math.round(Math.sqrt(total/ratio)/32)*32);
        return {w,h,mp:w*h/1048576};
      };
      const refreshRepairHDUI=()=>{
        repairHdTgl._set(!!S.repairHd); repairHdBody.style.display=S.repairHd?"block":"none";
        repairHdPills.forEach((p,i)=>p._set(+_repairTargetDefs[i][0]===+S.repairTargetMp));
        const target=_repairTargetRes(S.repairInfo);
        const ready=_finishAvail&&_latentUpAvail&&!!(S.latentUpModel||_latentUpModels.length);
        if(!S.repairHd)return;
        if(!ready){ repairHdBanner.style.color="#ffcf5a"; repairHdBanner.textContent="HD finish needs the installed H3 latent upscaler + 16GB temporal-window nodes. It will become ready automatically after their check, or after one ComfyUI restart if an update is pending."; return; }
        repairHdBanner.style.color="#9be7ab";
        repairHdBanner.textContent=target
          ? `Repair stays at H3’s safe ${S.repairInfo.width}×${S.repairInfo.height} canvas, then the repaired latent is upscaled to ${target.w}×${target.h} (${target.mp.toFixed(2)} MP) and refined in internally fused 20-frame H3 windows. The mask and source audio remain locked — no separate clips or hard-cut stitching.`
          : "Pick a source video to see the exact 16GB-safe target. This adds a low-denoise H3 detail pass only after the masked repair succeeds.";
      };
      repairPanel.appendChild(tx(mk("div",{fontSize:"9px",color:C.muted,lineHeight:"1.45",marginTop:"7px"}),"The repair itself remains source-locked. HD finish is optional: it uses the same latent upscaler and low-denoise, CPU-fused temporal windows as your working Two-pass HD path — not the drift-prone external LTX chunk workflow."));

      const updateRepairUI=()=>{
        if(!_repairAvail){
          repairBanner.style.display="block"; repairBanner.style.borderColor="#745d16"; repairBanner.style.background="rgba(255,184,77,.08)"; repairBanner.style.color="#ffcf5a";
          repairBanner.textContent=_repairMissing.length?"Repair nodes unavailable: "+_repairMissing.join(", ")+". Restart ComfyUI after installing/updating ComfyUI-MiniMaxH3-Contex-Loop.":"Checking the installed H3 masking nodes…";
          return;
        }
        const sam=S.repairMaskMode==="sam3";
        if(sam&&!_sam3Avail){
          repairBanner.style.display="block"; repairBanner.style.borderColor="#745d16"; repairBanner.style.background="rgba(255,184,77,.08)"; repairBanner.style.color="#ffcf5a";
          repairBanner.textContent="SAM 3.1 tracked mask is not ready: "+(_sam3Missing.length?_sam3Missing.join(", "):"checking the SAM tracker")+". Static painted mask remains available.";
          return;
        }
        repairBanner.style.display="block"; repairBanner.style.borderColor="#356b44"; repairBanner.style.background="rgba(80,180,105,.08)"; repairBanner.style.color="#9be7ab";
        if(sam){
          const target=(S.repairSamPrompt||"").trim()||"one object";
          const cleanup=!!S.repairSamCleanup;
          repairBanner.textContent="Ready — SAM 3.1 will track “"+target+"” through the full source timeline; H3 redraws only that moving region and preserves source audio."+(cleanup?(_sam3CleanupAvail?" MaskVid cleanup is active.":" MaskVid cleanup will activate after one ComfyUI restart."):"");
        } else {
          repairBanner.textContent="Ready — source audio is locked, white mask region only is generated, and normal H3 modes remain isolated.";
        }
        try{refreshRepairHDUI();}catch(_e){}
      };
      refreshRepairSource(); updateRepairMaskMode(); updateRepairUI();
      inputsWrap.appendChild(repairPanel);
      // ── H3 DIRECTOR — visual assembler: ordered shot list → one song-locked master ──
      // Productizes the MV-assembly pipeline: each clip is normalized + trimmed to its
      // duration, joined (hard cut / dissolve), then an optional soundtrack is muxed over
      // the top (song-locked so lip-synced shots stay aligned). Backend: /minimaxh3/assemble.
      const dirPanel=mk("div",{display:"none"});
      dirPanel.appendChild(sectionTitle("Shot list"));
      dirPanel.appendChild(tx(mk("div",{fontSize:"9.5px",color:C.muted,lineHeight:"1.45",marginBottom:"8px"}),
        "Add your rendered clips in order. Each is trimmed to its duration and joined — hard cut or dissolve. Add a soundtrack below to song-lock the edit (clip audio dropped, your real track over the top) — the way lip-synced shots stay in sync. The master lands in the gallery / output folder for DaVinci."));
      const dirList=mk("div",{display:"flex",flexDirection:"column",gap:"6px"});
      dirPanel.appendChild(dirList);
      const dirAddBtn=tx(mk("button",{width:"100%",padding:"9px",borderRadius:"8px",border:"1px dashed "+C.border,background:C.bg2,color:LIME,fontSize:"11px",fontWeight:"700",cursor:"pointer",marginTop:"8px"}),"＋ Add shots from gallery");
      dirPanel.appendChild(dirAddBtn);
      const dirDrop=FileRow("…or click / drop clips to add","video/*",(n)=>{ if(n){ S.dirShots.push({filename:n.split("/").pop(),subfolder:n.indexOf("/")>=0?n.slice(0,n.lastIndexOf("/")):"",type:"input",input:true,raw:n,dur:0,seam:"cut"}); renderDirList(); persist(); } });
      dirDrop.style.marginTop="6px"; dirPanel.appendChild(dirDrop);

      dirPanel.appendChild(sectionTitle("Soundtrack (optional)"));
      const dirAudBox=mk("div",{display:"flex",gap:"8px",alignItems:"center",marginBottom:"4px"});
      const dirAudInfo=tx(mk("div",{flex:"1",fontSize:"10px",color:C.muted,padding:"9px",border:"1px dashed "+C.border,borderRadius:"8px",background:C.bg2,overflow:"hidden",whiteSpace:"nowrap",textOverflow:"ellipsis"}),"No track — clip audio kept");
      const dirAudClr=tx(mk("button",{padding:"9px 12px",borderRadius:"8px",border:"1px solid "+C.border,background:C.bg2,color:C.muted,fontSize:"10px",cursor:"pointer",flexShrink:"0"}),"Clear");
      dirAudBox.append(dirAudInfo,dirAudClr); dirPanel.appendChild(dirAudBox);
      const dirAudDrop=FileRow("Click / drop the song (mp3 / wav) to song-lock","audio/*",(n)=>{ if(n){ S.dirAudio={filename:n.split("/").pop(),subfolder:n.indexOf("/")>=0?n.slice(0,n.lastIndexOf("/")):"",type:"input",input:true,raw:n}; refreshDirAudio(); persist(); } });
      dirPanel.appendChild(dirAudDrop);
      dirAudClr.onclick=()=>{ S.dirAudio=null; refreshDirAudio(); persist(); };
      const refreshDirAudio=()=>{ dirAudInfo.textContent=(S.dirAudio&&S.dirAudio.filename)?("♪ "+S.dirAudio.filename+"   (song-locked)"):"No track — clip audio kept"; };

      dirPanel.appendChild(sectionTitle("Output"));
      // aspect ratio — the assemble backend previously hardcoded 16:9 regardless of source clips.
      // "Res" below is the SHORT edge only (matches standard "1080p" usage regardless of orientation);
      // the long edge is computed from whichever aspect is picked here.
      const dirAspRow=mk("div",{display:"flex",gap:"6px",alignItems:"center",marginBottom:"6px"});
      dirAspRow.appendChild(tx(mk("div",{fontSize:"10px",color:C.muted}),"Aspect"));
      const _dirAspDefs=[["9:16","9:16"],["16:9","16:9"],["1:1","1:1"]];
      const _dirAspPills=_dirAspDefs.map(([v,lbl])=>Pill(lbl,S.dirAspect===v,()=>{S.dirAspect=v;_dirAspPills.forEach((p,i)=>p._set(_dirAspDefs[i][0]===v));updateDirResHint();persist();}));
      dirAspRow.append(..._dirAspPills);
      dirPanel.appendChild(dirAspRow);
      const dirOutRow=mk("div",{display:"flex",gap:"8px",alignItems:"center"});
      dirOutRow.appendChild(tx(mk("div",{fontSize:"10px",color:C.muted}),"Res"));
      const _dirResTierLbl={"4k":"4K (2160)","1440":"1440p","1080":"1080p"};
      const dirResDD=DD([_dirResTierLbl["4k"],_dirResTierLbl["1440"],_dirResTierLbl["1080"]],_dirResTierLbl[S.dirOutRes]||_dirResTierLbl["4k"],(lbl)=>{ S.dirOutRes=lbl.indexOf("4K")>=0?"4k":lbl.indexOf("1440")>=0?"1440":"1080"; updateDirResHint(); persist(); });
      dirOutRow.appendChild(dirResDD);
      dirOutRow.appendChild(tx(mk("div",{fontSize:"10px",color:C.muted,marginLeft:"6px"}),"fps"));
      const dirFpsDD=DD(["24","30"],String(S.dirFps||24),v=>{ S.dirFps=+v||24; persist(); });
      dirOutRow.appendChild(dirFpsDD);
      dirPanel.appendChild(dirOutRow);
      const dirResHint=mk("div",{fontSize:"9px",color:C.muted,margin:"4px 0 0"});
      dirPanel.appendChild(dirResHint);
      const _dirComputeRes=()=>{
        const SHORT={"4k":2160,"1440":1440,"1080":1080}[S.dirOutRes]||2160;
        const asp=S.dirAspect||"9:16";
        if(asp==="16:9") return [Math.round(SHORT*16/9/2)*2, SHORT];
        if(asp==="1:1") return [SHORT, SHORT];
        return [SHORT, Math.round(SHORT*16/9/2)*2]; // 9:16
      };
      const updateDirResHint=()=>{ const r=_dirComputeRes(); dirResHint.textContent="Output: "+r[0]+"×"+r[1]; };
      updateDirResHint();
      // export format (pro delivery for DaVinci)
      const dirFmtRow=mk("div",{marginTop:"8px"}); dirFmtRow.appendChild(cap("Export format"));
      const _dirFmtLbl={"h264":"H.264 (compatible · .mp4)","h264_10":"H.264 10-bit (.mp4)","prores":"ProRes 422 HQ (.mov)","ffv1":"FFV1 lossless (.mkv)"};
      const dirFmtDD=DD([_dirFmtLbl["h264"],_dirFmtLbl["h264_10"],_dirFmtLbl["prores"],_dirFmtLbl["ffv1"]],_dirFmtLbl[S.dirFmt]||_dirFmtLbl["h264"],(lbl)=>{ S.dirFmt=lbl.indexOf("10-bit")>=0?"h264_10":lbl.indexOf("ProRes")>=0?"prores":lbl.indexOf("FFV1")>=0?"ffv1":"h264"; persist(); });
      dirFmtRow.appendChild(dirFmtDD); dirPanel.appendChild(dirFmtRow);
      dirPanel.appendChild(tx(mk("div",{fontSize:"9px",color:C.muted,marginTop:"8px",lineHeight:"1.45"}),
        "Durations auto-fill from each clip when added (edit to trim). For perfect lip-sync, keep each singing shot's duration = the audio slice it was made from, and use hard cuts on singing shots. Dissolves shift timing slightly — use them only on b-roll. Encodes H.264 (DaVinci-friendly); upscale/grade there."));
      inputsWrap.appendChild(dirPanel);

      const renderDirList=()=>{
        dirList.innerHTML="";
        if(!S.dirShots.length){ dirList.appendChild(tx(mk("div",{fontSize:"10px",color:C.muted,padding:"14px",textAlign:"center",border:"1px dashed "+C.border,borderRadius:"8px"}),"No shots yet — add your rendered clips below, in order.")); return; }
        S.dirShots.forEach((sh,i)=>{
          const row=mk("div",{display:"flex",gap:"7px",alignItems:"center",padding:"6px",border:"1px solid "+C.border,borderRadius:"8px",background:C.bg1});
          row.appendChild(tx(mk("div",{width:"14px",fontSize:"11px",fontWeight:"800",color:LIME,textAlign:"center",flexShrink:"0"}),String(i+1)));
          const th=mk("video",{width:"60px",height:"34px",objectFit:"cover",borderRadius:"4px",background:C.bg2,flexShrink:"0"},{muted:true,preload:"metadata"});
          th.src=(sh.input? `/view?filename=${encodeURIComponent(sh.raw||sh.filename)}&type=input` : _viewUrl(sh))+"#t=0.12"; _thumbFrame(th);
          const mid=mk("div",{flex:"1",minWidth:"0",display:"flex",flexDirection:"column",gap:"4px"});
          mid.appendChild(tx(mk("div",{fontSize:"9px",color:C.text,overflow:"hidden",whiteSpace:"nowrap",textOverflow:"ellipsis"}),sh.filename));
          const ctl=mk("div",{display:"flex",gap:"5px",alignItems:"center"});
          ctl.appendChild(tx(mk("div",{fontSize:"8.5px",color:C.muted}),"sec"));
          const durIn=NI(+sh.dur||0,0,600,0.05,(v)=>{ sh.dur=+v||0; persist(); },"50px");
          ctl.appendChild(durIn._inp);
          th.addEventListener("loadedmetadata",()=>{ if((!sh.dur||+sh.dur<=0)&&isFinite(th.duration)&&th.duration>0){ sh.dur=Math.round(th.duration*100)/100; try{durIn.set(sh.dur);}catch(_e){} persist(); } },{once:true});
          if(i<S.dirShots.length-1){ const seamDD=DD(["cut","dissolve"],sh.seam||"cut",(v)=>{ sh.seam=v; persist(); }); try{seamDD.style.width="86px";}catch(_e){} ctl.appendChild(seamDD); }
          mid.appendChild(ctl); row.append(th,mid);
          const nav=mk("div",{display:"flex",gap:"3px",flexShrink:"0"});
          const _nb=(t,dis,fn)=>{ const b=tx(mk("button",{width:"22px",height:"22px",borderRadius:"5px",border:"1px solid "+C.border,background:C.bg2,color:dis?C.border:C.muted,fontSize:"10px",cursor:dis?"default":"pointer",padding:"0",lineHeight:"1"}),t); if(!dis)b.onclick=fn; return b; };
          nav.appendChild(_nb("▲",i===0,()=>{ const a=S.dirShots,t=a[i-1];a[i-1]=a[i];a[i]=t; renderDirList(); persist(); }));
          nav.appendChild(_nb("▼",i===S.dirShots.length-1,()=>{ const a=S.dirShots,t=a[i+1];a[i+1]=a[i];a[i]=t; renderDirList(); persist(); }));
          nav.appendChild(_nb("✕",false,()=>{ S.dirShots.splice(i,1); renderDirList(); persist(); }));
          row.appendChild(nav); dirList.appendChild(row);
        });
        const tot=S.dirShots.reduce((s,x)=>s+(+x.dur||0),0);
        dirList.appendChild(tx(mk("div",{fontSize:"9px",color:C.muted,textAlign:"right",marginTop:"2px"}),"Total: "+tot.toFixed(1)+"s  ·  "+S.dirShots.length+" shot"+(S.dirShots.length===1?"":"s")));
      };
      dirAddBtn.onclick=()=>openGalleryModal((it)=>{ S.dirShots.push({filename:it.filename,subfolder:it.subfolder||"",type:it.type||"output",dur:0,seam:"cut"}); renderDirList(); persist(); });

      async function assembleDirector(){
        if(S.generating) return;
        if(!S.dirShots.length){ _activeShowError("Add at least one shot to the list — pick from the gallery or drop clips."); return; }
        const res=_dirComputeRes(); // aspect-aware — was hardcoded 16:9 regardless of source clip shape
        const payload={
          shots:S.dirShots.map(s=>({filename:s.filename,subfolder:s.subfolder||"",input:!!s.input,raw:s.raw||"",dur:+s.dur||0,seam:s.seam||"cut"})),
          audio:(S.dirAudio&&S.dirAudio.filename)?{filename:S.dirAudio.filename,subfolder:S.dirAudio.subfolder||"",input:!!S.dirAudio.input,raw:S.dirAudio.raw||""}:null,
          width:res[0],height:res[1],fps:+S.dirFps||24,fmt:S.dirFmt||"h264",prefix:"H3_Director"
        };
        S.generating=true; genBtn.disabled=true; genBtn.style.opacity=".6"; genBtn.textContent="… assembling"; try{errBox.style.display="none";}catch(_e){}
        try{
          const r=await api.fetchApi("/minimaxh3/assemble",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(payload)});
          const d=await r.json(); if(!d.ok) throw new Error(d.error||"assemble failed");
          reset(); try{_loadGallery&&_loadGallery();}catch(_e){}
          _activeShowError("✅ Master assembled → "+d.name+"   (in the gallery / output folder — ready for DaVinci).");
        }catch(e){ _activeShowError("Assemble failed:\n"+fmtErr(e)); reset(); }
      }

      // ===== LEFT: VIDEO (resolution + duration) =====
      const vidWrap=mk("div",{marginTop:"18px"});
      vidWrap.appendChild(sectionTitle("Video"));
      // aspect
      vidWrap.appendChild(cap("Aspect ratio"));
      const aspectSel=DD(ASPECT_KEYS,S.aspect,v=>{S.aspect=v;updateRes();persist();});
      vidWrap.appendChild(aspectSel);
      // megapixels
      const mpRow=mk("div",{display:"flex",alignItems:"center",gap:"8px",margin:"10px 0 0"});
      mpRow.append(cap("Resolution")); mpRow.lastChild.style.margin="0";
      const mpVal=NI(S.megapixels,0.1,4.0,0.05,v=>{S.megapixels=v;mpSlider.set(v);updateRes();persist();},"56px");
      mpRow.appendChild(tx(mk("span",{fontSize:"9px",color:C.muted}),"MP")); mpRow.appendChild(mpVal._inp);
      vidWrap.appendChild(mpRow);
      const mpSlider=Slider(S.megapixels,0.1,4.0,0.05,v=>{S.megapixels=v;mpVal.set(v);updateRes();persist();});
      vidWrap.appendChild(mpSlider._inp);
      const resReadout=tx(mk("div",{fontSize:"10px",fontWeight:"700",color:LIME,margin:"5px 0 0"}),"");
      vidWrap.appendChild(resReadout);
      const resWarn=tx(mk("div",{fontSize:"9px",color:"#ff9f43",margin:"3px 0 0",lineHeight:"1.4",display:"none"}),"");
      vidWrap.appendChild(resWarn);
      const vramWarn=tx(mk("div",{fontSize:"9px",color:"#ff8a8a",margin:"3px 0 0",lineHeight:"1.4",display:"none"}),"");
      vidWrap.appendChild(vramWarn);
      // live size-reference table (mirrors the official workflow note): megapixels →
      // exact output for the CHOSEN aspect ratio. Highlights the current pick; click to set.
      const resTblWrap=mk("div",{marginTop:"8px",border:"1px solid "+C.border,borderRadius:"7px",overflow:"hidden"});
      const resTblHdr=tx(mk("div",{fontSize:"9px",fontWeight:"700",letterSpacing:".06em",color:C.muted,cursor:"pointer",padding:"6px 8px",background:C.bg1}),"▸ Size table  (megapixels → output)");
      const resTbl=mk("div",{display:"none",maxHeight:"172px",overflowY:"auto"},{className:"mmh3-scroll"});
      let _resTblOpen=false;
      resTblHdr.onclick=()=>{ _resTblOpen=!_resTblOpen; resTbl.style.display=_resTblOpen?"block":"none"; resTblHdr.textContent=(_resTblOpen?"▾":"▸")+" Size table  (megapixels → output)"; if(_resTblOpen)renderResTbl(); };
      resTblWrap.append(resTblHdr,resTbl);
      vidWrap.appendChild(resTblWrap);
      const renderResTbl=()=>{
        if(!_resTblOpen)return;
        resTbl.innerHTML="";
        const cur=calcRes(S.aspect,S.megapixels,MULTIPLE);
        MP_STEPS.forEach(mp=>{
          const {w,h}=calcRes(S.aspect,mp,MULTIPLE);
          const isCur=(w===cur.w&&h===cur.h);
          const over=(w*h>MAX_PIXELS||Math.min(w,h)>BASE_SHORT_EDGE);
          const row=mk("div",{display:"flex",justifyContent:"space-between",padding:"4px 9px",fontSize:"9.5px",cursor:"pointer",
            background:isCur?"rgba(240,255,65,.14)":"transparent",color:isCur?LIME:(over?"#c9a06a":C.text),borderLeft:"2px solid "+(isCur?LIME:"transparent")});
          row.append(tx(mk("span"),mp.toFixed(2)+" MP"),tx(mk("span",{fontWeight:"700"}),`${w} × ${h}`+(over?"  ⚠":"")));
          row.onmouseenter=()=>{ if(!isCur)row.style.background=C.bg3; };
          row.onmouseleave=()=>{ if(!isCur)row.style.background="transparent"; };
          row.onclick=()=>{ S.megapixels=mp; mpVal.set(mp); mpSlider.set(mp); updateRes(); persist(); };
          resTbl.appendChild(row);
        });
      };
      const updateRes=()=>{
        const {w,h}=calcRes(S.aspect,S.megapixels,MULTIPLE);
        resReadout.textContent=`→ ${w} × ${h}  ·  ${(w*h/1048576).toFixed(2)} MP`;
        if(w*h>MAX_PIXELS||Math.min(w,h)>BASE_SHORT_EDGE){ resWarn.style.display="block"; resWarn.textContent="⚠ Above H3's trained 768-short-edge canvas (≤1344×768). Higher is possible but slower and less stable."; }
        else resWarn.style.display="none";
        // pushing past ~2 MP is real headroom on 16GB+ cards but risks OOM below that — only warn
        // once VRAM is actually detected, so this never fires on a false guess.
        if(_vramGB!==null && _vramGB<16 && (+S.megapixels||0)>2.0){
          vramWarn.style.display="block";
          vramWarn.textContent="⚠ "+_vramGB+"GB VRAM detected — above 2 MP risks running out of memory. Lower this (or the refine target) if you hit an OOM error.";
        } else vramWarn.style.display="none";
        renderResTbl();
        try{ tpUpdateNote(); }catch(_e){}   // keep the two-pass res note in sync (defined later)
      };
      // duration
      const durRow=mk("div",{display:"flex",alignItems:"center",gap:"8px",margin:"12px 0 0"});
      durRow.append(cap("Duration")); durRow.lastChild.style.margin="0";
      const durVal=NI(S.duration,1,20,0.5,v=>{S.duration=v;durSlider.set(v);updateDur();persist();},"56px");
      durRow.append(tx(mk("span",{fontSize:"9px",color:C.muted}),"sec"),durVal._inp);
      vidWrap.appendChild(durRow);
      const durSlider=Slider(S.duration,1,20,0.5,v=>{S.duration=v;durVal.set(v);updateDur();persist();});
      vidWrap.appendChild(durSlider._inp);
      const durReadout=tx(mk("div",{fontSize:"10px",fontWeight:"700",color:LIME,margin:"5px 0 0"}),"");
      vidWrap.appendChild(durReadout);
      const durWarn=tx(mk("div",{fontSize:"9px",color:"#ff9f43",margin:"3px 0 0",lineHeight:"1.4",display:"none"}),"");
      vidWrap.appendChild(durWarn);
      const updateDur=()=>{
        const len=durToLen(S.duration); const sec=(len/FPS);
        durReadout.textContent=`≈ ${sec.toFixed(1)}s  ·  ${len} frames @ ${FPS} fps  (snaps to a 17k+5 grid)`;
        if(len<LEN_MIN){ durWarn.style.display="block"; durWarn.textContent="⚠ Below H3's trained range (~5s min). Very short clips can be unstable."; }
        else if(len>LEN_MAX){ durWarn.style.display="block"; durWarn.textContent="⚠ Above H3's trained range (~15s max, 362 frames). Longer is untested."; }
        else durWarn.style.display="none";
        try{updatePromptChecks();}catch(_e){}
      };
      // ── Two-pass HD (hires-fix): generate small → refine to the resolution above ──
      const tpWrap=mk("div",{marginTop:"12px",border:"1px solid "+C.border,borderRadius:"8px",padding:"9px 10px",background:C.bg1});
      const tpTgl=Toggle("⚡ Two-pass HD",S.twoPass,v=>{S.twoPass=v;tpBody.style.display=v?"block":"none";updateTwoPassUI();persist();},"#7fd0a0");
      tpWrap.appendChild(tpTgl);
      const tpBody=mk("div",{display:S.twoPass?"block":"none",marginTop:"8px"});
      const tpRow=mk("div",{display:"flex",alignItems:"center",gap:"8px",flexWrap:"wrap"});
      const tpMpLbl=cap("Draft"); tpMpLbl.style.margin="0"; tpRow.append(tpMpLbl);
      // T2V/I2V/First+Last show Draft → Refine; R2V keeps its existing Refine-only flow.
      const tpS1=NI(S.stage1Mp,0.1,1.0,0.05,v=>{S.stage1Mp=v;persist();tpUpdateNote();},"56px");
      const tpS2=NI(_stage2TargetMp(),0.6,4.0,0.05,v=>{S.stage2Mp=v;S.stage2MpOverride=true;persist();tpUpdateNote();},"56px");
      const tpS2Lbl=tx(mk("span",{fontSize:"9px",color:C.muted}),"→ Refine");
      tpRow.append(tpS1._inp,tpS2Lbl,tpS2._inp,tx(mk("span",{fontSize:"9px",color:C.muted}),"MP"));
      const tpSteps=NI(S.stage2Steps,1,12,1,v=>{S.stage2Steps=v;persist();},"46px");
      tpRow.append(tpSteps._inp,tx(mk("span",{fontSize:"9px",color:C.muted}),"steps · denoise"));
      const tpDen=NI(S.stage2Denoise,0.05,0.6,0.05,v=>{S.stage2Denoise=v;persist();},"52px");
      tpRow.append(tpDen._inp);
      tpBody.appendChild(tpRow);
      // upscale ENGINE: pixel (decode→VSR/Lanczos→encode) vs latent (split→neural latent upscale→rejoin)
      const tpEngRow=mk("div",{display:"flex",alignItems:"center",gap:"6px",flexWrap:"wrap",margin:"8px 0 0"});
      tpEngRow.append(cap("Upscale")); tpEngRow.lastChild.style.margin="0";
      const _tpEngDefs=[["pixel","Pixel (VSR)"],["latent","Latent ⚡"]];
      const _tpEngPills=_tpEngDefs.map(([v,lbl])=>Pill(lbl,S.twoPassEngine===v,()=>{S.twoPassEngine=v;if(v==="latent"&&S.twoPassWindowed&&S.twoPassWindowProfile==="safe")S.twoPassWindowProfile="ultra";_tpEngPills.forEach((p,i)=>p._set(_tpEngDefs[i][0]===v));updateTwoPassUI();persist();}));
      tpEngRow.append(..._tpEngPills);
      tpBody.appendChild(tpEngRow);
      // The safe branch only windows the light second pass. Stage 1 remains one full H3
      // generation; stage 2 fuses overlapping H3 windows before the final decode.
      const tpSafeRow=mk("div",{display:"flex",alignItems:"center",gap:"7px",flexWrap:"wrap",margin:"8px 0 0"});
      const tpSafeTgl=Toggle("16GB-safe Stage 2",S.twoPassWindowed,v=>{
        S.twoPassWindowed=v;
        if(v){
          if(S.twoPassEngine==="latent"&&S.twoPassWindowProfile==="safe")S.twoPassWindowProfile="ultra";
          if((+S.stage2Denoise||0.2)>0.25){ S.stage2Denoise=0.20; tpDen.set(0.20); }
        }
        tpSafeBody.style.display=v?"block":"none";
        updateTwoPassUI(); persist();
      },"#82cfff");
      tpSafeRow.appendChild(tpSafeTgl); tpBody.appendChild(tpSafeRow);
      const tpSafeBody=mk("div",{display:S.twoPassWindowed?"block":"none",margin:"6px 0 0",padding:"7px",border:"1px solid #315c78",borderRadius:"6px",background:"rgba(72,165,220,.07)"});
      const _tpWinDefs=[["ultra","Ultra Safe · 20f"],["safe","16GB Safe · 39f"],["balanced","Balanced · 58f"]];
      const _tpWinPills=_tpWinDefs.map(([v,lbl])=>Pill(lbl,S.twoPassWindowProfile===v,()=>{S.twoPassWindowProfile=v;_tpWinPills.forEach((p,i)=>p._set(_tpWinDefs[i][0]===v));updateTwoPassUI();persist();}));
      tpSafeBody.append(..._tpWinPills);
      tpSafeBody.appendChild(tx(mk("div",{fontSize:"9px",color:C.muted,marginTop:"6px",lineHeight:"1.42"}),"Stage 1 stays whole. Pixel streams VSR/encode in 17-frame groups; Latent uses its neural upscaler's temporal chunks. Both fuse overlapping H3 windows internally — no separate videos to stitch — lock Stage-1 audio, and require low denoise (0.20–0.25). Ultra Safe is the smallest valid H3 window for 16GB at high targets."));
      tpBody.appendChild(tpSafeBody);
      // The protected production recipe is an explicit action, never a silent default. It sets the
      // already-proven graph inputs without changing the graph builder below.
      const tpProtectedWrap=mk("div",{margin:"9px 0 0",padding:"8px",border:"1px solid rgba(127,208,160,.34)",borderRadius:"7px",background:"rgba(127,208,160,.06)"});
      tpProtectedWrap.appendChild(cap("Protected 15s / 16GB recipe")); tpProtectedWrap.lastChild.style.margin="0 0 6px";
      const tpProtectedRow=mk("div",{display:"flex",gap:"6px",flexWrap:"wrap"});
      const _tpProtectedDefs=[[2.0,"1080p"],[4.0,"2K"]], tpProtectedPills=[];
      const _protectedTwoPassMatches=(target)=>!!S.twoPass&&S.twoPassEngine==="latent"&&S.twoPassWindowed&&S.twoPassWindowProfile==="ultra"&&durToLen(S.duration)===362&&Math.abs((+S.megapixels||0)-0.5)<0.01&&Math.abs((+S.stage1Mp||0)-0.5)<0.01&&Math.abs((+S.stage2Mp||0)-target)<0.01&&(+S.stage2Steps||0)===4&&Math.abs((+S.stage2Denoise||0)-0.20)<0.001;
      const refreshProtectedTwoPass=()=>{ tpProtectedPills.forEach((p,i)=>p._set(_protectedTwoPassMatches(_tpProtectedDefs[i][0]))); };
      const applyProtectedTwoPass=(target)=>{
        S.twoPass=true; S.twoPassEngine="latent"; S.twoPassWindowed=true; S.twoPassWindowProfile="ultra";
        S.duration=15; S.megapixels=0.5; S.stage1Mp=0.5; S.stage2Mp=target; S.stage2MpOverride=true; S.stage2Steps=4; S.stage2Denoise=0.20;
        durVal.set(15); durSlider.set(15); mpVal.set(0.5); mpSlider.set(0.5); tpTgl._set(true); tpBody.style.display="block"; tpS1.set(0.5); tpS2.set(target); tpSteps.set(4); tpDen.set(0.20);
        updateDur(); updateRes(); updateTwoPassUI(); refreshProtectedTwoPass(); try{refreshStudioSafe();}catch(_e){} persist();
      };
      _tpProtectedDefs.forEach(([target,label])=>tpProtectedPills.push(Pill(label,_protectedTwoPassMatches(target),()=>applyProtectedTwoPass(target))));
      tpProtectedRow.append(...tpProtectedPills); tpProtectedWrap.appendChild(tpProtectedRow);
      tpProtectedWrap.appendChild(tx(mk("div",{fontSize:"9px",color:C.muted,marginTop:"6px",lineHeight:"1.42"}),"Pins the working route: 362 frames at 15s, 0.5 MP draft, FP32 neural latent upscale, 20-frame CPU-fused H3 windows, locked audio, 4-step refine, denoise 0.20."));
      tpBody.appendChild(tpProtectedWrap);
      const tpLatModelRow=mk("div",{display:"none",margin:"6px 0 0"});
      tpLatModelRow.appendChild(cap("Latent upscaler model")); tpLatModelRow.lastChild.style.margin="0 0 4px";
      const tpLatModelDD=DD(["…"],S.latentUpModel||"…",v=>{ if(v&&v!=="…"&&v!=="(none found)"){ S.latentUpModel=v; persist(); } });
      tpLatModelRow.appendChild(tpLatModelDD);
      tpBody.appendChild(tpLatModelRow);
      const tpBanner=mk("div",{display:"none",margin:"7px 0 0",padding:"7px",borderRadius:"6px",border:"1px solid #cc7a00",background:"rgba(255,150,0,.08)",fontSize:"9px",color:"#ffb84d",lineHeight:"1.4"});
      tpBody.appendChild(tpBanner);
      const tpNote=mk("div",{fontSize:"9px",color:C.muted,margin:"7px 0 0",lineHeight:"1.45"});
      tpBody.appendChild(tpNote);
      tpWrap.appendChild(tpBody);
      vidWrap.appendChild(tpWrap);
      const tpUpdateNote=()=>{
        const studio=(S.mode==="studio"), r2vm=(_isReferenceMode()&&!studio);
        const s2mp=_stage2TargetMp();
        tpS1._inp.style.display=r2vm?"none":""; tpS2Lbl.style.display=r2vm?"none":""; tpS2._inp.style.display="";
        tpS2.set(s2mp);
        tpMpLbl.textContent=r2vm?"Refine →":"Draft";
        const tgt=calcRes(S.aspect,S.megapixels,MULTIPLE);
        const _safe=!!S.twoPassWindowed;
        const _safeLatent=_safe&&S.twoPassEngine==="latent";
        const _win=_twoPassWindowConfig();
        const _eng=_safe?(_safeLatent?"<b>temporal neural latent upscale</b>, then <b>internally fused H3 "+_win.label+"</b>":"<b>17-frame VSR chunks</b>, then <b>internally fused H3 "+_win.label+"</b>")
          :(S.twoPassEngine==="latent"?"<b>latent-space upscales</b> (no decode round-trip)":"<b>RTX-VSR upscales</b>");
        if(studio){ const s1mp=Math.min(+S.stage1Mp||0.5,s2mp), s1=calcRes(S.aspect,s1mp,MULTIPLE), s2=calcRes(S.aspect,Math.max(s2mp,s1mp),MULTIPLE);
          tpNote.innerHTML="Studio renders its <b>"+s1.w+"×"+s1.h+" draft</b> with native CGlide references / continuation, then "+_eng+" to <b>"+s2.w+"×"+s2.h+"</b>. Stage 2 uses CGlide’s refine-safe conditioning, so keyframe anchors do not collide with the larger latent.";
        } else if(r2vm){ const s2=calcRes(S.aspect,Math.max(s2mp,S.megapixels),MULTIPLE);
          const _s2vramWarn=(_vramGB!==null&&_vramGB<16&&(+S.stage2Mp||0)>2.0)
            ? " <b style='color:#ff8a8a'>⚠ "+_vramGB+"GB VRAM detected — above 2 MP risks OOM; lower Refine if it crashes.</b>" : "";
          tpNote.innerHTML="Generates at <b>"+tgt.w+"×"+tgt.h+"</b> (references intact — identity untouched), then "+_eng+" to <b>"+s2.w+"×"+s2.h+"</b> and does a light <b>"+(+S.stage2Steps||4)+"-step · "+(+S.stage2Denoise||0.2)+" denoise</b> refine. A <b>quality</b> pass, not a speed trick. Set the generate res with <b>Resolution</b> above."+_s2vramWarn;
        } else { const s1mp=Math.min(+S.stage1Mp||0.4,s2mp), s1=calcRes(S.aspect,s1mp,MULTIPLE), s2=calcRes(S.aspect,Math.max(s2mp,s1mp),MULTIPLE);
          const _refineHint=S.stage2MpOverride?"Refine is now independent of Resolution above.":"Refine follows Resolution above until you set it here.";
          tpNote.innerHTML="Renders at <b>"+s1.w+"×"+s1.h+"</b> (fast draft), then "+_eng+" up to <b>"+s2.w+"×"+s2.h+"</b> and refines at <b>"+(+S.stage2Steps||4)+" steps · denoise "+(+S.stage2Denoise||0.2)+"</b> — a hires-fix that adds real detail cheaper than full-res. <b>"+_refineHint+"</b>"; }
        if(_safe) tpNote.innerHTML+=" <span style='color:#83cfff'><b>Audio is locked; this stays one fused H3 timeline, not an MP4 stitch.</b></span>";
      };
      const updateTwoPassUI=()=>{ const standardReady=_ptConcatAvail&&_t8DecodeAvail; const skip=S.twoPass&&(S.mode==="upscale");
        const latentOn=S.twoPassEngine==="latent";
        const safeRequested=!!S.twoPassWindowed;
        const safeActive=safeRequested;
        const safeReady=_windowedTwoPassReady();
        const safeDenoise=(+S.stage2Denoise||0.2)<=0.25;
        const ready=safeActive?safeReady:standardReady;
        const rtxWant=S.twoPass&&!latentOn&&!safeActive&&_isReferenceMode()&&!_rtxAvailable;   // regular pixel-engine R2V wants RTX VSR
        const latentMissing=S.twoPass&&latentOn&&!_latentUpAvail;
        // Latent two-pass is a TURBO pipeline (matches the LBH reference: 4-step turbo pass 1 +
        // 3-step refine). If neither Turbo nor the lightx2v preset is on, pass 1 runs the FULL
        // step count (~20) = ~5x slower AND off-recipe. Warn so the user enables the preset.
        const _lxOn=(S.lxTurbo==="fl2v"||S.lxTurbo==="r2v"), _turboOn=!!S.turboOn, _pddOn=!!S.pddOn;
        const latentNoTurbo=S.twoPass&&latentOn&&_latentUpAvail&&!_lxOn&&!_turboOn&&!_pddOn;
        _tpEngPills.forEach((p,i)=>p._set(_tpEngDefs[i][0]===S.twoPassEngine));
        tpSafeTgl._set(safeRequested); tpSafeBody.style.display=safeRequested?"block":"none";
        _tpWinPills.forEach((p,i)=>p._set(_tpWinDefs[i][0]===S.twoPassWindowProfile));
        tpLatModelRow.style.display=latentOn?"block":"none";
        if(S.twoPass&&safeActive&&!safeReady){
          tpBanner.style.display="block";
          tpBanner.innerHTML=latentOn
            ? "16GB-safe Latent needs <b>Comfyui_Minimax_h3_latent_Upscaler</b> with a model selected, plus <b>ComfyUI-MMH3Tools</b> (Context Windows + AV Split/Pack) and the core audio-mask nodes — update/install, rescan models, then <b>restart ComfyUI</b>."
            : "16GB-safe Stage 2 needs <b>ComfyUI-MMH3Tools</b> (Chunked Pixel Upscale + Context Windows + AV Split/Pack) and the core audio-mask nodes — update/install it, then <b>restart ComfyUI</b>.";
          tpUpdateNote(); return;
        }
        if(S.twoPass&&safeActive&&!safeDenoise){
          tpBanner.style.display="block";
          tpBanner.innerHTML="<b>16GB-safe Stage 2 is a low-denoise refine only.</b> Set Denoise to <b>0.20–0.25</b>; higher values can make individual windows invent different faces or details.";
          tpUpdateNote(); return;
        }
        tpBanner.style.display=(S.twoPass&&(!ready||skip||rtxWant||latentMissing||latentNoTurbo))?"block":"none";
        tpBanner.innerHTML=skip?"Two-pass is skipped in <b>Upscale</b> mode (that tab already upscales)."
          :(!ready?"Two-pass needs <b>ComfyUI-PT_H3ConcatAVLatent</b> + <b>comfyui-minimax-h3-audio-T8</b> — install both + <b>restart ComfyUI</b>."
          :(latentMissing?"Latent engine needs <b>Comfyui_Minimax_h3_latent_Upscaler</b> + a model in <b>models/latent_upscale_models</b> — install + <b>restart ComfyUI</b>, or switch Upscale to Pixel."
          :(latentNoTurbo?"⚡ <b>Latent two-pass wants a Turbo pass 1.</b> Turn on the <b>FL2V/R2V distilled preset</b> (or Turbo) in <b>Speed</b> below — otherwise pass 1 runs the full ~20 steps (≈5× slower) and won't match the tuned latent recipe."
          :(rtxWant?"R2V pixel two-pass upscales with <b>RTX VSR</b> — install it for the cleanest result (otherwise it falls back to Lanczos, still fine).":""))));
        refreshProtectedTwoPass();
        tpUpdateNote(); };
      left.appendChild(vidWrap);

      // ===== LEFT: SAMPLING =====
      const sampWrap=mk("div",{marginTop:"18px"});
      sampWrap.appendChild(sectionTitle("Sampling"));
      const sRow=mk("div",{display:"flex",gap:"6px",alignItems:"center",flexWrap:"wrap",marginBottom:"10px"});
      const stepsIn=NI(S.steps,1,100,1,v=>{S.steps=v;persist();});
      sRow.append(tx(mk("span",{fontSize:"10px",color:C.muted}),"steps"),stepsIn._inp);
      sampWrap.appendChild(sRow);
      const ddSampWrap=mk("div",{display:"flex",gap:"6px",marginBottom:"6px"});
      const sW=mk("div",{flex:"1"}); const samplerDD=DD(SAMPLERS,S.sampler,v=>{S.sampler=v;persist();}); sW.append(cap("Sampler"),samplerDD);
      const cW=mk("div",{flex:"1"}); const schedDD=DD(SCHEDULERS,S.scheduler,v=>{S.scheduler=v;persist();}); cW.append(cap("Scheduler"),schedDD);
      ddSampWrap.append(sW,cW); sampWrap.appendChild(ddSampWrap);
      const schedHint=tx(mk("div",{fontSize:"9px",color:C.muted,margin:"0 0 10px",lineHeight:"1.4"}),"");
      sampWrap.appendChild(schedHint);
      // seed
      const seedRow=mk("div",{display:"flex",gap:"10px",alignItems:"center",flexWrap:"wrap"});
      const seedTgl=Toggle("Randomize seed",S.randomizeSeed,v=>{S.randomizeSeed=v;seedIn._inp.style.opacity=v?".4":"1";persist();},LIME);
      const seedIn=NI(S.seed,0,9e15,1,v=>{S.seed=v;persist();},"120px"); seedIn._inp.style.opacity=S.randomizeSeed?".4":"1";
      seedRow.append(seedTgl,tx(mk("span",{fontSize:"10px",color:C.muted}),"seed"),seedIn._inp);
      sampWrap.appendChild(seedRow);
      const guideNote=tx(mk("div",{fontSize:"9px",color:C.muted,margin:"8px 0 0",lineHeight:"1.45"}),"MiniMax H3 is guidance-distilled: positive-only (no CFG, no negative prompt). Put everything — including what you DON'T want, phrased positively — in the prompt.");
      sampWrap.appendChild(guideNote);
      left.appendChild(sampWrap);

      // ===== LEFT: ADVANCED (collapsible) =====
      const advWrap=mk("div",{marginTop:"18px"});
      const advHdr=tx(mk("div",{fontSize:"10px",fontWeight:"800",letterSpacing:".12em",textTransform:"uppercase",color:LIME,cursor:"pointer",borderBottom:"1px solid "+C.border,paddingBottom:"6px"}),"▸ Advanced");
      const advBody=mk("div",{display:"none",marginTop:"10px"});
      advHdr.onclick=()=>{ const open=advBody.style.display==="none"; advBody.style.display=open?"block":"none"; advHdr.textContent=(open?"▾":"▸")+" Advanced"; };
      advWrap.append(advHdr,advBody);
      // sigma shift
      const shiftTgl=Toggle("Custom sigma shift (video / audio flow)",S.sigmaShiftOn,v=>{S.sigmaShiftOn=v;shiftRows.style.display=v?"flex":"none";persist();},LIME);
      advBody.appendChild(shiftTgl);
      const shiftRows=mk("div",{display:S.sigmaShiftOn?"flex":"none",gap:"10px",alignItems:"center",flexWrap:"wrap",margin:"8px 0 0"});
      const shVid=NI(S.shiftVideo,0.01,100,0.5,v=>{S.shiftVideo=v;persist();},"60px");
      const shAud=NI(S.shiftAudio,0.01,100,0.5,v=>{S.shiftAudio=v;persist();},"60px");
      shiftRows.append(tx(mk("span",{fontSize:"10px",color:C.muted}),"video"),shVid._inp,tx(mk("span",{fontSize:"10px",color:C.muted}),"audio"),shAud._inp);
      advBody.appendChild(shiftRows);
      const shiftHint=tx(mk("div",{fontSize:"9px",color:C.muted,margin:"6px 0 0",lineHeight:"1.4"}),"Off = the model's built-in shifts (video 12 / audio 3). Higher video shift = more motion/structure change; only touch if you know what you're doing.");
      advBody.appendChild(shiftHint);
      // speed (experimental) — sage attention + Blackwell fast fp8, applied to ALL modes
      const spTitle=tx(mk("div",{fontSize:"9px",fontWeight:"800",letterSpacing:".1em",textTransform:"uppercase",color:LIME,margin:"14px 0 8px",borderTop:"1px solid "+C.border,paddingTop:"10px"}),"Speed (experimental)");
      advBody.appendChild(spTitle);
      // Stage 3 — Live preview (CGlide Glide Preview patch): watch the shot form while it samples.
      const lpTgl=Toggle("👁 Live preview while sampling",S.livePreview,(v)=>{ S.livePreview=v; try{updateLpNote();}catch(_e){} persist(); },LIME);
      const lpRow=mk("div",{margin:"2px 0 0"}); lpRow.appendChild(lpTgl); advBody.appendChild(lpRow);
      const lpNote=tx(mk("div",{fontSize:"9px",color:C.muted,margin:"5px 0 11px",lineHeight:"1.5"}),"");
      advBody.appendChild(lpNote);
      const updateLpNote=()=>{ lpNote.innerHTML = !S.livePreview ? "" : (_cglidePrevAvail
        ? "Shows the shot animating in the preview as it denoises. Drop <b>taeh3.safetensors</b> in models/vae_approx for a sharp preview; otherwise it's a rough colour approximation."
        : "<span style='color:#ffcf5a'>Needs ComfyUI-CGlide (its Glide Preview provides the H3 preview) — it's installed on your machine, just RESTART ComfyUI.</span>"); };
      // ── Distilled Turbo PRESETS (lightx2v) — ONE-CLICK, LOCKED recipes. Pick one and only the
      //    render-quality dial stays yours; everything else (LoRA, sigma shift, sampler, steps) is
      //    forced to the exact trained values in generate(). These ride the H3 applicator + sigma
      //    shift with a NORMAL euler sampler (NOT the TurboSampler, which these LoRAs don't use).
      const ptRow=mk("div",{display:"flex",gap:"6px",flexWrap:"wrap",margin:"2px 0 0",alignItems:"center"});
      ptRow.append(tx(mk("span",{fontSize:"10px",color:C.muted,marginRight:"2px"}),"⚡ 1-click Turbo:"));
      const ptOffP=Pill("Off",S.lxTurbo==="off",()=>setPreset("off"));
      const ptFlP=Pill("FL2V 768p",S.lxTurbo==="fl2v",()=>setPreset("fl2v"));
      const ptR2P=Pill("R2V lip-sync",S.lxTurbo==="r2v",()=>setPreset("r2v"));
      ptRow.append(ptOffP,ptFlP,ptR2P); advBody.appendChild(ptRow);
      const ptFileRow=mk("div",{display:S.lxTurbo==="off"?"none":"block",margin:"7px 0 0"});
      const ptFileCap=cap("Exact LightX recipe file"); ptFileCap.style.margin="0 0 4px"; ptFileRow.appendChild(ptFileCap);
      const ptFileDD=DD(["(scan models)"],"(scan models)",v=>{
        if(!v||v==="(scan models)"||v==="(none found)")return;
        if(S.lxTurbo==="fl2v"){ S.lxTurboFlFile=v; _lxFl2vLora=v; }
        else if(S.lxTurbo==="r2v"){ S.lxTurboRefFile=v; _lxR2vLora=v; }
        persist(); refreshPreset(); try{updateSpeedNotes();}catch(_e){}
      });
      ptFileRow.appendChild(ptFileDD); advBody.appendChild(ptFileRow);
      const ptNote=mk("div",{fontSize:"9px",color:C.muted,margin:"6px 0 11px",lineHeight:"1.5"}); advBody.appendChild(ptNote);
      function setPreset(m){ if(m!=="off"&&S.pddOn){ S.pddOn=false; try{updatePDDUI();}catch(_e){} } S.lxTurbo=m; if(m!=="off"&&S.turboOn){ S.turboOn=false; try{applyTurboUI();}catch(_e){} } ptOffP._set(m==="off"); ptFlP._set(m==="fl2v"); ptR2P._set(m==="r2v"); persist(); refreshPreset(); try{updateSpeedNotes();}catch(_e){} try{updateTwoPassUI();}catch(_e){} }
      function refreshPreset(){
        const m=S.lxTurbo;
        ptFileRow.style.display=m==="off"?"none":"block";
        if(m==="off"){ ptNote.innerHTML="Pick a preset for a <b>locked, correct-by-construction</b> turbo: it auto-wires the selected LoRA, sigma shift, euler sampler and exact step count — you only set <b>render quality</b> (megapixel + 2-pass). Or use the manual Turbo / shift controls below."; return; }
        const fl=(m==="fl2v"), lora=fl?_lxFl2vLora:_lxR2vLora, refMode=_isReferenceMode(), okMode=fl?!refMode:refMode;
        const is8=/8[_-]?step/i.test(lora||"");   // 8-step LoRA auto-runs 8 steps + 12/3 shift
        const stepN=is8?8:4, shiftTxt=fl?(is8?"12/3":"6/3"):"12/3";
        const choices=fl?_lxFl2vLoras:_lxR2vLoras, opts=choices.length?choices:["(none found)"];
        const _recipeNorm=s=>String(s||"").replace(/\\/g,"/").toLowerCase();
        const installed=!!lora&&choices.some(f=>_recipeNorm(f)===_recipeNorm(lora));
        ptFileCap.textContent=(fl?"FL2V":"Ref2V")+" LightX recipe file"; ptFileDD.updateItems(opts); ptFileDD.set(lora||"(none found)");
        let s="🔒 <b>"+(fl?(is8?"FL2V Turbo 768p (8-step)":"FL2V Turbo 768p"):"R2V Turbo (lip-sync)")+"</b> — locked: <b>"+stepN+" steps · shift "+shiftTxt+" · euler/simple · strength 1.0</b>"+((fl&&is8)?" <span style='color:"+LIME+"'>— sharper (author-recommended)</span>":"")+". ";
        s+= fl ? "For <b>first→last-frame</b> keyframe animation (storyboard panels) — render near <b>768p</b>. "
               : "For <b>R2V lip-sync</b> (idol / character) — keeps audio refs; render near <b>0.5&nbsp;MP</b>. ⚠ your <b>first run confirms</b> the lip-sync holds at 4 steps. ";
        if(!_turboNode) s+="<br><span style='color:#ff9a5a'>⚠ Turbo node not registered — RESTART ComfyUI.</span>";
        else if(!installed) s+="<br><span style='color:#ff9a5a'>⚠ The pinned LoRA is not in models/loras — restore that exact file or choose another recipe above.</span>";
        else if(!okMode) s+="<br><span style='color:#ff9a5a'>⚠ Switch to <b>"+(fl?"T2V / I2V / Studio First–Last":"R2V / Studio References")+"</b> mode to use this preset.</span>";
        else s+="<br><span style='color:"+LIME+"'>✓ Ready: "+String(lora).split(/[\\/]/).pop()+".</span>";
        ptNote.innerHTML=s;
      }
      refreshPreset();
      // ── PDD Acc (Alibaba) — a separate acceleration format, not a generic LoRA. Its
      // official node loads both the trunk LoRA and trained per-step final-layer heads.
      const pddTitle=tx(mk("div",{fontSize:"9px",fontWeight:"800",letterSpacing:".1em",textTransform:"uppercase",color:"#ffb84d",margin:"14px 0 8px",borderTop:"1px solid "+C.border,paddingTop:"10px"}),"PDD Acceleration (official)");
      advBody.appendChild(pddTitle);
      const pddTgl=Toggle("PDD Acc 8-step — separate loader",S.pddOn,v=>setPDDEnabled(v),"#ffb84d");
      advBody.appendChild(pddTgl);
      const pddBody=mk("div",{display:S.pddOn?"block":"none",margin:"8px 0 0",padding:"8px",border:"1px solid rgba(255,184,77,.28)",borderRadius:"8px",background:"rgba(255,184,77,.05)"});
      const pddModeLabel=mk("div",{fontSize:"9px",fontWeight:"800",color:"#ffd18a",marginBottom:"6px"});
      pddBody.appendChild(pddModeLabel);
      const pddFileRow=mk("div",{marginBottom:"7px"});
      pddFileRow.appendChild(cap("PDD file (auto-matched)")); pddFileRow.lastChild.style.margin="0 0 4px";
      const pddFileDD=DD(["(restart ComfyUI)"],"(restart ComfyUI)",v=>{ if(v&&v!=="(none found)"&&v!=="(restart ComfyUI)"&&v!=="…"){ if(_isReferenceMode())S.pddRefFile=v; else S.pddFlFile=v; persist(); updatePDDUI(); updateSpeedNotes(); } });
      pddFileRow.appendChild(pddFileDD); pddBody.appendChild(pddFileRow);
      const pddNfeRow=mk("div",{display:"flex",gap:"6px",alignItems:"center",flexWrap:"wrap",margin:"2px 0 0"});
      pddNfeRow.append(tx(mk("span",{fontSize:"9px",color:C.muted,marginRight:"2px"}),"PDD steps:"));
      const _pddNfeDefs=[["8","8 · best"],["6","6 · faster"],["4","4 · fastest"]];
      const pddNfePills=_pddNfeDefs.map(([v,lbl])=>Pill(lbl,S.pddNfe===v,()=>{S.pddNfe=v; pddNfePills.forEach((p,i)=>p._set(_pddNfeDefs[i][0]===v)); persist(); updateSpeedNotes();}));
      pddNfeRow.append(...pddNfePills); pddBody.appendChild(pddNfeRow);
      const pddHint=mk("div",{fontSize:"9px",color:C.muted,margin:"7px 0 0",lineHeight:"1.45"});
      pddBody.appendChild(pddHint); advBody.appendChild(pddBody);
      function setPDDEnabled(v){
        S.pddOn=!!v;
        if(S.pddOn){
          // PDD owns its sampler/sigmas. Other distill LoRAs and step caches are off-recipe.
          S.turboOn=false; S.lxTurbo="off"; S.cacheEngine="off";
          try{applyTurboUI(); refreshPreset(); updateCacheUI();}catch(_e){}
        }
        pddTgl._set(S.pddOn); updatePDDUI(); persist();
        try{updateSpeedNotes();}catch(_e){} try{updateTwoPassUI();}catch(_e){}
      }
      function updatePDDUI(){
        const r2=_isReferenceMode(), opts=(r2?_pddRefFiles:_pddFlFiles).slice();
        let pick=opts.find(f=>_norm(f)===_norm(_pddFileForMode())) || opts[0] || "";
        if(pick){ if(r2)S.pddRefFile=pick; else S.pddFlFile=pick; }
        pddModeLabel.textContent=r2?"R2V / Studio References → Ref2VA PDD Acc file":"T2V / First–Last / Studio F–L → FL2VA PDD Acc file";
        pddFileDD.updateItems(opts.length?opts:[_pddReady()?"(none found)":"(restart ComfyUI)"]);
        pddFileDD.set(pick||(_pddReady()?"(none found)":"(restart ComfyUI)"));
        pddNfePills.forEach((p,i)=>p._set(_pddNfeDefs[i][0]===String(S.pddNfe||"8")));
        pddTgl._set(!!S.pddOn); pddBody.style.display=S.pddOn?"block":"none";
      }
      // Turbo 4-step LoRA — the biggest speed win (~5×), applies to T2V / I2V / R2V
      const turboTgl=Toggle("Turbo 4-step LoRA (~5× faster)",S.turboOn,v=>{S.turboOn=v;if(v){ if(S.pddOn){S.pddOn=false;try{updatePDDUI();}catch(_e){}} setPreset("off"); }applyTurboUI();persist();updateSpeedNotes();try{updateTwoPassUI();}catch(_e){}},"#ff5fa2");
      advBody.appendChild(turboTgl);
      const turboRow=mk("div",{display:S.turboOn?"flex":"none",alignItems:"center",gap:"8px",margin:"7px 0 0"});
      turboRow.append(cap("Turbo steps")); turboRow.lastChild.style.margin="0";
      const turboStepsIn=NI(S.turboSteps,4,16,1,v=>{S.turboSteps=v;persist();},"52px"); turboRow.appendChild(turboStepsIn._inp);
      turboRow.append(tx(mk("span",{fontSize:"9px",color:C.muted}),"(6–8 = sharp)"));
      advBody.appendChild(turboRow);
      // Turbo LoRA selector (SAFEGUARD) — pick the exact H3 turbo LoRA so a wrong/krea2 LoRA can't
      // auto-load onto H3. Auto-detect just sets the default (v4); this lets you confirm/override + A/B.
      const turboLoraRow=mk("div",{display:S.turboOn?"block":"none",margin:"8px 0 0"});
      turboLoraRow.appendChild(cap("Turbo LoRA (H3)")); turboLoraRow.lastChild.style.margin="0 0 4px";
      const turboLoraDD=DD(["…"],S.turboLora||"…",v=>{ if(v&&v!=="…"&&v!=="(none found)"){ S.turboLora=v; persist(); updateSpeedNotes(); } });
      turboLoraRow.appendChild(turboLoraDD);
      advBody.appendChild(turboLoraRow);
      const turboHint=mk("div",{fontSize:"9px",color:C.muted,margin:"5px 0 11px",lineHeight:"1.45"});
      advBody.appendChild(turboHint);
      const applyTurboUI=()=>{ const on=S.turboOn; turboRow.style.display=on?"flex":"none"; turboLoraRow.style.display=on?"block":"none"; };
      // Style / character LoRA STACK — any H3-format LoRA (a look, a character, a physics/motion
      // LoRA), any number of them, applied in order via the H3 applicator. Add as many as you need.
      const styleTgl=Toggle("Style LoRA (character / look / physics — stackable)",S.styleOn,v=>{S.styleOn=v;applyStyleUI();persist();},"#8b5cf6");
      advBody.appendChild(styleTgl);
      const styleListWrap=mk("div",{display:S.styleOn?"block":"none",margin:"8px 0 0"});
      const styleRowsHost=mk("div",{display:"flex",flexDirection:"column",gap:"6px"});
      styleListWrap.appendChild(styleRowsHost);
      const styleAddBtn=tx(mk("button",{width:"100%",padding:"7px",borderRadius:"7px",border:"1px dashed "+C.border,background:C.bg2,color:"#8b5cf6",fontSize:"10px",fontWeight:"700",cursor:"pointer",marginTop:"6px"}),"＋ Add LoRA");
      styleListWrap.appendChild(styleAddBtn);
      const animeMotionBtn=tx(mk("button",{width:"100%",padding:"7px",borderRadius:"7px",border:"1px solid rgba(130,207,255,.42)",background:"rgba(130,207,255,.07)",color:"#82cfff",fontSize:"10px",fontWeight:"700",cursor:"pointer",marginTop:"6px"}),"＋ Anime Motion · curated");
      styleListWrap.appendChild(animeMotionBtn);
      const animeMotionNote=mk("div",{fontSize:"9px",color:C.muted,margin:"6px 0 0",lineHeight:"1.42"}); styleListWrap.appendChild(animeMotionNote);
      advBody.appendChild(styleListWrap);
      let _styleOptsList=["(none found)"];
      const renderStyleLoras=()=>{
        styleRowsHost.innerHTML="";
        S.styleLoras.forEach((entry,i)=>{
          if(!entry.lora || !_styleOptsList.includes(entry.lora)){ entry.lora=_styleOptsList[0]!=="(none found)"?_styleOptsList[0]:""; }
          const row=mk("div",{display:"flex",gap:"6px",alignItems:"center"});
          const dd=DD(_styleOptsList,entry.lora||"(none found)",(v)=>{ if(v&&v!=="(none found)"){ entry.lora=v; persist(); } });
          dd.style.flex="1";
          row.appendChild(dd);
          const ni=NI(entry.strength!==undefined?entry.strength:1.0,0,2,0.05,v=>{entry.strength=v;persist();},"52px");
          row.appendChild(ni._inp);
          const rmBtn=tx(mk("button",{width:"26px",height:"26px",borderRadius:"6px",border:"1px solid "+C.border,background:C.bg2,color:C.muted,fontSize:"11px",cursor:"pointer",padding:"0",flexShrink:"0"}),"✕");
          rmBtn.onclick=()=>{ S.styleLoras.splice(i,1); renderStyleLoras(); persist(); };
          row.appendChild(rmBtn);
          styleRowsHost.appendChild(row);
        });
        if(!S.styleLoras.length) styleRowsHost.appendChild(tx(mk("div",{fontSize:"9px",color:C.muted,padding:"6px 0"}),"No LoRAs added yet — click ＋ Add LoRA below."));
      };
      styleAddBtn.onclick=()=>{ S.styleLoras.push({lora:_styleOptsList[0]!=="(none found)"?_styleOptsList[0]:"",strength:1.0}); renderStyleLoras(); persist(); };
      const addAnimeMotion=()=>{
        const lora=_animeMotionLoras[0]||"";
        if(!lora){ animeMotionNote.style.color="#ffcf5a"; animeMotionNote.textContent="Anime Motion is not installed yet. Install it in models/loras, then use ↻ Rescan."; return false; }
        const existing=S.styleLoras.find(e=>e&&_norm(e.lora)===_norm(lora));
        const strength=_isReferenceMode()?0.65:1.0;
        if(!existing)S.styleLoras.push({lora,strength});
        S.styleOn=true; styleTgl._set(true); applyStyleUI(); renderStyleLoras(); persist(); refreshAnimeMotionUI(); return true;
      };
      animeMotionBtn.onclick=addAnimeMotion;
      const refreshAnimeMotionUI=()=>{
        const installed=!!_animeMotionLoras.length, ref=_isReferenceMode();
        animeMotionBtn.style.opacity=installed?"1":".55";
        animeMotionNote.style.color=installed?C.muted:"#ffcf5a";
        animeMotionNote.innerHTML=installed
          ? "Uses <b>"+String(_animeMotionLoras[0]).split(/[\\/]/).pop()+"</b>. Author-tested for I2V at strength 1.0. Reference mode starts at <b>0.65</b> as an opt-in beta to protect identity and audio; compare a short shot before production."
          : "No Anime Motion checkpoint found yet. Rescan after installation.";
      };
      const styleHint=mk("div",{fontSize:"9px",color:C.muted,margin:"7px 0 11px",lineHeight:"1.45"});
      styleHint.innerHTML="Any H3 <b>style / character / physics</b> LoRA — drop it in <b>models/loras</b>, hit <b>↻ Rescan</b>. Uses the H3 applicator (standard loaders don't match H3 keys). Stack as many as you need; each applies in the order listed. <b>2+ stacked, manual Turbo, LightX, or PDD auto-switches to merge mode</b> to avoid the H3 applicator's bypass-mode collision.";
      advBody.appendChild(styleHint);
      const applyStyleUI=()=>{ const on=S.styleOn; styleListWrap.style.display=on?"block":"none"; };

      // ── Voice Library (comfyui-minimax-h3-audio-T8) — described-voice profiles, saved once,
      // reused forever. No audio reference needed. Panel wraps MiniMaxH3VoiceProfileT8 /
      // VoiceLibrarySave / VoiceLibraryDelete / VoiceLibraryLoad + SpeechPlan/SpeechStudio for
      // the "test a line" preview — none of these are wired into the main video graph (that stays
      // a separate future step); this panel only manages the library + lets you hear a voice. ──
      const voiceTitle=tx(mk("div",{fontSize:"9px",fontWeight:"800",letterSpacing:".1em",textTransform:"uppercase",color:"#ff9ecf",margin:"14px 0 8px",borderTop:"1px solid "+C.border,paddingTop:"10px"}),"🎙 Voice Library");
      advBody.appendChild(voiceTitle);
      let _voiceAvail=false; // MiniMaxH3VoiceProfileT8 detected — probed on init
      const voiceRowsHost=mk("div",{display:"flex",flexDirection:"column",gap:"6px"});
      advBody.appendChild(voiceRowsHost);
      const voiceAddBtn=tx(mk("button",{width:"100%",padding:"7px",borderRadius:"7px",border:"1px dashed "+C.border,background:C.bg2,color:"#ff9ecf",fontSize:"10px",fontWeight:"700",cursor:"pointer",marginTop:"2px"}),"＋ Add Voice");
      advBody.appendChild(voiceAddBtn);
      const voiceHint=mk("div",{fontSize:"9px",color:C.muted,margin:"7px 0 11px",lineHeight:"1.45"});
      voiceHint.innerHTML="Describe a voice once (no audio needed) — <b>Save</b> writes it to the library, reusable in any future generation. <b>Test</b> renders a short line so you can hear it before committing to a scene.";
      advBody.appendChild(voiceHint);

      const LANGS=["English","Chinese","Japanese","Korean","Spanish","French","German","Italian","Portuguese","Russian","Arabic"];
      const _voiceStatus=(row,msg,ok)=>{ row._status.textContent=msg; row._status.style.color=ok===false?"#ff8a8a":(ok?"#8fd19e":C.muted); };

      const _submitPrompt=async(prompt)=>{
        const r=await api.fetchApi("/prompt",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({prompt})});
        const d=await r.json().catch(()=>({}));
        if(!r.ok || (d.node_errors && Object.keys(d.node_errors).length)) throw new Error(d.error?.message || JSON.stringify(d.node_errors||d));
        return d;
      };

      const voiceSave=async(entry,row)=>{
        _voiceStatus(row,"Saving…");
        try{
          const prompt={
            "VP":{class_type:"MiniMaxH3VoiceProfileT8",inputs:{voice_mode:"described_voice",speaker_id:entry.name,voice_description:entry.description,language:entry.language||"English",rights_confirmed:false,reference_start_seconds:0.0,reference_duration_seconds:0.0,highpass_60hz:true,peak_limit_minus_3_dbfs:true},_meta:{title:"Voice Profile — "+entry.name}},
            "VS":{class_type:"MiniMaxH3VoiceLibrarySaveT8",inputs:{voice_profile:["VP",0],library_name:entry.name,replace_existing:true},_meta:{title:"Voice Library Save — "+entry.name}}
          };
          await _submitPrompt(prompt);
          if(!S.voiceLibrary.includes(entry)) S.voiceLibrary.push(entry);
          persist(); _voiceStatus(row,"✅ Saved",true);
        }catch(e){ _voiceStatus(row,"❌ "+(e.message||e),false); }
      };
      const voiceDelete=async(entry,row)=>{
        if(!confirm("Delete voice \""+entry.name+"\" from the library? This removes it from disk.")) return;
        _voiceStatus(row,"Deleting…");
        try{
          const prompt={"VD":{class_type:"MiniMaxH3VoiceLibraryDeleteT8",inputs:{library_name:entry.name,confirm_delete:true},_meta:{title:"Voice Library Delete — "+entry.name}}};
          await _submitPrompt(prompt);
          S.voiceLibrary=S.voiceLibrary.filter(v=>v!==entry); persist(); renderVoiceLibrary();
        }catch(e){ _voiceStatus(row,"❌ "+(e.message||e),false); }
      };
      const voiceTestLine=async(entry,row,text)=>{
        if(!text||!text.trim()){ _voiceStatus(row,"Type a line first"); return; }
        if(!S.unetRef||!S.textEncoder||!S.videoVae||!S.audioVae){ _voiceStatus(row,"❌ Set model / CLIP / VAEs above first",false); return; }
        _voiceStatus(row,"Rendering line… (loads the H3 model, ~1-2 min)");
        try{
          const seed=Math.floor(Math.random()*1e15);
          const prompt={
            "T:unet":{class_type:"UNETLoader",inputs:{unet_name:S.unetRef,weight_dtype:"default"},_meta:{title:"H3 model (voice test)"}},
            "T:clip":{class_type:"CLIPLoader",inputs:{clip_name:S.textEncoder,type:"minimax",device:"default"},_meta:{title:"CLIP (voice test)"}},
            "T:vvae":{class_type:"VAELoader",inputs:{vae_name:S.videoVae},_meta:{title:"Video VAE (voice test)"}},
            "T:avae":{class_type:"VAELoader",inputs:{vae_name:S.audioVae},_meta:{title:"Audio VAE (voice test)"}},
            "T:load":{class_type:"MiniMaxH3VoiceLibraryLoadT8",inputs:{library_name:entry.name},_meta:{title:"Load voice — "+entry.name}},
            "T:plan":{class_type:"MiniMaxH3SpeechPlanT8",inputs:{voice_profile:["T:load",0],text:text,language:entry.language||"English",acting_direction:"natural, conversational pacing",emotion:"neutral",emotion_intensity:0.6,space:"studio",chunking:"single_segment",target_units:18,max_units:24},_meta:{title:"Speech plan"}},
            "T:studio":{class_type:"MiniMaxH3SpeechStudioT8",inputs:{model:["T:unet",0],clip:["T:clip",0],video_vae:["T:vvae",0],audio_vae:["T:avae",0],voice_profile:["T:load",0],speech_plan:["T:plan",0],segment_index:0,seed:seed,render_seconds:10.0,resolution:32,steps:20,sampler_name:"res_multistep",scheduler:"simple",shift_video:12,shift_audio:3,trim_mode:"none",verify_mode:"off",asr_model_directory:"",asr_language:entry.language||"English",min_similarity:0.85,unload_asr_after_verify:true,speaker_check_mode:"off",speaker_model_directory:"",min_speaker_similarity:0.86,unload_speaker_after_verify:true,peak_limit_dbfs:-1,release_policy:"unload_all_models"},_meta:{title:"Speech Studio — "+entry.name}},
            "T:save":{class_type:"SaveAudioMP3",inputs:{audio:["T:studio",0],filename_prefix:"voice_test/"+entry.name,quality:"320k"},_meta:{title:"Save test line (MP3, drag-in ready)"}}
          };
          await _submitPrompt(prompt);
          _voiceStatus(row,"✅ Queued — check output/audio/voice_test/ once it finishes",true);
        }catch(e){ _voiceStatus(row,"❌ "+(e.message||e),false); }
      };

      const renderVoiceLibrary=()=>{
        voiceRowsHost.innerHTML="";
        if(!S.voiceLibrary.length){ voiceRowsHost.appendChild(tx(mk("div",{fontSize:"9px",color:C.muted,padding:"6px 0"}),"No voices yet — click ＋ Add Voice below.")); return; }
        S.voiceLibrary.forEach((entry,i)=>{
          const row=mk("div",{border:"1px solid "+C.border,borderRadius:"7px",padding:"8px",background:C.bg1});
          const head=mk("div",{display:"flex",alignItems:"center",gap:"6px"});
          const nameIn=mk("input",{flex:"1",padding:"5px 7px",borderRadius:"6px",border:"1px solid "+C.border,background:C.bg2,color:"#ff9ecf",fontSize:"10px",fontWeight:"700"},{type:"text",value:entry.name});
          nameIn.oninput=()=>{ entry.name=nameIn.value; persist(); };
          const langDD=DD(LANGS,entry.language||"English",v=>{ entry.language=v; persist(); }); langDD.style.width="90px";
          const delBtn=tx(mk("button",{width:"24px",height:"24px",borderRadius:"6px",border:"1px solid "+C.border,background:C.bg2,color:C.muted,fontSize:"11px",cursor:"pointer",padding:"0",flexShrink:"0"}),"✕");
          delBtn.onclick=()=>voiceDelete(entry,row);
          head.append(nameIn,langDD,delBtn);
          row.appendChild(head);
          const descTa=mk("textarea",{width:"100%",marginTop:"6px",padding:"6px 7px",borderRadius:"6px",border:"1px solid "+C.border,background:C.bg2,color:C.text,fontSize:"9.5px",lineHeight:"1.4",minHeight:"44px",resize:"vertical",fontFamily:"inherit"});
          descTa.value=entry.description||""; descTa.oninput=()=>{ entry.description=descTa.value; persist(); };
          row.appendChild(descTa);
          const actRow=mk("div",{display:"flex",gap:"6px",marginTop:"6px"});
          const saveBtn=tx(mk("button",{flex:"1",padding:"6px",borderRadius:"6px",border:"1px solid "+C.border,background:"rgba(255,158,207,.12)",color:"#ff9ecf",fontSize:"9.5px",fontWeight:"700",cursor:"pointer"}),"💾 Save");
          saveBtn.onclick=()=>voiceSave(entry,row);
          actRow.appendChild(saveBtn);
          row.appendChild(actRow);
          const testRow=mk("div",{display:"flex",gap:"6px",marginTop:"6px"});
          const testIn=mk("input",{flex:"1",padding:"5px 7px",borderRadius:"6px",border:"1px solid "+C.border,background:C.bg2,color:C.text,fontSize:"9.5px"},{type:"text",placeholder:"Type a line to test this voice…"});
          const testBtn=tx(mk("button",{padding:"6px 10px",borderRadius:"6px",border:"1px solid "+C.border,background:C.bg2,color:LIME,fontSize:"9.5px",fontWeight:"700",cursor:"pointer",flexShrink:"0"}),"▶ Test");
          testBtn.onclick=()=>voiceTestLine(entry,row,testIn.value);
          testRow.append(testIn,testBtn);
          row.appendChild(testRow);
          const status=mk("div",{fontSize:"9px",color:C.muted,marginTop:"5px"});
          row._status=status; row.appendChild(status);
          if(!_voiceAvail) _voiceStatus(row,"⚠ comfyui-minimax-h3-audio-T8 not detected — restart ComfyUI to use this",false);
          voiceRowsHost.appendChild(row);
        });
      };
      voiceAddBtn.onclick=()=>{ S.voiceLibrary.push({name:"new_voice",language:"English",description:"an adult speaker with a natural warm voice, clear diction, human micro-pauses, and close conversational delivery"}); persist(); renderVoiceLibrary(); };
      renderVoiceLibrary();
      api.fetchApi("/object_info/MiniMaxH3VoiceProfileT8").then(r=>r.ok?r.json():{}).then(d=>{ _voiceAvail=!!(d&&d.MiniMaxH3VoiceProfileT8); if(!_voiceAvail) renderVoiceLibrary(); }).catch(()=>{ _voiceAvail=false; renderVoiceLibrary(); });

      const sageTgl=Toggle("Sage attention — mem-efficient (KJNodes)",S.sageAttn,v=>{S.sageAttn=v;if(v)S.solAttn=false;persist();updateSpeedNotes();},"#5fd0ff");
      advBody.appendChild(sageTgl);
      const sageHint=mk("div",{fontSize:"9px",color:C.muted,margin:"5px 0 11px",lineHeight:"1.45"});
      advBody.appendChild(sageHint);
      const solTgl=Toggle("Sol-Attn — sparse (Blackwell: faster + less VRAM)",S.solAttn,v=>{S.solAttn=v;if(v)S.sageAttn=false;persist();updateSpeedNotes();},"#8f7fff");
      advBody.appendChild(solTgl);
      const solHint=mk("div",{fontSize:"9px",color:C.muted,margin:"5px 0 11px",lineHeight:"1.45"});
      advBody.appendChild(solHint);
      const fastTgl=Toggle("Blackwell fast FP8 (RTX 50-series)",S.fastFp8,v=>{S.fastFp8=v;persist();updateSpeedNotes();},"#5fd0ff");
      advBody.appendChild(fastTgl);
      const fastHint=mk("div",{fontSize:"9px",color:C.muted,margin:"5px 0 0",lineHeight:"1.45"});
      advBody.appendChild(fastHint);

      // ── cache accelerator (step reuse) — mutually exclusive; biggest win on full-quality runs ──
      const cacheTitle=tx(mk("div",{fontSize:"9px",fontWeight:"800",letterSpacing:".1em",textTransform:"uppercase",color:LIME,margin:"14px 0 8px",borderTop:"1px solid "+C.border,paddingTop:"10px"}),"Cache accelerator (step reuse)");
      advBody.appendChild(cacheTitle);
      const cacheRow=mk("div",{display:"flex",gap:"6px",flexWrap:"wrap",marginBottom:"6px"});
      const _cacheDefs=[["off","Off"],["teacache","TeaCache ⭐"],["spectrum","Spectrum"],["fbc","FirstBlockCache"],["easycache","EasyCache"]];
      const _cachePills=_cacheDefs.map(([v,lbl])=>Pill(lbl,S.cacheEngine===v,()=>setCacheEngine(v)));
      cacheRow.append(..._cachePills); advBody.appendChild(cacheRow);
      const cacheKnob=mk("div",{display:"flex",alignItems:"center",gap:"10px",flexWrap:"wrap",margin:"2px 0 0"});
      const teaKnobWrap=mk("div",{display:"none",alignItems:"center",gap:"5px"});
      const teaKnob=NI(S.teaThresh,0.0,0.5,0.01,v=>{S.teaThresh=v;persist();},"56px");
      teaKnobWrap.append(tx(mk("span",{fontSize:"9px",color:C.muted}),"threshold"),teaKnob._inp,tx(mk("span",{fontSize:"9px",color:C.muted}),"↑ = faster / more drift"));
      const specKnobWrap=mk("div",{display:"none",alignItems:"center",gap:"5px"});
      const specKnob=NI(S.spectrumBlend,0.1,1.0,0.05,v=>{S.spectrumBlend=v;persist();},"56px");
      specKnobWrap.append(tx(mk("span",{fontSize:"9px",color:C.muted}),"blend"),specKnob._inp,tx(mk("span",{fontSize:"9px",color:C.muted}),"↑ = faster / more drift"));
      const fbcKnobWrap=mk("div",{display:"none",alignItems:"center",gap:"6px",flexWrap:"wrap"});
      const _fbcDefs=[["H3 Safe — 0.08 / max 2","Safe"],["H3 Fast — 0.10 / max 2","Fast"],["H3 Aggressive — 0.12 / max 2","Aggressive"]];
      const _fbcPills=_fbcDefs.map(([v,lbl])=>Pill(lbl,S.fbcMode===v,()=>{ S.fbcMode=v; _fbcPills.forEach((p,i)=>p._set(_fbcDefs[i][0]===v)); persist(); }));
      fbcKnobWrap.append(tx(mk("span",{fontSize:"9px",color:C.muted}),"preset"),..._fbcPills);
      const easyKnobWrap=mk("div",{display:"none",alignItems:"center",gap:"5px"});
      const easyKnob=NI(S.easyThresh,0.0,3.0,0.01,v=>{S.easyThresh=v;persist();},"56px");
      easyKnobWrap.append(tx(mk("span",{fontSize:"9px",color:C.muted}),"reuse threshold"),easyKnob._inp,tx(mk("span",{fontSize:"9px",color:C.muted}),"↑ = faster / more drift"));
      cacheKnob.append(teaKnobWrap,specKnobWrap,fbcKnobWrap,easyKnobWrap); advBody.appendChild(cacheKnob);
      const cacheBanner=mk("div",{display:"none",margin:"6px 0 0",padding:"7px",borderRadius:"6px",border:"1px solid #cc7a00",background:"rgba(255,150,0,.08)",fontSize:"9px",color:"#ffb84d",lineHeight:"1.4"});
      advBody.appendChild(cacheBanner);
      const cacheHint=mk("div",{fontSize:"9px",color:C.muted,margin:"6px 0 0",lineHeight:"1.45"});
      advBody.appendChild(cacheHint);
      const _cacheAvail=(e)=>e==="teacache"?_teaAvailable:e==="spectrum"?_spectrumAvailable:e==="fbc"?_fbcAvailable:e==="easycache"?_easycacheAvailable:true;
      const _cacheNodeName=(e)=>e==="teacache"?"ComfyUI-MiniMaxH3-TeaCache":e==="spectrum"?"ComfyUI-Spectrum-MiniMax-H3":e==="easycache"?"ComfyUI core":"ComfyUI-MiniMaxH3-FirstBlockCache";
      const updateCacheUI=()=>{
        _cachePills.forEach((p,i)=>p._set(_cacheDefs[i][0]===S.cacheEngine));
        teaKnobWrap.style.display=S.cacheEngine==="teacache"?"flex":"none";
        specKnobWrap.style.display=S.cacheEngine==="spectrum"?"flex":"none";
        fbcKnobWrap.style.display=S.cacheEngine==="fbc"?"flex":"none";
        easyKnobWrap.style.display=S.cacheEngine==="easycache"?"flex":"none";
        const e=S.cacheEngine, avail=_cacheAvail(e);
        cacheBanner.style.display=(e!=="off"&&!avail)?"block":"none";
        if(e!=="off"&&!avail) cacheBanner.innerHTML = e==="easycache"
          ? "<b>EasyCache</b> is native to ComfyUI core but isn't registered on this install — <b>update + restart ComfyUI</b> so it appears."
          : "<b>"+_cacheNodeName(e)+"</b> isn't detected — clone it into <code>custom_nodes</code> and <b>restart ComfyUI</b> so it registers.";
        cacheHint.innerHTML = e==="off"
          ? "Reuses transformer output across near-identical steps to skip redundant compute. <b>Pick one</b> — biggest win on <b>full-quality</b> (higher-step) runs; little benefit with Turbo's few steps. Not lossless, so <b>A/B it</b>."
          : e==="teacache"
          ? "<b>TeaCache</b> — reuses a forward pass while the input barely changes. <b>~3× measured</b>, quality A/B-matches around <b>0.15</b>; higher = faster / more drift. First & last steps stay real. <b>The recommended one.</b>"
          : e==="spectrum"
          ? "<b>Spectrum</b> — forecasts features (Chebyshev regression) to skip steps. ~1.3×, conservative; <b>audio kept native</b> for fidelity. Not lossless (can shift some seeds) — <b>A/B it</b>. History in system RAM (16 GB-safe)."
          : e==="easycache"
          ? "<b>EasyCache</b> — native ComfyUI accelerator, reuses the diffusion output when it barely changed step to step. Fast (community reports close to <b>3×</b> with Sage + fewer steps), but <b>quality trade-off is the real cost</b> — not lossless, and it can visibly soften detail/motion. Try <b>TeaCache first</b> for full-quality runs; reach for this only when speed matters more than fidelity. Lower the threshold if it looks soft. Don't combine with Spectrum (auto-deactivates if both are on the same model)."
          : "<b>FirstBlockCache</b> — runs block 1 each step, reuses the rest when the change is small. <b>Safe / Fast / Aggressive</b> = 0.08 / 0.10 / 0.12. Lightweight, VRAM-neutral.";
      };
      const setCacheEngine=(v)=>{ if(v!=="off"&&S.pddOn){ S.pddOn=false; try{updatePDDUI();}catch(_e){} } S.cacheEngine=v; updateCacheUI(); persist(); try{updateSpeedNotes();}catch(_e){} };

      const updateSpeedNotes=()=>{
        sageTgl._set(S.sageAttn); solTgl._set(S.solAttn); fastTgl._set(S.fastFp8); turboTgl._set(S.turboOn); applyTurboUI();
        styleTgl._set(S.styleOn); applyStyleUI(); try{updatePDDUI();}catch(_e){}
        const _pddFile=_pddFileForMode(), _pddExpect=_isReferenceMode()?"ref2va":"fl2va";
        const _pddFileOK=!!(_pddFile&&_norm(_pddFile).includes(_pddExpect));
        if(S.pddOn){
          pddHint.innerHTML=_pddReady()&&_pddFileOK
            ? "<span style=\"color:#ffd18a\">✓ <b>PDD Acc "+(S.pddNfe||"8")+"-step is ready.</b></span> Uses the exact PDD head-bank schedule, <b>Euler</b>, and flow shift <b>12 / 3</b>. Turbo and cache are held off. "+(_isReferenceMode()?"Your Ref2VA audio/video references stay on the reference path.":"Using the FL2VA file for this mode.")
            : "<span style=\"color:#ff9a5a\">⚠ PDD needs a ComfyUI restart and its matching "+(_isReferenceMode()?"Ref2VA":"FL2VA")+" file in <code>models/pdd_acc</code>.</span>";
        } else {
          pddHint.innerHTML="Official PDD acceleration is a <b>separate format</b>, not a style or Turbo LoRA. Turn it on for its trained <b>8-step</b> route; it automatically selects "+(_isReferenceMode()?"Ref2VA":"FL2VA")+", locks Euler + 12/3, and disables caches / other distill LoRAs.";
        }
        const turboReady=_turboNode && !!S.turboLora;
        turboHint.innerHTML = turboReady
          ? "larryvrh's <b>Turbo LoRA</b> + its audio-aware dual-schedule sampler — <b>~5× faster</b> (works on your pruned fp8 base). 4 = fastest/softer, <b>6–8 = sharp</b>. Overrides steps &amp; sampler, and turns off custom sigma shift. <b>R2V:</b> compatible H3 Turbo LoRAs can keep reference-video soundtracks and standalone &lt;Audio&gt; clips; <b>minimax_h3_turbo_v4_step600_ema</b> is supported. If an unrelated third-party LoRA errors, it is not Ref2VA-audio compatible — use the Larry v4-600 LoRA. LoRA: <code>"+(S.turboLora||"—")+"</code>."
          : "<span style='color:#c9a06a'>Turbo LoRA is installed — <b>restart ComfyUI</b> so the MiniMax-H3-Turbo node registers, then toggle on. (Needs the node + a turbo LoRA in models/loras.)</span>";
        sageHint.innerHTML = _sageAvailable
          ? "Patches H3 self-attention to a memory-efficient SageAttention kernel — benchmarks show <b>~7% faster + lower peak VRAM</b>, output near-identical. Uses your <code>--use-sage-attention</code> launch."
          : "<span style='color:#c9a06a'>Needs ComfyUI-KJNodes + a recent <code>sageattention</code> (not detected). Install KJNodes and restart, then toggle on.</span>";
        solHint.innerHTML = _solAvailable
          ? "NVIDIA <b>Sol-Attn</b> sparse attention + FFN chunking, H3-specific for your Blackwell card — benchmarks show <b>~1.15–1.4× faster and ~37% less MLP VRAM</b>. Keeps prompt/reference/audio KV exact, so sync holds; the rest is approximate (not bit-identical), so <b>A/B it</b>. <b>Replaces Sage</b> when on."
          : "<span style='color:#c9a06a'>Sol-Attn is installed — <b>restart ComfyUI</b> so its H3 nodes register, then toggle on. (Needs Blackwell SM120 + Triton TMA — you have both.)</span>";
        // int8/NVFP4/convrot models carry their quantization in the file — ComfyUI runs the right
        // kernels automatically, so the fp8 toggle doesn't apply. Show that instead of misleading.
        const _actUnet=((_isReferenceMode()?S.unetRef:S.unetFl)||"");
        const _int8Model=/int8|w8a8|convrot|nvfp4|fp4/i.test(_actUnet);
        fastTgl.style.opacity=_int8Model?".4":"1";
        fastHint.innerHTML = _int8Model
          ? "<span style='color:#7fd0a0'>A <b>quantized model</b> is selected (<code>"+_actUnet.split("/").pop()+"</code>). It's <b>already quantized in the file</b> (int8/convrot or NVFP4) — ComfyUI runs its native kernels automatically, so this fp8 toggle is <b>ignored</b>. No extra switch needed: picking the model <i>is</i> the switch.</span>"
          : "Loads the fp8 model with fast fp8 matmul (<code>fp8_e4m3fn_fast</code>) — Blackwell/50-series tensor-core acceleration on your <b>existing</b> weights. Small speed win; can very slightly shift quality, so A/B it. For a bigger jump, use an <b>int8/convrot</b> or <b>NVFP4</b> model (just select it — no toggle).";
      };
      left.appendChild(advWrap);

      // ===== LEFT: MODELS (collapsible, auto-detected) =====
      const modWrap=mk("div",{marginTop:"18px"});
      const modHdrRow=mk("div",{display:"flex",alignItems:"center",justifyContent:"space-between",borderBottom:"1px solid "+C.border,paddingBottom:"6px",cursor:"pointer"});
      const modHdr=tx(mk("div",{fontSize:"10px",fontWeight:"800",letterSpacing:".12em",textTransform:"uppercase",color:LIME}),"▸ Models");
      const modStatus=tx(mk("span",{fontSize:"9px",fontWeight:"700"}),"");
      modHdrRow.append(modHdr,modStatus);
      const modBody=mk("div",{display:"none",marginTop:"10px"});
      modHdrRow.onclick=()=>{ const open=modBody.style.display==="none"; modBody.style.display=open?"block":"none"; modHdr.textContent=(open?"▾":"▸")+" Models"; };
      modWrap.append(modHdrRow,modBody);
      const ddRow=(label)=>{ const r=mk("div",{marginBottom:"8px"}); r.appendChild(cap(label)); const dd=DD(["none"],"none",()=>{}); r.appendChild(dd); r._dd=dd; return r; };
      const mFl=ddRow("Diffusion · fl2va (T2V / I2V)");
      const mRef=ddRow("Diffusion · ref2va (R2V)");
      const mTE=ddRow("Text encoder (Qwen3-VL · minimax)");
      const mVVae=ddRow("VAE · video");
      const mAVae=ddRow("VAE · audio");
      mFl._dd=DD(["none"],"none",v=>{S.unetFl=v==="none"?"":v;persist();updateModStatus();updateSpeedNotes();}); mFl.replaceChild(mFl._dd,mFl.lastChild);
      mRef._dd=DD(["none"],"none",v=>{S.unetRef=v==="none"?"":v;persist();updateModStatus();updateSpeedNotes();}); mRef.replaceChild(mRef._dd,mRef.lastChild);
      mTE._dd=DD(["none"],"none",v=>{S.textEncoder=v==="none"?"":v;persist();updateModStatus();}); mTE.replaceChild(mTE._dd,mTE.lastChild);
      mVVae._dd=DD(["none"],"none",v=>{S.videoVae=v==="none"?"":v;persist();updateModStatus();}); mVVae.replaceChild(mVVae._dd,mVVae.lastChild);
      mAVae._dd=DD(["none"],"none",v=>{S.audioVae=v==="none"?"":v;persist();updateModStatus();}); mAVae.replaceChild(mAVae._dd,mAVae.lastChild);
      [mFl,mRef,mTE,mVVae,mAVae].forEach(r=>modBody.appendChild(r));
      const rescanBtn=tx(mk("button",{marginTop:"2px",padding:"5px 10px",fontSize:"10px",fontWeight:"700",background:C.bg2,border:"1px solid "+C.border,borderRadius:"6px",color:LIME,cursor:"pointer"}),"↻ Rescan models");
      rescanBtn.onclick=()=>_loadModels();
      modBody.appendChild(rescanBtn);
      left.appendChild(modWrap);
      const updateModStatus=()=>{
        const need=_isReferenceMode()?[S.unetRef,S.textEncoder,S.videoVae,S.audioVae]:[S.unetFl,S.textEncoder,S.videoVae,S.audioVae];
        const ok=need.every(v=>v&&v!=="none");
        modStatus.textContent=ok?"✓ detected":"⚠ missing";
        modStatus.style.color=ok?LIME:"#ff9f43";
      };

      // ===== LEFT: DOWNLOAD DOCS (collapsible, default collapsed) =====
      const dl=mk("div",{marginTop:"18px"});
      const dlHdr=tx(mk("div",{fontSize:"10px",fontWeight:"800",letterSpacing:".12em",textTransform:"uppercase",color:LIME,cursor:"pointer",borderBottom:"1px solid "+C.border,paddingBottom:"6px"}),"▸ Models — where to download");
      const dlBody=mk("div",{display:"none",marginTop:"10px"});
      dlHdr.onclick=()=>{ const open=dlBody.style.display==="none"; dlBody.style.display=open?"block":"none"; dlHdr.textContent=(open?"▾":"▸")+" Models — where to download"; };
      dl.append(dlHdr,dlBody);
      const dlBox=mk("div",{fontSize:"10px",color:C.text,lineHeight:"1.55"});
      const HF="https://huggingface.co/Comfy-Org/MiniMax-H3/resolve/main";
      dlBox.innerHTML=
        "All files from "+link("🤗 Comfy-Org/MiniMax-H3","https://huggingface.co/Comfy-Org/MiniMax-H3")+" (pick ONE quant per model — fp8 or int8 ≈ 21GB, best for a 16–24GB card).<br>"+
        "<b style='color:"+LIME+"'>Diffusion</b> → <code>models/diffusion_models/</code><br>"+
        link("minimax_h3_fl2va_pruned_fp8_scaled.safetensors",HF+"/diffusion_models/minimax_h3_fl2va_pruned_fp8_scaled.safetensors")+" &nbsp;(T2V / I2V)<br>"+
        link("minimax_h3_ref2va_pruned_fp8_scaled.safetensors",HF+"/diffusion_models/minimax_h3_ref2va_pruned_fp8_scaled.safetensors")+" &nbsp;(R2V)<br>"+
        "<b style='color:"+LIME+"'>Text encoder</b> → <code>models/text_encoders/</code><br>"+
        link("qwen3vl_32b_minimax_h3_int8_convrot.safetensors",HF+"/text_encoders/qwen3vl_32b_minimax_h3_int8_convrot.safetensors")+" &nbsp;(or the <code>nvfp4_awq</code> variant on 50-series)<br>"+
        "<b style='color:"+LIME+"'>VAE</b> → <code>models/vae/</code><br>"+
        link("minimax_h3_video_vae_fp16.safetensors",HF+"/vae/minimax_h3_video_vae_fp16.safetensors")+"<br>"+
        link("minimax_h3_audio_vae_fp32.safetensors",HF+"/vae/minimax_h3_audio_vae_fp32.safetensors")+"<br>"+
        "<b style='color:#5fd0ff'>⚡ Faster on Blackwell (RTX 50-series): NVFP4 weights</b> → <code>models/diffusion_models/</code><br>"+
        link("MiniMax-H3 pruned NVFP4 (browse)","https://huggingface.co/models?search=minimax-h3%20nvfp4")+" — native FP4 tensor cores, ~half size &amp; fast; 4-bit trades a little motion fidelity vs int8/fp8. Select it in Models like any other diffusion file.<br>"+
        "<span style='color:"+C.muted+"'>After copying files, hit ↻ Rescan models (Models panel). Needs a current ComfyUI with the native MiniMax H3 nodes (PR #15224).</span>";
      dlBody.appendChild(dlBox);
      left.appendChild(dl);

      // ===== RIGHT: preview + generate =====
      const preview=mk("div",{flex:"1",borderRadius:"10px",border:"1px solid "+C.border,background:C.bg1,display:"flex",alignItems:"center",justifyContent:"center",overflow:"hidden",position:"relative",minHeight:"0"});
      const placeholder=tx(mk("div",{color:C.muted,fontSize:"12px",textAlign:"center",padding:"24px"}),"Your video (with sound) will appear here.");
      // muted autoplay is the only reliable autoplay; the note tells users to unmute.
      const videoEl=mk("video",{maxWidth:"100%",maxHeight:"100%",display:"none"},{controls:true,autoplay:true,loop:true,muted:true});
      // fullscreen button (top-right of the preview) — only shown once a video is loaded
      const fsBtn=tx(mk("button",{position:"absolute",top:"8px",right:"8px",zIndex:"4",width:"30px",height:"30px",borderRadius:"7px",border:"1px solid "+C.border,background:"rgba(0,0,0,.6)",color:LIME,cursor:"pointer",fontSize:"14px",display:"none",alignItems:"center",justifyContent:"center",lineHeight:"1"}),"⛶");
      fsBtn.title="Fullscreen (Esc to close)";
      fsBtn.onclick=()=>openFullscreen();
      // Stage 3 — live-preview frame (shown while sampling, hidden when the finished video loads)
      const previewImg=mk("img",{maxWidth:"100%",maxHeight:"100%",display:"none",objectFit:"contain"});
      preview.append(placeholder,videoEl,previewImg,fsBtn);

      // ── node-local fullscreen overlay (covers the whole panel; like Krea2) ──
      const fsOverlay=mk("div",{position:"absolute",inset:"0",zIndex:"60",background:"rgba(8,8,10,.98)",display:"none",flexDirection:"column",borderRadius:"12px"});
      const fsTop=mk("div",{position:"absolute",top:"0",left:"0",right:"0",display:"flex",alignItems:"center",justifyContent:"space-between",padding:"12px 14px",zIndex:"2",background:"linear-gradient(to bottom,rgba(0,0,0,.6),rgba(0,0,0,0))"});
      const fsName=tx(mk("div",{fontSize:"11px",fontWeight:"700",color:"#fff",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap",flex:"1",padding:"0 10px 0 2px"}),"");
      const fsClose=tx(mk("button",{width:"30px",height:"30px",borderRadius:"50%",background:"rgba(255,255,255,.1)",border:"1px solid rgba(255,255,255,.2)",color:"#fff",fontSize:"14px",cursor:"pointer",flex:"0 0 auto",lineHeight:"1"}),"✕");
      fsClose.title="Close (Esc)"; fsClose.onclick=()=>closeFullscreen();
      fsTop.append(fsName,fsClose);
      const fsMedia=mk("div",{flex:"1",display:"flex",alignItems:"center",justifyContent:"center",padding:"52px 18px 18px",boxSizing:"border-box",minHeight:"0"});
      const fsVideo=mk("video",{maxWidth:"100%",maxHeight:"100%",borderRadius:"8px",boxShadow:"0 6px 30px rgba(0,0,0,.6)"},{controls:true,autoplay:true,loop:true});
      fsMedia.appendChild(fsVideo);
      fsOverlay.append(fsMedia,fsTop);
      root.appendChild(fsOverlay);
      let _fsFilename="";
      const openFullscreen=()=>{
        if(!videoEl.src||videoEl.style.display==="none") return;
        fsVideo.src=videoEl.src; fsVideo.muted=false; fsVideo.currentTime=videoEl.currentTime||0;
        fsName.textContent=_fsFilename||"";
        fsOverlay.style.display="flex"; try{ fsVideo.play&&fsVideo.play().catch(()=>{}); }catch(e){}
        fsOverlay.focus&&fsOverlay.focus();
      };
      const closeFullscreen=()=>{ try{ fsVideo.pause&&fsVideo.pause(); }catch(e){} fsVideo.src=""; fsOverlay.style.display="none"; };
      fsOverlay.setAttribute("tabindex","-1");
      fsOverlay.addEventListener("keydown",e=>{ if(e.key==="Escape")closeFullscreen(); });

      const audioNote=tx(mk("div",{fontSize:"9px",color:C.muted,textAlign:"center",margin:"6px 0 0"}),"🔊 H3 renders native stereo audio — unmute the player to hear it.");

      // ── progress (percent · step · elapsed) ──
      const progLabel=tx(mk("div",{marginTop:"10px",fontSize:"11px",fontWeight:"700",color:LIME,display:"none"}),"");
      const progWrap=mk("div",{marginTop:"5px",height:"10px",borderRadius:"5px",background:C.bg3,overflow:"hidden",display:"none"});
      const progBar=mk("div",{height:"100%",width:"0%",background:"linear-gradient(90deg,"+LIME+",#9be15d)",transition:"width .2s"});
      progWrap.appendChild(progBar);

      const errBox=mk("div",{marginTop:"8px",display:"none",fontSize:"10px",color:"#ff6b6b",background:"rgba(255,80,80,.08)",border:"1px solid rgba(255,80,80,.3)",borderRadius:"6px",padding:"7px",whiteSpace:"pre-wrap"});

      const btnRow=mk("div",{marginTop:"10px",display:"flex",gap:"8px"});
      const genBtn=tx(mk("button",{flex:"1",padding:"13px",borderRadius:"10px",border:"2px solid "+LIME,background:"rgba(240,255,65,.1)",color:LIME,fontSize:"13px",fontWeight:"800",letterSpacing:".06em",cursor:"pointer",textTransform:"uppercase"}),"▶ Generate");
      const folderBtn=tx(mk("button",{padding:"13px 14px",borderRadius:"10px",border:"1px solid "+C.border,background:C.bg2,color:C.text,fontSize:"11px",cursor:"pointer"}),"📁");
      folderBtn.title="Open output folder";
      folderBtn.onclick=()=>api.fetchApi("/minimaxh3/open_folder",{method:"POST",body:JSON.stringify({}),headers:{"Content-Type":"application/json"}});
      btnRow.append(genBtn,folderBtn);

      // ── gallery (recent renders) ──
      const galWrap=mk("div",{marginTop:"12px"});
      const galHdr=mk("div",{display:"flex",alignItems:"center",justifyContent:"space-between",gap:"6px",margin:"0 0 6px"});
      const galTitle=tx(mk("div",{fontSize:"9px",fontWeight:"800",letterSpacing:".1em",textTransform:"uppercase",color:C.muted}),"Gallery · recent renders");
      const galBtns=mk("div",{display:"flex",gap:"5px"});
      const galAllBtn=tx(mk("button",{fontSize:"9px",fontWeight:"700",background:C.bg2,border:"1px solid "+C.border,borderRadius:"5px",color:LIME,cursor:"pointer",padding:"2px 9px"}),"⤢ view all");
      const galRefresh=tx(mk("button",{fontSize:"9px",fontWeight:"700",background:C.bg2,border:"1px solid "+C.border,borderRadius:"5px",color:LIME,cursor:"pointer",padding:"2px 9px"}),"↻");
      galRefresh.title="Rescan output folder";
      galRefresh.onclick=()=>_loadGallery();
      galAllBtn.onclick=()=>openGalleryModal();
      galBtns.append(galAllBtn,galRefresh);
      galHdr.append(galTitle,galBtns);
      galWrap.appendChild(galHdr);
      const galStrip=mk("div",{display:"flex",gap:"6px",overflowX:"auto",paddingBottom:"5px"},{className:"mmh3-scroll"});
      const galEmpty=tx(mk("div",{fontSize:"9px",color:C.muted}),"Finished videos collect here — click one to see its settings.");
      galWrap.append(galStrip,galEmpty);

      right.append(preview,audioNote,progLabel,progWrap,errBox,btnRow,galWrap);

      // heart icon (fill follows currentColor so the button/badge colour controls it)
      const _mkHeart=(size)=>{ const s=document.createElementNS("http://www.w3.org/2000/svg","svg"); s.setAttribute("viewBox","0 0 24 24"); s.setAttribute("width",size); s.setAttribute("height",size); s.style.display="block"; const p=document.createElementNS("http://www.w3.org/2000/svg","path"); p.setAttribute("d","M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z"); p.setAttribute("fill","currentColor"); s.appendChild(p); return s; };

      // ── full-panel "view all" grid (browse renders + favorites filter) ──
      const galModal=mk("div",{position:"absolute",inset:"0",background:"rgba(8,8,8,.97)",zIndex:"50",display:"none",flexDirection:"column",borderRadius:"12px"});
      const gmHdr=mk("div",{display:"flex",alignItems:"center",justifyContent:"space-between",padding:"12px 14px",borderBottom:"1px solid "+C.border});
      const gmTitle=tx(mk("div",{fontSize:"12px",fontWeight:"800",letterSpacing:".04em",color:LIME}),"Gallery");
      const gmBtns=mk("div",{display:"flex",gap:"8px",alignItems:"center"});
      const gmFav=mk("button",{fontSize:"10px",fontWeight:"700",background:C.bg2,border:"1px solid "+C.border,borderRadius:"6px",color:C.muted,cursor:"pointer",padding:"5px 11px",display:"flex",alignItems:"center",gap:"5px"});
      const _gmFavIco=_mkHeart("12px"); gmFav.append(_gmFavIco,tx(mk("span"),"Favorites"));
      const gmRefresh=tx(mk("button",{fontSize:"10px",fontWeight:"700",background:C.bg2,border:"1px solid "+C.border,borderRadius:"6px",color:LIME,cursor:"pointer",padding:"5px 11px"}),"↻ refresh");
      const gmClose=tx(mk("button",{fontSize:"12px",fontWeight:"800",background:C.bg2,border:"1px solid "+C.border,borderRadius:"6px",color:C.text,cursor:"pointer",padding:"4px 12px"}),"✕ close");
      const _styleGmFav=()=>{ gmFav.style.color=_favOnly?LIME:C.muted; gmFav.style.borderColor=_favOnly?LIME:C.border; gmFav.style.background=_favOnly?"rgba(240,255,65,.12)":C.bg2; };
      gmFav.onclick=()=>{ _favOnly=!_favOnly; _styleGmFav(); renderGalleryModal(); };
      gmRefresh.onclick=()=>_loadGallery();
      gmClose.onclick=()=>{ _galSelectCb=null; galModal.style.display="none"; };
      gmBtns.append(gmFav,gmRefresh,gmClose); gmHdr.append(gmTitle,gmBtns);
      const gmGrid=mk("div",{flex:"1",overflowY:"auto",padding:"12px",display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(180px,1fr))",gap:"10px",alignContent:"start"},{className:"mmh3-scroll"});
      galModal.append(gmHdr,gmGrid);
      root.appendChild(galModal);

      // ══ gallery detail lightbox (settings · player · restore · favorite) ══════
      const lb=mk("div",{position:"absolute",inset:"0",background:"#0a0a0a",zIndex:"60",display:"none",flexDirection:"column",borderRadius:"12px",boxSizing:"border-box"});
      const lbTop=mk("div",{display:"flex",alignItems:"center",gap:"8px",padding:"10px 12px 6px",flexShrink:"0"});
      const lbName=mk("div",{flex:"1",fontSize:"11px",color:C.muted,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"});
      const lbCloseBtn=tx(mk("button",{background:"transparent",border:"1px solid #e05555",borderRadius:"6px",padding:"3px 12px",fontSize:"11px",color:"#e05555",cursor:"pointer",outline:"none"}),"✕");
      lbTop.append(lbName,lbCloseBtn);
      const lbBody=mk("div",{display:"flex",alignItems:"center",flex:"1",minHeight:"0",gap:"8px",padding:"0 8px"});
      const _lbArrow=(t)=>{ const b=tx(mk("button",{background:"rgba(255,255,255,.08)",border:"none",borderRadius:"6px",width:"38px",flexShrink:"0",alignSelf:"stretch",cursor:"pointer",fontSize:"20px",color:C.text,outline:"none"}),t); b.onmouseenter=()=>b.style.background="rgba(255,255,255,.16)"; b.onmouseleave=()=>b.style.background="rgba(255,255,255,.08)"; return b; };
      const lbPrev=_lbArrow("‹"), lbNext=_lbArrow("›");
      const lbVidWrap=mk("div",{flex:"1",minWidth:"0",display:"flex",alignItems:"center",justifyContent:"center",height:"100%",minHeight:"0"});
      const lbVid=mk("video",{maxWidth:"100%",maxHeight:"100%",borderRadius:"8px",background:"#000",display:"block"},{controls:true,loop:true,preload:"metadata"});
      lbVidWrap.appendChild(lbVid);
      lbBody.append(lbPrev,lbVidWrap,lbNext);
      // meta panel
      const lbMeta=mk("div",{flexShrink:"0",margin:"6px 8px",background:"linear-gradient(180deg,rgba(240,255,65,.07),rgba(240,255,65,.02))",border:"1px solid rgba(240,255,65,.2)",borderRadius:"10px",padding:"9px 12px",display:"none",flexDirection:"column",gap:"7px",maxHeight:"48%",overflowY:"auto"},{className:"mmh3-scroll"});
      const lbPromptWrap=mk("div",{display:"flex",flexDirection:"column",gap:"3px"});
      lbPromptWrap.appendChild(tx(mk("div",{fontSize:"8px",color:C.muted,fontWeight:"700",letterSpacing:".08em",textTransform:"uppercase"}),"Prompt"));
      const lbPrompt=mk("div",{fontSize:"10px",color:C.text,lineHeight:"1.5",maxHeight:"66px",overflowY:"auto",whiteSpace:"pre-wrap"},{className:"mmh3-scroll"});
      lbPromptWrap.appendChild(lbPrompt);
      const lbChips=mk("div",{display:"flex",gap:"6px",flexWrap:"wrap"});
      const lbRefs=mk("div",{display:"none",gap:"6px",flexWrap:"wrap",alignItems:"flex-end"});
      const lbActions=mk("div",{display:"flex",gap:"6px",alignItems:"stretch",flexWrap:"wrap",marginTop:"1px"});
      const lbRestore=tx(mk("button",{background:LIME,color:"#111",border:"none",borderRadius:"6px",padding:"6px 14px",fontSize:"11px",fontWeight:"800",cursor:"pointer",outline:"none",display:"none",alignItems:"center",whiteSpace:"nowrap"}),"Load settings into UI");
      lbRestore.onmouseenter=()=>lbRestore.style.opacity=".85"; lbRestore.onmouseleave=()=>lbRestore.style.opacity="1";
      const lbFav=mk("button",{background:"rgba(20,20,30,.85)",border:"1px solid rgba(240,255,65,.25)",borderRadius:"6px",width:"38px",flexShrink:"0",cursor:"pointer",outline:"none",display:"flex",alignItems:"center",justifyContent:"center",color:"rgba(240,255,65,.4)"});
      lbFav.title="Favorite (♥)"; lbFav.appendChild(_mkHeart("15px"));
      const lbFolder=tx(mk("button",{background:"transparent",border:"1px solid "+C.border,borderRadius:"6px",padding:"6px 11px",fontSize:"10px",color:C.muted,cursor:"pointer",outline:"none",whiteSpace:"nowrap"}),"📁 Show in folder");
      lbFolder.onmouseenter=()=>{lbFolder.style.borderColor=C.text;lbFolder.style.color=C.text;}; lbFolder.onmouseleave=()=>{lbFolder.style.borderColor=C.border;lbFolder.style.color=C.muted;};
      const lbDel=tx(mk("button",{background:"rgba(160,25,25,.6)",border:"1px solid rgba(255,80,80,.3)",borderRadius:"6px",padding:"6px 11px",fontSize:"10px",fontWeight:"700",color:"rgba(255,190,190,.95)",cursor:"pointer",outline:"none",whiteSpace:"nowrap",marginLeft:"auto"}),"🗑 Delete");
      // Delete failures used to be console-only, which made Windows file locks or
      // a missing/stale gallery path look like the button simply did nothing.
      const lbDeleteNote=mk("div",{display:"none",flexBasis:"100%",fontSize:"9px",lineHeight:"1.4",padding:"5px 7px",borderRadius:"5px"});
      lbActions.append(lbRestore,lbFav,lbFolder,lbDel,lbDeleteNote);
      lbMeta.append(lbPromptWrap,lbChips,lbRefs,lbActions);
      const lbBottom=mk("div",{display:"flex",justifyContent:"center",alignItems:"center",padding:"4px 10px 8px",flexShrink:"0"});
      const lbCounter=mk("div",{fontSize:"10px",color:C.muted}); lbBottom.appendChild(lbCounter);
      lb.append(lbTop,lbBody,lbMeta,lbBottom);
      root.appendChild(lb);

      // small labelled chip + tag helpers for the meta panel
      const _lbChip=(label,val)=>{ const c=mk("div",{display:"flex",flexDirection:"column",gap:"1px",background:C.bg3,borderRadius:"5px",padding:"4px 8px",minWidth:"42px"}); c.append(tx(mk("div",{fontSize:"7.5px",color:C.muted,fontWeight:"700",letterSpacing:".06em",textTransform:"uppercase"}),label),tx(mk("div",{fontSize:"10px",color:C.text,fontWeight:"600"}),val==null||val===""?"—":String(val))); return c; };
      const _lbTag=(t,col)=>tx(mk("span",{fontSize:"9px",color:col||C.muted,background:C.bg3,borderRadius:"4px",padding:"3px 7px",border:"1px solid "+C.border,whiteSpace:"nowrap",alignSelf:"center"}),t);
      const _lbRefThumb=(name,type,label)=>{ const wrap=mk("div",{display:"flex",flexDirection:"column",alignItems:"center",gap:"2px"}); const url="/view?filename="+encodeURIComponent(name)+"&type=input"; let el;
        if(type==="video"){ el=mk("video",{width:"48px",height:"48px",objectFit:"cover",borderRadius:"5px",border:"1px solid "+C.border,background:"#000"},{src:url+"#t=0.1",muted:true,preload:"metadata"}); _thumbFrame(el); }
        else { el=mk("img",{width:"48px",height:"48px",objectFit:"cover",borderRadius:"5px",border:"1px solid "+C.border,background:"#000"},{src:url}); }
        el.title=name; wrap.append(el,tx(mk("div",{fontSize:"7.5px",color:C.muted}),label)); return wrap; };

      // ── gallery data + rendering ──
      const _galItems=[];       // {filename,subfolder,type,mtime,favorite,has_meta}
      const _galMetaCache={};   // filename -> meta object (or null when none saved)
      const _galKey=(it)=>String((it&&it.subfolder)||"")+"|"+String((it&&it.filename)||"");
      let _favOnly=false;       // modal filter: show only favorited clips
      let _galSelectCb=null;    // when set, clicking a modal item selects it instead of opening details
      function _viewUrl(it){ const sub=it.subfolder?`&subfolder=${encodeURIComponent(it.subfolder)}`:""; return `/view?filename=${encodeURIComponent(it.filename)}&type=${encodeURIComponent(it.type||"output")}${sub}`; }
      // force a still frame for the thumbnail (preload=metadata alone paints black in most
      // browsers) by seeking a touch into the clip once it has data.
      function _thumbFrame(v){ v.addEventListener("loadeddata",()=>{ try{ if(v.currentTime<0.05)v.currentTime=0.12; }catch(e){} },{once:true}); }
      const _playInPreview=(it)=>{ _showVideoUrl(_viewUrl(it)+"&rand="+Math.random(), it.filename); };
      const _fetchMeta=async(it,force)=>{ const k=it.filename; if(!force&&_galMetaCache[k]!==undefined)return _galMetaCache[k];
        try{ const r=await api.fetchApi("/minimaxh3/meta?filename="+encodeURIComponent(it.filename)+"&subfolder="+encodeURIComponent(it.subfolder||"")); const d=await r.json(); _galMetaCache[k]=d.ok?d.meta:null; if(d&&typeof d.favorite==="boolean")it.favorite=d.favorite; }
        catch(e){ _galMetaCache[k]=null; } return _galMetaCache[k]; };

      // small favorite-heart badge for a thumbnail cell
      const _favBadge=()=>{ const b=mk("div",{position:"absolute",top:"4px",right:"4px",color:LIME,filter:"drop-shadow(0 1px 2px rgba(0,0,0,.9))",pointerEvents:"none"}); b.appendChild(_mkHeart("13px")); return b; };

      const renderGallery=()=>{
        galTitle.textContent="Gallery · "+(_galItems.length?_galItems.length+" render"+(_galItems.length>1?"s":""):"recent renders");
        galStrip.innerHTML="";
        if(!_galItems.length){ galEmpty.style.display="block"; return; }
        galEmpty.style.display="none";
        // quick strip = the 30 most recent (scrolls horizontally); "view all" shows the rest
        _galItems.slice(0,30).forEach((it,i)=>{
          const cell=mk("div",{position:"relative",flex:"0 0 auto",width:"108px",height:"62px",borderRadius:"6px",overflow:"hidden",border:"1px solid "+C.border,cursor:"pointer",background:"#000"});
          const v=mk("video",{width:"100%",height:"100%",objectFit:"cover",pointerEvents:"none"},{src:_viewUrl(it)+"#t=0.12",muted:true,preload:"metadata"});
          _thumbFrame(v);
          const info=tx(mk("div",{position:"absolute",inset:"0",display:"flex",alignItems:"center",justifyContent:"center",fontSize:"15px",color:"rgba(255,255,255,.85)",textShadow:"0 0 4px #000"}),"ⓘ");
          cell.append(v,info); if(it.favorite)cell.appendChild(_favBadge()); cell.title=it.filename;
          cell.onclick=()=>_lbShow(it,i,_galItems);
          galStrip.appendChild(cell);
        });
        if(galModal.style.display!=="none") renderGalleryModal();
      };
      const renderGalleryModal=()=>{
        const selecting=!!_galSelectCb;
        const list=(!selecting&&_favOnly)?_galItems.filter(it=>it.favorite):_galItems;
        gmTitle.textContent=(selecting?("Pick a video to "+(S.mode==="repair"?"repair":"upscale")+" — "):(_favOnly?"Favorites — ":"Gallery — "))+list.length+" render"+(list.length===1?"":"s");
        gmGrid.innerHTML="";
        if(!list.length){ gmGrid.appendChild(tx(mk("div",{color:C.muted,fontSize:"11px"}),_favOnly&&!selecting?"No favorites yet — open a clip and tap the ♥.":"No renders yet.")); return; }
        list.forEach((it,i)=>{
          const cell=mk("div",{display:"flex",flexDirection:"column",gap:"3px",cursor:"pointer"});
          const thumbWrap=mk("div",{position:"relative",width:"100%",aspectRatio:"16/9",borderRadius:"7px",overflow:"hidden",border:"1px solid "+C.border,background:"#000"});
          const v=mk("video",{width:"100%",height:"100%",objectFit:"cover"},{src:_viewUrl(it)+"#t=0.12",muted:true,preload:"metadata",controls:false});
          _thumbFrame(v);
          const info=tx(mk("div",{position:"absolute",inset:"0",display:"flex",alignItems:"center",justifyContent:"center",fontSize:"22px",color:selecting?LIME:"rgba(255,255,255,.9)",textShadow:"0 0 5px #000",pointerEvents:"none"}),selecting?"＋":"ⓘ");
          thumbWrap.append(v,info); if(it.favorite)thumbWrap.appendChild(_favBadge());
          const name=tx(mk("div",{fontSize:"9px",color:C.muted,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}),it.filename);
          cell.append(thumbWrap,name);
          cell.title=selecting?"Click to pick for upscaling":"Click to open details";
          cell.onclick=()=>{ if(_galSelectCb){ const cb=_galSelectCb; _galSelectCb=null; galModal.style.display="none"; cb(it); } else { _lbShow(it,i,list); } };
          gmGrid.appendChild(cell);
        });
      };
      const openGalleryModal=(selectCb)=>{ _galSelectCb=selectCb||null; if(selectCb)_favOnly=false; _styleGmFav(); galModal.style.display="flex"; renderGalleryModal(); _loadGallery(); };
      const _galAdd=(it)=>{ if(!it||!it.filename)return; const k=(x)=>x.filename+"|"+(x.subfolder||""); const key=k(it);
        for(let i=_galItems.length-1;i>=0;i--) if(k(_galItems[i])===key) _galItems.splice(i,1);
        _galItems.unshift(it); renderGallery(); };
      const _loadGallery=()=>api.fetchApi("/minimaxh3/outputs").then(r=>r.json()).then(d=>{
        _galItems.length=0; (d.videos||[]).forEach(v=>_galItems.push(v)); renderGallery();
        // Reliable settings-save: the `executed` event that carries the finished clip is flaky in
        // this frontend (completion is really detected by the queue poll → _finishActive → here),
        // so if a just-finished generation left its settings snapshot unsaved, attach it to the
        // newest clip now. Guarded by !S.generating so a manual refresh mid-run can't mis-tag the
        // previous clip; _activeShowVideo clears _pendingMeta first when its event DID fire.
        if(S._pendingMeta && !S.generating && _galItems.length){
          const it=_galItems[0], meta=S._pendingMeta; S._pendingMeta=null;
          _galMetaCache[it.filename]=meta; it.has_meta=true; renderGallery();
          api.fetchApi("/minimaxh3/save_meta",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({filename:it.filename,subfolder:it.subfolder||"",meta})}).catch(e=>console.warn("[MMH3] save_meta:",e));
        }
      }).catch(()=>{});
      _activeRefreshGallery=_loadGallery;   // completion handlers pull the newest render in

      // ── lightbox behaviour ────────────────────────────────────────────────
      let _lbList=[], _lbIdx=0, _lbItem=null, _lbFavOn=false;
      const _lbIsOpen=()=>lb.style.display==="flex";
      const _lbClose=()=>{ try{lbVid.pause();}catch(_e){} lb.style.display="none"; _lbItem=null; };
      const _setDeleteNote=(message,ok)=>{
        if(!message){ lbDeleteNote.style.display="none"; lbDeleteNote.textContent=""; return; }
        lbDeleteNote.style.display="block"; lbDeleteNote.textContent=message;
        lbDeleteNote.style.color=ok?"#9ee4b6":"#ffb0a0";
        lbDeleteNote.style.background=ok?"rgba(80,190,125,.08)":"rgba(255,95,75,.10)";
        lbDeleteNote.style.border="1px solid "+(ok?"rgba(80,190,125,.24)":"rgba(255,95,75,.28)");
      };
      lbCloseBtn.onclick=_lbClose;
      const _setLbFav=(on)=>{ _lbFavOn=on; lbFav.style.color=on?LIME:"rgba(240,255,65,.4)"; lbFav.style.borderColor=on?LIME:"rgba(240,255,65,.25)"; lbFav.style.background=on?"rgba(240,255,65,.15)":"rgba(20,20,30,.85)";
        lb.style.background=on?"linear-gradient(180deg,rgba(240,255,65,.12) 0%,rgba(240,255,65,.03) 42%,#0a0a0a 100%)":"#0a0a0a"; };
      const _renderMeta=(m)=>{
        lbPrompt.textContent=m.prompt||"(no prompt saved)";
        lbChips.innerHTML=""; lbRefs.innerHTML="";
        const modeLbl=({t2v:"T2V",i2v:"I2V",r2v:"R2V",studio:"H3 Studio",upscale:"Upscale",repair:"Repair"})[m.mode]||(m.mode||"").toUpperCase();
        lbChips.appendChild(_lbChip("Mode",modeLbl));
        if(m.mode==="upscale"){
          lbChips.appendChild(_lbChip("Engine",({model:"ESRGAN",seedvr2:"SeedVR2",flashvsr:"FlashVSR",rtxvsr:"RTX VSR"})[m.upEngine]||m.upEngine));
          if(m.upScale)lbChips.appendChild(_lbChip("Target",String(m.upScale)+(m.upEngine==="seedvr2"?"p":"×")));
          if(m.upModel)lbChips.appendChild(_lbChip("Model",String(m.upModel).split("/").pop().replace(/\.(safetensors|pth|gguf)$/i,"")));
          if(m.sourceName)lbChips.appendChild(_lbChip("Source",String(m.sourceName)));
          lbRefs.style.display="none"; return;
        }
        if(m.w&&m.h)lbChips.appendChild(_lbChip("Size",m.w+"×"+m.h));
        if(m.duration!=null)lbChips.appendChild(_lbChip("Length",(+m.duration).toFixed((+m.duration)%1?1:0)+"s"));
        if(m.seed!=null)lbChips.appendChild(_lbChip("Seed",m.seed));
        const pdd=!!m.pddOn, steps=pdd?(m.pddNfe||8):(m.turboOn?(m.turboSteps||6):(m.steps||20));
        lbChips.appendChild(_lbChip("Steps",steps+(pdd?" ⚡ PDD":(m.turboOn?" ⚡":""))));
        lbChips.appendChild(_lbChip("Sampler",pdd?"PDD Euler":(m.turboOn?"Turbo":(m.sampler||"—"))));
        if(m.scheduler)lbChips.appendChild(_lbChip("Sched",m.scheduler));
        if(m.turboOn&&m.turboLora)lbChips.appendChild(_lbTag("Turbo: "+String(m.turboLora).split("/").pop().replace(/\.safetensors$/i,""),"#ff8fbf"));
        if(pdd&&m.pddFile)lbChips.appendChild(_lbTag("PDD: "+String(m.pddFile).split("/").pop().replace(/\.safetensors$/i,""),"#ffd18a"));
        if(m.sigmaShiftOn)lbChips.appendChild(_lbTag("σ "+(m.shiftVideo??12)+"/"+(m.shiftAudio??3)));
        if(m.sageAttn)lbChips.appendChild(_lbTag("Sage","#8fd8ff"));
        if(m.solAttn)lbChips.appendChild(_lbTag("Sol-Attn","#b9a8ff"));
        if(m.fastFp8)lbChips.appendChild(_lbTag("FP8-fast","#8fd8ff"));
        if(m.cacheEngine&&m.cacheEngine!=="off")lbChips.appendChild(_lbTag("Cache: "+(({teacache:"TeaCache",spectrum:"Spectrum",fbc:"FBC",easycache:"EasyCache"})[m.cacheEngine]||m.cacheEngine),"#7fd0a0"));
        if(m.twoPass)lbChips.appendChild(_lbTag("2-pass HD","#7fd0a0"));
        // reference thumbnails (input files that fed the generation)
        let hasRef=false;
        if(m.mode==="i2v" || (m.mode==="studio"&&m.studioMode==="fl2va")){
          if(m.firstFrame){ lbRefs.appendChild(_lbRefThumb(m.firstFrame,"image","First")); hasRef=true; }
          if(m.lastFrame){ lbRefs.appendChild(_lbRefThumb(m.lastFrame,"image","Last")); hasRef=true; }
        } else if(m.mode==="r2v" || (m.mode==="studio"&&m.studioMode==="ref2va")){
          (m.refImages||[]).forEach((n,i)=>{ if(n){ lbRefs.appendChild(_lbRefThumb(n,"image","P"+(i+1))); hasRef=true; } });
          (m.refVideos||[]).forEach((v,i)=>{ if(v&&v.file){ lbRefs.appendChild(_lbRefThumb(v.file,"video","V"+(i+1))); hasRef=true; } });
          (m.refAudios||[]).forEach((a,i)=>{ if(a){ lbRefs.appendChild(_lbTag("🔊 Audio "+(i+1))); hasRef=true; } });
        }
        lbRefs.style.display=hasRef?"flex":"none";
      };
      const _lbShow=async(it,idx,list)=>{
        _lbItem=it; if(list)_lbList=list; _lbIdx=(idx==null?_lbList.indexOf(it):idx); if(_lbIdx<0)_lbIdx=0;
        tx(lbName,it.filename);
        try{ lbVid.pause(); }catch(_e){}
        lbVid.src=_viewUrl(it); try{ lbVid.load(); lbVid.play().catch(()=>{}); }catch(_e){}
        lb.style.display="flex";
        const total=_lbList.length||1;
        tx(lbCounter,(_lbIdx+1)+" / "+total);
        lbPrev.style.opacity=_lbIdx>0?"1":".25"; lbNext.style.opacity=_lbIdx<total-1?"1":".25";
        lbChips.innerHTML=""; lbRefs.innerHTML=""; lbRefs.style.display="none"; lbPrompt.textContent="Loading settings…";
        lbMeta.style.display="flex"; lbRestore.style.display="none"; lbDel._armed=null; lbDel.textContent="🗑 Delete"; _setDeleteNote("");
        _setLbFav(it.favorite===true);
        const meta=await _fetchMeta(it);
        if(_lbItem!==it) return;   // user navigated away while the fetch was in flight
        _setLbFav(it.favorite===true||(meta&&meta.favorite===true));
        if(!meta){ lbPrompt.textContent="⚠ No saved settings for this clip — it was rendered before the gallery upgrade (or imported). Newer generations store their full settings here."; lbChips.innerHTML=""; return; }
        _renderMeta(meta);
        lbRestore.style.display="flex"; lbRestore.onclick=()=>_applyMeta(meta);
      };
      const _lbNav=(delta)=>{ if(!_lbList.length)return; const ni=Math.max(0,Math.min(_lbList.length-1,_lbIdx+delta)); if(ni===_lbIdx)return; _lbShow(_lbList[ni],ni,_lbList); };
      lbPrev.onclick=()=>_lbNav(-1); lbNext.onclick=()=>_lbNav(1);
      lbFav.onclick=async()=>{ const it=_lbItem; if(!it)return; const nf=!_lbFavOn;
        try{ const r=await api.fetchApi("/minimaxh3/update_meta",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({filename:it.filename,subfolder:it.subfolder||"",patch:{favorite:nf}})}); const d=await r.json();
          if(d.ok){ it.favorite=nf; if(_galMetaCache[it.filename])_galMetaCache[it.filename].favorite=nf; _setLbFav(nf); renderGallery(); if(galModal.style.display!=="none")renderGalleryModal(); }
        }catch(e){ console.warn("[MMH3] fav:",e); } };
      lbFolder.onclick=()=>{ const it=_lbItem; if(!it)return; api.fetchApi("/minimaxh3/open_folder",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({filename:it.filename,subfolder:it.subfolder||""})}).catch(()=>{}); };
      lbDel.onclick=async()=>{ const it=_lbItem; if(!it)return;
        if(lbDel._armed!==it){ lbDel._armed=it; lbDel.textContent="Click again to delete"; setTimeout(()=>{ if(lbDel._armed===it){ lbDel._armed=null; lbDel.textContent="🗑 Delete"; } },2600); return; }
        lbDel._armed=null; lbDel.textContent="🗑 Delete";
        try{
          // Release the active preview before asking Windows to remove the source.
          // This avoids a needless sharing violation on files still being streamed.
          try{ lbVid.pause(); lbVid.removeAttribute("src"); lbVid.load(); }catch(_e){}
          const r=await api.fetchApi("/minimaxh3/delete",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({filename:it.filename,subfolder:it.subfolder||""})});
          let d={}; try{ d=await r.json(); }catch(_e){}
          if(!r.ok||!d||d.ok!==true)throw new Error((d&&d.error)||("delete request failed (HTTP "+r.status+")"));
          const key=_galKey(it);
          for(let i=_galItems.length-1;i>=0;i--)if(_galKey(_galItems[i])===key)_galItems.splice(i,1);
          delete _galMetaCache[it.filename];
          const li=_lbList.indexOf(it); if(li>=0)_lbList.splice(li,1);
          renderGallery(); if(galModal.style.display!=="none")renderGalleryModal();
          if(!_lbList.length)_lbClose(); else { const ni=Math.min(_lbIdx,_lbList.length-1); _lbShow(_lbList[ni],ni,_lbList); }
          _loadGallery(); // authoritative refresh: the server confirms the file is really gone
        }catch(e){ console.warn("[MMH3] delete:",e); _setDeleteNote("Could not delete this clip: "+fmtErr(e),false); } };
      // lightbox keys (capture so ComfyUI's canvas doesn't swallow them)
      document.addEventListener("keydown",(e)=>{
        if(!_lbIsOpen())return;
        if(e.key==="Escape"){ e.preventDefault(); e.stopPropagation(); _lbClose(); }
        else if(e.key==="ArrowLeft"){ e.preventDefault(); e.stopPropagation(); _lbNav(-1); }
        else if(e.key==="ArrowRight"){ e.preventDefault(); e.stopPropagation(); _lbNav(1); }
        else if(e.key==="f"||e.key==="F"){ e.preventDefault(); e.stopPropagation(); try{ if(!document.fullscreenElement)lbVid.requestFullscreen&&lbVid.requestFullscreen().catch(()=>{}); else document.exitFullscreen().catch(()=>{}); }catch(_e){} }
      },{capture:true});

      // ── "Load settings into UI" — restore a saved generation's settings ───────
      const _applyMeta=(m)=>{
        _lbClose(); _galSelectCb=null; galModal.style.display="none";
        try{
          if(m.mode==="upscale"){
            setMode("upscale");
            if(m.upEngine)setUpEngine(m.upEngine);
            if(m.upEngine==="model"){
              if(m.upScale&&[2,3,4].indexOf(+m.upScale)>=0){ S.upscaleScale=+m.upScale; _upScalePills.forEach((pp,i)=>pp._set([2,3,4][i]===+m.upScale)); }
              if(m.upModel){ S.upscaleModel=m.upModel; try{upModDD.set(m.upModel);}catch(_e){} }
            }
            persist(); return;
          }
          const mode=(m.mode==="i2v"||m.mode==="r2v"||m.mode==="studio")?m.mode:"t2v";
          // Set the native CGlide Studio sub-mode before switching panels: it decides
          // whether Studio exposes first/last inputs or its reference/audio slots.
          if(mode==="studio" && (m.studioMode==="fl2va"||m.studioMode==="ref2va"))S.studioMode=m.studioMode;
          setMode(mode);
          if(m.prompt!=null){ S.prompt=m.prompt; posTA.value=m.prompt; }
          if(m.aspect&&ASPECT_KEYS.indexOf(m.aspect)>=0){ S.aspect=m.aspect; aspectSel.set(m.aspect); }
          if(m.megapixels!=null){ S.megapixels=m.megapixels; mpVal.set(m.megapixels); mpSlider.set(m.megapixels); }
          updateRes();
          if(m.duration!=null){ S.duration=m.duration; durVal.set(m.duration); durSlider.set(m.duration); updateDur(); }
          // sampler/scheduler/steps AFTER setMode (setMode nudges the r2v scheduler default)
          if(m.steps!=null){ S.steps=m.steps; stepsIn.set(m.steps); }
          if(m.sampler){ S.sampler=m.sampler; samplerDD.set(m.sampler); }
          if(m.scheduler){ S.scheduler=m.scheduler; schedDD.set(m.scheduler); }
          // seed — restore the exact seed used + turn randomize OFF so it reproduces
          if(m.seed!=null){ S.seed=m.seed; S.randomizeSeed=false; seedIn.set(m.seed); seedTgl._set(false); seedIn._inp.style.opacity="1"; }
          // sigma shift
          S.sigmaShiftOn=!!m.sigmaShiftOn; shiftTgl._set(S.sigmaShiftOn); shiftRows.style.display=S.sigmaShiftOn?"flex":"none";
          if(m.shiftVideo!=null){ S.shiftVideo=m.shiftVideo; shVid.set(m.shiftVideo); }
          if(m.shiftAudio!=null){ S.shiftAudio=m.shiftAudio; shAud.set(m.shiftAudio); }
          // turbo / PDD acceleration
          S.turboOn=!!m.turboOn; if(m.turboSteps!=null){ S.turboSteps=m.turboSteps; turboStepsIn.set(m.turboSteps); }
          if(m.turboLora){ S.turboLora=m.turboLora; try{turboLoraDD.set(m.turboLora);}catch(_e){} }
          if(m.turboStrength!=null)S.turboStrength=m.turboStrength;
          S.pddOn=!!m.pddOn; if(m.pddNfe!=null&&["8","6","4"].includes(String(m.pddNfe)))S.pddNfe=String(m.pddNfe);
          if(m.pddFile){ if(mode==="r2v"||(mode==="studio"&&S.studioMode==="ref2va"))S.pddRefFile=m.pddFile; else S.pddFlFile=m.pddFile; }
          if(S.pddOn){ S.turboOn=false; S.lxTurbo="off"; S.cacheEngine="off"; try{updatePDDUI();}catch(_e){} }
          // speed toggles (updateSpeedNotes re-syncs the switches + turbo rows)
          S.sageAttn=!!m.sageAttn; S.solAttn=!!m.solAttn; S.fastFp8=!!m.fastFp8;
          try{updatePDDUI();}catch(_e){} updateSpeedNotes();
          if(m.cacheEngine){ setCacheEngine(m.cacheEngine); }
          // two-pass HD
          if(m.twoPass!=null){ S.twoPass=!!m.twoPass; tpTgl._set(S.twoPass); tpBody.style.display=S.twoPass?"block":"none"; }
          if(m.twoPassEngine==="pixel"||m.twoPassEngine==="latent"){ S.twoPassEngine=m.twoPassEngine; }
          if(m.latentUpModel){ S.latentUpModel=m.latentUpModel; try{tpLatModelDD.set(m.latentUpModel);}catch(_e){} }
          if(m.twoPassWindowed!=null){ S.twoPassWindowed=!!m.twoPassWindowed; }
          if(m.twoPassWindowProfile==="safe"||m.twoPassWindowProfile==="balanced"){ S.twoPassWindowProfile=m.twoPassWindowProfile; }
          if(m.stage1Mp!=null){ S.stage1Mp=m.stage1Mp; tpS1.set(m.stage1Mp); }
          if(m.stage2Mp!=null){ S.stage2Mp=m.stage2Mp; }
          if(m.stage2MpOverride!=null){ S.stage2MpOverride=!!m.stage2MpOverride; }
          if(m.stage2Steps!=null){ S.stage2Steps=m.stage2Steps; tpSteps.set(m.stage2Steps); }
          if(m.stage2Denoise!=null){ S.stage2Denoise=m.stage2Denoise; tpDen.set(m.stage2Denoise); }
          updateTwoPassUI();
          // reference inputs
          if(mode==="i2v" || (mode==="studio"&&S.studioMode==="fl2va")){
            S.firstFrame=m.firstFrame||null; S.useLastFrame=!!m.useLastFrame; S.lastFrame=(m.useLastFrame?m.lastFrame:null)||null;
            if(S.firstFrame)firstSlot.setName(S.firstFrame); else firstSlot.clear();
            flfTgl._set(S.useLastFrame); lastWrap.style.display=S.useLastFrame?"block":"none";
            if(S.lastFrame)lastSlot.setName(S.lastFrame); else lastSlot.clear();
          } else if(mode==="r2v" || (mode==="studio"&&S.studioMode==="ref2va")){
            S.allow9=!!m.allow9; allow9Tgl._set(S.allow9);
            S.refImages=(m.refImages||[]).slice(); while(S.refImages.length<MAX_REF_IMAGES)S.refImages.push(null);
            S.refVideos=(m.refVideos||[]).map(v=>({file:(v&&v.file)||null,useAudio:v?!!v.useAudio:true,start:(v&&+v.start)||0,end:(v&&+v.end)||0})); while(S.refVideos.length<MAX_REF_VIDEOS)S.refVideos.push({file:null,useAudio:true,start:0,end:0});
            S.refAudios=(m.refAudios||[]).slice(); while(S.refAudios.length<MAX_REF_AUDIOS)S.refAudios.push(null);
            S.refAudioTrim=(m.refAudioTrim||[]).map(t=>({start:(t&&+t.start)||0,end:(t&&+t.end)||0})); while(S.refAudioTrim.length<MAX_REF_AUDIOS)S.refAudioTrim.push({start:0,end:0});
            if(m.refImageSize){ S.refImageSize=m.refImageSize; try{risSel.set(m.refImageSize);}catch(_e){} }
            renderRefImages(); warnRefImages(); renderRefVideos(); renderRefAudios(); rebuildTagRow();
          }
          if(mode==="studio"){
            S.studioContinue=m.studioContinue||null;
            S.studioContinueFrames=m.studioContinueFrames===39?39:22;
            S.studioContinueAudio=m.studioContinueAudio!==false;
            S.studioContinueFlatten=Math.max(0,Math.min(1,+m.studioContinueFlatten||0));
            S.studioSeamMode=["early_cut","early_scurve","hard_cut"].includes(m.studioSeamMode)?m.studioSeamMode:"early_cut";
            S.studioSeamBlend=Math.max(1,Math.min(12,+m.studioSeamBlend||6));
            if(S.studioContinue)studioContFile.setName(S.studioContinue); else studioContFile.clear();
            studioContFramesDD.set(S.studioContinueFrames===39?"39 frames · ~1.6s":"22 frames · ~0.9s");
            studioContAudioTgl._set(S.studioContinueAudio); studioFlat.set(S.studioContinueFlatten);
            studioSeamPills.forEach((p,i)=>p._set(_studioSeamDefs[i][0]===S.studioSeamMode));
            refreshStudioContinue(); refreshStudioUI(); rebuildStudioTagRow();
          }
          persist();
        }catch(err){ console.warn("[MMH3] applyMeta:",err); }
      };

      // ── reactive: mode switch ─────────────────────────────────────────────
      // generation-only left sections — hidden in Upscale mode (which reuses the shared
      // preview / progress / gallery on the right but has its own inputs).
      const _genSections=[promptHdr,modeHint,posTA,vidWrap,sampWrap,advWrap,modWrap,dl];
      function setMode(m){
        // A normal tab always wins over the optional CREATE workspace.  This keeps
        // the two surfaces independent even when a user changes modes mid-draft.
        try{closeCreativeStudio();}catch(_e){}
        S.mode=m;
        pillT2V._set(m==="t2v"); pillI2V._set(m==="i2v"); pillR2V._set(m==="r2v"); pillStudio._set(m==="studio"); pillUp._set(m==="upscale"); pillRepair._set(m==="repair"); pillDir._set(m==="director");
        const isUp=(m==="upscale"), isRepair=(m==="repair"), isDir=(m==="director"), isStudio=(m==="studio"), studioRef=isStudio&&S.studioMode==="ref2va";
        _genSections.forEach(el=>{ if(el) el.style.display=(isUp||isRepair||isDir)?"none":""; });
        ivPanel.style.display=(m==="i2v"||(isStudio&&!studioRef))?"block":"none";
        r2vPanel.style.display=(m==="r2v"||studioRef)?"block":"none";
        studioPanel.style.display=isStudio?"block":"none";
        upPanel.style.display=isUp?"block":"none";
        repairPanel.style.display=isRepair?"block":"none";
        dirPanel.style.display=isDir?"block":"none";
        tagRow.style.display=(m==="r2v")?"flex":"none";
        studioTagRow.style.display=isStudio?"flex":"none";
        genBtn.textContent=isDir?"🎬 Assemble master":(isUp?"▶ Upscale video":(isRepair?"🩹 Repair masked area":(isStudio?"🎞 Render Studio clip":"▶ Generate")));
        if(isDir){ try{renderDirList(); refreshDirAudio();}catch(_e){} persist(); return; }
        if(isUp){ setUpEngine(S.upscaleEngine); refreshUpSource(); _loadModels(); updateModStatus(); updateTwoPassUI(); try{probeFinishSource();detectFinishSource();refreshFinishUI();}catch(_e){} persist(); return; }
        if(isRepair){ refreshRepairSource(); updateRepairUI(); _loadModels(); persist(); return; }
        // scheduler default per mode (beta for reference-heavy, simple otherwise)
        const refMode=(m==="r2v"||studioRef);
        if(refMode&&S.scheduler==="simple"){ S.scheduler="beta"; schedDD.set("beta"); }
        else if(!refMode&&S.scheduler==="beta"){ S.scheduler="simple"; schedDD.set("simple"); }
        schedHint.textContent=refMode?"Reference-heavy H3 modes work best with beta or normal (simple can wash out identity)."
                                         :"simple is the tuned default for T2V / I2V.";
        modeHint.textContent =(m==="t2v")?"Text → video + audio. Describe the shots, camera and sound; the model writes the picture and the soundtrack together."
                             :(m==="i2v")?"Animate a still (first frame), or bridge from a first to a last frame. Add the frames below."
                             :isStudio?"CGlide H3 Studio composition and continuation, rendered through the same One Node quality/LoRA/safe-refine engine. Use Studio @tokens, not manual <Picture> numbers."
                                         :"Reference-driven. Feed images / video / audio below, tag them in the prompt, and describe the target scene.";
        if(isStudio){
          refIntro.innerHTML=studioRef
            ? "Native CGlide Studio references. Add images, video and audio below, then insert the <b>@image1</b>, <b>@video1</b> and <b>@audio1</b> tokens shown above. CGlide assigns the real H3 tag order for you."
            :"Native CGlide Studio first/last frames. Use <b>@first</b> and <b>@last</b> in the prompt only when those frames are present.";
          rfRowIv.style.display="none"; rfRowR2v.style.display="none";
          if(studioRef){ renderRefImages(); warnRefImages(); renderRefVideos(); renderRefAudios(); }
          rebuildStudioTagRow(); refreshStudioUI();
        } else {
          rfRowIv.style.display=""; rfRowR2v.style.display="";
          if(m==="r2v"){ refIntro.innerHTML="Lock a <b>character</b>, <b>style</b>, <b>motion/camera</b>, or <b>voice</b> from references, then describe the target scene. Tag each reference in the prompt in the order shown (<code>&lt;Picture 1&gt;</code>, <code>&lt;Video 1&gt;</code>, <code>&lt;Audio 1&gt;</code>)."; renderRefImages(); warnRefImages(); renderRefVideos(); renderRefAudios(); rebuildTagRow(); }
        }
        refreshTemplateDD(); updateModStatus(); try{updatePDDUI();}catch(_e){} updateSpeedNotes(); updateTwoPassUI(); persist();
      }

      // ── model scan ────────────────────────────────────────────────────────
      const _norm=(s)=>(s||"").replace(/\\/g,"/").toLowerCase();
      const _isPddAccFile=(f)=>/minimax.*(?:fl2va|ref2va).*acc.*8.*step/i.test(_norm(f));
      const pick=(list,saved,kws,excl)=>{
        if(!list||!list.length) return "";
        let r=list.find(i=>_norm(i)===_norm(saved)); if(r)return r;
        if(saved){ const b=_norm(saved).split("/").pop(); r=list.find(i=>_norm(i).split("/").pop()===b); if(r)return r; }
        const ks=(kws||[]).map(k=>k.toLowerCase());
        const cand=list.filter(f=>{ const n=_norm(f); return ks.every(k=>n.includes(k)) && (!excl||!excl.some(e=>n.includes(e))); });
        if(cand.length) return cand[0];
        return saved||"";
      };
      const _loadModels=()=>api.fetchApi("/minimaxh3/models").then(r=>r.json()).then(d=>{
        const diff=(d.diffusion_models||[]).filter(f=>f!=="none");
        const te=(d.text_encoders||[]).filter(f=>f!=="none");
        const vaes=(d.vaes||[]).filter(f=>f!=="none");
        const setDD=(f,list,val)=>{ const opts=["none",...list]; f._dd.updateItems(opts); f._dd.set(val||"none"); };
        S.unetFl=pick(diff,S.unetFl,["fl2va"]) || pick(diff,S.unetFl,["minimax","h3"],["ref2va"]);
        S.unetRef=pick(diff,S.unetRef,["ref2va"]);
        S.textEncoder=pick(te,S.textEncoder,["minimax"]) || pick(te,S.textEncoder,["qwen3vl"]);
        S.videoVae=pick(vaes,S.videoVae,["h3","video"]) || pick(vaes,S.videoVae,["minimax","video"]);
        S.audioVae=pick(vaes,S.audioVae,["h3","audio"]) || pick(vaes,S.audioVae,["minimax","audio"]);
        setDD(mFl,diff,S.unetFl); setDD(mRef,diff,S.unetRef); setDD(mTE,te,S.textEncoder);
        setDD(mVVae,vaes,S.videoVae); setDD(mAVae,vaes,S.audioVae);
        // upscale models (Upscale tab)
        const ups=(d.upscale_models||[]).filter(f=>f!=="none");
        S.upscaleModel=pick(ups,S.upscaleModel,[]) || (ups[0]||"");
        upModDD.updateItems(["none",...ups]); upModDD.set(S.upscaleModel||"none");
        // turbo LoRA auto-detect — H3-ONLY (must be minimax/h3 + turbo). The bare "turbo" keyword
        // used to match krea2_*_turbo LoRAs in the same folder, applying a Krea2 LoRA to the H3 model.
        // Prefer the newer v4-step600 checkpoint (EMA first): better micro-detail, no v1 "plastic" look.
        const loras=(d.loras||[]).filter(f=>f!=="none");
        const h3turbos=loras.filter(f=>/turbo/i.test(f) && /(minimax|h3)/i.test(f) && !/krea2/i.test(f) && !_isPddAccFile(f));
        const _v4=h3turbos.find(f=>/v4[_-]?step600.*ema/i.test(f)) || h3turbos.find(f=>/v4[_-]?step600/i.test(f)) || h3turbos.find(f=>/\bv4\b/i.test(f));
        const _savedH3=h3turbos.find(f=>_norm(f)===_norm(S.turboLora));
        // respect a valid saved pick (from the selector); else default to the newer v4; else first H3 turbo.
        S.turboLora = _savedH3 || _v4 || h3turbos[0] || "";
        // Distilled LightX recipes are exact-file selections. For older saved states, preserve the
        // legacy auto-picks (FL2V reverse-lexical first; Ref2V first returned by the backend), then
        // persist that file so a later install can never silently switch the active recipe.
        const _lxFlRaw=loras.filter(f=>/fl2v.*turbo/i.test(f) && /(minimax|h3)/i.test(f) && !_isPddAccFile(f));
        const _lxRefRaw=loras.filter(f=>/ref2v.*turbo/i.test(f) && /(minimax|h3)/i.test(f) && !_isPddAccFile(f));
        const _numericDesc=(a,b)=>String(b).localeCompare(String(a),undefined,{numeric:true,sensitivity:"base"});
        const _savedMatch=(list,saved)=>{ if(!saved)return ""; const n=_norm(saved), base=n.split("/").pop(); return list.find(f=>_norm(f)===n)||list.find(f=>_norm(f).split("/").pop()===base)||""; };
        _lxFl2vLoras=_lxFlRaw.slice().sort(_numericDesc); _lxR2vLoras=_lxRefRaw.slice().sort(_numericDesc);
        _lxFl2vLora=_savedMatch(_lxFl2vLoras,S.lxTurboFlFile)||(saved.lxTurboFlFile?S.lxTurboFlFile:(_lxFlRaw.slice().sort().reverse()[0]||""));
        _lxR2vLora=_savedMatch(_lxR2vLoras,S.lxTurboRefFile)||(saved.lxTurboRefFile?S.lxTurboRefFile:(_lxRefRaw[0]||""));
        S.lxTurboFlFile=_lxFl2vLora; S.lxTurboRefFile=_lxR2vLora;
        try{ refreshPreset(); }catch(_e){}
        // populate the Turbo LoRA selector (H3 turbos; fall back to all loras if detection finds none)
        const _turboOpts = h3turbos.length ? h3turbos : (loras.length ? loras : ["(none found)"]);
        try{ turboLoraDD.updateItems(_turboOpts); turboLoraDD.set(S.turboLora||"(none found)"); }catch(_e){}
        // Style LoRA stack — H3 loras that aren't turbo/krea2. Newest-first isn't meaningful here
        // (no version convention across style/character/physics LoRAs), so just list what's found;
        // each row keeps its own pick if still valid, or falls back to the first available.
        const _styleOpts = loras.filter(f=>!h3turbos.includes(f) && !/krea2/i.test(f) && !_isPddAccFile(f));
        _styleOptsList = _styleOpts.length ? _styleOpts : ["(none found)"];
        _animeMotionLoras=_styleOpts.filter(f=>/anime.*motion|motion.*anime/i.test(f)).sort(_numericDesc);
        try{ renderStyleLoras(); refreshAnimeMotionUI(); }catch(_e){}
        persist(); updateModStatus(); updateSpeedNotes(); try{refreshFinishUI();}catch(_e){}
      }).catch(e=>console.warn("[MMH3] models:",e));

      // ── templates ─────────────────────────────────────────────────────────
      let _tmplT2V=[], _tmplR2V=[];
      const applyTemplate=(name)=>{
        const pool=_isReferenceMode()?_tmplR2V:_tmplT2V;
        const t=pool.find(x=>x.name===name); if(!t)return;
        S.prompt=t.prompt; posTA.value=t.prompt; persist(); tmplSel.set("Load example…");
      };
      const _loadTemplates=()=>api.fetchApi("/minimaxh3/config").then(r=>r.json()).then(d=>{
        _tmplT2V=d.prompt_templates||[]; _tmplR2V=d.r2v_prompt_templates||[];
        refreshTemplateDD();
      }).catch(()=>{});
      const refreshTemplateDD=()=>{
        const pool=_isReferenceMode()?_tmplR2V:_tmplT2V;
        tmplSel.updateItems(["Load example…",...pool.map(t=>t.name)]); tmplSel.set("Load example…");
      };

      // ── generate ──────────────────────────────────────────────────────────
      let _genStart=0, _progTimer=null, _lastPct=0, _lastVal=null, _lastMax=null;
      // Bulletproof completion watch: poll /queue while running. The moment our prompt
      // leaves the running+pending queue it is done — this cannot be defeated by event
      // timing quirks (the reason the button used to stay stuck on "generating").
      let _completePoll=null, _sawQueued=false;
      const stopCompletionWatch=()=>{ if(_completePoll){clearInterval(_completePoll);_completePoll=null;} _sawQueued=false; };
      const startCompletionWatch=()=>{
        stopCompletionWatch(); _sawQueued=false;
        _completePoll=setInterval(async()=>{
          if(!_activeRunning||!_activePromptId){ stopCompletionWatch(); return; }
          try{
            const r=await api.fetchApi("/queue"); const q=await r.json();
            const inQ=[...(q.queue_running||[]),...(q.queue_pending||[])]
              .some(e=>(Array.isArray(e)?e[1]:(e&&e.prompt_id))===_activePromptId);
            if(inQ){ _sawQueued=true; }
            else if(_sawQueued){ _finishActive(); }   // was queued, now gone → finished
          }catch(e){ /* transient — keep polling */ }
        }, 1500);
      };
      const _elapsed=()=> _genStart? Math.round((Date.now()-_genStart)/1000)+"s":"";
      const renderProg=()=>{ progWrap.style.display="block"; progLabel.style.display="block"; progBar.style.width=Math.round(_lastPct*100)+"%";
        progLabel.textContent=(_lastPct>0?`⏳ generating — ${Math.round(_lastPct*100)}%`:"⏳ starting… (first run loads ~48 GB of weights)")+((_lastVal!=null&&_lastMax)?` · step ${_lastVal}/${_lastMax}`:"")+(_genStart?` · ${_elapsed()}`:""); };
      const reset=()=>{ S.generating=false; genBtn.disabled=false; genBtn.style.opacity="1"; genBtn.textContent=S.mode==="director"?"🎬 Assemble master":S.mode==="upscale"?(S.upscaleEngine==="h3finish"?"▶ Finish video":"▶ Upscale video"):S.mode==="repair"?"🩹 Repair masked area":S.mode==="studio"?"🎞 Render Studio clip":"▶ Generate";
        progWrap.style.display="none"; progBar.style.width="0%"; progLabel.style.display="none";
        if(_progTimer){clearInterval(_progTimer);_progTimer=null;} stopCompletionWatch(); _genStart=0; _lastPct=0; _lastVal=null; _lastMax=null; };
      _activeReset=reset;
      _activeSetPreview=(url)=>{ try{ previewImg.src=url; previewImg.style.display="block"; placeholder.style.display="none"; videoEl.style.display="none"; }catch(_e){} };
      _activeSetProgress=(f,val,max)=>{ _lastPct=f; if(val!=null){_lastVal=val;_lastMax=max;} renderProg(); };
      _activeShowError=(msg)=>{ errBox.style.display="block"; errBox.style.color="#ff6b6b"; errBox.style.borderColor="rgba(255,80,80,.3)"; errBox.style.background="rgba(255,80,80,.08)"; errBox.textContent=msg; };
      // non-fatal amber heads-up (generation still proceeds)
      const _showNotice=(msg)=>{ errBox.style.display="block"; errBox.style.color="#ffb84d"; errBox.style.borderColor="#cc7a00"; errBox.style.background="rgba(255,150,0,.08)"; errBox.textContent=msg; };
      const _showVideoUrl=(url,filename)=>{ try{previewImg.style.display="none";}catch(_e){} videoEl.src=url; videoEl.style.display="block"; placeholder.style.display="none"; fsBtn.style.display="flex"; _fsFilename=filename||""; if(videoEl.play)videoEl.play().catch(()=>{}); };
      _activeShowVideo=(item)=>{
        if(/\.(mp4|webm|mov|mkv)$/i.test(item.filename)){ _showVideoUrl(_viewUrl(item)+"&rand="+Math.random(), item.filename); _galAdd(item);
          // persist the settings that produced this clip so the gallery detail view can
          // show them and "Load settings into UI" can reproduce the result.
          if(S._pendingMeta){ const meta=S._pendingMeta; S._pendingMeta=null; _galMetaCache[item.filename]=meta; item.has_meta=true;
            api.fetchApi("/minimaxh3/save_meta",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({filename:item.filename,subfolder:item.subfolder||"",meta})}).catch(e=>console.warn("[MMH3] save_meta:",e));
          }
        }
        else { videoEl.style.display="none"; placeholder.style.display="block"; placeholder.textContent="Saved: "+item.filename; }
      };

      const _startRun=()=>{
        S.generating=true; genBtn.disabled=true; genBtn.style.opacity=".6"; genBtn.textContent="… working"; errBox.style.display="none";
        _genStart=Date.now(); _lastPct=0; _lastVal=null; _lastMax=null; renderProg();
        if(_progTimer)clearInterval(_progTimer); _progTimer=setInterval(()=>{ if(S.generating)renderProg(); },1000);
      };
      const _submit=async(prompt)=>{
        try{
          const r=await api.fetchApi("/prompt",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({prompt})});
          if(!r.ok){ const t=await r.text(); throw new Error(t); }
          const d=await r.json(); _activePromptId=d.prompt_id||null; _activeRunning=true; startCompletionWatch();
        }catch(e){ _activeShowError("ComfyUI rejected the graph:\n"+fmtErr(e)); _activeRunning=false; reset(); }
      };

      // ── H3 FINISH: source-locked latent recovery for an already-rendered video ──────────────
      // This is intentionally a separate Upscale engine. It does NOT turn a normal generation
      // into an external clip-chaining operation: MMH3ContextWindows keeps the whole timeline in
      // one internally fused H3 sampling run, while the untouched source soundtrack is re-muxed.
      const h3FinishGenerate=async()=>{
        if(S.generating)return;
        errBox.style.display="none";
        if(!_finishAvail){
          _activeShowError("H3 Finish is not ready: "+(_finishMissing.length?_finishMissing.join(", "):"the source-lock nodes are still being checked")+". Restart ComfyUI after installing/updating the H3 source-lock nodes.");
          return;
        }
        if(!S.upscaleSource||!S.upscaleSource.filename){ _activeShowError("Choose the video to finish first — select it from the gallery or drop it in the Upscale tab."); return; }
        if(!_latentUpAvail||!(S.latentUpModel||_latentUpModels[0])){ _activeShowError("The H3 latent-upscale model is missing. Put minimax_h3_latent_upscaler_3d_fp32.pth (or bf16/fp16) in models, open T2V → Models → ↻ Rescan, then return here."); return; }
        const hasRef=!!S.finishReference;
        const unet=hasRef?S.unetRef:S.unetFl;
        if([unet,S.textEncoder,S.videoVae,S.audioVae].some(v=>!v)){
          _activeShowError("Some H3 models are not selected. Switch once to T2V → Models → ↻ Rescan, then choose the FL2VA model (or REF2VA when using a finish reference), text encoder, video VAE, and audio VAE.");
          modBody.style.display="block"; modHdr.textContent="▾ Models"; return;
        }
        if(S.sageAttn&&!_sageAvailable){ _activeShowError("Sage Attention is enabled but its H3 patch is not registered. Restart ComfyUI or turn Sage Attention off before using H3 Finish."); return; }
        if(S.solAttn&&!_solAvailable){ _activeShowError("Sol-Attn is enabled but its H3 nodes are not registered. Restart ComfyUI or turn Sol-Attn off before using H3 Finish."); return; }
        let staged;
        try{ staged=await stageAndProbeFinish(); }
        catch(e){ _activeShowError("Couldn't prepare this source video for H3 Finish:\n"+fmtErr(e)+"\nRestart ComfyUI if the /minimaxh3/stage_repair route is missing."); return; }
        const inName=staged.inName, info=staged.info;
        if(!info||(+info.h3_frames||0)<5){ _activeShowError("This source clip is too short for an H3 Finish pass."); return; }
        const target=_finishTargetRes(info);
        if(!target){ _activeShowError("Couldn't calculate an H3-aligned finish canvas for this source clip."); return; }
        const sourceType=_finishEffectiveSource();
        const seed=S.finishRandomize?Math.floor(Math.random()*1e15):(+S.finishSeed||0);
        const steps=Math.max(4,Math.min(20,+S.finishSteps||8));
        const denoise=S.finishStrength==="conservative"?0.14:S.finishStrength==="strong"?0.24:0.20;
        const savedPrompt=(sourceType==="h3"&&S.finishUseSavedPrompt&&_finishDetected&&_finishDetected.meta&&String(_finishDetected.meta.prompt||"").trim())||"";
        const requested=(S.finishPrompt||"").trim()||savedPrompt||"Recover clean source detail while keeping the existing image exactly recognizable.";
        const fullPrompt=`integrated_multimodal_description:\n${requested}\n\n[H3 finish source lock]\nThe supplied source video is authoritative. Preserve the existing faces, identity, gender presentation, age, hair, wardrobe, jewelry, logos, object design, anime linework, materials, environment, camera movement, composition, motion timing, and shot continuity. Recover clean fine detail from the source latent without redesigning people, swapping objects, adding subjects, changing accessories, changing the camera, or inventing a new scene.${hasRef?" Use <Picture 1> only to reinforce the exact identity or object appearance already present in the source.":""}\n\noverall_soundscape:\nReuse the protected synchronized source soundtrack exactly. Generate no replacement speech, narrator, music, ambience, or sound effects.\n\nnon_diegetic_music:\nN/A`;
        const planJSON=JSON.stringify({defaults:{length:+info.h3_frames,steps},shots:[{id:"finish_video",prompt:fullPrompt,length:+info.h3_frames,steps,seed:String(seed)}]});
        S._pendingMeta={v:1,mode:"finish_h3",prompt:requested,sourceName:S.upscaleSource.filename,sourceType,sourceDetected:_finishDetected&&_finishDetected.kind||"unknown",sourcePromptUsed:!!savedPrompt,reference:S.finishReference||null,targetMp:+S.finishTargetMp||2,w:target.w,h:target.h,sourceW:+info.width,sourceH:+info.height,duration:+info.duration,sourceDuration:+info.source_duration||0,steps,denoise,seed,wasRandom:!!S.finishRandomize,sourceAudioLocked:!!info.has_audio,canvasAdjusted:!!info.canvas_adjusted,trimmedFrames:+info.trimmed_frames||0};
        _startRun();
        const _int8=/int8|w8a8|convrot/i.test(unet);
        const g={
          "F:load":{class_type:"LoadVideo",inputs:{file:inName},_meta:{title:"Finish source video"}},
          "F:comp":{class_type:"GetVideoComponents",inputs:{video:["F:load",0]},_meta:{title:"Source frames + original audio"}},
          // Never give H3 a finished 2K/4K source canvas directly: the source is normalized
          // first, then its H3 latent is upscaled. This is the 16GB-safe part of the route.
          "F:scale":{class_type:"ImageScale",inputs:{image:["F:comp",0],upscale_method:"lanczos",width:+info.width,height:+info.height,crop:"center"},_meta:{title:"Normalize source canvas for H3"}},
          "F:unet":{class_type:"UNETLoader",inputs:{unet_name:unet,weight_dtype:(!_int8&&S.fastFp8)?"fp8_e4m3fn_fast":"default"},_meta:{title:hasRef?"H3 Ref2VA finish model":"H3 FL2VA finish model"}},
          "F:clip":{class_type:"CLIPLoader",inputs:{clip_name:S.textEncoder,type:"minimax",device:"default"},_meta:{title:"H3 text encoder"}},
          "F:vae":{class_type:"VAELoader",inputs:{vae_name:S.videoVae},_meta:{title:"H3 video VAE"}},
          "F:avae":{class_type:"VAELoader",inputs:{vae_name:S.audioVae},_meta:{title:"H3 audio VAE"}},
          "F:plan":{class_type:"MiniMaxH3ChainPlan",inputs:{plan_json:planJSON,run_name:"mmh3_finish_"+Date.now(),generation_fingerprint:"one-node-finish-v1",width:+info.width,height:+info.height,context_length:39,encode_mode:"video",anchor_mode:"head",crop:"center",audio_mode:"generated_audio",audio_context_length:39,default_duration_seconds:+info.duration,default_steps:steps,base_seed:seed,segment_crf:18,video_blend_frames:0,continuation_mode:"masked_av"},_meta:{title:"Source-lock finish plan"}},
          "F:start":{class_type:"MiniMaxH3ChainLoopStart",inputs:{plan:["F:plan",0],start_clip:1,scene_range:"1",verify_resume_history:false},_meta:{title:"Start source-lock pass"}},
          "F:current":{class_type:"MiniMaxH3ChainCurrent",inputs:{state:["F:start",1],align_audio_reference:false},_meta:{title:"Finish shot settings"}},
          "F:condsrc":{class_type:"MiniMaxH3ImageToVideo",inputs:{clip:["F:clip",0],vae:["F:vae",0],prompt:["F:current",4],width:["F:current",8],height:["F:current",9],length:["F:current",6]},_meta:{title:"Source-canvas H3 conditioning"}},
          "F:ctxsrc":{class_type:"MiniMaxH3ChainContext",inputs:{state:["F:current",0],conditioning:["F:condsrc",0],vae:["F:vae",0],latent:["F:condsrc",1],audio_vae:["F:avae",0]},_meta:{title:"H3 source-lock context"}},
          "F:source":{class_type:"MiniMaxH3ContexLoopSourceAVTarget",inputs:{state:["F:current",0],latent:["F:ctxsrc",3],vae:["F:vae",0],audio_vae:["F:avae",0],source_frames:["F:scale",0],source_audio:info.has_audio?["F:comp",1]:["F:silence",0],source_fps:["F:comp",2],crop:"center"},_meta:{title:"Encode protected source AV latent"}},
          "F:sep":{class_type:"LTXVSeparateAVLatent",inputs:{av_latent:["F:source",0]},_meta:{title:"Split protected video + audio latent"}},
          "F:lup":{class_type:"MinimaxH3LatentUpscaler3D",inputs:{latent:["F:sep",0],model_name:(S.latentUpModel||_latentUpModels[0]||""),mode:"target dimensions","mode.width":target.w,"mode.height":target.h,align:32,enable_temporal_chunking:true,force_unload:true,device:"cuda",precision:"fp32"},_meta:{title:"H3 neural latent upscale"}},
          "F:concat":{class_type:"LTXVConcatAVLatent",inputs:{video_latent:["F:lup",0],audio_latent:["F:sep",1]},_meta:{title:"Rejoin protected audio with upscaled video latent"}},
          "F:mask":{class_type:"SolidMask",inputs:{value:1.0,width:target.w,height:target.h},_meta:{title:"Full-frame low-denoise recovery mask"}},
          "F:masked":{class_type:"MiniMaxH3ContexMaskedTarget",inputs:{target_latent:["F:concat",0],mask:["F:mask",0],mask_meaning:"white = generate",audio_mode:"preserve source audio",mask_conversion:"H3 exact (causal/token max)"},_meta:{title:"Source-locked recovery latent"}},
          "F:sampler":{class_type:"KSamplerSelect",inputs:{sampler_name:"euler"},_meta:{title:"H3 finish sampler"}},
          "F:sched":{class_type:"BasicScheduler",inputs:{model:["F:win",0],scheduler:"beta",steps,denoise},_meta:{title:"Conservative finish schedule"}},
          "F:guider":{class_type:"BasicGuider",inputs:{model:["F:win",0],conditioning:["F:condtarget",0]},_meta:{title:"Finish guider"}},
          "F:noise":{class_type:"RandomNoise",inputs:{noise_seed:seed},_meta:{title:"Finish seed"}},
          // Internal overlapping H3 windows are fused on the latent timeline — no independently
          // rendered chunks and no external xfade stitches.
          "F:win":{class_type:"MMH3ContextWindows",inputs:{model:["F:unet",0],context_length:7,context_overlap:2,fuse_method:"pyramid",context_schedule:"standard_static",context_stride:1,freenoise:false,split_conds_to_windows:false,accumulator_device:"cpu"},_meta:{title:"H3 internal temporal windows (16GB safe)"}},
          "F:sample":{class_type:"SamplerCustomAdvanced",inputs:{noise:["F:noise",0],guider:["F:guider",0],sampler:["F:sampler",0],sigmas:["F:sched",0],latent_image:["F:masked",0]},_meta:{title:"Low-denoise H3 finish recovery"}},
          "F:decode":{class_type:"VAEDecode",inputs:{samples:["F:sample",0],vae:["F:vae",0]},_meta:{title:"Decode finished frames"}},
          "F:video":{class_type:"CreateVideo",inputs:{images:["F:decode",0],audio:["F:source",2],fps:24,bit_depth:"auto",color_space:"sRGB"},_meta:{title:"Re-mux original source audio"}},
          "F:save":{class_type:"SaveVideo",inputs:{video:["F:video",0],filename_prefix:"ComfyUI-MiniMaxH3-OneNode/H3_Finished",format:"auto",codec:"auto"},_meta:{title:"Save H3 finished video"}},
        };
        if(!info.has_audio)g["F:silence"]={class_type:"EmptyAudio",inputs:{duration:(+info.duration||0)+0.5,sample_rate:32000,channels:2},_meta:{title:"Silent source track"}};
        if(hasRef){
          g["F:ref"]={class_type:"LoadImage",inputs:{image:S.finishReference,upload:"image"},_meta:{title:"Finish identity / object reference"}};
          g["F:condtarget"]={class_type:"MiniMaxH3ReferenceToVideo",inputs:{clip:["F:clip",0],vae:["F:vae",0],audio_vae:["F:avae",0],prompt:["F:current",4],width:target.w,height:target.h,length:+info.h3_frames,ref_image_size:"match","ref_images.ref_image_0":["F:ref",0]},_meta:{title:"Target Ref2VA conditioning"}};
        } else {
          g["F:condtarget"]={class_type:"MiniMaxH3ImageToVideo",inputs:{clip:["F:clip",0],vae:["F:vae",0],prompt:["F:current",4],width:target.w,height:target.h,length:+info.h3_frames},_meta:{title:"Target H3 conditioning"}};
        }
        // Same quality-preserving speed patches as Repair. Turbo, caches, and style LoRAs are
        // intentionally excluded: they can make source recovery redesign frames or accessories.
        let modelSrc=["F:unet",0];
        if(S.sigmaShiftOn){ g["F:shift"]={class_type:"MiniMaxH3SigmaShift",inputs:{model:modelSrc,shift_video:+S.shiftVideo||12,shift_audio:+S.shiftAudio||3},_meta:{title:"MiniMax H3 Sigma Shift"}}; modelSrc=["F:shift",0]; }
        if(S.sageAttn){ g["F:sage"]={class_type:"MiniMaxH3MemoryEfficientSageAttentionPatch",inputs:{model:modelSrc},_meta:{title:"MiniMax H3 Sage Attention"}}; modelSrc=["F:sage",0]; }
        if(S.solAttn){
          g["F:sol"]={class_type:"MiniMaxH3MemoryEfficientSolAttentionPatch",inputs:{model:modelSrc,enabled:true,tau:1.0,min_tokens:4096,strict:false,thresh_type:"diag",int8_qk:false,int8_pv:false,sink_conditioning:"exact_kv",dense_blocks:""},_meta:{title:"MiniMax H3 Sol-Attn"}}; modelSrc=["F:sol",0];
          g["F:solff"]={class_type:"MiniMaxH3ChunkFeedForward",inputs:{model:modelSrc,enabled:true,chunks:2,min_tokens:8192},_meta:{title:"MiniMax H3 FFN chunking"}}; modelSrc=["F:solff",0];
        }
        // The internal window node always receives the fully patched model. If Sol-Attn is off
        // this is simply the H3 model (or the sigma-shift patched version) — no fake pass-through.
        g["F:win"].inputs.model=modelSrc;
        await _submit(g);
      };

      // ── UPSCALE: enlarge a finished video (ESRGAN model / SeedVR2 / FlashVSR) + keep audio ──
      const upscaleGenerate=async()=>{
        if(S.generating)return; errBox.style.display="none";
        if(S.upscaleEngine==="h3finish") return h3FinishGenerate();
        const eng=S.upscaleEngine, svr=eng==="seedvr2", fvsr=eng==="flashvsr", rtx=eng==="rtxvsr";
        const src=S.upscaleSource;
        if(!src||!src.filename){ _activeShowError("Pick a source video first — choose one from the gallery or drop a file in the Upscale panel."); return; }
        if(eng==="model" && !S.upscaleModel){ _activeShowError("Select an upscale model (models/upscale_models). Put one there — e.g. 4x_foolhardy_Remacri.pth — and hit Rescan."); return; }
        if(svr && !_svrAvailable){ _activeShowError("SeedVR2 isn't detected yet. It's installed — RESTART ComfyUI so its nodes register (first run auto-downloads the model), or switch the engine to Model."); return; }
        if(fvsr && !_fvsrAvailable){ _activeShowError("FlashVSR isn't detected yet. It's installed — RESTART ComfyUI so its nodes register (first run auto-downloads its models), or switch the engine."); return; }
        if(rtx && !_rtxAvailable){ _activeShowError("RTX VSR isn't detected. Install Comfy-Org/Nvidia_RTX_Nodes_ComfyUI into custom_nodes + RESTART ComfyUI (NVIDIA RTX GPU only), or switch the engine."); return; }
        // snapshot upscale settings so the finished clip carries them in the gallery
        S._pendingMeta={v:1,mode:"upscale",upEngine:eng,
          upScale: svr?(+S.svrRes||1080) : fvsr?(+S.fvsrScale||2) : rtx?(+S.rtxScale||2) : (+S.upscaleScale||2),
          upModel: eng==="model"?S.upscaleModel : svr?S.svrDitModel : fvsr?S.fvsrVae : rtx?("RTX "+(S.rtxQuality||"ULTRA")) : "",
          sourceName: src.filename};
        _startRun();
        // stage the source into the input dir so LoadVideo can read it (unless it's already an upload)
        let inName=src._raw||src.filename;
        if(!src._input){
          try{
            const r=await api.fetchApi("/minimaxh3/stage",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({filename:src.filename,subfolder:src.subfolder||""})});
            const d=await r.json(); if(!d.ok) throw new Error(d.error||"stage failed"); inName=d.name;
          }catch(e){ _activeShowError("Couldn't stage the source video for upscaling:\n"+fmtErr(e)+"\n(Restart ComfyUI if the /minimaxh3/stage route is missing.)"); reset(); return; }
        }
        let g;
        if(fvsr){
          // FlashVSR — fast diffusion VSR. frames -> FlashVSRNode -> re-mux original audio. Models auto-download.
          const vae=S.fvsrVae||"Wan2.1";
          g={
            "U:load":{class_type:"LoadVideo",inputs:{file:inName},_meta:{title:"Load source video"}},
            "U:comp":{class_type:"GetVideoComponents",inputs:{video:["U:load",0]},_meta:{title:"Split frames + audio"}},
            "U:fvsr":{class_type:"FlashVSRNode",inputs:{frames:["U:comp",0],model:"FlashVSR-v1.1",mode:S.fvsrMode||"tiny",vae_model:vae,scale:+S.fvsrScale||2,tiled_vae:true,tiled_dit:true,unload_dit:true,seed:Math.floor(Math.random()*1e9),frame_chunk_size:33,attention_mode:"sparse_sage_attention",enable_debug:false,keep_models_on_cpu:false,resize_factor:1.0},_meta:{title:"FlashVSR upscale"}},
            "U:cvid":{class_type:"CreateVideo",inputs:{images:["U:fvsr",0],audio:["U:comp",1],fps:["U:comp",2],bit_depth:8},_meta:{title:"Re-mux with original audio"}},
            "U:save":{class_type:"SaveVideo",inputs:{video:["U:cvid",0],filename_prefix:"ComfyUI-MiniMaxH3-OneNode/MiniMax_H3_upscaled",format:"auto",codec:"auto"},_meta:{title:"Save upscaled video"}},
          };
          await _submit(g); return;
        }
        if(rtx){
          // RTX Video Super Resolution — NVIDIA hardware upscaler (per-frame), then re-mux the original audio.
          g={
            "U:load":{class_type:"LoadVideo",inputs:{file:inName},_meta:{title:"Load source video"}},
            "U:comp":{class_type:"GetVideoComponents",inputs:{video:["U:load",0]},_meta:{title:"Split frames + audio"}},
            // resize_type is a v3 DynamicCombo: the sub-input serializes as the dotted key
            // "resize_type.scale" (same pattern as H3's ref_images.ref_image_N), NOT a flat "scale".
            "U:rtx":{class_type:"RTXVideoSuperResolution",inputs:{images:["U:comp",0],resize_type:"scale by multiplier","resize_type.scale":+S.rtxScale||2,quality:S.rtxQuality||"ULTRA"},_meta:{title:"RTX Video Super Resolution"}},
            "U:cvid":{class_type:"CreateVideo",inputs:{images:["U:rtx",0],audio:["U:comp",1],fps:["U:comp",2],bit_depth:8},_meta:{title:"Re-mux with original audio"}},
            "U:save":{class_type:"SaveVideo",inputs:{video:["U:cvid",0],filename_prefix:"ComfyUI-MiniMaxH3-OneNode/MiniMax_H3_upscaled",format:"auto",codec:"auto"},_meta:{title:"Save upscaled video"}},
          };
          await _submit(g); return;
        }
        if(svr){
          // SeedVR2 diffusion upscaler (models auto-download to models/SEEDVR2 on first run)
          g={
            "U:load":{class_type:"LoadVideo",inputs:{file:inName},_meta:{title:"Load source video"}},
            "U:comp":{class_type:"GetVideoComponents",inputs:{video:["U:load",0]},_meta:{title:"Split frames + audio"}},
            "U:dit":{class_type:"SeedVR2LoadDiTModel",inputs:{model:S.svrDitModel||"seedvr2_ema_3b_fp8_e4m3fn.safetensors",device:"cuda:0",blocks_to_swap:+S.svrBlockSwap||0,swap_io_components:false,offload_device:((+S.svrBlockSwap||0)>0?"cpu":"none"),cache_model:((+S.svrBlockSwap||0)>0),attention_mode:_sageAvailable?"sageattn_2":"sdpa"},_meta:{title:"SeedVR2 DiT (3B)"}},
            "U:vae":{class_type:"SeedVR2LoadVAEModel",inputs:{model:"ema_vae_fp16.safetensors",device:"cuda:0",encode_tiled:false,decode_tiled:true,decode_tile_size:1024,decode_tile_overlap:128,offload_device:"cpu",cache_model:false},_meta:{title:"SeedVR2 VAE"}},
            "U:svr":{class_type:"SeedVR2VideoUpscaler",inputs:{image:["U:comp",0],dit:["U:dit",0],vae:["U:vae",0],seed:Math.floor(Math.random()*1e9),resolution:+S.svrRes||1080,max_resolution:0,batch_size:Math.max(5,+S.svrBatch||5),uniform_batch_size:!!S.svrCompile,temporal_overlap:0,prepend_frames:0,color_correction:"wavelet",input_noise_scale:0.0,latent_noise_scale:0.0,enable_debug:false},_meta:{title:"SeedVR2 upscale"}},
            "U:cvid":{class_type:"CreateVideo",inputs:{images:["U:svr",0],audio:["U:comp",1],fps:["U:comp",2],bit_depth:8},_meta:{title:"Re-mux with original audio"}},
            "U:save":{class_type:"SaveVideo",inputs:{video:["U:cvid",0],filename_prefix:"ComfyUI-MiniMaxH3-OneNode/MiniMax_H3_upscaled",format:"auto",codec:"auto"},_meta:{title:"Save upscaled video"}},
          };
          // torch.compile — big speedup for the many diffusion batches in a long clip (first run warms up).
          // uniform_batch_size (above) pads the ragged last batch so compile doesn't re-trace and stall.
          if(S.svrCompile){
            g["U:tc"]={class_type:"SeedVR2TorchCompileSettings",inputs:{backend:"inductor",mode:"default",fullgraph:false,dynamic:false,dynamo_cache_size_limit:64,dynamo_recompile_limit:128},_meta:{title:"torch.compile settings"}};
            g["U:dit"].inputs.torch_compile_args=["U:tc",0];
          }
        } else {
          // Memory-safe: shrink frames to (target/native) BEFORE the model so it outputs the
          // target directly, instead of always producing a full-native (4×) intermediate for
          // every frame (that intermediate is what OOMs a whole clip at once). preScale=1 for
          // a native-scale target is a harmless no-op.
          const nativeM=(String(S.upscaleModel).match(/(\d+)\s*x/i)||[])[1]; const native=nativeM?+nativeM:4;
          const preScale=Math.min(1,(+S.upscaleScale||2)/native);
          g={
            "U:load":{class_type:"LoadVideo",inputs:{file:inName},_meta:{title:"Load source video"}},
            "U:comp":{class_type:"GetVideoComponents",inputs:{video:["U:load",0]},_meta:{title:"Split frames + audio"}},
            "U:pre":{class_type:"ImageScaleBy",inputs:{image:["U:comp",0],upscale_method:"area",scale_by:preScale},_meta:{title:"Pre-scale (memory saver)"}},
            "U:model":{class_type:"UpscaleModelLoader",inputs:{model_name:S.upscaleModel},_meta:{title:"Upscale model"}},
            "U:up":{class_type:"ImageUpscaleWithModel",inputs:{upscale_model:["U:model",0],image:["U:pre",0]},_meta:{title:"Upscale frames → target"}},
            "U:cvid":{class_type:"CreateVideo",inputs:{images:["U:up",0],audio:["U:comp",1],fps:["U:comp",2],bit_depth:8},_meta:{title:"Re-mux with original audio"}},
            "U:save":{class_type:"SaveVideo",inputs:{video:["U:cvid",0],filename_prefix:"ComfyUI-MiniMaxH3-OneNode/MiniMax_H3_upscaled",format:"auto",codec:"auto"},_meta:{title:"Save upscaled video"}},
          };
        }
        await _submit(g);
      };

      // ── REPAIR: source AV plate + exact white-mask H3 sampling ───────────────
      const repairGenerate=async()=>{
        if(S.generating)return;
        errBox.style.display="none";
        if(!_repairAvail){
          _activeShowError("Repair mode is not ready: "+(_repairMissing.length?_repairMissing.join(", "):"the H3 masking nodes are still being checked")+". Restart ComfyUI after installing/updating ComfyUI-MiniMaxH3-Contex-Loop.");
          return;
        }
        if(!S.repairSource||!S.repairSource.filename){ _activeShowError("Choose the video to repair first — select it from the gallery or drop it in the Repair tab."); return; }
        const samTrack=S.repairMaskMode==="sam3";
        if(samTrack&&!_sam3Avail){ _activeShowError("SAM 3.1 track mode is not ready: "+(_sam3Missing.length?_sam3Missing.join(", "):"the SAM model is still being checked")+". Use Static painted mask for now, or restart ComfyUI after installing SAM 3.1."); return; }
        if(samTrack&&!(S.repairSamPrompt||"").trim()){ _activeShowError("Describe the one object SAM 3.1 should track first — for example: ‘the woman’s silver ring on her right hand’. "); return; }
        if(!samTrack&&!S.repairMask){ _activeShowError("Add a static black-and-white mask first. White is the only area H3 is allowed to redraw; black remains protected."); return; }
        const hasRef=!!S.repairRef;
        const unet=hasRef?S.unetRef:S.unetFl;
        if([unet,S.textEncoder,S.videoVae,S.audioVae].some(v=>!v)){
          _activeShowError("Some H3 models are not selected. Open Models → ↻ Rescan, then choose the FL2VA model (or REF2VA when using a replacement reference), text encoder, video VAE, and audio VAE.");
          modBody.style.display="block"; modHdr.textContent="▾ Models"; return;
        }
        if(S.sageAttn&&!_sageAvailable){ _activeShowError("Sage Attention is enabled but its H3 patch is not registered. Restart ComfyUI or turn Sage Attention off before using Repair."); return; }
        if(S.solAttn&&!_solAvailable){ _activeShowError("Sol-Attn is enabled but its H3 nodes are not registered. Restart ComfyUI or turn Sol-Attn off before using Repair."); return; }
        let staged;
        try{ staged=await stageAndProbeRepair(); }
        catch(e){ _activeShowError("Couldn't prepare this source video for repair:\n"+fmtErr(e)+"\nRestart ComfyUI if the /minimaxh3/stage_repair route is missing."); return; }
        const inName=staged.inName, info=staged.info;
        if(!info||(+info.h3_frames||0)<5){ _activeShowError("This source clip is too short for H3 repair."); return; }
        const seed=S.repairRandomize?Math.floor(Math.random()*1e15):(+S.repairSeed||0);
        const steps=Math.max(12,Math.min(30,+S.repairSteps||20));
        const repairHd=!!S.repairHd;
        const target=repairHd?_repairTargetRes(info):null;
        const repairHdSteps=Math.max(2,Math.min(8,+S.repairHdSteps||4));
        const repairHdDenoise=Math.max(0.05,Math.min(0.25,+S.repairHdDenoise||0.20));
        if(repairHd&&(!_finishAvail||!_latentUpAvail||!(S.latentUpModel||_latentUpModels[0]))){
          _activeShowError("HD finish after Repair is not ready yet. It needs the H3 latent-upscale model plus the same 16GB temporal-window nodes used by H3 Finish. Open T2V → Models → ↻ Rescan, then restart ComfyUI only if the banner still says it is missing.");
          return;
        }
        if(repairHd&&!target){ _activeShowError("Couldn't calculate the HD repair target from this source clip. Select the source again so the Repair tab can read its dimensions."); return; }
        const requested=(S.repairPrompt||"").trim()||"Repair the white masked region so it naturally belongs in the existing scene.";
        const maskSource=samTrack?"the temporally tracked SAM 3.1 white mask":"the user-painted static white mask";
        const fullPrompt=`integrated_multimodal_description:\n${requested}\n\n[masked source repair]\nTreat the supplied source video as the authoritative plate. Preserve every black or unmasked pixel, camera path, composition, lighting, identities, wardrobe, objects, motion timing, image style, and all details outside the white mask exactly. Regenerate only the white masked region defined by ${maskSource}. Keep the mask boundary clean with no halo, flicker, duplicate subject, object redesign, new camera move, or changes outside the mask.${hasRef?" Use <Picture 1> only as the visual appearance reference for the white masked region.":""}\n\noverall_soundscape:\nReuse the protected synchronized source soundtrack exactly. Generate no replacement sound or speech.\n\nnon_diegetic_music:\nN/A`;
        const planJSON=JSON.stringify({defaults:{length:+info.h3_frames,steps},shots:[{id:"masked_repair",prompt:fullPrompt,length:+info.h3_frames,steps,seed:String(seed)}]});
        // Save exact repair settings with the resulting clip so gallery history identifies the source and mask.
        S._pendingMeta={v:2,mode:"repair",prompt:requested,sourceName:S.repairSource.filename,mask:samTrack?null:S.repairMask,maskMode:samTrack?"sam3":"static",samTarget:samTrack?(S.repairSamPrompt||"").trim():null,samThreshold:samTrack?(+S.repairSamThreshold||0.5):null,samCleanup:samTrack?!!S.repairSamCleanup:false,reference:S.repairRef||null,
          w:repairHd?target.w:+info.width,h:repairHd?target.h:+info.height,repairCanvasW:+info.width,repairCanvasH:+info.height,duration:+info.duration,sourceDuration:+info.source_duration||0,steps,seed,wasRandom:!!S.repairRandomize,
          hdFinish:repairHd,hdTargetMp:repairHd?(+S.repairTargetMp||2):null,hdSteps:repairHd?repairHdSteps:null,hdDenoise:repairHd?repairHdDenoise:null,
          sourceAudioLocked:!!info.has_audio,canvasAdjusted:!!info.canvas_adjusted,trimmedFrames:+info.trimmed_frames||0};
        _startRun();
        const _int8=/int8|w8a8|convrot/i.test(unet);
        const g={
          "R:load":{class_type:"LoadVideo",inputs:{file:inName},_meta:{title:"Repair source video"}},
          "R:comp":{class_type:"GetVideoComponents",inputs:{video:["R:load",0]},_meta:{title:"Source frames + audio"}},
          // Always normalize the source frames to the H3 canvas reported by the backend. This is
          // a no-op for a normal 0.5–1MP H3 render but prevents accidental 2K/4K repair OOMs.
          "R:scale":{class_type:"ImageScale",inputs:{image:["R:comp",0],upscale_method:"lanczos",width:+info.width,height:+info.height,crop:"center"},_meta:{title:"Normalize source canvas for H3"}},
          "R:unet":{class_type:"UNETLoader",inputs:{unet_name:unet,weight_dtype:(!_int8&&S.fastFp8)?"fp8_e4m3fn_fast":"default"},_meta:{title:hasRef?"H3 Ref2VA repair model":"H3 FL2VA repair model"}},
          "R:clip":{class_type:"CLIPLoader",inputs:{clip_name:S.textEncoder,type:"minimax",device:"default"},_meta:{title:"H3 text encoder"}},
          "R:vae":{class_type:"VAELoader",inputs:{vae_name:S.videoVae},_meta:{title:"H3 video VAE"}},
          "R:avae":{class_type:"VAELoader",inputs:{vae_name:S.audioVae},_meta:{title:"H3 audio VAE"}},
          "R:plan":{class_type:"MiniMaxH3ChainPlan",inputs:{plan_json:planJSON,run_name:"mmh3_repair_"+Date.now(),generation_fingerprint:"one-node-repair-v2-sam3",width:+info.width,height:+info.height,context_length:39,encode_mode:"video",anchor_mode:"head",crop:"center",audio_mode:"generated_audio",audio_context_length:39,default_duration_seconds:+info.duration,default_steps:steps,base_seed:seed,segment_crf:18,video_blend_frames:0,continuation_mode:"masked_av"},_meta:{title:"Masked repair plan (one source shot)"}},
          "R:start":{class_type:"MiniMaxH3ChainLoopStart",inputs:{plan:["R:plan",0],start_clip:1,scene_range:"1",verify_resume_history:false},_meta:{title:"Start repair source shot"}},
          "R:current":{class_type:"MiniMaxH3ChainCurrent",inputs:{state:["R:start",1],align_audio_reference:false},_meta:{title:"Repair shot settings"}},

          "R:ctx":{class_type:"MiniMaxH3ChainContext",inputs:{state:["R:current",0],conditioning:["R:cond",0],vae:["R:vae",0],latent:["R:cond",1],audio_vae:["R:avae",0]},_meta:{title:"H3 repair context"}},
          "R:source":{class_type:"MiniMaxH3ContexLoopSourceAVTarget",inputs:{state:["R:current",0],latent:["R:ctx",3],vae:["R:vae",0],audio_vae:["R:avae",0],source_frames:["R:scale",0],source_audio:info.has_audio?["R:comp",1]:["R:silence",0],source_fps:["R:comp",2],crop:"center"},_meta:{title:"Encode source AV plate"}},
          "R:grid":{class_type:"MiniMaxH3ContexMaskGridPreview",inputs:{image:["R:source",1],mask:["R:mask",0],cell_selection:"runtime exact (latent max)",cell_adjust:0,preview_frame:0,overlay_opacity:0.38,show_grid:true,show_source_outline:true,mask_meaning:"white = generate"},_meta:{title:"Snap mask to H3 grid"}},
          "R:masked":{class_type:"MiniMaxH3ContexMaskedTarget",inputs:{target_latent:["R:source",0],mask:["R:grid",0],mask_meaning:"white = generate",audio_mode:"preserve source audio",mask_conversion:"H3 exact (causal/token max)"},_meta:{title:"Lock source + mask repair region"}},
          "R:noise":{class_type:"RandomNoise",inputs:{noise_seed:seed},_meta:{title:"Repair seed"}},
          "R:sampler":{class_type:"KSamplerSelect",inputs:{sampler_name:"res_multistep"},_meta:{title:"H3 repair sampler"}},
          "R:sched":{class_type:"BasicScheduler",inputs:{model:["R:unet",0],scheduler:"simple",steps,denoise:1.0},_meta:{title:"H3 repair schedule"}},
          "R:guider":{class_type:"BasicGuider",inputs:{model:["R:unet",0],conditioning:["R:ctx",0]},_meta:{title:"H3 repair guider"}},
          "R:sample":{class_type:"SamplerCustomAdvanced",inputs:{noise:["R:noise",0],guider:["R:guider",0],sampler:["R:sampler",0],sigmas:["R:sched",0],latent_image:["R:masked",0]},_meta:{title:"Generate white mask region only"}},
          "R:decode":{class_type:"VAEDecode",inputs:{samples:["R:sample",0],vae:["R:vae",0]},_meta:{title:"Decode repaired frames"}},
          "R:video":{class_type:"CreateVideo",inputs:{images:["R:decode",0],audio:["R:source",2],fps:24,bit_depth:"auto",color_space:"sRGB"},_meta:{title:"Re-mux protected source audio"}},
          "R:save":{class_type:"SaveVideo",inputs:{video:["R:video",0],filename_prefix:"ComfyUI-MiniMaxH3-OneNode/H3_Repair",format:"auto",codec:"auto"},_meta:{title:"Save repaired video"}},
        };
        // Static mode keeps the original painter path. SAM mode replaces only the mask input
        // with a per-frame tracked mask built from the normalized H3 source timeline.
        let repairMaskRef=["R:mask",0];
        if(samTrack){
          g["R:samload"]={class_type:"CheckpointLoaderSimple",inputs:{ckpt_name:_sam3Checkpoint},_meta:{title:"SAM 3.1 tracker model"}};
          g["R:samtext"]={class_type:"CLIPTextEncode",inputs:{text:(S.repairSamPrompt||"").trim(),clip:["R:samload",1]},_meta:{title:"SAM 3.1 target prompt"}};
          g["R:samtrack"]={class_type:"SAM3_VideoTrack",inputs:{images:["R:source",1],model:["R:samload",0],conditioning:["R:samtext",0],detection_threshold:Math.max(0.1,Math.min(0.9,+S.repairSamThreshold||0.5)),max_objects:1,detect_interval:1},_meta:{title:"Track moving repair target"}};
          g["R:sammask"]={class_type:"SAM3_TrackToMask",inputs:{track_data:["R:samtrack",0],object_indices:""},_meta:{title:"Extract moving repair mask"}};
          repairMaskRef=["R:sammask",0];
          if(_sam3CleanupAvail&&S.repairSamCleanup){
            g["R:samclean"]={class_type:"MVEx_MaskCleanup",inputs:{masks:repairMaskRef,threshold:0.5,method:"shrink_grow","method.shrink":2,"method.min_frames":2,edge_grow:3},_meta:{title:"Clean SAM mask flicker / specks"}};
            repairMaskRef=["R:samclean",0];
          }
        } else {
          g["R:mask"]={class_type:"LoadImageMask",inputs:{image:S.repairMask,channel:"red"},_meta:{title:"White = generate mask"}};
        }
        g["R:grid"].inputs.mask=repairMaskRef;        if(!info.has_audio)g["R:silence"]={class_type:"EmptyAudio",inputs:{duration:(+info.duration||0)+0.5,sample_rate:32000,channels:2},_meta:{title:"Silent source track"}};
        if(hasRef){
          g["R:ref"]={class_type:"LoadImage",inputs:{image:S.repairRef,upload:"image"},_meta:{title:"Replacement reference image"}};
          g["R:cond"]={class_type:"MiniMaxH3ReferenceToVideo",inputs:{clip:["R:clip",0],vae:["R:vae",0],audio_vae:["R:avae",0],prompt:["R:current",4],width:["R:current",8],height:["R:current",9],length:["R:current",6],ref_image_size:"match","ref_images.ref_image_0":["R:ref",0]},_meta:{title:"Ref2VA replacement conditioning"}};
        } else {
          g["R:cond"]={class_type:"MiniMaxH3ImageToVideo",inputs:{clip:["R:clip",0],vae:["R:vae",0],prompt:["R:current",4],width:["R:current",8],height:["R:current",9],length:["R:current",6]},_meta:{title:"H3 repair conditioning"}};
        }
        // Reuse only the quality-preserving model patches from the normal node. Deliberately
        // omit Turbo, caches, and style LoRAs: repair needs stable mask edges, not speed tricks.
        let modelSrc=["R:unet",0];
        if(S.sigmaShiftOn){ g["R:shift"]={class_type:"MiniMaxH3SigmaShift",inputs:{model:modelSrc,shift_video:+S.shiftVideo||12,shift_audio:+S.shiftAudio||3},_meta:{title:"MiniMax H3 Sigma Shift"}}; modelSrc=["R:shift",0]; }
        if(S.sageAttn){ g["R:sage"]={class_type:"MiniMaxH3MemoryEfficientSageAttentionPatch",inputs:{model:modelSrc},_meta:{title:"MiniMax H3 Sage Attention"}}; modelSrc=["R:sage",0]; }
        if(S.solAttn){
          g["R:sol"]={class_type:"MiniMaxH3MemoryEfficientSolAttentionPatch",inputs:{model:modelSrc,enabled:true,tau:1.0,min_tokens:4096,strict:false,thresh_type:"diag",int8_qk:false,int8_pv:false,sink_conditioning:"exact_kv",dense_blocks:""},_meta:{title:"MiniMax H3 Sol-Attn"}}; modelSrc=["R:sol",0];
          g["R:solff"]={class_type:"MiniMaxH3ChunkFeedForward",inputs:{model:modelSrc,enabled:true,chunks:2,min_tokens:8192},_meta:{title:"MiniMax H3 FFN chunking"}}; modelSrc=["R:solff",0];
        }
        g["R:sched"].inputs.model=modelSrc; g["R:guider"].inputs.model=modelSrc;
        if(repairHd){
          // The first pass repairs only the native H3 source plate.  This second pass uses the
          // exact same safe topology as H3 Finish: neural video-latent upscale, untouched audio,
          // then low-denoise H3 windows fused in one latent timeline.  Crucially, the snapped
          // repair mask is applied again at the larger canvas so black pixels cannot be redesigned.
          g["R:sep2"]={class_type:"LTXVSeparateAVLatent",inputs:{av_latent:["R:sample",0]},_meta:{title:"Split repaired video + locked audio"}};
          g["R:lup2"]={class_type:"MinimaxH3LatentUpscaler3D",inputs:{latent:["R:sep2",0],model_name:(S.latentUpModel||_latentUpModels[0]||""),mode:"target dimensions","mode.width":target.w,"mode.height":target.h,align:32,enable_temporal_chunking:true,force_unload:true,device:"cuda",precision:"fp32"},_meta:{title:"Repair HD latent upscale"}};
          g["R:concat2"]={class_type:"LTXVConcatAVLatent",inputs:{video_latent:["R:lup2",0],audio_latent:["R:sep2",1]},_meta:{title:"Rejoin HD video + locked audio"}};
          g["R:masked2"]={class_type:"MiniMaxH3ContexMaskedTarget",inputs:{target_latent:["R:concat2",0],mask:["R:grid",0],mask_meaning:"white = generate",audio_mode:"preserve source audio",mask_conversion:"H3 exact (causal/token max)"},_meta:{title:"Lock protected pixels again at HD"}};
          if(hasRef){
            g["R:cond2"]={class_type:"MiniMaxH3ReferenceToVideo",inputs:{clip:["R:clip",0],vae:["R:vae",0],audio_vae:["R:avae",0],prompt:["R:current",4],width:target.w,height:target.h,length:+info.h3_frames,ref_image_size:"match","ref_images.ref_image_0":["R:ref",0]},_meta:{title:"HD replacement conditioning"}};
          } else {
            g["R:cond2"]={class_type:"MiniMaxH3ImageToVideo",inputs:{clip:["R:clip",0],vae:["R:vae",0],prompt:["R:current",4],width:target.w,height:target.h,length:+info.h3_frames},_meta:{title:"HD repair conditioning"}};
          }
          g["R:win2"]={class_type:"MMH3ContextWindows",inputs:{model:modelSrc,context_length:7,context_overlap:2,fuse_method:"pyramid",context_schedule:"standard_static",context_stride:1,freenoise:false,split_conds_to_windows:false,accumulator_device:"cpu"},_meta:{title:"HD repair windows (16GB safe)"}};
          g["R:sampler2"]={class_type:"KSamplerSelect",inputs:{sampler_name:"euler"},_meta:{title:"HD repair sampler"}};
          g["R:sched2"]={class_type:"BasicScheduler",inputs:{model:["R:win2",0],scheduler:"beta",steps:repairHdSteps,denoise:repairHdDenoise},_meta:{title:"HD repair low-denoise schedule"}};
          g["R:guider2"]={class_type:"BasicGuider",inputs:{model:["R:win2",0],conditioning:["R:cond2",0]},_meta:{title:"HD repair guider"}};
          g["R:noise2"]={class_type:"RandomNoise",inputs:{noise_seed:(seed+1)%1000000000000000},_meta:{title:"HD repair seed"}};
          g["R:sample2"]={class_type:"SamplerCustomAdvanced",inputs:{noise:["R:noise2",0],guider:["R:guider2",0],sampler:["R:sampler2",0],sigmas:["R:sched2",0],latent_image:["R:masked2",0]},_meta:{title:"HD repair refine (mask stays locked)"}};
          g["R:decode"].inputs.samples=["R:sample2",0];
          g["R:decode"]._meta.title="Decode HD repaired frames";
          g["R:save"].inputs.filename_prefix="ComfyUI-MiniMaxH3-OneNode/H3_Repair_HD";
        }
        await _submit(g);
      };
      const generate=async()=>{
        if(S.mode==="director") return assembleDirector();
        if(S.mode==="upscale") return upscaleGenerate();
        if(S.mode==="repair") return repairGenerate();
        if(S.generating)return;
        errBox.style.display="none";
        const studio=S.mode==="studio";
        const r2v=_isReferenceMode();
        // model validation
        const unet=r2v?S.unetRef:S.unetFl;
        const need=[unet,S.textEncoder,S.videoVae,S.audioVae];
        if(need.some(v=>!v)){ _activeShowError("Some models aren't selected. Open the Models panel → ↻ Rescan, or pick them manually."); modBody.style.display="block"; modHdr.textContent="▾ Models"; return; }
        if(studio&&!(_studioCastAvail&&_studioVideoAvail&&_studioSafeJoinAvail)){
          _activeShowError("H3 Studio needs native CGlide Cast + Glide Video and this node's H3 Studio Safe Join. ComfyUI has to be fully restarted once after this Studio update — browser refresh alone cannot load its Python seam node.");
          return;
        }
        if(S.sageAttn&&!_sageAvailable){ _activeShowError("Sage attention is on but MiniMaxH3MemoryEfficientSageAttentionPatch (KJNodes) isn't detected. Install ComfyUI-KJNodes + a recent sageattention, or turn it off in Advanced → Speed."); return; }
        if(S.solAttn&&!_solAvailable){ _activeShowError("Sol-Attn is on but its H3 nodes aren't detected. RESTART ComfyUI so ComfyUI-sol-attn registers (needs Blackwell + Triton), or turn it off in Advanced → Speed."); return; }
        if(S.turboOn&&!(_turboNode&&S.turboLora)){ _activeShowError("Turbo 4-step is on but isn't ready: "+(!_turboNode?"the ComfyUI-MiniMax-H3-Turbo node isn't registered (RESTART ComfyUI).":"no turbo LoRA found in models/loras (hit ↻ Rescan).")+" Or turn Turbo off in Advanced → Speed."); return; }
        if(S.lxTurbo!=="off"){
          const _fl=S.lxTurbo==="fl2v", _lora=_fl?_lxFl2vLora:_lxR2vLora, _okMode=_fl?!r2v:r2v;
          const _installed=(_fl?_lxFl2vLoras:_lxR2vLoras).some(f=>_norm(f)===_norm(_lora));
          if(!_turboNode){ _activeShowError("The 1-click Turbo preset needs the ComfyUI-MiniMax-H3-Turbo node — RESTART ComfyUI, or set the preset to Off (Advanced → Speed)."); return; }
          if(!_lora||!_installed){ _activeShowError("The exact pinned "+(_fl?"FL2V":"R2V")+" Turbo recipe isn't in models/loras. Restore that file, choose another file in Advanced → Speed, or set the preset to Off."); return; }
          if(!_okMode){ _activeShowError("The "+(_fl?"FL2V":"R2V")+" Turbo preset only runs in "+(_fl?"T2V / I2V / Studio First–Last":"R2V / Studio References")+" mode. Switch mode, or set the preset to Off (Advanced → Speed)."); return; }
        }
        if(S.pddOn){
          const _pddFile=_pddFileForMode(), _pddNeed=r2v?"ref2va":"fl2va";
          if(!_pddReady()){ _activeShowError("PDD Acceleration is on but its official nodes are not registered yet. Restart ComfyUI so ComfyUI-MiniMax-H3-PDD-Acc loads, then try again."); return; }
          if(!_pddFile||!_norm(_pddFile).includes(_pddNeed)){ _activeShowError("PDD Acceleration needs the matching "+(r2v?"Ref2VA":"FL2VA")+" 8-step file. Restart ComfyUI, then open Advanced → PDD Acceleration and let it auto-select the right file."); return; }
        }
        if(S.cacheEngine!=="off"){ const _ca={teacache:_teaAvailable,spectrum:_spectrumAvailable,fbc:_fbcAvailable,easycache:_easycacheAvailable}[S.cacheEngine]; const _cn={teacache:"ComfyUI-MiniMaxH3-TeaCache",spectrum:"ComfyUI-Spectrum-MiniMax-H3",fbc:"ComfyUI-MiniMaxH3-FirstBlockCache",easycache:"ComfyUI core"}[S.cacheEngine]; if(!_ca){ _activeShowError(S.cacheEngine==="easycache" ? "EasyCache is native to ComfyUI core but isn't registered — update + RESTART ComfyUI, or set Cache to Off in Advanced → Speed." : "The cache accelerator ("+S.cacheEngine+") isn't detected. Install "+_cn+" in custom_nodes + RESTART ComfyUI, or set Cache to Off in Advanced → Speed."); return; } }
        const _twoPassMode=S.twoPass&&(S.mode==="t2v"||S.mode==="i2v"||S.mode==="r2v"||studio);
        const _windowed2p=!!S.twoPassWindowed;
        if(_twoPassMode&&_windowed2p&&!_windowedTwoPassReady()){
          _activeShowError(S.twoPassEngine==="latent"
            ? "16GB-safe Latent needs Comfyui_Minimax_h3_latent_Upscaler with a selected model, plus MiniMax H3 Context Windows, MMH3 Split AV and MMH3 Pack AV. Update/install the nodes, rescan models, then restart ComfyUI."
            : "16GB-safe Stage 2 needs the registered MMH3Tools nodes: MMH3 Chunked Pixel Upscale, MiniMax H3 Context Windows, MMH3 Split AV and MMH3 Pack AV. Update/install ComfyUI-MMH3Tools, then restart ComfyUI.");
          return;
        }
        if(_twoPassMode&&_windowed2p&&(+S.stage2Denoise||0.2)>0.25){ _activeShowError("16GB-safe Stage 2 is a low-denoise refine only. Set Two-pass HD Denoise to 0.20–0.25 so the overlapping H3 windows preserve the character instead of inventing new details."); return; }
        if(_twoPassMode&&!_windowed2p&&!(_ptConcatAvail&&_t8DecodeAvail)){ _activeShowError("Two-pass HD needs ComfyUI-PT_H3ConcatAVLatent + comfyui-minimax-h3-audio-T8 — install both + RESTART ComfyUI, or turn Two-pass off (Video panel)."); return; }
        if(_twoPassMode&&!_windowed2p&&S.twoPassEngine==="latent"&&!(_latentUpAvail && (S.latentUpModel||_latentUpModels.length))){ _activeShowError("Two-pass Latent engine needs Comfyui_Minimax_h3_latent_Upscaler + a model in models/latent_upscale_models — install + RESTART ComfyUI, or switch Upscale to Pixel (Video → Two-pass HD)."); return; }
        // mode-specific validation
        if(S.mode==="i2v"&&!S.firstFrame){ _activeShowError("I2V needs a first frame — drop an image in the Frames panel (or switch to T2V)."); return; }
        let refImgNames=[], refVids=[], refAuds=[];
        if(r2v){
          const lim=S.allow9?MAX_REF_IMAGES:REF_IMAGES_SAFE;
          for(let i=0;i<lim;i++){ if(S.refImages[i]) refImgNames.push(S.refImages[i]); }
          S.refVideos.forEach(v=>{ if(v.file) refVids.push({file:v.file,useAudio:!!v.useAudio,start:+v.start||0,end:+v.end||0}); });
          S.refAudios.forEach((a,idx)=>{ if(a){ const t=S.refAudioTrim[idx]||{}; refAuds.push({file:a,start:+t.start||0,end:+t.end||0}); } });
          // CGlide deliberately treats Continue From as a guide, not a normal reference
          // slot. That guide alone is a complete valid Studio continuation, so do not
          // make users upload the same video twice just to pass the ordinary R2V guard.
          const hasStudioContinuation=studio&&!!S.studioContinue;
          if(!refImgNames.length&&!refVids.length&&!refAuds.length&&!hasStudioContinuation){ _activeShowError(studio?"Studio References mode needs a reference or a Continue From clip. Add either one — not the same video in both places.":"R2V needs at least one reference (image, video, or audio) in the Reference editor."); return; }
        }

        S.generating=true; genBtn.disabled=true; genBtn.style.opacity=".6"; genBtn.textContent="… generating"; errBox.style.display="none";
        _genStart=Date.now(); _lastPct=0; _lastVal=null; _lastMax=null; renderProg();
        if(_progTimer)clearInterval(_progTimer); _progTimer=setInterval(()=>{ if(S.generating)renderProg(); },1000);

        const wfUrl=r2v?"/minimaxh3/workflow_r2v":"/minimaxh3/workflow_iv";
        let wf;
        try{ const r=await api.fetchApi(wfUrl); if(!r.ok)throw new Error("HTTP "+r.status); wf=await r.json(); }
        catch(e){ _activeShowError("Could not load workflow (404 = restart ComfyUI): "+fmtErr(e)); reset(); return; }
        const prompt=JSON.parse(JSON.stringify(wf));
        const set=(id,k,v)=>{ if(prompt[id])prompt[id].inputs[k]=v; };

        // H3 Studio is deliberately drafted small before its safe latent refine.  The
        // normal modes keep their existing Resolution behaviour unchanged.
        const _studioDraftMp=studio&&S.twoPass?Math.min(+S.stage1Mp||0.5,+_stage2TargetMp()):(+S.megapixels||0.4);
        // resolution + length
        const {w,h}=calcRes(S.aspect,_studioDraftMp,MULTIPLE);
        const _studioFinalRes=studio&&S.twoPass
          ?calcRes(S.aspect,Math.max(+_stage2TargetMp()||2,_studioDraftMp),MULTIPLE)
          :{w,h};
        const len=durToLen(S.duration);
        const seed=S.randomizeSeed?Math.floor(Math.random()*1e15):(+S.seed||0);

        // CGlide owns the H3 Studio presentation: it converts stable @slot tags
        // into the correct <Picture>/<Video>/<Audio> ordering, creates the tail
        // guide for continuation, and gives us a refine-safe conditioning output.
        // The One Node still owns model selection, LoRAs, speed patches and stage 2.
        let studioData=null;
        if(studio){
          const lim=S.allow9?MAX_REF_IMAGES:REF_IMAGES_SAFE;
          const shotSeconds=len/FPS;
          const capSeconds=S.refVidCap?Math.min(+S.refVidCapSec||4,shotSeconds+0.6):shotSeconds+0.6;
          const videos=S.refVideos.slice(0,MAX_REF_VIDEOS).map(v=>{
            if(!v||!v.file)return null;
            const start=+v.start||0, enteredEnd=+v.end||0;
            const end=enteredEnd>start?Math.min(enteredEnd,start+capSeconds):start+capSeconds;
            return {file:v.file,start,end,audio:!!v.useAudio,carry:false,pick:false};
          });
          const audios=S.refAudios.slice(0,MAX_REF_AUDIOS).map((file,i)=>{
            if(!file)return null;
            const trim=S.refAudioTrim[i]||{}, start=+trim.start||0, enteredEnd=+trim.end||0;
            // Capping an untrimmed audio reference to this shot avoids encoding a
            // whole song as conditioning on a 16 GB card.
            const end=enteredEnd>start?enteredEnd:start+shotSeconds+0.6;
            return {file,start,end};
          });
          studioData={
            mode:S.studioMode,width:w,height:h,length:len,
            ref_image_size:S.refImageSize==="max"?"max":"match",prompt:S.prompt||"",
            slots:S.studioMode==="fl2va"
              ?{first:S.firstFrame?{file:S.firstFrame}:null,last:(S.useLastFrame&&S.lastFrame)?{file:S.lastFrame}:null,images:[],videos:[],audios:[]}
              :{first:null,last:null,images:S.refImages.slice(0,lim).map(file=>file?{file}:null),videos,audios},
            cont:S.studioContinue?{file:S.studioContinue,frames:S.studioContinueFrames===39?39:22,audio:!!S.studioContinueAudio,flatten:+S.studioContinueFlatten||0}:null,
          };
        }

        // snapshot the settings behind this render (saved to the clip once it finishes,
        // so the gallery can display them + restore them). seed = the ACTUAL seed used.
        S._pendingMeta=(()=>{
          const _pdd=S.pddOn&&_pddReady()&&!!_pddFileForMode();
          const _turbo=!_pdd&&S.turboOn && _turboNode && !!S.turboLora;
          const _safe2p=!!S.twoPassWindowed;
          const _twoPassReady=_safe2p?_windowedTwoPassReady():(_ptConcatAvail&&_t8DecodeAvail);

          const mm={v:1,mode:S.mode,prompt:S.prompt||"",aspect:S.aspect,megapixels:studio?(S.twoPass?(+S.stage2Mp||2):_studioDraftMp):S.megapixels,w:studio?_studioFinalRes.w:w,h:studio?_studioFinalRes.h:h,duration:S.duration,
            steps:_pdd?(+S.pddNfe||8):(+S.steps||20),sampler:_pdd?"euler":S.sampler,scheduler:S.scheduler,seed:seed,wasRandom:!!S.randomizeSeed,
            sigmaShiftOn:!!(_pdd||(S.sigmaShiftOn&&!_turbo)),shiftVideo:_pdd?12:S.shiftVideo,shiftAudio:_pdd?3:S.shiftAudio,
            sageAttn:!!S.sageAttn,solAttn:!!S.solAttn,fastFp8:!!S.fastFp8,cacheEngine:_pdd?"off":(S.cacheEngine||"off"),
            turboOn:!!_turbo,turboSteps:+S.turboSteps||6,turboLora:S.turboLora||"",turboStrength:S.turboStrength,
            pddOn:!!_pdd,pddNfe:String(S.pddNfe||"8"),pddFile:_pdd?_pddFileForMode():"",
            twoPass:!!(S.twoPass&&(S.mode==="t2v"||S.mode==="i2v"||S.mode==="r2v"||studio)&&_twoPassReady),twoPassEngine:S.twoPassEngine,twoPassWindowed:_safe2p,twoPassWindowProfile:S.twoPassWindowProfile,stage1Mp:S.stage1Mp,stage2Mp:S.stage2Mp,stage2MpOverride:S.stage2MpOverride,stage2Steps:S.stage2Steps,stage2Denoise:S.stage2Denoise};
          if(S.mode==="i2v"){ mm.useLastFrame=!!(S.useLastFrame&&S.lastFrame); mm.firstFrame=S.firstFrame||null; mm.lastFrame=mm.useLastFrame?S.lastFrame:null; }
          if(r2v){ mm.allow9=!!S.allow9; mm.refImageSize=S.refImageSize;
            mm.refImages=S.refImages.slice(0,S.allow9?MAX_REF_IMAGES:REF_IMAGES_SAFE);
            mm.refVideos=S.refVideos.map(v=>({file:v.file||null,useAudio:!!v.useAudio,start:+v.start||0,end:+v.end||0}));
            mm.refAudios=S.refAudios.slice();
            mm.refAudioTrim=S.refAudioTrim.map(t=>({start:(t&&+t.start)||0,end:(t&&+t.end)||0})); }
          if(studio){
            mm.studioMode=S.studioMode; mm.studioContinue=S.studioContinue||null;
            mm.studioContinueFrames=S.studioContinueFrames===39?39:22;
            mm.studioContinueAudio=!!S.studioContinueAudio; mm.studioContinueFlatten=+S.studioContinueFlatten||0;
            mm.studioSeamMode=S.studioSeamMode; mm.studioSeamBlend=+S.studioSeamBlend||6;
            if(S.studioMode==="fl2va"){ mm.useLastFrame=!!(S.useLastFrame&&S.lastFrame); mm.firstFrame=S.firstFrame||null; mm.lastFrame=mm.useLastFrame?S.lastFrame:null; }
          }
          return mm;
        })();

        // loaders
        set("M:unet","unet_name",unet);
        // INT8 (W8A8 / convrot) checkpoints carry their own quantization in the file — ComfyUI reads
        // the quant_format and runs its native int8 kernels. Layering fp8 on top would conflict, so
        // force weight_dtype=default for int8 models (the fast-fp8 toggle only applies to fp16/bf16).
        const _int8Unet=/int8|w8a8|convrot/i.test(unet);
        set("M:unet","weight_dtype",(!_int8Unet && S.fastFp8)?"fp8_e4m3fn_fast":"default");
        set("M:clip","clip_name",S.textEncoder);
        set("M:vae","vae_name",S.videoVae);
        set("M:avae","vae_name",S.audioVae);
        // conditioning. Studio replaces the stock conditioning node with CGlide's
        // native Cast output; its second output is the correct blank AV latent,
        // and output 9 deliberately strips only incompatible keyframe anchors for
        // the higher-resolution stage-2 refine.
        const condId=studio?"M:studio":"M:cond";
        if(studio){
          delete prompt["M:cond"];
          prompt["M:studio"]={class_type:"CSGlideCastCS",inputs:{clip:["M:clip",0],vae:["M:vae",0],audio_vae:["M:avae",0],h3_data:JSON.stringify(studioData||{})},_meta:{title:"H3 Studio · native CGlide cast"}};
          set("M:samp","latent_image",["M:studio",1]);
          set("M:guider","conditioning",["M:studio",0]);
        } else {
          set("M:cond","prompt",S.prompt||"");
          set("M:cond","width",w); set("M:cond","height",h); set("M:cond","length",len);
          if(r2v) set("M:cond","ref_image_size",S.refImageSize);
        }
        // PDD owns the sampler schedule and per-step head bank. It must win over every other
        // distillation path even if an older saved state still has a Turbo/cache flag enabled.
        const pdd=S.pddOn&&_pddReady()&&!!_pddFileForMode(), pddFile=pdd?_pddFileForMode():"";
        // distilled-turbo PRESET (lightx2v) — locked recipe; uses a NORMAL euler sampler + forced
        // sigma shift, NOT the TurboSampler. FL2V rides T2V/I2V; R2V rides R2V and keeps audio refs.
        const lxFl2v = !pdd&&S.lxTurbo==="fl2v" && _turboNode && !!_lxFl2vLora && !r2v;
        const lxR2v  = !pdd&&S.lxTurbo==="r2v"  && _turboNode && !!_lxR2vLora  && r2v;
        const lx = lxFl2v || lxR2v;
        const lxLora = lxFl2v ? _lxFl2vLora : (lxR2v ? _lxR2vLora : "");
        // LightX 8-step files use 8 NFE. FL2V 4-step uses 6/3 shifts; FL2V 8-step and
        // every Ref2V recipe use 12/3. The pinned filename makes this deterministic.
        const _lx8 = /8[_-]?step/i.test(lxLora);
        const lxShiftV = lxFl2v ? (_lx8?12:6) : 12, lxShiftA = 3;
        // sampler / scheduler / seed / fps — Turbo overrides steps + sampler (preset wins over manual turbo)
        const turbo=!pdd&&S.turboOn && _turboNode && !!S.turboLora && !lx;
        // Audio-aware Turbo R2V: the installed MiniMax-H3-Turbo sampler carries the
        // ref_audio_t conditioning row added by Larry's compatibility update. Keep every
        // user-selected paired video soundtrack and standalone reference-audio input wired
        // into Ref2VA; the Turbo sampler below handles the video/audio flow schedules.
        if(turbo){ set("M:sched","scheduler","simple"); set("M:sched","steps",+S.turboSteps||6); }
        else if(lx){ set("M:sched","scheduler","simple"); set("M:sched","steps",_lx8?8:4); }
        else { set("M:sched","scheduler",S.scheduler); set("M:sched","steps",+S.steps||20); }
        if(turbo) prompt["M:sampsel"]={class_type:"MiniMaxH3TurboSampler",inputs:{},_meta:{title:"MiniMax H3 Turbo Sampler (4-step)"}};
        else set("M:sampsel","sampler_name",(lx||pdd)?"euler":S.sampler);
        set("M:noise","noise_seed",seed);
        set("M:cvid","fps",FPS);

        // model-patch chain: UNETLoader → [sigma shift] → [sage] → [turbo LoRA] → scheduler/guider.
        // Turbo's sampler hardcodes the 12/3 flow shifts, so custom sigma shift is skipped when it's on.
        let modelSrc=["M:unet",0];
        // Style / character LoRA (any H3-format LoRA) via the H3 applicator, first in the chain.
        // Force merge mode when Turbo is also on: two bypass-LoRA nodes collide on the same
        // "bypass_lora" injection key (the 2nd would replace the 1st), so merge composes safely.
        if(S.styleOn && _turboNode && Array.isArray(S.styleLoras)){
          const _activeStyles=S.styleLoras.filter(e=>e&&e.lora&&e.lora!=="(none found)");
          // 2+ stacked (or Turbo also on) forces merge mode — bypass-mode H3 LoRA patches collide on
          // a shared injection key when more than one is applied, so merge is the only safe path then.
          const _forceMerge=_activeStyles.length>1||turbo||lx||pdd;
          _activeStyles.forEach((entry,i)=>{
            const _id="M:stylelora"+i;
            prompt[_id]={class_type:"MiniMaxH3TurboLoRA",inputs:{model:modelSrc,lora_name:entry.lora,strength:+entry.strength||1.0,low_vram:(_forceMerge||!!S.styleLowVram)},_meta:{title:"Style LoRA "+(i+1)+" (H3)"}};
            modelSrc=[_id,0];
          });
        }
        if(pdd){
          // Exact official PDD flow shifts. Its final-layer heads are trained only on this grid.
          prompt["M:shift"]={class_type:"MiniMaxH3SigmaShift",inputs:{model:modelSrc,shift_video:12,shift_audio:3},_meta:{title:"MiniMax H3 Sigma Shift (PDD 12/3)"}};
          modelSrc=["M:shift",0];
        } else if(lx){
          // preset forces its trained shift (FL2V 6/3, R2V 12/3), overriding any manual shift
          prompt["M:shift"]={class_type:"MiniMaxH3SigmaShift",inputs:{model:modelSrc,shift_video:lxShiftV,shift_audio:lxShiftA},_meta:{title:"MiniMax H3 Sigma Shift (preset)"}};
          modelSrc=["M:shift",0];
        } else if(S.sigmaShiftOn && !turbo){
          prompt["M:shift"]={class_type:"MiniMaxH3SigmaShift",inputs:{model:modelSrc,shift_video:+S.shiftVideo||12,shift_audio:+S.shiftAudio||3},_meta:{title:"MiniMax H3 Sigma Shift"}};
          modelSrc=["M:shift",0];
        }
        if(S.sageAttn){
          prompt["M:sage"]={class_type:"MiniMaxH3MemoryEfficientSageAttentionPatch",inputs:{model:modelSrc},_meta:{title:"MiniMax H3 Sage Attention (mem-efficient)"}};
          modelSrc=["M:sage",0];
        }
        if(S.solAttn){
          // NVIDIA Sol-Attn sparse attention (keeps prompt/ref/audio KV exact) + FFN chunking (−37% MLP peak VRAM).
          prompt["M:sol"]={class_type:"MiniMaxH3MemoryEfficientSolAttentionPatch",inputs:{model:modelSrc,enabled:true,tau:1.0,min_tokens:4096,strict:false,thresh_type:"diag",int8_qk:false,int8_pv:false,sink_conditioning:"exact_kv",dense_blocks:""},_meta:{title:"MiniMax H3 Sol-Attn (sparse)"}};
          modelSrc=["M:sol",0];
          prompt["M:solff"]={class_type:"MiniMaxH3ChunkFeedForward",inputs:{model:modelSrc,enabled:true,chunks:2,min_tokens:8192},_meta:{title:"MiniMax H3 FFN chunking (VRAM saver)"}};
          modelSrc=["M:solff",0];
        }
        if(pdd){
          prompt["M:pdd"]={class_type:"MiniMaxH3PDDAccApply",inputs:{model:modelSrc,pdd_file:pddFile,nfe:String(S.pddNfe||"8"),lora_strength:1.0,head_strength:1.0,on_off_grid:"error",partition_check:"error"},_meta:{title:"PDD Acc official trunk + head bank"}};
          modelSrc=["M:pdd",0];
          // Full first pass uses the exact trained PDD sigma boundaries—not BasicScheduler.
          prompt["M:samp"].inputs.sigmas=["M:pdd",1];
        } else if(turbo){
          prompt["M:turbo"]={class_type:"MiniMaxH3TurboLoRA",inputs:{model:modelSrc,lora_name:S.turboLora,strength:+S.turboStrength||1.0,low_vram:!!S.turboLowVram},_meta:{title:"MiniMax H3 Turbo LoRA (4-step)"}};
          modelSrc=["M:turbo",0];
        } else if(lx){
          prompt["M:turbo"]={class_type:"MiniMaxH3TurboLoRA",inputs:{model:modelSrc,lora_name:lxLora,strength:1.0,low_vram:!!S.turboLowVram},_meta:{title:"H3 LightX Distilled Turbo ("+(_lx8?"8":"4")+"-step, pinned file)"}};
          modelSrc=["M:turbo",0];
        }
        // Cache accelerator (step reuse) — applied LAST so it wraps the fully-patched model, right
        // before the guider/scheduler. Mutually exclusive; skips redundant transformer work on
        // near-identical timesteps. total_steps must match the scheduler (turbo overrides steps).
        if(!pdd && S.cacheEngine!=="off"){
          const _steps=turbo?(+S.turboSteps||6):(lx?(_lx8?8:4):(+S.steps||20));
          if(S.cacheEngine==="teacache" && _teaAvailable){
            prompt["M:cache"]={class_type:"MiniMaxH3TeaCache",inputs:{model:modelSrc,rel_l1_thresh:+S.teaThresh||0.15,start_step:2,end_step:-2,total_steps:_steps},_meta:{title:"TeaCache (step reuse)"}};
            modelSrc=["M:cache",0];
          } else if(S.cacheEngine==="spectrum" && _spectrumAvailable){
            prompt["M:cache"]={class_type:"SpectrumApplyMiniMaxH3",inputs:{model:modelSrc,enabled:true,blend_weight:+S.spectrumBlend||0.5,degree:1,ridge_lambda:0.10,window_size:2.0,flex_window:0.75,warmup_steps:1,tail_actual_steps:1,max_history:8,debug:false,audio_blend_weight:0.0,history_storage:"system_ram",offline_smoothing_replay:true,offline_archive_storage:"system_ram"},_meta:{title:"Spectrum (spectral forecast)"}};
            modelSrc=["M:cache",0];
          } else if(S.cacheEngine==="fbc" && _fbcAvailable){
            prompt["M:cache"]={class_type:"ApplyMiniMaxH3FirstBlockCache",inputs:{model:modelSrc,mode:S.fbcMode||"H3 Fast — 0.10 / max 2",threshold:0.10,start_percent:0.10,end_percent:0.95,max_consecutive_hits:2,temporal_guard:false},_meta:{title:"FirstBlockCache"}};
            modelSrc=["M:cache",0];
          } else if(S.cacheEngine==="easycache" && _easycacheAvailable){
            prompt["M:cache"]={class_type:"EasyCache",inputs:{model:modelSrc,reuse_threshold:+S.easyThresh||0.2,start_percent:0.15,end_percent:0.95,verbose:false},_meta:{title:"EasyCache (native, step reuse)"}};
            modelSrc=["M:cache",0];
          }
        }
        // Keep the fully optimized, pre-preview model for a memory-safe stage 2. The stage-2
        // window pass deliberately skips preview work; stage 1 remains previewable as usual.
        const modelBeforePreview=modelSrc;
        // Stage 3 - live preview: patch the (fully-patched) model to stream animated previews while sampling.
        if(S.livePreview && _cglidePrevAvail){
          prompt["M:prev"]={class_type:"CSGlidePreviewCS",inputs:{model:modelSrc,mode:"animated",fps:7.2,columns:4,every_n_steps:2,max_resolution:512,sampler_preview:false,decoder:"taeh3.safetensors"},_meta:{title:"Live preview (CGlide)"}};   // taeh3 = sharp; CGlide falls back to latent2rgb if absent
          modelSrc=["M:prev",0];
        }
        set("M:sched","model",modelSrc); set("M:guider","model",modelSrc);

        // mode inputs
        // Reframe every input image to the output canvas (w×h) so the last frame + all refs
        // perfectly match the first frame's aspect. crop=center = "match" (no distortion).
        let _ffSrc=["M:ff",0], _lfSrc=["M:lf",0];
        const _rfCrop = S.reframe==="stretch" ? "disabled" : (S.reframe==="off" ? null : "center");
        const _reframed=(srcKey,dstKey)=>{ if(!_rfCrop) return [srcKey,0];
          prompt[dstKey]={class_type:"ImageScale",inputs:{image:[srcKey,0],upscale_method:"lanczos",width:w,height:h,crop:_rfCrop},_meta:{title:"Reframe "+w+"x"+h}}; return [dstKey,0]; };
        if(studio){
          // CGlide Cast already loaded and encoded Studio's first/last frames or
          // reference slots.  Do not build a second generic reference graph here.
        } else if(S.mode==="i2v"){
          prompt["M:ff"]={class_type:"LoadImage",inputs:{image:S.firstFrame,upload:"image"},_meta:{title:"First frame"}};
          _ffSrc=_reframed("M:ff","M:ffr"); prompt["M:cond"].inputs.first_frame=_ffSrc;
          if(S.useLastFrame&&S.lastFrame){ prompt["M:lf"]={class_type:"LoadImage",inputs:{image:S.lastFrame,upload:"image"},_meta:{title:"Last frame"}}; _lfSrc=_reframed("M:lf","M:lfr"); prompt["M:cond"].inputs.last_frame=_lfSrc; }
        } else if(r2v){
          // reference images — contiguous ref_image_0..N-1 (dotted autogrow keys)
          refImgNames.forEach((name,i)=>{
            const id="M:ri"+i;
            prompt[id]={class_type:"LoadImage",inputs:{image:name,upload:"image"},_meta:{title:`Ref image ${i+1}`}};
            prompt["M:cond"].inputs["ref_images.ref_image_"+i]=_reframed(id,id+"r");
          });
          // reference videos — LoadVideo -> GetVideoComponents (images + optional paired audio)
          refVids.forEach((v,i)=>{
            const lid="M:rv"+i, cid="M:rvc"+i;
            prompt[lid]={class_type:"LoadVideo",inputs:{file:v.file},_meta:{title:`Ref video ${i+1}`}};
            let vsrc=[lid,0];
            // Reference-video window (seconds). H3 only consumes up to `length` frames of each
            // reference (it slices to frame_count internally), so we ALWAYS cap the decoded window
            // to the output length — otherwise GetVideoComponents decodes the ENTIRE source clip
            // (big VRAM + slow) before the core discards the excess. The low-VRAM toggle caps tighter
            // still (default 4s) so a full 10–15s ref can't overflow 16 GB; off = full output-length
            // window (24 GB+). An explicit end trim always wins if it's shorter. end 0 = to finish.
            const vs=+v.start||0, ve=+v.end||0;
            const _outCap=len/FPS+0.6;                                          // output length (+margin), seconds
            const _capSec=S.refVidCap?Math.min((+S.refVidCapSec||4),_outCap):_outCap;
            const _refWin=(ve>vs)?Math.min(ve-vs,_capSec):_capSec;              // explicit trim wins if shorter
            const sid="M:rvt"+i;
            prompt[sid]={class_type:"Video Slice",inputs:{video:vsrc,start_time:vs,duration:_refWin,strict_duration:false},_meta:{title:`Ref video ${i+1} window (≤${_refWin.toFixed(1)}s)`}};
            vsrc=[sid,0];
            prompt[cid]={class_type:"GetVideoComponents",inputs:{video:vsrc},_meta:{title:`Ref video ${i+1} frames`}};
            prompt["M:cond"].inputs["ref_videos.ref_video_"+i]=[cid,0];
            if(v.useAudio) prompt["M:cond"].inputs["ref_video_audios.ref_video_audio_"+i]=[cid,1];
          });
          // standalone reference audio — LoadAudio
          refAuds.forEach((a,i)=>{
            const id="M:ra"+i;
            prompt[id]={class_type:"LoadAudio",inputs:{audio:a.file},_meta:{title:`Ref audio ${i+1}`}};
            let asrc=[id,0];
            // optional start/end trim (seconds) — end 0 = to the finish (large duration)
            const as=+a.start||0, ae=+a.end||0;
            if(as>0 || ae>as){ const tid="M:rat"+i; prompt[tid]={class_type:"TrimAudioDuration",inputs:{audio:asrc,start_index:as,duration:(ae>as?ae-as:100000)},_meta:{title:`Ref audio ${i+1} trim`}}; asrc=[tid,0]; }
            prompt["M:cond"].inputs["ref_audios.ref_audio_"+i]=asrc;
          });
        }

        // ── Two-pass HD (hires-fix): stage 1 renders low-res, then decode → upscale frames →
        // re-encode the video latent → re-join the stage-1 audio latent → stage-2 partial-denoise
        // refine at the target res. T2V / I2V only (fl2va). Mirrors the proven two-stage workflow
        // (euler + beta, stage 2 = 4 steps / denoise 0.2). Both stages use the SAME frame count. ──
        const _windowedStage2=!!(S.twoPassWindowed&&_windowedTwoPassReady());
        if(S.twoPass && (S.mode==="t2v"||S.mode==="i2v"||S.mode==="r2v"||studio) && (_windowedStage2||(_ptConcatAvail&&_t8DecodeAvail))){
          const _r2v=r2v;
          // I2V/T2V/First+Last: stage 1 = Draft, stage 2 = explicitly selected Refine target.
          // R2V: stage 1 keeps the base/reference canvas, stage 2 can only refine upward.
          const _stage2Mp=_stage2TargetMp();
          const s2res=_r2v ? calcRes(S.aspect,Math.max(_stage2Mp,S.megapixels),MULTIPLE) : calcRes(S.aspect,Math.max(_stage2Mp,+S.stage1Mp||0.4),MULTIPLE);
          if(!_r2v&&!studio){ const s1=calcRes(S.aspect,Math.min(+S.stage1Mp||0.4,_stage2Mp),MULTIPLE); set("M:cond","width",s1.w); set("M:cond","height",s1.h); }
          let stage2Latent;
          if(_windowedStage2&&S.twoPassEngine==="pixel"){
            // The VAE/pixel handoff is streamed in one 17-frame H3 group at a time. The
            // output remains one AV latent; it is not a set of independently generated clips.
            prompt["M:chunkup2"]={class_type:"MMH3ChunkedPixelUpscale",inputs:{latent:["M:samp",0],vae:["M:vae",0],width:s2res.w,height:s2res.h,method:_rtxAvailable?"rtx_vsr":"lanczos-ish bicubic",groups_per_chunk:1,rtx_quality:S.rtxQuality||"ULTRA",offload_latents:true},_meta:{title:"Stage 2 streamed pixel upscale (17f groups)"}};
            prompt["M:split2"]={class_type:"MMH3SplitAV",inputs:{latent:["M:chunkup2",0],preserve_masks:true},_meta:{title:"Split stage-2 AV latent"}};
            prompt["M:audiozero2"]={class_type:"SolidMask",inputs:{value:0,width:32,height:32},_meta:{title:"Zero audio denoise mask"}};
            prompt["M:audiolock2"]={class_type:"SetLatentNoiseMask",inputs:{samples:["M:split2",1],mask:["M:audiozero2",0]},_meta:{title:"Lock stage-1 audio"}};
            prompt["M:pack2"]={class_type:"MMH3PackAV",inputs:{video_latent:["M:split2",0],audio_latent:["M:audiolock2",0]},_meta:{title:"Re-pack video + locked audio"}};
            stage2Latent=["M:pack2",0];
          } else if(S.twoPassEngine==="latent" && _latentUpAvail){
            // LATENT-SPACE upscale: split the AV latent, upscale ONLY the video latent with the
            // neural upscaler, rejoin the untouched audio latent. No decode/encode round trip; the
            // upscaler never sees audio. LTXVSeparate/Concat ship with ComfyUI core.
            prompt["M:sep"]={class_type:"LTXVSeparateAVLatent",inputs:{av_latent:["M:samp",0]},_meta:{title:"Split AV latent (video / audio)"}};
            prompt["M:lup"]={class_type:"MinimaxH3LatentUpscaler3D",inputs:{latent:["M:sep",0],model_name:(S.latentUpModel||_latentUpModels[0]||""),mode:"target dimensions","mode.width":s2res.w,"mode.height":s2res.h,align:32,enable_temporal_chunking:true,force_unload:true,device:"cuda",precision:"fp32"},_meta:{title:"Latent upscale → refine res"}};
            prompt["M:concat"]={class_type:"LTXVConcatAVLatent",inputs:{video_latent:["M:lup",0],audio_latent:["M:sep",1]},_meta:{title:"Re-join AV latent (stage-2 start)"}};
            if(_windowedStage2){
              prompt["M:split2"]={class_type:"MMH3SplitAV",inputs:{latent:["M:concat",0],preserve_masks:true},_meta:{title:"Split latent-upscaled AV"}};
              prompt["M:audiozero2"]={class_type:"SolidMask",inputs:{value:0,width:32,height:32},_meta:{title:"Zero audio denoise mask"}};
              prompt["M:audiolock2"]={class_type:"SetLatentNoiseMask",inputs:{samples:["M:split2",1],mask:["M:audiozero2",0]},_meta:{title:"Lock stage-1 audio"}};
              prompt["M:pack2"]={class_type:"MMH3PackAV",inputs:{video_latent:["M:split2",0],audio_latent:["M:audiolock2",0]},_meta:{title:"Re-pack latent video + locked audio"}};
              stage2Latent=["M:pack2",0];
            } else stage2Latent=["M:concat",0];
          } else {
            // PIXEL-SPACE upscale (default): decode → VSR/Lanczos → re-encode → rejoin.
            prompt["M:t8dec"]={class_type:"MiniMaxH3AVDecodeT8",inputs:{av_latent:["M:samp",0],video_vae:["M:vae",0],audio_vae:["M:avae",0]},_meta:{title:"Stage 1 decode → frames + audio latent"}};
            // upscale frames to the stage-2 res — R2V prefers RTX VSR (clean hardware); else Lanczos
            if(_r2v && _rtxAvailable){
              prompt["M:up"]={class_type:"RTXVideoSuperResolution",inputs:{images:["M:t8dec",0],resize_type:"target dimensions","resize_type.width":s2res.w,"resize_type.height":s2res.h,quality:S.rtxQuality||"ULTRA"},_meta:{title:"RTX VSR upscale → refine res"}};
            } else {
              prompt["M:up"]={class_type:"ImageScale",inputs:{image:["M:t8dec",0],upscale_method:"lanczos",width:s2res.w,height:s2res.h,crop:"disabled"},_meta:{title:"Upscale frames → stage-2 res"}};
            }
            prompt["M:enc"]={class_type:"VAEEncode",inputs:{pixels:["M:up",0],vae:["M:vae",0]},_meta:{title:"Re-encode video latent (stage 2)"}};
            prompt["M:concat"]={class_type:"PT_H3ConcatAVLatent",inputs:{video_latent:["M:enc",0],audio_latent:["M:t8dec",3]},_meta:{title:"Re-join AV latent (stage-2 start)"}};
            stage2Latent=["M:concat",0];
          }
          // stage-2 conditioning: native Studio Cast output 9 retains References
          // but removes only the first/last/continuation anchor that cannot be
          // broadcast into the larger latent. Standard R2V stays unchanged.
          let cond2;
          if(studio){ cond2=["M:studio",9]; }
          else if(_r2v){ cond2=["M:cond",0]; }
          else { const c2={class_type:"MiniMaxH3ImageToVideo",inputs:{clip:["M:clip",0],vae:["M:vae",0],prompt:S.prompt||"",width:s2res.w,height:s2res.h,length:len},_meta:{title:"Stage 2 conditioning (target res)"}};
            if(S.mode==="i2v"){ if(S.firstFrame)c2.inputs.first_frame=_ffSrc; if(S.useLastFrame&&S.lastFrame)c2.inputs.last_frame=_lfSrc; }
            prompt["M:cond2"]=c2; cond2=["M:cond2",0]; }
          prompt["M:sampsel2"]={class_type:"KSamplerSelect",inputs:{sampler_name:"euler"},_meta:{title:"Stage 2 sampler (euler)"}};
          let model2Src=_windowedStage2?modelBeforePreview:modelSrc;
          if(_windowedStage2){
            const wc=_twoPassWindowConfig();
            prompt["M:win2"]={class_type:"MMH3ContextWindows",inputs:{model:model2Src,context_length:wc.contextLength,context_overlap:wc.contextOverlap,fuse_method:"pyramid",context_schedule:"standard_static",context_stride:1,freenoise:false,split_conds_to_windows:false,accumulator_device:"cpu"},_meta:{title:"Stage 2 H3 windows (pyramid fused)"}};
            model2Src=["M:win2",0];
          }
          if(pdd){
            // PDD partial refine must use only its trained block boundaries; 0.20–0.25 = last two blocks at 8 NFE.
            const _pddRefine=Math.max(0.20,Math.min(0.25,+S.stage2Denoise||0.20));
            prompt["M:sched2"]={class_type:"MiniMaxH3PDDAccScheduler",inputs:{nfe:String(S.pddNfe||"8"),denoise:_pddRefine},_meta:{title:"Stage 2 PDD trained block schedule"}};
          } else if(S.twoPassEngine==="latent" && _latentUpAvail && !_windowedStage2){
            // community-tuned refine sequence, paired specifically with the LBH latent upscaler
            // (verified 2026-08-25 against LBH-123-AI's own "fixed" 2-stage reference workflow —
            // not a generic beta/steps/denoise guess like the pixel-engine path below).
            prompt["M:sched2"]={class_type:"ManualSigmas",inputs:{sigmas:"0.9035, 0.6316, 0.3158, 0.0000"},_meta:{title:"Stage 2 refine sigmas (LBH-tuned)"}};
          } else {
            prompt["M:sched2"]={class_type:"BasicScheduler",inputs:{model:model2Src,scheduler:"beta",steps:+S.stage2Steps||4,denoise:+S.stage2Denoise||0.2},_meta:{title:"Stage 2 scheduler (partial denoise)"}};
          }
          prompt["M:guider2"]={class_type:"BasicGuider",inputs:{model:model2Src,conditioning:cond2},_meta:{title:"Stage 2 guider"}};
          prompt["M:noise2"]={class_type:"RandomNoise",inputs:{noise_seed:(seed+1)%1000000000000000},_meta:{title:"Stage 2 noise"}};
          prompt["M:samp2"]={class_type:"SamplerCustomAdvanced",inputs:{noise:["M:noise2",0],guider:["M:guider2",0],sampler:["M:sampsel2",0],sigmas:["M:sched2",0],latent_image:stage2Latent},_meta:{title:"Stage 2 refine"}};
          set("M:vdec","samples",["M:samp2",0]); set("M:adec","samples",["M:samp2",0]);   // decode stage-2 output
        }

        if(studio){
          // Do not send a finished 1080p/2K continuation through CGlide Glide
          // Join: that join correctly works in tensors, but can materialise both
          // whole clips in RAM.  Glide Video writes one temporary master; our
          // output node streams the final seam/audio splice in ffmpeg instead.
          delete prompt["M:cvid"]; delete prompt["M:save"];
          prompt["M:studioTemp"]={class_type:"CSGlideVideoCS",inputs:{
            images:["M:vdec",0],audio:["M:adec",0],fps:FPS,
            preset:"ProRes 422 HQ (master)",filename_prefix:"mmh3_studio_temp",
            save_output:false,save_metadata:false,fallback_on_failure:true,container:"auto",
          },_meta:{title:"Studio temporary AV master"}};
          prompt["M:studioSave"]={class_type:"MMH3StudioSafeJoin",inputs:{
            source_video:["M:studio",7],continuation_video:["M:studioTemp",0],
            overlap_frames:["M:studio",6],fps:FPS,seam_mode:S.studioSeamMode||"early_cut",
            seam_blend_frames:+S.studioSeamBlend||6,filename_prefix:"H3_Studio",
          },_meta:{title:"H3 Studio final seam · streaming 2K safe"}};
        }

        try{
          const r=await api.fetchApi("/prompt",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({prompt})});
          if(!r.ok){ const t=await r.text(); throw new Error(t); }
          const d=await r.json(); _activePromptId=d.prompt_id||null; _activeRunning=true;
          startCompletionWatch();   // guaranteed reset when our prompt leaves the queue
        }catch(e){ _activeShowError("ComfyUI rejected the graph:\n"+fmtErr(e)); _activeRunning=false; reset(); }
      };
      genBtn.onclick=generate;

      // ── keyboard shortcuts — capture:true so events reach us BEFORE ComfyUI's canvas
      // handler swallows them (that was why they didn't fire); hover read live via :hover. ──
      const _isEditable=(el)=> el && (el.tagName==="INPUT"||el.tagName==="TEXTAREA"||el.tagName==="SELECT"||el.isContentEditable);
      const _keyHandler=(e)=>{
        if(_lbIsOpen()) return;   // the detail lightbox owns the keyboard while it's open
        const fsOpen=fsOverlay.style.display!=="none", galOpen=galModal.style.display!=="none";
        if(e.key==="Escape"){ if(_nodeFS){_exitNodeFS();e.preventDefault();} else if(fsOpen){closeFullscreen();e.preventDefault();} else if(galOpen){_galSelectCb=null;galModal.style.display="none";e.preventDefault();} return; }
        if(_isEditable(e.target)) return;
        let over=false; try{ over=root.matches(":hover"); }catch(_e){}
        if(!over && !fsOpen && !galOpen && !_nodeFS) return;
        const k=(e.key||"").toLowerCase();
        if(k==="f"){ _toggleNodeFS(); e.preventDefault(); }
        else if(k==="g"){ if(galOpen){_galSelectCb=null;galModal.style.display="none";} else openGalleryModal(); e.preventDefault(); }
        else if((e.key===" "||e.code==="Space")&&!e.repeat){ if(!S.generating)generate(); e.preventDefault(); }
      };
      document.addEventListener("keydown",_keyHandler,{capture:true});
      // a subtle shortcuts hint under the buttons
      const shortcutsHint=tx(mk("div",{fontSize:"8.5px",color:C.muted,textAlign:"center",margin:"7px 0 0",letterSpacing:".03em"}),"Space · generate    F · fullscreen    G · gallery");
      right.appendChild(shortcutsHint);

      // assemble
      // ── credit footer (lower-third) — author + support links ──
      const footer=mk("div",{display:"flex",alignItems:"center",justifyContent:"center",gap:"9px",padding:"6px 10px",borderTop:"1px solid "+C.border,fontSize:"10px",color:C.muted,flex:"0 0 auto",background:C.bg1});
      const _credLink=(label,url,color)=>{ const a=tx(mk("a",{color:color,textDecoration:"none",fontWeight:"700",cursor:"pointer"},{href:url,target:"_blank",rel:"noopener noreferrer"}),label); a.onmouseenter=()=>{a.style.textDecoration="underline";}; a.onmouseleave=()=>{a.style.textDecoration="none";}; a.onclick=(e)=>{ e.preventDefault(); e.stopPropagation(); window.open(url,"_blank","noopener"); }; return a; };
      footer.append(
        tx(mk("span",{color:C.muted}),"made by"),
        tx(mk("span",{fontWeight:"800",color:C.text,letterSpacing:".02em"}),"The New Game Plus"),
        tx(mk("span",{color:C.border}),"·"),
        _credLink("☕ Ko-fi","https://ko-fi.com/thenewgameplus","#ff5e5b"),
        tx(mk("span",{color:C.border}),"·"),
        _credLink("▶ YouTube","https://www.youtube.com/@TheNewGamePluss","#ff4444"),
      );
      root.append(header,body,footer);
      const _w=this.addDOMWidget("mmh3_ui","div",root,{getValue(){return null;},setValue(){},serialize:false});
      // computeSize must be assigned ON the widget (options.computeSize is ignored by this
      // ComfyUI frontend). It returns the PERSISTED target size (from S.nodeSize, floored at
      // the min) so the node holds a real default and keeps whatever the user drags it to —
      // onResize writes the new target back into S.nodeSize.
      _w.computeSize=function(){ const t=S.nodeSize||[NODE_W,NODE_H]; return [Math.max(MIN_W,t[0]),Math.max(MIN_H-TITLE_H,t[1]-TITLE_H)]; };
      this.setSize((S.nodeSize&&S.nodeSize.length===2)?S.nodeSize.slice():[NODE_W,NODE_H]);

      // init
      renderRefImages(); renderRefVideos(); renderRefAudios();
      setMode(S.mode); updateRes(); updateDur(); rebuildTagRow(); updateSpeedNotes(); updateCacheUI(); updateTwoPassUI();
      _loadModels(); _loadTemplates(); _loadGallery();
      // probe the KJNodes sage-attention patch so its toggle can guide/guard the user
      api.fetchApi("/object_info/MiniMaxH3MemoryEfficientSageAttentionPatch").then(r=>r.ok?r.json():{}).then(d=>{ _sageAvailable=!!(d&&d.MiniMaxH3MemoryEfficientSageAttentionPatch); updateSpeedNotes(); }).catch(()=>{ _sageAvailable=false; updateSpeedNotes(); });
      api.fetchApi("/object_info/MiniMaxH3MemoryEfficientSolAttentionPatch").then(r=>r.ok?r.json():{}).then(d=>{ _solAvailable=!!(d&&d.MiniMaxH3MemoryEfficientSolAttentionPatch); updateSpeedNotes(); }).catch(()=>{ _solAvailable=false; updateSpeedNotes(); });
      // probe SeedVR2 so the Upscale tab's engine can guide/guard the user
      api.fetchApi("/object_info/SeedVR2VideoUpscaler").then(r=>r.ok?r.json():{}).then(d=>{ _svrAvailable=!!(d&&d.SeedVR2VideoUpscaler); if(S.mode==="upscale")setUpEngine(S.upscaleEngine); }).catch(()=>{ _svrAvailable=false; });
      api.fetchApi("/object_info/FlashVSRNode").then(r=>r.ok?r.json():{}).then(d=>{ _fvsrAvailable=!!(d&&d.FlashVSRNode); if(S.mode==="upscale")setUpEngine(S.upscaleEngine); }).catch(()=>{ _fvsrAvailable=false; });
      api.fetchApi("/object_info/RTXVideoSuperResolution").then(r=>r.ok?r.json():{}).then(d=>{ _rtxAvailable=!!(d&&d.RTXVideoSuperResolution); if(S.mode==="upscale")setUpEngine(S.upscaleEngine); }).catch(()=>{ _rtxAvailable=false; });
      // probe the Turbo sampler node so the Turbo toggle can guide/guard the user
      api.fetchApi("/object_info/MiniMaxH3TurboSampler").then(r=>r.ok?r.json():{}).then(d=>{ _turboNode=!!(d&&d.MiniMaxH3TurboSampler); updateSpeedNotes(); }).catch(()=>{ _turboNode=false; updateSpeedNotes(); });
      // Official Alibaba PDD Acc loader: files are in models/pdd_acc and must be selected by
      // architecture (FL2VA for T2V/I2V, Ref2VA for R2V). Never route these through a generic LoRA node.
      api.fetchApi("/object_info/MiniMaxH3PDDAccApply").then(r=>r.ok?r.json():{}).then(d=>{
        _pddApplyAvail=!!(d&&d.MiniMaxH3PDDAccApply);
        const spec=d&&d.MiniMaxH3PDDAccApply&&d.MiniMaxH3PDDAccApply.input&&d.MiniMaxH3PDDAccApply.input.required&&d.MiniMaxH3PDDAccApply.input.required.pdd_file;
        const opts=Array.isArray(spec&&spec[0])?spec[0]:(spec&&spec[1]&&Array.isArray(spec[1].options)?spec[1].options:[]);
        _pddFiles=(opts||[]).filter(Boolean); _pddFlFiles=_pddFiles.filter(f=>/fl2va/i.test(f)); _pddRefFiles=_pddFiles.filter(f=>/ref2va/i.test(f));
        const choose=(list,saved)=>list.find(f=>_norm(f)===_norm(saved))||list[0]||"";
        S.pddFlFile=choose(_pddFlFiles,S.pddFlFile); S.pddRefFile=choose(_pddRefFiles,S.pddRefFile);
        try{updatePDDUI(); persist(); updateSpeedNotes();}catch(_e){}
      }).catch(()=>{ _pddApplyAvail=false; _pddFiles=[]; _pddFlFiles=[]; _pddRefFiles=[]; try{updatePDDUI();updateSpeedNotes();}catch(_e){} });
      api.fetchApi("/object_info/MiniMaxH3PDDAccScheduler").then(r=>r.ok?r.json():{}).then(d=>{ _pddSchedulerAvail=!!(d&&d.MiniMaxH3PDDAccScheduler); try{updatePDDUI();updateSpeedNotes();}catch(_e){} }).catch(()=>{ _pddSchedulerAvail=false; try{updatePDDUI();updateSpeedNotes();}catch(_e){} });
      // probe the cache-accelerator nodes (TeaCache / Spectrum / FirstBlockCache) for the selector
      api.fetchApi("/object_info/MiniMaxH3TeaCache").then(r=>r.ok?r.json():{}).then(d=>{ _teaAvailable=!!(d&&d.MiniMaxH3TeaCache); updateCacheUI(); }).catch(()=>{ _teaAvailable=false; updateCacheUI(); });
      api.fetchApi("/object_info/SpectrumApplyMiniMaxH3").then(r=>r.ok?r.json():{}).then(d=>{ _spectrumAvailable=!!(d&&d.SpectrumApplyMiniMaxH3); updateCacheUI(); }).catch(()=>{ _spectrumAvailable=false; updateCacheUI(); });
      api.fetchApi("/object_info/ApplyMiniMaxH3FirstBlockCache").then(r=>r.ok?r.json():{}).then(d=>{ _fbcAvailable=!!(d&&d.ApplyMiniMaxH3FirstBlockCache); updateCacheUI(); }).catch(()=>{ _fbcAvailable=false; updateCacheUI(); });
      api.fetchApi("/object_info/EasyCache").then(r=>r.ok?r.json():{}).then(d=>{ _easycacheAvailable=!!(d&&d.EasyCache); updateCacheUI(); }).catch(()=>{ _easycacheAvailable=false; updateCacheUI(); });
      // two-pass HD nodes (PT_H3ConcatAVLatent + MiniMaxH3AVDecodeT8)
      api.fetchApi("/object_info/PT_H3ConcatAVLatent").then(r=>r.ok?r.json():{}).then(d=>{ _ptConcatAvail=!!(d&&d.PT_H3ConcatAVLatent); updateTwoPassUI(); }).catch(()=>{ _ptConcatAvail=false; updateTwoPassUI(); });
      api.fetchApi("/object_info/MiniMaxH3AVDecodeT8").then(r=>r.ok?r.json():{}).then(d=>{ _t8DecodeAvail=!!(d&&d.MiniMaxH3AVDecodeT8); updateTwoPassUI(); }).catch(()=>{ _t8DecodeAvail=false; updateTwoPassUI(); });
      // MMH3Tools gives us the safe stage-2 topology: VAE pixel chunks plus H3-aware
      // overlapping context windows, fused inside the sampler instead of stitched as clips.
      api.fetchApi("/object_info/MMH3ChunkedPixelUpscale").then(r=>r.ok?r.json():{}).then(d=>{ _mmh3ChunkUpAvail=!!(d&&d.MMH3ChunkedPixelUpscale); updateTwoPassUI(); }).catch(()=>{ _mmh3ChunkUpAvail=false; updateTwoPassUI(); });
      api.fetchApi("/object_info/MMH3ContextWindows").then(r=>r.ok?r.json():{}).then(d=>{ _mmh3WindowAvail=!!(d&&d.MMH3ContextWindows); updateTwoPassUI(); }).catch(()=>{ _mmh3WindowAvail=false; updateTwoPassUI(); });
      api.fetchApi("/object_info/MMH3SplitAV").then(r=>r.ok?r.json():{}).then(d=>{ _mmh3SplitAvail=!!(d&&d.MMH3SplitAV); updateTwoPassUI(); }).catch(()=>{ _mmh3SplitAvail=false; updateTwoPassUI(); });
      api.fetchApi("/object_info/MMH3PackAV").then(r=>r.ok?r.json():{}).then(d=>{ _mmh3PackAvail=!!(d&&d.MMH3PackAV); updateTwoPassUI(); }).catch(()=>{ _mmh3PackAvail=false; updateTwoPassUI(); });
      Promise.all([api.fetchApi("/object_info/SetLatentNoiseMask"),api.fetchApi("/object_info/SolidMask")]).then(async rr=>{
        const a=rr[0].ok?await rr[0].json():{}, b=rr[1].ok?await rr[1].json():{};
        _noiseMaskAvail=!!(a&&a.SetLatentNoiseMask&&b&&b.SolidMask); updateTwoPassUI();
      }).catch(()=>{ _noiseMaskAvail=false; updateTwoPassUI(); });
      api.fetchApi("/object_info/MinimaxH3LatentUpscaler3D").then(r=>r.ok?r.json():{}).then(d=>{
        const info=d&&d.MinimaxH3LatentUpscaler3D; _latentUpAvail=!!info;
        if(info){ try{ const mn=(info.input.required||{}).model_name;
          // V3 combo: ["COMBO",{options:[...]}]; legacy combo: [[...options]]. Handle both.
          let arr=null;
          if(Array.isArray(mn)){ if(mn[1]&&Array.isArray(mn[1].options)) arr=mn[1].options; else if(Array.isArray(mn[0])) arr=mn[0]; }
          if(Array.isArray(arr)){ _latentUpModels=arr.filter(x=>x&&!String(x).startsWith("(")); }
          // default to the H3-specific model (not e.g. an LTX upscaler that lives in the same folder)
          // prefer fp32 — matches the community-tuned two-pass recipe (paired with the ManualSigmas
          // refine below); fp16/bf16 stay selectable for lighter/faster runs.
          const _h3all=_latentUpModels.filter(x=>/minimax|_h3|h3_/i.test(x));
          const _h3pref=_h3all.find(x=>/fp32/i.test(x))||_h3all[0];
          if(!S.latentUpModel||!_latentUpModels.includes(S.latentUpModel)){ S.latentUpModel=_h3pref||_latentUpModels[0]||""; persist(); }
          const _list=_latentUpModels.length?_latentUpModels:["(none found)"];
          try{ tpLatModelDD.updateItems(_list); tpLatModelDD.set(S.latentUpModel||"(none found)"); }catch(_e){}
        }catch(_e){} }
        updateTwoPassUI(); try{refreshFinishUI();updateRepairUI();}catch(_e){}
      }).catch(()=>{ _latentUpAvail=false; updateTwoPassUI(); try{refreshFinishUI();updateRepairUI();}catch(_e){} });
      api.fetchApi("/object_info/CSGlidePreviewCS").then(r=>r.ok?r.json():{}).then(d=>{ _cglidePrevAvail=!!(d&&d.CSGlidePreviewCS); try{updateLpNote();}catch(_e){} }).catch(()=>{ _cglidePrevAvail=false; });
      // Studio is deliberately all-or-nothing.  If a CGlide update or this node's
      // Python side has not been restarted yet, show one clear guard instead of
      // submitting a partly-built graph that can fail after a long sample.
      const _checkStudioAvailability=async()=>{
        const names=["CSGlideCastCS","CSGlideVideoCS","MMH3StudioSafeJoin"];
        const checks=await Promise.all(names.map(async n=>{ try{ const r=await api.fetchApi("/object_info/"+encodeURIComponent(n)); const d=r.ok?await r.json():{}; return d&&d[n]?null:n; }catch(_e){ return n; } }));
        _studioCastAvail=!checks[0]; _studioVideoAvail=!checks[1]; _studioSafeJoinAvail=!checks[2];
        try{refreshStudioUI();}catch(_e){}
      };
      _checkStudioAvailability();
      // Repair is all-or-nothing: only enable the tab when every node in the maintained
      // source-AV masking chain is registered by the current ComfyUI install.
      const _checkRepairAvailability=async()=>{
        const names=["MiniMaxH3ChainPlan","MiniMaxH3ChainLoopStart","MiniMaxH3ChainCurrent","MiniMaxH3ChainContext","MiniMaxH3ContexLoopSourceAVTarget","MiniMaxH3ContexMaskGridPreview","MiniMaxH3ContexMaskedTarget","MiniMaxH3ImageToVideo","MiniMaxH3ReferenceToVideo","LoadImageMask","EmptyAudio","CreateVideo","SaveVideo"];
        const checks=await Promise.all(names.map(async n=>{ try{ const r=await api.fetchApi("/object_info/"+encodeURIComponent(n)); const d=r.ok?await r.json():{}; return d&&d[n]?null:n; }catch(_e){ return n; } }));
        _repairMissing=checks.filter(Boolean); _repairAvail=!_repairMissing.length; try{updateRepairUI();}catch(_e){}
      };
      _checkRepairAvailability();
      // Finish is all-or-nothing too: the feature only advertises itself as ready when it can
      // build the protected source-AV → latent-upscale → low-denoise H3 route in one graph.
      const _checkFinishAvailability=async()=>{
        const names=["MiniMaxH3ChainPlan","MiniMaxH3ChainLoopStart","MiniMaxH3ChainCurrent","MiniMaxH3ChainContext","MiniMaxH3ContexLoopSourceAVTarget","MiniMaxH3ContexMaskedTarget","MiniMaxH3ImageToVideo","MiniMaxH3ReferenceToVideo","LTXVSeparateAVLatent","LTXVConcatAVLatent","MinimaxH3LatentUpscaler3D","MMH3ContextWindows","SolidMask","EmptyAudio","CreateVideo","SaveVideo"];
        const checks=await Promise.all(names.map(async n=>{ try{ const r=await api.fetchApi("/object_info/"+encodeURIComponent(n)); const d=r.ok?await r.json():{}; return d&&d[n]?null:n; }catch(_e){ return n; } }));
        _finishMissing=checks.filter(Boolean); _finishAvail=!_finishMissing.length; try{refreshFinishUI();updateRepairUI();}catch(_e){}
      };
      _checkFinishAvailability();
      // SAM 3.1 is part of recent ComfyUI core. MaskVid is optional cleanup: the tracked
      // repair path still works without it, then gains temporal speck cleanup after restart.
      const _checkSam3Availability=async()=>{
        const names=["SAM3_VideoTrack","SAM3_TrackToMask","CheckpointLoaderSimple","CLIPTextEncode"];
        const checks=await Promise.all(names.map(async n=>{ try{ const r=await api.fetchApi("/object_info/"+encodeURIComponent(n)); const d=r.ok?await r.json():{}; return d&&d[n]?null:n; }catch(_e){ return n; } }));
        _sam3Missing=checks.filter(Boolean); _sam3Checkpoint="";
        try{
          const r=await api.fetchApi("/object_info/CheckpointLoaderSimple");
          const d=r.ok?await r.json():{}; const info=d&&d.CheckpointLoaderSimple;
          const raw=info&&info.input&&info.input.required&&info.input.required.ckpt_name;
          let options=[];
          if(Array.isArray(raw)){ if(Array.isArray(raw[0]))options=raw[0]; else if(raw[1]&&Array.isArray(raw[1].options))options=raw[1].options; }
          _sam3Checkpoint=options.find(x=>/sam3\.1_multiplex.*\.safetensors/i.test(String(x)))||"";
        }catch(_e){}
        if(!_sam3Checkpoint)_sam3Missing.push("sam3.1_multiplex_fp16.safetensors");
        _sam3Avail=!_sam3Missing.length;
        try{ const r=await api.fetchApi("/object_info/MVEx_MaskCleanup"); const d=r.ok?await r.json():{}; _sam3CleanupAvail=!!(d&&d.MVEx_MaskCleanup); }catch(_e){ _sam3CleanupAvail=false; }
        try{updateRepairUI();}catch(_e){}
      };
      _checkSam3Availability();
      api.fetchApi("/system_stats").then(r=>r.ok?r.json():{}).then(d=>{
        const dev=(d&&d.devices&&d.devices[0])||{};
        if(typeof dev.vram_total==="number") _vramGB=Math.round(dev.vram_total/1073741824);
        try{ updateRes(); }catch(_e){}
      }).catch(()=>{ _vramGB=null; });

      window.__mmh3_nodes[this.id]={root,S,_t0:Date.now(),fns:{
        reset,setProgress:_activeSetProgress,showVideo:_activeShowVideo,showError:_activeShowError,persist,refreshGallery:_loadGallery,
        // test/debug hooks — drive the injection path headlessly
        generate,setMode,calcRes,durToLen,applyProtectedTwoPass,addAnimeMotion,
        setLightXFile:(mode,file)=>{ if(mode==="fl2v"){_lxFl2vLora=file;S.lxTurboFlFile=file;}else{_lxR2vLora=file;S.lxTurboRefFile=file;} refreshPreset();persist(); },
        setTwoPassAvailability:(v,model="minimax_h3_latent_upscaler_3d_fp32.pth")=>{_latentUpAvail=!!v;_mmh3WindowAvail=!!v;_mmh3SplitAvail=!!v;_mmh3PackAvail=!!v;_noiseMaskAvail=!!v;_latentUpModels=v?[model]:[];S.latentUpModel=v?model:"";updateTwoPassUI();},
        setCacheAvailability:(v)=>{_teaAvailable=!!v;},setVramGB:(v)=>{_vramGB=v;updateRes();},setSageAvailable:(v)=>{_sageAvailable=v;updateSpeedNotes();},setTurboAvailable:(v)=>{_turboNode=v;updateSpeedNotes();},
      }};
      _bindActive(window.__mmh3_nodes[this.id]);
    };
  },
});

function _bindActive(cached){
  if(!cached)return;
  _activeReset=cached.fns.reset||_activeReset;
  _activeShowVideo=cached.fns.showVideo||_activeShowVideo;
  _activeShowError=cached.fns.showError||_activeShowError;
  _activeRefreshGallery=cached.fns.refreshGallery||_activeRefreshGallery;
}
