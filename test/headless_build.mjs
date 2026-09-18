// Headless build/TDZ smoke test for web/minimaxh3_one_node.js.
// Stubs ComfyUI's app/api + a minimal DOM, strips the two ESM imports, then runs
// the extension's onNodeCreated/_buildUI to catch reference errors, TDZ, and
// undefined-global mistakes WITHOUT a GPU or a running ComfyUI. It then drives the
// injection path (generate) across T2V / I2V / FLF / R2V and validates the emitted
// API graph — including the dotted COMFY_AUTOGROW_V3 reference keys.
//
//   node test/headless_build.mjs   ->  exit 0 on success, 1 on any thrown error.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(__dirname, "..", "web", "minimaxh3_one_node.js");
const IV = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "workflows", "minimax-h3-one-node-v3.24-fl2va.json"), "utf8"));
const R2V = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "workflows", "minimax-h3-one-node-v3.24-ref2va.json"), "utf8"));

// ── minimal DOM ───────────────────────────────────────────────────────────────
function makeEl(tag){
  const el={
    tagName:(tag||"div").toUpperCase(), style:{}, children:[], _listeners:{},
    textContent:"", innerHTML:"", value:"", className:"", id:"",
    selectionStart:0, selectionEnd:0, files:[], step:"", min:"", max:"", type:"",
    classList:{ add(){}, remove(){}, toggle(){}, contains(){return false;} },
    appendChild(c){ this.children.push(c); c.parentElement=this; return c; },
    append(...cs){ cs.forEach(c=>this.appendChild(c)); },
    prepend(c){ this.children.unshift(c); c.parentElement=this; return c; },
    removeChild(c){ const i=this.children.indexOf(c); if(i>=0)this.children.splice(i,1); return c; },
    replaceChild(n,o){ const i=this.children.indexOf(o); if(i>=0)this.children[i]=n; else this.children.push(n); n.parentElement=this; return o; },
    remove(){ if(this.parentElement)this.parentElement.removeChild(this); },
    get lastChild(){ return this.children[this.children.length-1]||null; },
    get firstChild(){ return this.children[0]||null; },
    addEventListener(t,fn){ (this._listeners[t]||(this._listeners[t]=[])).push(fn); },
    removeEventListener(){},
    querySelector(){ return null; },
    querySelectorAll(){ return []; },
    getBoundingClientRect(){ return {left:0,top:0,width:100,height:100,right:100,bottom:100}; },
    focus(){}, blur(){}, select(){}, click(){}, scrollIntoView(){},
    setAttribute(){}, getAttribute(){return null;}, removeAttribute(){},
    insertBefore(n){ this.children.unshift(n); n.parentElement=this; return n; },
    cloneNode(){ return makeEl(this.tagName); },
    get offsetWidth(){ return 100; }, get offsetHeight(){ return 100; },
    set onclick(fn){ this._onclick=fn; }, get onclick(){ return this._onclick; },
    set onchange(fn){ this._onchange=fn; }, get onchange(){ return this._onchange; },
    set oninput(fn){ this._oninput=fn; }, get oninput(){ return this._oninput; },
    set onmouseenter(fn){}, set onmouseleave(fn){},
  };
  return el;
}
const idMap={};
const documentStub={
  _byId:idMap,
  createElement(t){ return makeEl(t); },
  createElementNS(_ns,t){ return makeEl(t); },
  getElementById(id){ return idMap[id]||null; },
  querySelector(){ return null; }, querySelectorAll(){ return []; },
  addEventListener(){}, removeEventListener(){},
  head:makeEl("head"), body:makeEl("body"),
};
const _origCreate=documentStub.createElement.bind(documentStub);
documentStub.createElement=(t)=>{ const e=_origCreate(t); Object.defineProperty(e,"id",{get(){return e._id||"";},set(v){ e._id=v; if(v)idMap[v]=e; }}); return e; };

