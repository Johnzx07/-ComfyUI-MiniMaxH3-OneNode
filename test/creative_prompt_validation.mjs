import assert from 'node:assert/strict';
import {validatePrompt,requiredFields,inputSignature} from '../web/creative_assistant.js';
const prompt='integrated_multimodal_description: [Shot 1] A pilot pauses.\noverall_soundscape: Wind continues.\nnon_diegetic_music: No music.';
assert.equal(validatePrompt(prompt),true);
assert.equal(validatePrompt(prompt.replace('[Shot 1] A pilot pauses.','')),false);
assert.equal(validatePrompt(prompt+'\noverall_soundscape: Another field.'),false);
assert.equal(validatePrompt(prompt.replace('overall_soundscape','negative_prompt')),false);
assert.equal(validatePrompt(prompt.replace(': Wind continues.',':\nWind continues.')),true);
console.log('PASS: editable AI prompt validates actual nonempty field bodies, including multiline text.');
const official={skill_mode:'official',mode:'r2v',task_focus:'continuity'};
const ref=requiredFields(official).map(name=>name+': Test content.').join('\n');
assert.equal(validatePrompt(ref,official),true);
assert.equal(validatePrompt(prompt,official),false);
assert.equal(validatePrompt(ref,{skill_mode:'glide',mode:'r2v'}),false);
assert.equal(requiredFields({...official,mode:'studio',studio_mode:'fl2va'}).length,3);
assert.equal(requiredFields({...official,mode:'studio',studio_mode:'ref2va'}).length,6);
for(const changed of [{task_focus:'music'},{skill_mode:'glide'},{reference_mapping:'<Picture 2>'},{has_last_frame:true}]) {
  assert.notEqual(inputSignature(official),inputSignature({...official,...changed}));
}
console.log('PASS: six-field Ref2VA, three-field keyframes/legacy, and stale-skill/reference guards.');
