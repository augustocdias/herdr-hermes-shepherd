import { registerHooks } from "node:module";
import { test } from "node:test";
import assert from "node:assert/strict";

const store = globalThis.shepherdChatTestStore = new Map();
const transport = globalThis.shepherdChatTestTransport = {};
const stubs = {
  "gpui-kit": "export const div=()=>{};",
  "gpui-base": `
    class State {
      constructor(options={}) { this.text=options.value??''; this.events={}; }
      value(){return this.text;} set_value(text){this.text=text;} replace(text){this.text+=text;}
      on(name,fn){this.events[name]=fn;} set_auto_grow(){} focus(){} release(){this.released=true;}
    }
    export const TextareaState={new:options=>new State(options)}, InputState={new:options=>new State(options)};
    export const v_flex=()=>{},h_flex=()=>{},Button={},TextView={},Textarea={},Input={};`,
  herdr: `
    export const appHome=()=>'/private/app', shared=key=>globalThis.shepherdChatTestStore.get(key),
      setShared=(key,value)=>globalThis.shepherdChatTestStore.set(key,value), theme=()=>({}), run=()=>{}, openOverlay=()=>{};
    export const nextCommand=()=>new Promise(()=>{});
    export const exec=(...args)=>globalThis.shepherdChatTestTransport.exec(...args);`,
  net: "export const connect=(...args)=>globalThis.shepherdChatTestTransport.connect(...args);",
};
registerHooks({ resolve(specifier, context, next) {
  return specifier in stubs ? { url:`data:text/javascript,${encodeURIComponent(stubs[specifier])}`,shortCircuit:true } : next(specifier,context);
} });
const { ShepherdChat } = await import("../mods/hermes-shepherd/chat.js");

const snapshot = (fields={}) => ({ type:"state",profile:"coordinator",connected:true,session_id:"session-a",generation:7,running:false,items:[],prompts:[],...fields });
function setup() {
  store.clear();
  const tasks=[],frames=[];
  const cx={spawn:fn=>{tasks.push(fn);},notify(){},bind_keys(){},stop_propagation(){},sleep:()=>new Promise(()=>{}),
    focus_handle:()=>({focus(){},is_focused:()=>true})};
  const panel=new ShepherdChat(()=>"coordinator"); panel.init(cx);
  tasks.length=0; // Init's real connection/focus/profile loops are exercised by App smoke, not this state harness.
  panel.connecting=false; panel.socket={write:async frame=>frames.push(JSON.parse(frame)),close(){}};
  panel.receive(snapshot());
  const launch=()=>tasks.shift()(cx);
  const settle=async()=>{await Promise.resolve();await Promise.resolve();await Promise.resolve();};
  return {panel,cx,frames,tasks,launch,settle};
}

test("a draft clears only after a successful send acknowledgement",async()=>{
  const {panel,cx,frames,launch,settle}=setup();
  panel.saveDraft({text:"Hello",pending:null});panel.composer.set_value("Hello");
  panel.send(cx);const sending=launch();launch();await settle();
  assert.equal(panel.draft().text,"Hello");
  assert.equal(frames[0].op,"send");assert.equal(frames[0].session_id,"session-a");
  assert.ok(frames[0].request_id);
  panel.receive({type:"reply",id:frames[0].id,ok:true});await sending;
  assert.deepEqual(panel.draft(),{text:"",pending:null});assert.equal(panel.composer.value(),"");
});

test("acknowledgement preserves text edited while a send was in flight",async()=>{
  const {panel,cx,frames,launch,settle}=setup();
  panel.saveDraft({text:"First",pending:null});panel.send(cx);const sending=launch();launch();await settle();
  panel.saveDraft({...panel.draft(),text:"Next message"});
  panel.receive({type:"reply",id:frames[0].id,ok:true});await sending;
  assert.deepEqual(panel.draft(),{text:"Next message",pending:null});
});