// ── app / api stubs ───────────────────────────────────────────────────────────
const objectInfo={
  MiniMaxH3SigmaShift:{}, MiniMaxH3MemoryEfficientSageAttentionPatch:{}, MiniMaxH3TurboSampler:{}, SeedVR2VideoUpscaler:{},
  MMH3ContextWindows:{}, MMH3SplitAV:{}, MMH3PackAV:{}, SetLatentNoiseMask:{}, SolidMask:{}, MiniMaxH3TeaCache:{},
  MinimaxH3LatentUpscaler3D:{input:{required:{model_name:["COMBO",{options:["minimax_h3_latent_upscaler_3d_fp32.pth"]}]}}},
};
let lastPrompt=null; // captures the graph submitted to /prompt
const apiStub={
  _l:{}, addEventListener(t,fn){ (this._l[t]||(this._l[t]=[])).push(fn); },
  async fetchApi(url,opts){
    if(url.includes("/object_info/")){ const k=url.split("/object_info/")[1]; return { ok:true, json:async()=>(objectInfo[k]?{[k]:objectInfo[k]}:{}) }; }
    if(url.includes("/minimaxh3/models")) return { ok:true, json:async()=>({
      diffusion_models:["minimax_h3_fl2va_pruned_fp8_scaled.safetensors","minimax_h3_ref2va_pruned_fp8_scaled.safetensors"],
      text_encoders:["qwen3vl_32b_minimax_h3_int8_convrot.safetensors"],
      vaes:["minimax_h3_video_vae_fp16.safetensors","minimax_h3_audio_vae_fp32.safetensors"],
      upscale_models:["4x_foolhardy_Remacri.pth"],
      loras:[
        "minimax_h3_turbo_4step_ckpt500.safetensors",
        "minimax_h3_fl2v_turbo_4step_v1.1_768p_comfyui.safetensors",
        "minimax_h3_fl2v_turbo_8step_v1.0_768p_comfyui.safetensors",
        "minimax_h3_ref2v_turbo_4step_v0.1_comfyui_bf16.safetensors",
        "minimax_h3_ref2v_turbo_8step_v1.0_768p_comfyui.safetensors",
        "MiniMax-H3-I2V-Anime-Motion-LoRA-1000.safetensors",
        "MiniMax-H3-I2V-Anime-Motion-LoRA-1400.safetensors"
      ]}) };
    if(url.includes("/minimaxh3/config")) return { ok:true, json:async()=>({prompt_templates:[{name:"T",prompt:"hello"}],r2v_prompt_templates:[{name:"R",prompt:"<Picture 1> hi"}]}) };
    if(url.includes("/minimaxh3/outputs")) return { ok:true, json:async()=>({videos:[{filename:"MiniMax_H3_00001.mp4",subfolder:"ComfyUI-MiniMaxH3-OneNode",type:"output"}]}) };
    if(url.includes("/minimaxh3/workflow_r2v")) return { ok:true, json:async()=>JSON.parse(JSON.stringify(R2V)) };
    if(url.includes("/minimaxh3/workflow_iv"))  return { ok:true, json:async()=>JSON.parse(JSON.stringify(IV)) };
    if(url.includes("/upload/image")) return { ok:true, json:async()=>({name:"up.png",subfolder:"",type:"input"}) };
    if(url.includes("/prompt")&&opts&&opts.body){ try{ lastPrompt=JSON.parse(opts.body).prompt; }catch(e){} return { ok:true, json:async()=>({prompt_id:"pid"}), text:async()=>"" }; }
    return { ok:true, text:async()=>"{}", json:async()=>({}) };
  },
};
let captured=null;
const appStub={ registerExtension(def){ captured=def; }, graph:{ getNodeById(){ return null; }, links:{} } };

function makeNode(id,proto){
  const n=Object.create(proto||Object.prototype);
  Object.assign(n,{ id, widgets:[], inputs:[], outputs:[], size:[0,0],
    addDOMWidget(){ return {}; }, setSize(s){ this.size=s; }, addWidget(){ return {}; },
    onConnectionsChange:null });
  return n;
}

