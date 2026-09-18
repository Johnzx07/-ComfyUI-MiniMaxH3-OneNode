// Loaded only when CREATE opens. No ComfyUI imports, render graph, or GPU calls.
const CONNECTION_KEY = "minimaxh3_create_assistant_connection_v1";
const ui = {background:"#111c22", color:"#d4e8ef", border:"1px solid #36515a", borderRadius:"7px", padding:"7px 8px", fontSize:"11px", boxSizing:"border-box"};
function el(tag, text, style={}) {
  const node=document.createElement(tag); Object.assign(node.style,style);
  if(text!==undefined) node.textContent=text;
  return node;
}
function field(parent,label,tag="input",placeholder="") {
  const box=el("label",undefined,{display:"block",marginBottom:"8px",fontSize:"10px",lineHeight:"1.5",color:"#b5cdd6"});
  box.append(el("span",label));
  const input=el(tag,undefined,{...ui,display:"block",width:"100%",marginTop:"3px"});
  input.setAttribute("aria-label",label); if(placeholder)input.placeholder=placeholder;
  box.append(input); parent.append(box); return input;
}
function options(select,items,value) {
  select.replaceChildren(...items.map(([id,label])=>{const o=el("option",label);o.value=id;return o;})); select.value=value;
}
function button(parent,label,fn) {
  const b=el("button",label,{...ui,cursor:"pointer",fontWeight:"700"}); b.type="button";
  b.onclick=()=>Promise.resolve().then(fn).catch(e=>console.warn("[MMH3 CREATE] Action failed:", e.name)); parent.append(b);return b;
}
function check(parent,label,value=false) {
  const wrap=el("label",undefined,{display:"flex",gap:"7px",fontSize:"10px",lineHeight:"1.5",margin:"8px 0"});
  const input=el("input");input.type="checkbox";input.checked=value;input.setAttribute("aria-label",label); wrap.append(input,el("span",label));parent.append(wrap);return input;
}
function readConnection() {
  try {const v=JSON.parse(localStorage.getItem(CONNECTION_KEY));return v&&typeof v==="object"?v:{};}catch{return {};}
}
export function inputSignature(input) {
  // Only authored context and timing, never network state or the generated answer.
  return JSON.stringify([input.brief,input.style,input.continuity,input.baseline,input.duration,input.aspect,input.noDialogue,input.mode,
    input.skill_mode,input.task_focus,input.studio_mode,input.has_first_frame,input.has_last_frame,input.is_continuation,input.reference_mapping]);
}
export function requiredFields(input={}) {
  const reference=input.mode==="r2v" || (input.mode==="studio" && (input.studio_mode||"ref2va")==="ref2va");
  return input.skill_mode==="official"&&reference ?
    ["subject_definitions","summary","retention_analysis","detailed_description","overall_soundscape","non_diegetic_music"] :
    ["integrated_multimodal_description","overall_soundscape","non_diegetic_music"];
}
export function validatePrompt(prompt,input={}) {
  if(typeof prompt!=="string"||prompt.length>24000)return false;
  const required=requiredFields(input);
  const headers=[...prompt.matchAll(/^[ \t]*([a-z_]{4,})[ \t]*:/gim)];
  return headers.length===required.length && headers.every((h,i)=>h[1].toLowerCase()===required[i] &&
    prompt.slice(h.index+h[0].length,headers[i+1]?.index??prompt.length).trim().length>0);
}