test("disconnect preserves durable request identity and never automatically resends",async()=>{
  const {panel,cx,frames,launch,settle}=setup();
  panel.saveDraft({text:"Keep me",pending:null});panel.send(cx);const sending=launch();launch();await settle();
  const request=panel.draft().pending;
  panel.detach();await sending;
  assert.deepEqual(panel.draft().pending,request);assert.equal(panel.draft().text,"Keep me");
  assert.equal(frames.length,1);
  panel.socket={write:async frame=>frames.push(JSON.parse(frame)),close(){}};panel.connecting=false;panel.error="";panel.receive(snapshot());
  panel.send(cx);assert.equal(frames.length,1);
  panel.send(cx,true);const retried=launch();launch();await settle();
  assert.equal(frames[1].request_id,frames[0].request_id);
  panel.receive({type:"reply",id:frames[1].id,ok:true});await retried;
});

test("an explicit refusal preserves the draft without leaving an ambiguous send",async()=>{
  const {panel,cx,frames,launch,settle}=setup();
  panel.saveDraft({text:"Rejected",pending:null});panel.send(cx);const sending=launch();launch();await settle();
  panel.receive({type:"reply",id:frames[0].id,ok:false,acknowledged:true,error:"Wrong session"});await sending;
  assert.deepEqual(panel.draft(),{text:"Rejected",pending:null});assert.equal(panel.error,"Wrong session");
});

test("an ambiguous gateway failure retains the original durable send",async()=>{
  const {panel,cx,frames,launch,settle}=setup();
  panel.saveDraft({text:"Possibly accepted",pending:null});panel.send(cx);const sending=launch();launch();await settle();
  const pending=panel.draft().pending;
  panel.receive({type:"reply",id:frames[0].id,ok:false,acknowledged:false,error:"Gateway outcome unknown"});await sending;
  assert.deepEqual(panel.draft(),{text:"Possibly accepted",pending});
});

test("a snapshot for another profile is refused",()=>{
  const {panel}=setup();
  assert.throws(()=>panel.receive(snapshot({profile:"other"})),/different Hermes profile/);
  assert.equal(panel.state.profile,"coordinator");
});

test("selection and send are serialized and an uncertain request cannot migrate sessions",async()=>{
  const {panel,cx,frames,launch,settle}=setup();
  panel.saveDraft({text:"Hello",pending:null});panel.send(cx);const sending=launch();launch();await settle();
  panel.action("resume",{session_id:"session-b"},cx);assert.equal(frames.length,1);
  panel.detach();await sending;
  panel.socket={write:async frame=>frames.push(JSON.parse(frame)),close(){}};panel.connecting=false;panel.error="";
  panel.receive(snapshot({session_id:"session-b"}));panel.send(cx,true);
  assert.equal(frames.length,1);assert.equal(panel.draft().pending.session_id,"session-a");
});

test("approval choices keep exact backend spelling and generation, and remain until authoritative state",async()=>{
  const {panel,cx,frames,launch,settle}=setup();
  const prompt={id:"approval-1",kind:"approval",generation:7,choices:["approve_once","deny"]};
  panel.receive(snapshot({prompts:[prompt]}));panel.answer(prompt,cx,"approve_once");
  const answering=launch();launch();await settle();
  assert.equal(frames[0].choice,"approve_once");assert.equal(frames[0].generation,7);assert.equal(frames[0].prompt_id,"approval-1");
  panel.receive({type:"reply",id:frames[0].id,ok:true});await answering;
  assert.equal(panel.state.prompts.length,1);
  panel.receive(snapshot({prompts:[]}));assert.equal(panel.answers.size,0);
});

test("profile drafts are isolated and closing a viewer sends no stop request",()=>{
  const {panel,frames}=setup();
  panel.saveDraft({text:"Coordinator draft",pending:null});panel.profile="other";
  assert.equal(panel.draft().text,"");panel.saveDraft({text:"Other draft",pending:null});
  panel.profile="coordinator";assert.equal(panel.draft().text,"Coordinator draft");
  panel.close();assert.deepEqual(frames,[]);
});