const ctx={
  app:appStub, api:apiStub, window:{}, document:documentStub,
  LiteGraph:{ NODE_SLOT_HEIGHT:20 }, console,
  requestAnimationFrame:(fn)=>{ try{ fn(); }catch(e){} return 1; },
  setTimeout:(fn)=>{ return 0; }, clearTimeout(){},
  URL:{ createObjectURL(){ return "blob:stub"; }, revokeObjectURL(){} },
  FormData:class{ append(){} },
  MutationObserver:class{ observe(){} disconnect(){} },
  localStorage:{ _d:{}, getItem(k){ return this._d[k]||null; }, setItem(k,v){ this._d[k]=v; }, removeItem(k){ delete this._d[k]; } },
  Math, JSON, Object, Array, String, Number, Boolean, Date, Promise, Set, Map, parseInt, parseFloat, isNaN, encodeURIComponent,
};
ctx.window.__mmh3_nodes=undefined;
ctx.window.localStorage=ctx.localStorage;

let src=fs.readFileSync(SRC,"utf8");
src=src.replace(/^\s*import\s+\{[^}]*\}\s+from\s+["'][^"']+["'];\s*$/gm,"");

const names=Object.keys(ctx);
const fn=new Function(...names, '"use strict";\n'+src+"\nreturn { get captured(){ return captured; } };");
let mod;
try{ mod=fn(...names.map(n=>ctx[n])); }
catch(e){ console.error("✗ Module top-level evaluation threw:\n",e); process.exit(1); }

const cls=(p,id)=>p&&p[id]&&p[id].class_type;
const assert=(c,m)=>{ if(!c) throw new Error(m); };

