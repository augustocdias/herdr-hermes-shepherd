import { registerHooks } from "node:module";
import { test } from "node:test";
import assert from "node:assert/strict";

const state = globalThis.shepherdTest = { tree: null, commands: [], refuse: false };
const stubs = {
  "gpui-kit": "export class View {} export const div=()=>{}, svg=()=>{}, image=()=>{};",
  "gpui-base": "export const v_flex=()=>{}, h_flex=()=>{}, TextView={}, TextareaState={}, Textarea={}, InputState={}, Input={}, Scrollbar={};",
  herdr: `
    export const spaces=()=>[], panes=()=>[], terminals=()=>[], focused=()=>null,
      layout=()=>globalThis.shepherdTest.tree, home=()=>'', appHome=()=>'',
      readTextFile=async()=>null, writeTextFile=async()=>{}, run=()=>{}, watchFolder=()=>{},
      theme=()=>({}), settings=()=>({}), shared=()=>null, setShared=()=>{},
      props=()=>({panel:true}), openOverlay=()=>{}, closeOverlay=()=>{}, nextCommand=()=>{}, notify=()=>{};
    export async function hc(args) { globalThis.shepherdTest.commands.push(args); return {code:0,stdout:'',stderr:''}; }
    export async function exec(command,args) {
      if(command!=='herdr-app') return {code:1,stdout:'',stderr:''};
      if(globalThis.shepherdTest.refuse) return {code:1,stdout:'{"error":"shipped layout"}',stderr:''};
      globalThis.shepherdTest.tree=JSON.parse(args[2]).layout;
      return {code:0,stdout:'{"ok":true}',stderr:''};
    }`,
};
registerHooks({ resolve(specifier, context, next) {
  return specifier in stubs ? {url:`data:text/javascript,${encodeURIComponent(stubs[specifier])}`,shortCircuit:true} : next(specifier,context);
} });
const { default: Shepherd } = await import("../mods/hermes-shepherd/main.js");

function setup() {
  state.tree = {id:"root",type:"row",children:[
    {id:"files",type:"block",size:{px:321},content:{mod:"files"}},
    {id:"shepherd",type:"column",size:{px:600},children:[
      {id:"shepherd-bar",type:"block",size:{px:36},content:{mod:"hermes-shepherd",props:{panel:true}}},
    ]},
  ]};
  state.commands=[]; state.refuse=false;
  const tasks=[];
  const cx={spawn:fn=>tasks.push(fn(cx)),notify:()=>{}};
  const view=new Shepherd(); view.init({},cx);
  return {panel:view.details,cx,flush:async()=>{while(tasks.length) await tasks.shift();}};
}

test("restoring a missing chat block preserves the layout and does not restart a live conversation", async()=>{
  const {panel,cx,flush}=setup();
  const before=structuredClone(state.tree);
  panel.restart({kind:"running",term:{address:"t7"}},cx);
  await flush();
  assert.deepEqual(state.tree.children[0],before.children[0]);
  assert.deepEqual(state.tree.children[1].children[0],before.children[1].children[0]);
  assert.deepEqual(state.tree.children[1].size,{px:600});
  assert.deepEqual(state.tree.children[1].children[1],{id:"shepherd-terminal",type:"block",content:{terminal:"hermes-shepherd"}});
  assert.deepEqual(state.commands,[]);
  panel.restart({kind:"running",term:{address:"t7"}},cx);
  await flush();
  assert.equal(state.tree.children[1].children.length,2);
});

test("a refused layout repair leaves the layout and conversation untouched and allows another attempt",async()=>{
  const {panel,cx,flush}=setup();
  const before=structuredClone(state.tree);
  state.refuse=true;
  panel.restart({kind:"gone"},cx); await flush();
  assert.deepEqual(state.tree,before);
  assert.deepEqual(state.commands,[]);
  assert.match(panel.repairError,/shipped layout.*layout.clone/);
  assert.equal(panel.repairing,false);
  state.refuse=false;
  panel.restart({kind:"gone"},cx); await flush();
  assert.equal(state.tree.children[1].children[1].content.terminal,"hermes-shepherd");
  assert.equal(panel.phase,null);
});
