// Drive the real optional UI with a small DOM fixture. No browser, server or GPU.
import assert from 'node:assert/strict';
import {mountCreativeAssistant,requiredFields} from '../web/creative_assistant.js';
class Element {
  constructor(tag){this.tagName=tag;this.style={};this.children=[];this.attributes={};this.value='';this.textContent='';}
  append(...children){for(const child of children){this.children.push(child);child.parent=this;}}
  replaceChildren(...children){this.children=[];this.append(...children);}
  setAttribute(key,value){this.attributes[key]=value;}
  get options(){return this.children;}
  get selectedIndex(){return this.children.findIndex(c=>c.value===this.value);}
  remove(){if(this.parent)this.parent.children=this.parent.children.filter(c=>c!==this);}
}
globalThis.document={createElement:tag=>new Element(tag)};
globalThis.window={confirm:()=>true};
const storage=new Map();
globalThis.localStorage={getItem:key=>storage.get(key)||null,setItem:(key,value)=>storage.set(key,value)};
storage.set('minimaxh3_create_assistant_connection_v1',JSON.stringify({target:'local',local:{provider:'openai',url:'http://127.0.0.1:18766'}}));
const tick=()=>new Promise(r=>setTimeout(r,0));
function find(root,label){
  if(root.attributes['aria-label']===label||(root.tagName==='button'&&root.textContent===label))return root;
  for(const child of root.children){const result=find(child,label);if(result)return result;}
}
async function fixture({missing=false,old=false,draft={}}={}){
  const host=new Element('host'),planHost=new Element('plan'),editor=new Element('textarea');
  const calls=[];
  const api={fetchApi:async(path,opts)=>{
    const data=JSON.parse(opts.body);calls.push({path,data});
    let result;
    if(path.endsWith('/skills'))result={ok:true,official_available:!missing,skill_error:missing?'Missing official guide':null};
    else if(path.endsWith('/connect'))result={ok:true,models:[{id:'mock-text-only'}],skill_modes_supported:!old};
    else if(path.endsWith('/enhance'))result={ok:true,skill_mode:data.skill_mode,task_focus:data.task_focus,
      guide_version:'Official MiniMax H3 fixture',summary:'One shot',beats:[{start:0,end:5,action:'Pilot pauses'}],warnings:[],memory_message:'No actual model loaded.',
      prompt:requiredFields(data).map((name,i)=>name+': '+(i===0?'N/A':'[Shot 1] Test text.')).join('\n')};
    else throw new Error('Unexpected call: '+path);
    return {ok:true,status:200,json:async()=>result};
  }};
  const controller=mountCreativeAssistant({host,planHost,editor,api,draft,saveDraft:()=>{},
    getInput:()=>({brief:'One pilot pauses',style:'2D anime',baseline:'Basic formatter output',duration:5,aspect:'16:9',noDialogue:true,studio_mode:'ref2va'})});
  await tick();
  return {host,editor,calls,controller,draft};
}
const f=await fixture();
const skill=find(f.host,'Assistant skill mode'), focus=find(f.host,'Task focus · local guidance');
assert.equal(skill.value,'official');
assert.equal(f.calls.length,1);assert.ok(f.calls[0].path.endsWith('/skills'));
assert.equal(find(f.host,'Enhance / revise with Qwen').disabled,true);
await find(f.host,'Test connection / refresh models').onclick();
find(f.host,'I understand this model uses memory on my ComfyUI PC').checked=true;
focus.value='dialogue';focus.onchange();
await find(f.host,'Enhance / revise with Qwen').onclick();
assert.equal(f.calls.at(-1).data.skill_mode,'official');
assert.equal(f.calls.at(-1).data.task_focus,'dialogue');
assert.equal(f.draft.assistantSkillMode,'official');
assert.equal(f.editor.readOnly,false);
assert.ok(f.controller.getPrompt('r2v').prompt.startsWith('subject_definitions:'));
assert.ok(f.controller.getPrompt('t2v').error);
focus.value='music';focus.onchange();assert.match(f.controller.getPrompt('r2v').error,/task/);
focus.value='dialogue';focus.onchange();
f.editor.value='bad edit';f.editor.oninput();assert.match(f.controller.getPrompt('r2v').error,/6 ordered/);
await find(f.host,'Use basic formatter').onclick();assert.equal(f.controller.getPrompt('r2v'),null);
assert.equal(f.editor.readOnly,true);
f.controller.dispose();assert.equal(f.host.children.length,0);
for(const config of [{missing:true},{old:true}]){
  const safe=await fixture(config);
  await find(safe.host,'Test connection / refresh models').onclick();
  assert.equal(find(safe.host,'Enhance / revise with Qwen').disabled,true);
  const existing=find(safe.host,'Assistant skill mode');existing.value='glide';existing.onchange();
  assert.equal(find(safe.host,'Enhance / revise with Qwen').disabled,false);
  assert.equal(safe.controller.getPrompt('r2v'),null);
  safe.controller.dispose();
}
const previous=await fixture({draft:{assistantPrompt:'legacy draft'}});
assert.equal(find(previous.host,'Assistant skill mode').value,'glide');previous.controller.dispose();
console.log('PASS: real assistant mount, default/legacy selection, offline check, enhance, six-field handoff, stale task, edited-field guards, fallback and dispose. No GPU.');