export function mountCreativeAssistant({host,planHost,editor,api,draft,saveDraft,getInput}) {
  const saved=readConnection();
  let connected=false, busy=false, requestId=null, controller=null, disposed=false;
  let officialAvailable=false, skillsError="Checking bundled skill files…";
  let active=draft.assistantActive===true && typeof draft.assistantPrompt==="string";
  let lastResult=draft.assistantResult||null;
  let edited=draft.assistantEdited===true;
  let modelItems=[];
  const card=el("section",undefined,{...ui,padding:"12px",margin:"12px 0",background:"rgba(57,126,153,.09)"});
  card.append(el("div","✦ Qwen creative assistant",{fontSize:"13px",fontWeight:"800",marginBottom:"5px"}),
    el("div","Optional · sends only the brief and notes below to your selected model server. No videos, images, audio, or hidden project files are sent.",{fontSize:"10px",lineHeight:"1.5",color:"#9cb7c2",marginBottom:"9px"}));
  host.append(card);
  const guideBadge=el("div","H3 guidance · checked when you connect",{fontSize:"10px",color:"#8dbdcf",marginBottom:"8px"});card.append(guideBadge);
  const target=field(card,"Run assistant on","select");
  options(target,[["remote","Second PC · keeps this GPU free"],["local","This PC · shares memory with H3"]],saved.target==="local"?"local":"remote");
  const provider=field(card,"Model server app","select");
  const url=field(card,"Server address","input","http://your-second-PC-IP:port");url.type="url";url.autocomplete="off";
  const token=field(card,"API token · optional, kept only until disconnect");token.type="password";token.autocomplete="off";
  const row=el("div",undefined,{display:"flex",flexWrap:"wrap",gap:"6px",marginBottom:"8px"});card.append(row);
  const connect=button(row,"Test connection / refresh models",connectServer);
  const disconnect=button(row,"Disconnect",disconnectServer);
  const model=field(card,"Assistant model","select");options(model,[["","Test connection to list models"]],"");
  const mode=field(card,"Prepare this prompt for","select");
  options(mode,[["r2v","Reference to video · my references / audio"],["studio","H3 Studio · references / continuation"],["i2v","First / last frame"],["t2v","Text to video"]],draft.assistantMode||"r2v");
  const skill=field(card,"Assistant skill mode","select");
  options(skill,[["official","Official MiniMax H3 skill"],["glide","Existing Glide-style guide"]],
    draft.assistantSkillMode||(draft.assistantPrompt?"glide":"official"));
  const focus=field(card,"Task focus · local guidance","select");
  options(focus,[["general","General scene"],["continuity","Character / scene continuity"],["dialogue","Dialogue / my own audio"],
    ["storyboard","Storyboard / animation shot"],["product","Product / environment detail"],["music","Music-driven visuals"]],draft.assistantTaskFocus||"general");
  card.append(el("div","Official mode loads MiniMax's prompt-writing skill for your destination. Task focuses are our local guidance, not the complete Design skill library. Your selected visual style stays in control.",{fontSize:"10px",lineHeight:"1.5",color:"#9cb7c2",marginBottom:"8px"}));
  const sourceLink=el("a","View the official skill source",{fontSize:"10px",color:"#8dd2ed",display:"inline-block",marginBottom:"9px"});
  sourceLink.href="https://github.com/MiniMax-AI/MiniMax-H3/tree/d21241f0a4b3acbb34c97dae47fa417b7065e438/skills/h3-prompt-writing";sourceLink.target="_blank";sourceLink.rel="noopener noreferrer";card.append(sourceLink);
  const notes=field(card,"Continuity notes / reference mapping","textarea","Example: <Picture 1> = Mio; (S1) = Mio when speaking. Keep her jacket, earrings and rooftop. <Audio 1> = her recorded line, with exact words and timing below. Describe the other references and the previous clip's ending if continuing.");
  notes.style.minHeight="85px";notes.style.resize="vertical";notes.maxLength=8000;notes.value=draft.assistantNotes||"";
  const instruction=field(card,"Revision request · optional","textarea","Example: Keep her outfit unchanged; simplify the movement and slow the camera.");
  instruction.style.minHeight="53px";instruction.style.resize="vertical";instruction.maxLength=4000;instruction.value=draft.assistantInstruction||"";
  const localBox=el("div",undefined,{border:"1px solid #866334",padding:"7px",borderRadius:"7px",fontSize:"10px"});card.append(localBox);
  localBox.append(el("div","Local AI can compete with H3 for VRAM/RAM. Finish and unload the LLM before rendering. This feature does not unload ComfyUI models or change their memory settings."));
  const localConfirm=check(localBox,"I understand this model uses memory on my ComfyUI PC");
  const autoUnload=check(localBox,"Unload selected LOCAL model after a successful draft");
  const actions=el("div",undefined,{display:"flex",flexWrap:"wrap",gap:"7px",marginTop:"10px"});card.append(actions);
  const enhance=button(actions,"Enhance / revise with Qwen",enhancePrompt);
  const cancel=button(actions,"Cancel request",cancelRequest);
  const unload=button(actions,"Unload selected model…",unloadModel);
  const reset=button(actions,"Use basic formatter",()=>{
    active=false;draft.assistantActive=false;saveDraft(draft);refresh();
    status("Basic formatter selected. The last AI draft is retained until replaced.");
  });
  const restore=button(actions,"Restore last AI draft",()=>{
    if(!draft.assistantPrompt)return status("No AI draft saved yet.",true);
    active=true;draft.assistantActive=true;saveDraft(draft);refresh();
  });
  const statusBox=el("div","Not connected. Enter the server address and test the connection.",{fontSize:"10px",lineHeight:"1.5",marginTop:"10px",whiteSpace:"pre-wrap"});statusBox.setAttribute("role","status");card.append(statusBox);
  const note=el("div",undefined,{fontSize:"10px",lineHeight:"1.5",marginBottom:"8px",color:"#b8d5df"});
  const plan=el("div",undefined,{maxHeight:"130px",overflowY:"auto",marginBottom:"8px"});
  planHost.append(note,plan);
  const controls=[target,provider,url,token,model,mode,skill,focus,notes,instruction,localConfirm,autoUnload];
  function status(message,error=false){statusBox.textContent=message;statusBox.style.color=error?"#ffac95":"#abdcbf";}
  function profile(){return {url:url.value.trim(),provider:provider.value,model:model.value};}
  function persistConnection(){
    const state=readConnection();state.target=target.value;state[target.value]=profile();
    // Whitelist ensures an old token can never be serialized accidentally.
    const safe={target:state.target};for(const key of ["local","remote"]){if(state[key])safe[key]={url:state[key].url||"",provider:state[key].provider||"openai",model:state[key].model||""};}
    try{localStorage.setItem(CONNECTION_KEY,JSON.stringify(safe));}catch{}
  }
  function loadProfile(){
    const p=readConnection()[target.value]||{};
    options(provider,[["openai","OpenAI-compatible · llama.cpp / other"],["lmstudio","LM Studio"],["ollama","Ollama"]],p.provider||"openai");
    url.value=p.url||(target.value==="local"?"http://127.0.0.1:1234":"");token.value="";
    connected=false;modelItems=[];options(model,[["","Test connection to list models"]],"");localConfirm.checked=false;autoUnload.checked=false;
  }
  function config(){return {...profile(),target:target.value,token:token.value};}
  function input(){const value=getInput(mode.value);return {...value,mode:mode.value,continuity:notes.value.trim(),skill_mode:skill.value,task_focus:focus.value};}
  function busyUI(value){busy=value;refresh();}
  function refresh(){
    if(disposed)return;
    localBox.style.display=target.value==="local"?"block":"none";
    autoUnload.disabled=busy||provider.value==="openai";
    if(provider.value==="openai")autoUnload.checked=false;
    controls.forEach(c=>{if(c!==autoUnload)c.disabled=busy;});
    connect.disabled=busy;disconnect.disabled=busy;enhance.disabled=busy||!connected||!model.value||(skill.value==="official"&&!officialAvailable);
    const selectedInput=input();
    guideBadge.textContent=skill.value==="official" ? (officialAvailable ?
      `Official MiniMax H3 · ${requiredFields(selectedInput).length===6?"Ref2VA · 6 sections":"text/keyframes · 3 sections"} · bundled files verified; loaded on Enhance` : skillsError) :
      "Existing Glide-style guide · loaded on Enhance";
    unload.disabled=busy||!connected||!model.value||provider.value==="openai";
    cancel.disabled=!busy||!requestId;reset.disabled=busy;restore.disabled=busy||!draft.assistantPrompt;
    editor.readOnly=!active||busy;
    if(active){
      if(editor.value!==draft.assistantPrompt)editor.value=draft.assistantPrompt;
      const stale=draft.assistantSignature!==inputSignature(input());
      note.textContent=stale?"Brief, references, skill, task, mode, or timing changed. Generate a new AI draft, or choose Use basic formatter before handoff.":
        "AI draft · editable · review before handoff. "+(edited?"Edited by you; beat cards describe the original AI draft.":"Beat cards are a plan, not separate render jobs.");
      note.style.color=stale?"#ffcf75":"#b8d5df";
    }else{editor.value=getInput("t2v").baseline||"Choose a style and write your brief.";note.textContent="Basic formatter · no AI call. Connect Qwen and press Enhance to create an editable AI draft.";note.style.color="#b8d5df";}
    plan.replaceChildren();
    if(active&&lastResult){
      if(lastResult.guide_version)plan.append(el("div",lastResult.guide_version+" · included in this draft's AI instructions",{fontSize:"10px",color:"#8dbdcf",marginBottom:"5px"}));
      if(lastResult.task_focus)plan.append(el("div","Local task focus: "+lastResult.task_focus,{fontSize:"10px",color:"#8dbdcf",marginBottom:"5px"}));
      if(lastResult.summary)plan.append(el("div",lastResult.summary,{fontSize:"11px",marginBottom:"6px"}));
      for(const beat of lastResult.beats||[]){plan.append(el("div",`${beat.start}–${beat.end}s · ${beat.action}`,{...ui,fontSize:"10px",lineHeight:"1.45",marginBottom:"5px",background:"#10232b"}));}
      for(const warning of lastResult.warnings||[]){plan.append(el("div","Review: "+warning,{fontSize:"10px",lineHeight:"1.5",color:"#ffcf75",marginBottom:"5px"}));}
    }
  }
  async function request(action,body,signal,timeout=250000){
    const abort=new AbortController();const onAbort=()=>abort.abort();signal?.addEventListener("abort",onAbort,{once:true});
    const timer=setTimeout(()=>abort.abort(),timeout);
    try{
      const response=await api.fetchApi("/minimaxh3/assistant/"+action,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(body),signal:abort.signal});
      if(response.status===404||response.status===405)throw new Error("CREATE assistant backend is not loaded. Restart ComfyUI once, then refresh this page.");
      let data;try{data=await response.json();}catch{throw new Error("Unexpected server response. Check the ComfyUI connection.");}
      if(!response.ok||!data.ok)throw new Error(data.error||"Assistant request failed.");return data;
    }finally{clearTimeout(timer);signal?.removeEventListener("abort",onAbort);}
  }
  async function connectServer(){
    busyUI(true);status("Checking the model server… This does not start generation.");
    try{
      const data=await request("connect",config(),null,20000);
      modelItems=data.models;const previous=readConnection()[target.value]?.model;
      const selected=modelItems.find(m=>m.id===previous)||modelItems.find(m=>/qwen/i.test(m.id))||modelItems[0];
      options(model,modelItems.map(m=>[m.id,m.id]),selected.id);connected=true;persistConnection();
      if(!data.skill_modes_supported){officialAvailable=false;skillsError="Restart ComfyUI to load the skill-mode backend; hard refresh afterward.";}
      status(`Connected · ${modelItems.length} model(s). Text planning only; this connector does not inspect reference media.`);
    }catch(e){connected=false;status(e.name==="AbortError"?"Connection test timed out. Check the model server address.":e.message,true);}
    finally{busyUI(false);}
  }
  function disconnectServer(){
    connected=false;token.value="";status("Disconnected; session token cleared. The model remains on its server. Use Unload before disconnecting if you want to release its memory.");refresh();
  }
  async function enhancePrompt(){
    const value=input();if(value.error)return status(value.error,true);
    if(skill.value==="official"&&!officialAvailable)return status(skillsError,true);
    if(!value.style||!value.brief)return status("Choose a style and enter a brief first.",true);
    if(target.value==="local"&&!localConfirm.checked)return status("Confirm the local memory warning first, or select Second PC.",true);
    if(active&&draft.assistantPrompt&&!window.confirm("Replace the current AI draft with a new revision? Your original brief stays unchanged."))return;
    requestId=globalThis.crypto.randomUUID();controller=new AbortController();const start=Date.now();
    const signature=inputSignature(value);const sendConfig=config();
    busyUI(true);status("Qwen is drafting… No H3 render has been queued.");
    const ticker=setInterval(()=>status(`Qwen is drafting… ${Math.floor((Date.now()-start)/1000)}s. Model loading/reasoning can take time. No H3 render queued.`),1000);
    try{
      const result=await request("enhance",{...sendConfig,...value,request_id:requestId,instruction:instruction.value,
        current_prompt:active?draft.assistantPrompt:"",local_confirm:localConfirm.checked,auto_unload:autoUnload.checked},controller.signal);
      if(!validatePrompt(result.prompt,value)|| (value.skill_mode==="official"&&result.skill_mode!=="official"))throw new Error("Returned draft does not match the selected H3 skill. The previous draft is preserved; restart ComfyUI if you just updated.");
      draft.assistantPrompt=result.prompt;draft.assistantSignature=signature;draft.assistantActive=true;draft.assistantMode=mode.value;
      draft.assistantSkillMode=skill.value;draft.assistantTaskFocus=focus.value;
      draft.assistantResult={summary:result.summary,beats:result.beats,model:result.model,guide_version:result.guide_version,
        task_focus:result.task_focus,guide_sources:result.guide_sources,warnings:result.warnings||[]};draft.assistantEdited=false;
      lastResult=draft.assistantResult;edited=false;active=true;saveDraft(draft);
      status(`Draft ready (${Math.round((Date.now()-start)/1000)}s). ${result.guide_version||""}. Review it${result.warnings?.length?" and the review notes":""}, then choose the matching renderer. ${result.memory_message}`);
    }catch(e){status(e.name==="AbortError"?"Request stopped/timed out. Your previous draft is preserved. Check the model server if it is still computing.":e.message,true);}
    finally{clearInterval(ticker);requestId=null;controller=null;busyUI(false);}
  }
  async function cancelRequest(){
    const id=requestId;controller?.abort();
    if(id){try{const result=await request("cancel",{request_id:id},null,15000);status(result.message);}catch(e){status("Local wait stopped. Cancellation could not be confirmed; check your model server.",true);}}
  }
  async function unloadModel(){
    if(!window.confirm(`Unload only “${model.value}” from ${target.value==="remote"?"your second PC":"this PC"}? This can affect other apps using that model.`))return;
    busyUI(true);status("Asking the server to unload this model…");
    try{const result=await request("unload",{...config(),confirm_unload:true},null,75000);status(result.message);}
    catch(e){status(e.message,true);}finally{busyUI(false);}
  }
  function invalidate(){connected=false;persistConnection();status("Connection settings changed. Test the connection again.");refresh();}
  target.onchange=()=>{loadProfile();persistConnection();status("Select the server for this PC and test the connection.");refresh();};
  provider.onchange=invalidate;url.oninput=invalidate;token.oninput=invalidate;
  model.onchange=persistConnection;
  mode.onchange=()=>{draft.assistantMode=mode.value;saveDraft(draft);refresh();};
  skill.onchange=()=>{draft.assistantSkillMode=skill.value;saveDraft(draft);refresh();};
  focus.onchange=()=>{draft.assistantTaskFocus=focus.value;saveDraft(draft);refresh();};
  notes.oninput=()=>{draft.assistantNotes=notes.value;saveDraft(draft);refresh();};
  instruction.oninput=()=>{draft.assistantInstruction=instruction.value;saveDraft(draft);};
  editor.oninput=()=>{if(!active)return;draft.assistantPrompt=editor.value;draft.assistantEdited=true;edited=true;saveDraft(draft);refresh();};
  loadProfile();refresh();
  // Offline capability check is isolated: a missing optional skill cannot blank CREATE.
  request("skills",{},null,15000).then(data=>{
    if(disposed)return;officialAvailable=data.official_available===true;
    skillsError=data.skill_error||"Official skill files unavailable. Select the existing guide or reinstall the guide folder.";refresh();
  }).catch(e=>{if(disposed)return;officialAvailable=false;skillsError=e.message;refresh();});
  return {
    refresh,
    getPrompt(destination){
      if(busy)return {error:"Wait for the assistant request to finish, or cancel it before handoff."};
      if(!active)return null;
      if(draft.assistantSignature!==inputSignature(input()))return {error:"The brief, references, skill, task, mode or timing changed. Enhance again or choose Use basic formatter."};
      if(destination!==mode.value)return {error:"This AI draft was prepared for "+mode.options[mode.selectedIndex].textContent+". Use that renderer, or change the destination and enhance again."};
      if(!validatePrompt(draft.assistantPrompt,input()))return {error:"Keep the "+requiredFields(input()).length+" ordered, nonempty H3 fields for this skill before handoff."};
      return {prompt:draft.assistantPrompt};
    },
    dispose(){disposed=true;controller?.abort();if(requestId)request("cancel",{request_id:requestId},null,10000).catch(()=>{});card.remove();note.remove();plan.remove();},
  };
}