(async()=>{
  try{
    if(!captured) throw new Error("registerExtension was not called");
    // wrong node name early-returns (no throw, no hook)
    const proto1={};
    await captured.beforeRegisterNodeDef({prototype:proto1},{name:"SomeOtherNode"});
    if(proto1.onNodeCreated) throw new Error("hooked a foreign node");

    const proto={};
    await captured.beforeRegisterNodeDef({prototype:proto},{name:"MiniMaxH3OneNode"});
    assert(typeof proto.onNodeCreated==="function","onNodeCreated not installed");

    // first build (fresh)
    const n1=makeNode(11,proto); proto.onNodeCreated.call(n1);
    await new Promise(r=>setTimeout(r,0)); await Promise.resolve(); await Promise.resolve();

    // cached-path build (same id) + a fresh second instance
    const n2=makeNode(11,proto); proto.onNodeCreated.call(n2);
    const n3=makeNode(22,proto); proto.onNodeCreated.call(n3);
    // A saved active LightX recipe must also build before the async model scan finishes.
    ctx.localStorage._d.minimax_h3_one_node_state=JSON.stringify({mode:"r2v",lxTurbo:"r2v",lxTurboRefFile:"minimax_h3_ref2v_turbo_4step_v0.1_comfyui_bf16.safetensors"});
    const n4=makeNode(33,proto); proto.onNodeCreated.call(n4);
    delete ctx.localStorage._d.minimax_h3_one_node_state;
    await Promise.resolve();
    if(proto.onResize) proto.onResize.call(n1);
    if(proto.getSlotMenuOptions) proto.getSlotMenuOptions.call(n1);

    const cache=ctx.window.__mmh3_nodes[11];
    assert(cache&&cache.fns&&cache.fns.generate,"generate hook not exposed");
    const fns=cache.fns, S=cache.S;

    // sanity: resolution + length math matches the python
    const r=fns.calcRes("16:9 (Widescreen)",0.4,32);
    assert(r.w===864&&r.h===480,"calcRes 0.4/16:9 expected 864x480, got "+r.w+"x"+r.h);
    assert(fns.durToLen(5)===124,"durToLen(5) expected 124, got "+fns.durToLen(5));
    assert(fns.durToLen(15)===362,"durToLen(15) expected 362, got "+fns.durToLen(15));

    S.prompt="a cinematic shot, footsteps and wind";

    // ── T2V ────────────────────────────────────────────────────────────────
    fns.setMode("t2v"); fns.reset();
    lastPrompt=null; await fns.generate(); await Promise.resolve();
    assert(lastPrompt,"T2V did not submit");
    assert(cls(lastPrompt,"M:cond")==="MiniMaxH3ImageToVideo","T2V cond node wrong: "+cls(lastPrompt,"M:cond"));
    assert(lastPrompt["M:unet"].inputs.unet_name.includes("fl2va"),"T2V should use fl2va model");
    assert(lastPrompt["M:cond"].inputs.width===864&&lastPrompt["M:cond"].inputs.height===480,"T2V res not injected");
    assert(lastPrompt["M:cond"].inputs.length===124,"T2V length not 124");
    assert(!lastPrompt["M:ff"],"T2V must not add a first frame");
    assert(cls(lastPrompt,"M:guider")==="BasicGuider","T2V guider missing");
    assert(lastPrompt["M:cvid"].inputs.fps===24,"fps must be 24");
    assert(lastPrompt["M:sched"].inputs.scheduler==="simple","T2V scheduler should default simple");

    // ── I2V (first frame only) ───────────────────────────────────────────────
    fns.setMode("i2v"); S.firstFrame="start.png"; S.useLastFrame=false; S.lastFrame=null; fns.reset();
    lastPrompt=null; await fns.generate(); await Promise.resolve();
    assert(lastPrompt,"I2V did not submit");
    assert(cls(lastPrompt,"M:ff")==="LoadImage","I2V first frame loader missing");
    assert(cls(lastPrompt,"M:ffr")==="ImageScale","I2V first frame reframe missing");
    assert(JSON.stringify(lastPrompt["M:cond"].inputs.first_frame)===JSON.stringify(["M:ffr",0]),"I2V first_frame not wired through reframe");
    assert(!lastPrompt["M:lf"],"I2V without last frame must not add M:lf");

    // ── FLF (first + last) ───────────────────────────────────────────────────
    S.useLastFrame=true; S.lastFrame="end.png"; fns.reset();
    lastPrompt=null; await fns.generate(); await Promise.resolve();
    assert(cls(lastPrompt,"M:lf")==="LoadImage","FLF last frame loader missing");
    assert(cls(lastPrompt,"M:lfr")==="ImageScale","FLF last frame reframe missing");
    assert(JSON.stringify(lastPrompt["M:cond"].inputs.last_frame)===JSON.stringify(["M:lfr",0]),"FLF last_frame not wired through reframe");

    // I2V without a frame must be BLOCKED
    S.firstFrame=null; S.useLastFrame=false; fns.reset();
    lastPrompt=null; await fns.generate(); await Promise.resolve();
    assert(!lastPrompt,"I2V without a first frame should be blocked");
    S.firstFrame="start.png";

    // ── R2V (references) ─────────────────────────────────────────────────────
    fns.setMode("r2v");
    assert(S.scheduler==="beta","R2V should default scheduler to beta");
    S.allow9=false;
    S.refImages=["p1.png","p2.png","p3.png",null,null,null,null,null,null];
    S.refVideos=[{file:"clip.mp4",useAudio:true},{file:null,useAudio:true},{file:null,useAudio:true}];
    S.refAudios=["voice.wav",null,null];
    S.refImageSize="max";
    fns.reset();
    lastPrompt=null; await fns.generate(); await Promise.resolve();
    assert(lastPrompt,"R2V did not submit");
    assert(cls(lastPrompt,"M:cond")==="MiniMaxH3ReferenceToVideo","R2V cond wrong: "+cls(lastPrompt,"M:cond"));
    assert(lastPrompt["M:unet"].inputs.unet_name.includes("ref2va"),"R2V should use ref2va model");
    assert(lastPrompt["M:cond"].inputs.ref_image_size==="max","R2V ref_image_size not injected");
    // dotted autogrow keys — the make-or-break detail
    const ci=lastPrompt["M:cond"].inputs;
    assert(JSON.stringify(ci["ref_images.ref_image_0"])===JSON.stringify(["M:ri0r",0]),"ref_images.ref_image_0 not wired through reframe");
    assert(JSON.stringify(ci["ref_images.ref_image_1"])===JSON.stringify(["M:ri1r",0]),"ref_images.ref_image_1 not wired through reframe");
    assert(JSON.stringify(ci["ref_images.ref_image_2"])===JSON.stringify(["M:ri2r",0]),"ref_images.ref_image_2 not wired through reframe");
    assert(ci["ref_images.ref_image_3"]===undefined,"empty image slots must not be wired");
    assert(cls(lastPrompt,"M:ri0")==="LoadImage"&&lastPrompt["M:ri0"].inputs.image==="p1.png","ref image loader wrong");
    assert(cls(lastPrompt,"M:ri0r")==="ImageScale","reference image reframe missing");
    // video -> LoadVideo + GetVideoComponents, paired audio on slot 1
    assert(cls(lastPrompt,"M:rv0")==="LoadVideo"&&lastPrompt["M:rv0"].inputs.file==="clip.mp4","ref video loader wrong");
    assert(cls(lastPrompt,"M:rvc0")==="GetVideoComponents","GetVideoComponents missing");
    assert(JSON.stringify(ci["ref_videos.ref_video_0"])===JSON.stringify(["M:rvc0",0]),"ref_videos.ref_video_0 not wired to frames");
    assert(JSON.stringify(ci["ref_video_audios.ref_video_audio_0"])===JSON.stringify(["M:rvc0",1]),"paired video audio not wired");
    // standalone audio
    assert(cls(lastPrompt,"M:ra0")==="LoadAudio"&&lastPrompt["M:ra0"].inputs.audio==="voice.wav","ref audio loader wrong");
    assert(JSON.stringify(ci["ref_audios.ref_audio_0"])===JSON.stringify(["M:ra0",0]),"ref_audios.ref_audio_0 not wired");

    // R2V with NO references must be blocked
    S.refImages=[null,null,null,null,null,null,null,null,null];
    S.refVideos=[{file:null,useAudio:true},{file:null,useAudio:true},{file:null,useAudio:true}];
    S.refAudios=[null,null,null];
    fns.reset();
    lastPrompt=null; await fns.generate(); await Promise.resolve();
    assert(!lastPrompt,"R2V with no references should be blocked");

    // ── sigma shift injection (on T2V) ───────────────────────────────────────
    fns.setMode("t2v"); S.sigmaShiftOn=true; S.shiftVideo=10; S.shiftAudio=2.5; fns.reset();
    lastPrompt=null; await fns.generate(); await Promise.resolve();
    assert(cls(lastPrompt,"M:shift")==="MiniMaxH3SigmaShift","sigma shift node missing");
    assert(lastPrompt["M:shift"].inputs.shift_video===10&&lastPrompt["M:shift"].inputs.shift_audio===2.5,"sigma shift values wrong");
    assert(JSON.stringify(lastPrompt["M:sched"].inputs.model)===JSON.stringify(["M:shift",0]),"scheduler not repointed to sigma shift");
    assert(JSON.stringify(lastPrompt["M:guider"].inputs.model)===JSON.stringify(["M:shift",0]),"guider not repointed to sigma shift");
    S.sigmaShiftOn=false;

    // ── speed toggles: Blackwell fast fp8 + sage attention (chained after sigma shift) ──
    S.sigmaShiftOn=false; S.fastFp8=true; S.sageAttn=true; fns.reset();
    lastPrompt=null; await fns.generate(); await Promise.resolve();
    assert(lastPrompt,"speed-toggle run did not submit");
    assert(lastPrompt["M:unet"].inputs.weight_dtype==="fp8_e4m3fn_fast","fast fp8 weight_dtype not set");
    assert(cls(lastPrompt,"M:sage")==="MiniMaxH3MemoryEfficientSageAttentionPatch","sage node missing");
    assert(JSON.stringify(lastPrompt["M:sage"].inputs.model)===JSON.stringify(["M:unet",0]),"sage should chain off unet when no sigma shift");
    assert(JSON.stringify(lastPrompt["M:sched"].inputs.model)===JSON.stringify(["M:sage",0]),"scheduler not repointed to sage");
    assert(JSON.stringify(lastPrompt["M:guider"].inputs.model)===JSON.stringify(["M:sage",0]),"guider not repointed to sage");
    // fp8 off → default dtype
    S.fastFp8=false; fns.reset(); lastPrompt=null; await fns.generate(); await Promise.resolve();
    assert(lastPrompt["M:unet"].inputs.weight_dtype==="default","fp8 off should be default dtype");
    // sigma shift + sage together → unet → shift → sage → sampler
    S.sigmaShiftOn=true; S.sageAttn=true; fns.reset(); lastPrompt=null; await fns.generate(); await Promise.resolve();
    assert(JSON.stringify(lastPrompt["M:shift"].inputs.model)===JSON.stringify(["M:unet",0]),"shift should chain off unet");
    assert(JSON.stringify(lastPrompt["M:sage"].inputs.model)===JSON.stringify(["M:shift",0]),"sage should chain off sigma shift");
    assert(JSON.stringify(lastPrompt["M:guider"].inputs.model)===JSON.stringify(["M:sage",0]),"guider should end at sage");
    // sage unavailable → blocked
    S.sigmaShiftOn=false; fns.setSageAvailable(false); fns.reset(); lastPrompt=null; await fns.generate(); await Promise.resolve();
    assert(!lastPrompt,"sage on but unavailable should block generate");
    fns.setSageAvailable(true); S.sageAttn=false; S.fastFp8=false;

    // ── Turbo 4-step LoRA: injects LoRA + swaps sampler + steps, skips sigma shift ──
    fns.setMode("t2v"); fns.setTurboAvailable(true);
    S.turboOn=true; S.turboLora="minimax_h3_turbo_4step_ckpt500.safetensors"; S.turboSteps=6;
    S.sigmaShiftOn=true; /* must be skipped under turbo */ fns.reset();
    lastPrompt=null; await fns.generate(); await Promise.resolve();
    assert(lastPrompt,"Turbo run did not submit");
    assert(cls(lastPrompt,"M:turbo")==="MiniMaxH3TurboLoRA","Turbo LoRA node missing");
    assert(lastPrompt["M:turbo"].inputs.lora_name==="minimax_h3_turbo_4step_ckpt500.safetensors","turbo lora_name wrong");
    assert(cls(lastPrompt,"M:sampsel")==="MiniMaxH3TurboSampler","sampler not swapped to Turbo sampler");
    assert(lastPrompt["M:sched"].inputs.steps===6,"turbo steps not applied");
    assert(lastPrompt["M:sched"].inputs.scheduler==="simple","turbo must force scheduler simple");
    assert(!lastPrompt["M:shift"],"custom sigma shift must be skipped under Turbo");
    assert(JSON.stringify(lastPrompt["M:guider"].inputs.model)===JSON.stringify(["M:turbo",0]),"guider not fed by turbo LoRA");
    // Turbo on but node missing → blocked
    fns.setTurboAvailable(false); fns.reset(); lastPrompt=null; await fns.generate(); await Promise.resolve();
    assert(!lastPrompt,"Turbo on but node missing should block");
    fns.setTurboAvailable(true);
    // Turbo off → normal sampler restored
    S.turboOn=false; S.sigmaShiftOn=false; fns.reset(); lastPrompt=null; await fns.generate(); await Promise.resolve();
    assert(cls(lastPrompt,"M:sampsel")==="KSamplerSelect","non-turbo should use KSamplerSelect");
    assert(!lastPrompt["M:turbo"],"turbo node should be absent when off");

    // ── protected 15s / 16GB two-pass contract (R2V, the production-critical path) ──
    fns.setMode("r2v"); fns.setTwoPassAvailability(true); fns.setVramGB(16);
    S.refImages=["reference.png",null,null,null,null,null,null,null,null];
    S.refVideos=[{file:null,useAudio:true},{file:null,useAudio:true},{file:null,useAudio:true}]; S.refAudios=[null,null,null];
    S.turboOn=false; S.pddOn=false; S.lxTurbo="off"; S.styleOn=false; S.cacheEngine="off";
    fns.applyProtectedTwoPass(4.0); fns.reset(); lastPrompt=null; await fns.generate(); await Promise.resolve();
    assert(lastPrompt,"protected 2K R2V did not submit");
    const draft=fns.calcRes(S.aspect,0.5,32), twoK=fns.calcRes(S.aspect,4.0,32);
    assert(lastPrompt["M:cond"].inputs.length===362,"protected route must be 362 frames");
    assert(lastPrompt["M:cond"].inputs.width===draft.w&&lastPrompt["M:cond"].inputs.height===draft.h,"protected R2V draft must be 0.5 MP");
    assert(cls(lastPrompt,"M:lup")==="MinimaxH3LatentUpscaler3D","protected route must use neural latent upscaler");
    assert(lastPrompt["M:lup"].inputs["mode.width"]===twoK.w&&lastPrompt["M:lup"].inputs["mode.height"]===twoK.h,"protected 2K target dimensions wrong");
    assert(lastPrompt["M:lup"].inputs.enable_temporal_chunking===true&&lastPrompt["M:lup"].inputs.force_unload===true&&lastPrompt["M:lup"].inputs.precision==="fp32","protected upscaler memory/precision contract changed");
    assert(JSON.stringify(lastPrompt["M:concat"].inputs.audio_latent)===JSON.stringify(["M:sep",1]),"upscaler must bypass stage-1 audio");
    assert(cls(lastPrompt,"M:audiozero2")==="SolidMask"&&lastPrompt["M:audiozero2"].inputs.value===0,"protected audio zero-mask missing");
    assert(JSON.stringify(lastPrompt["M:audiolock2"].inputs.samples)===JSON.stringify(["M:split2",1]),"protected audio lock source wrong");
    assert(JSON.stringify(lastPrompt["M:pack2"].inputs.audio_latent)===JSON.stringify(["M:audiolock2",0]),"protected audio was not repacked locked");
    assert(lastPrompt["M:win2"].inputs.context_length===7&&lastPrompt["M:win2"].inputs.context_overlap===2,"Ultra Safe must stay on 20-frame H3 windows");
    assert(lastPrompt["M:win2"].inputs.fuse_method==="pyramid"&&lastPrompt["M:win2"].inputs.accumulator_device==="cpu","protected window fusion contract changed");
    assert(lastPrompt["M:sched2"].inputs.steps===4&&lastPrompt["M:sched2"].inputs.denoise===0.2,"protected refine must stay 4 steps / 0.20 denoise");
    assert(JSON.stringify(lastPrompt["M:samp2"].inputs.latent_image)===JSON.stringify(["M:pack2",0]),"stage 2 must sample the fused video + locked audio latent");
    assert(JSON.stringify(lastPrompt["M:vdec"].inputs.samples)===JSON.stringify(["M:samp2",0])&&JSON.stringify(lastPrompt["M:adec"].inputs.samples)===JSON.stringify(["M:samp2",0]),"final decoders must use stage-2 output");
    assert(!lastPrompt["M:t8dec"]&&!lastPrompt["M:up"]&&!lastPrompt["M:enc"]&&!lastPrompt["M:chunkup2"],"protected latent route must not enter a pixel round trip");

    fns.applyProtectedTwoPass(2.0); fns.reset(); lastPrompt=null; await fns.generate(); await Promise.resolve();
    const fullHD=fns.calcRes(S.aspect,2.0,32);
    assert(lastPrompt["M:lup"].inputs["mode.width"]===fullHD.w&&lastPrompt["M:lup"].inputs["mode.height"]===fullHD.h,"protected 1080p target dimensions wrong");

    // ── exact LightX recipe selection: Ref2V and FL2V 8-step files stay on 8 NFE ──
    S.twoPass=false; S.twoPassWindowed=false; S.styleOn=false; S.cacheEngine="teacache"; fns.setCacheAvailability(true); fns.setTurboAvailable(true);
    S.lxTurbo="r2v"; fns.setLightXFile("r2v","minimax_h3_ref2v_turbo_8step_v1.0_768p_comfyui.safetensors");
    fns.reset(); lastPrompt=null; await fns.generate(); await Promise.resolve();
    assert(lastPrompt["M:sched"].inputs.steps===8&&lastPrompt["M:sched"].inputs.scheduler==="simple","Ref2V 8-step recipe did not select 8/simple");
    assert(lastPrompt["M:shift"].inputs.shift_video===12&&lastPrompt["M:shift"].inputs.shift_audio===3,"Ref2V 8-step shift must be 12/3");
    assert(lastPrompt["M:cache"].inputs.total_steps===8,"cache wrapper must match a LightX 8-step scheduler");

    fns.setMode("t2v"); S.cacheEngine="off"; S.lxTurbo="fl2v";
    fns.setLightXFile("fl2v","minimax_h3_fl2v_turbo_4step_v1.1_768p_comfyui.safetensors");
    fns.reset(); lastPrompt=null; await fns.generate(); await Promise.resolve();
    assert(lastPrompt["M:sched"].inputs.steps===4&&lastPrompt["M:shift"].inputs.shift_video===6,"FL2V 4-step recipe must use 4 NFE / shift 6");
    fns.setLightXFile("fl2v","minimax_h3_fl2v_turbo_8step_v1.0_768p_comfyui.safetensors");
    fns.reset(); lastPrompt=null; await fns.generate(); await Promise.resolve();
    assert(lastPrompt["M:sched"].inputs.steps===8&&lastPrompt["M:shift"].inputs.shift_video===12,"FL2V 8-step recipe must use 8 NFE / shift 12");

    // ── Anime Motion: curated I2V checkpoint is opt-in; Ref2V starts conservatively ──
    fns.setMode("r2v"); S.lxTurbo="r2v"; fns.setLightXFile("r2v","minimax_h3_ref2v_turbo_8step_v1.0_768p_comfyui.safetensors");
    S.styleLoras=[]; S.styleOn=false; assert(fns.addAnimeMotion(),"Anime Motion quick-add should find the installed checkpoint");
    assert(S.styleOn&&S.styleLoras.length===1&&/1400/.test(S.styleLoras[0].lora),"Anime Motion quick-add should prefer checkpoint 1400");
    assert(S.styleLoras[0].strength===0.65,"Anime Motion Ref2V beta must start at conservative strength 0.65");
    fns.reset(); lastPrompt=null; await fns.generate(); await Promise.resolve();
    assert(cls(lastPrompt,"M:stylelora0")==="MiniMaxH3TurboLoRA","Anime Motion style node missing");
    assert(lastPrompt["M:stylelora0"].inputs.low_vram===true,"Anime Motion + LightX must force merge mode to avoid bypass collision");
    assert(JSON.stringify(lastPrompt["M:shift"].inputs.model)===JSON.stringify(["M:stylelora0",0]),"LightX shift must chain after Anime Motion");
    assert(JSON.stringify(lastPrompt["M:turbo"].inputs.model)===JSON.stringify(["M:shift",0]),"LightX LoRA must chain after its trained shift");

    // ── resolution table + resize math sanity ────────────────────────────────
    assert(fns.calcRes("9:16 (Portrait Widescreen)",0.4,32).w < fns.calcRes("9:16 (Portrait Widescreen)",0.4,32).h,"portrait aspect should be taller than wide");

    // ── missing-model guard ──────────────────────────────────────────────────
    S.videoVae=""; fns.reset();
    lastPrompt=null; await fns.generate(); await Promise.resolve();
    assert(!lastPrompt,"missing model should block generate");

    console.log("✓ MiniMax H3 headless build OK — _buildUI (fresh/cached/2nd) + generate across T2V / I2V / FLF / R2V validated: fl2va vs ref2va model routing, res/length math (864x480 / 124-362), dotted COMFY_AUTOGROW_V3 ref keys (images/videos+paired-audio/standalone-audio), sigma-shift injection & repoint, and the frame/reference/model guards.");
    process.exit(0);
  }catch(e){
    console.error("✗ build test failed:\n",e);
    process.exit(1);
  }
})();