test("bridge transport uses only the selected profile and decodes split UTF-8 frames without choosing a session",async()=>{
  const {panel,cx,frames,launch}=setup();
  const calls=[];
  const bytes=new TextEncoder().encode(JSON.stringify(snapshot({session_id:null,title:"café",items:[]}))+"\n");
  const split=bytes.indexOf(0xc3)+1;
  const chunks=[bytes.slice(0,split),new Error("socket read failed: Resource temporarily unavailable (os error 11)"),bytes.slice(split),null];
  transport.exec=async(...args)=>{calls.push(args);return {code:0,stdout:JSON.stringify({host:"127.0.0.1",port:1234,token:"private-token"})};};
  transport.connect=async(host,port)=>{
    assert.equal(host,"127.0.0.1");assert.equal(port,1234);
    return {write:async frame=>frames.push(JSON.parse(frame)),read:async()=>{const next=chunks.shift();if(next instanceof Error)throw next;return next;},close(){}};
  };
  panel.start(cx);await launch();
  assert.deepEqual(calls,[["hermes-shepherd-chat",["--connect","--profile","coordinator","--state-dir","/private/app/data/hermes-shepherd-chat"]]]);
  assert.deepEqual(frames,[{op:"hello",token:"private-token"}]);
  assert.equal(panel.state.title,"café");assert.equal(panel.state.session_id,null);
  assert.match(panel.error,/Disconnected/);
  assert.equal(panel.state.connected,false);
});

test("a nonlocal bridge endpoint is refused before opening a socket",async()=>{
  const {panel,cx,launch}=setup();
  let connections=0;
  transport.exec=async()=>({code:0,stdout:JSON.stringify({host:"example.com",port:1234,token:"private-token"})});
  transport.connect=async()=>{connections++;};
  panel.start(cx);await launch();
  assert.equal(connections,0);assert.match(panel.error,/invalid local endpoint/);
});

test("multi-select clarification sends canonical exact labels as JSON, while free text overrides selections",async()=>{
  const {panel,cx,frames,launch,settle}=setup();
  const prompt={id:"clarify-1",kind:"clarify",generation:7,multi_select:true,choices:["First choice","Second choice"]};
  panel.receive(snapshot({prompts:[prompt]}));
  const value=panel.answers.get(prompt.id);value.selected=["Second choice"];
  panel.answer(prompt,cx);const answering=launch();launch();await settle();
  assert.equal(frames[0].answer,'["Second choice"]');assert.equal(frames[0].choice,undefined);
  panel.receive({type:"reply",id:frames[0].id,ok:true});await answering;
  value.input.set_value("A different answer");
  panel.answer(prompt,cx);const freeText=launch();launch();await settle();
  assert.equal(frames[1].answer,"A different answer");
  panel.receive({type:"reply",id:frames[1].id,ok:true});await freeText;
});

test("an unavailable saved selection still permits History and New",async()=>{
  const {panel,cx,frames,launch,settle}=setup();
  panel.receive(snapshot({session_id:null,error:null,items:[{id:"selection-unavailable",kind:"notice",text:"Saved conversation unavailable (not_found). Choose New or History."}]}));
  panel.action("sessions",{},cx);const history=launch();launch();await settle();
  assert.equal(frames[0].op,"sessions");
  panel.receive({type:"reply",id:frames[0].id,ok:true,sessions:[{id:"other",title:"Another conversation"}]});await history;
  assert.equal(panel.history,true);
  panel.action("new",{},cx);const create=launch();launch();await settle();
  assert.equal(frames[1].op,"new");
  panel.receive({type:"reply",id:frames[1].id,ok:true});await create;
  assert.equal(panel.history,false);
});
