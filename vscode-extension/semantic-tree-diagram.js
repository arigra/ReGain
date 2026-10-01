const escapeHtml = value => String(value).replace(/[&<>"']/g, char =>
  ({"&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"}[char]));

function semanticDiagram(map) {
  const data = JSON.stringify(map).replace(/</g, "\\u003c").replace(/>/g, "\\u003e").replace(/&/g, "\\u0026");
  return `<!doctype html><!-- REGAIN_SEMANTIC_V1 -->
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(map.projectName)} · ReGain</title>
<style>
:root{font-family:Inter,Segoe UI,system-ui,sans-serif;color-scheme:dark;background:#0d1721;color:#eef6f8;--panel:#192a37;--edge:#395667;--muted:#a6bfcb;--accent:#78dade}
:root[data-theme="light"]{color-scheme:light;background:#f4f8fa;color:#19303b;--panel:#fff;--edge:#c9dce5;--muted:#506b79;--accent:#087d86}
*{box-sizing:border-box}body{margin:0;padding:clamp(20px,4vw,48px)}main{max-width:1350px;margin:auto}.eyebrow{font-size:.75rem;letter-spacing:.15em;text-transform:uppercase;font-weight:800;color:var(--accent)}h1{font-size:clamp(2rem,4vw,3.4rem);margin:12px 0}.summary{max-width:850px;color:var(--muted);line-height:1.6;font-size:1.06rem}
.toolbar{margin:23px 0}.toolbar input{width:min(100%,470px);border:1px solid var(--edge);background:var(--panel);color:inherit;border-radius:10px;padding:11px 14px;font:inherit}.toolbar input:focus{outline:2px solid var(--accent)}
.map{display:grid;grid-template-columns:minmax(290px,390px) minmax(0,1fr);gap:24px;align-items:start}.tree,.detail{background:var(--panel);border:1px solid var(--edge);border-radius:16px;padding:17px}.tree{max-height:78vh;overflow:auto}.tree h2{font-size:1.1rem;margin:3px 0 15px}.tree-row{display:flex;align-items:flex-start;gap:4px;margin:4px 0;position:relative}.tree-children{margin:4px 0 9px 13px;padding-left:16px;border-left:1px solid var(--accent)}.tree-children>.tree-row:before{content:"";position:absolute;left:-16px;top:19px;width:15px;border-top:1px solid var(--accent)}.twist{flex:none;width:26px;height:32px;border:0;background:transparent;color:var(--accent);font-size:18px;cursor:pointer}.twist:disabled{color:var(--muted);cursor:default}.node{flex:1;min-width:0;padding:7px 9px;text-align:left;border:1px solid transparent;border-radius:8px;background:transparent;color:inherit;cursor:pointer;font:inherit}.node:hover,.node[aria-selected=true]{background:color-mix(in srgb,var(--accent) 10%,transparent);border-color:var(--accent)}.node strong{display:block;font-size:.92rem}.node small{display:block;color:var(--muted);font-size:.74rem;margin-top:3px;line-height:1.35}
.detail{min-height:350px;padding:clamp(19px,3vw,30px)}.crumb{font-size:.75rem;color:var(--accent);margin-bottom:10px}.badge{display:inline-block;color:var(--accent);font-size:.72rem;text-transform:uppercase;letter-spacing:.08em;font-weight:800}.detail h2{font-size:1.7rem;margin:8px 0}.detail p{color:var(--muted);line-height:1.55}.actions{display:flex;gap:9px;flex-wrap:wrap;margin:19px 0}.action{border:1px solid var(--accent);background:color-mix(in srgb,var(--accent) 10%,transparent);border-radius:9px;color:var(--accent);padding:10px 14px;font:inherit;cursor:pointer}.action:hover{background:color-mix(in srgb,var(--accent) 20%,transparent)}.action.secondary{border-color:var(--edge);color:inherit;background:transparent}.action:disabled{opacity:.5;cursor:default}
.flow{display:flex;flex-wrap:wrap;gap:10px;margin:16px 0}.stage{flex:1 1 170px;min-width:165px;border:1px solid var(--edge);border-radius:10px;padding:12px}.stage strong{display:block;margin:4px 0}.stage p{font-size:.82rem;margin:0}.num{font-size:.7rem;color:var(--accent);font-weight:800}.scope{border-top:1px solid var(--edge);margin-top:24px;padding-top:13px}.scope h3{margin:8px 0;font-size:1.05rem}.scope-note{font-size:.85rem}.sources{display:flex;flex-wrap:wrap;gap:7px;margin:10px 0}.sources a{font-size:.78rem;color:var(--accent);border:1px solid var(--edge);border-radius:8px;padding:6px 8px;text-decoration:none;overflow-wrap:anywhere}.sources a:hover{text-decoration:underline}.relation,.uncertain{font-size:.83rem;color:var(--muted)}#status{min-height:24px;color:var(--accent);margin:14px 0}.uncertain{border-top:1px solid var(--edge);margin-top:25px;padding-top:14px}@media(max-width:850px){.map{grid-template-columns:1fr}.tree{max-height:40vh}}
</style></head><body><main><div class="eyebrow">ReGain · how this project works</div><h1>${escapeHtml(map.projectName)}</h1><p class="summary">${escapeHtml(map.summary)}</p><div class="toolbar"><input id="search" type="search" placeholder="Find a capability or feature…" aria-label="Find a capability or feature"></div><div class="map"><nav class="tree" id="tree" aria-label="Capability tree"></nav><section class="detail" id="detail" aria-live="polite"></section></div><div id="status" role="status"></div><section class="uncertain" id="uncertain"></section></main>
<script>
const map=${data};
window.addEventListener("DOMContentLoaded",()=>{
  const tree=document.getElementById("tree"),detail=document.getElementById("detail"),search=document.getElementById("search"),status=document.getElementById("status"),uncertain=document.getElementById("uncertain");
  const api=window.regainApi;
  if(map.analysis&&map.analysis.status!=="complete"){
    const alert=document.createElement("aside");
    alert.style.cssText="margin:20px 0;padding:13px 16px;border:1px solid #e6aa65;border-radius:10px;background:var(--panel);color:inherit";
    const title=document.createElement("strong");title.textContent="Analysis " + map.analysis.status.replace("_", " ");
    const message=document.createElement("p");message.textContent=map.analysis.message||"The map is still being checked.";
    alert.append(title,message);
    if(map.analysis.status!=="in_progress"){
      const retry=document.createElement("button");retry.className="action";retry.textContent="Resume analysis";
      retry.addEventListener("click",()=>{retry.disabled=true;retry.textContent="Resuming…";api.postMessage({type:"retryAnalysis"});});
      alert.append(retry);
    }
    if((map.analysis.unplaced||[]).length){
      const list=document.createElement("ul");
      for(const item of map.analysis.unplaced){const entry=document.createElement("li");entry.textContent=item.name+" — "+(item.evidencePaths||[]).join(", ");list.append(entry);}
      alert.append(list);
    }
    document.querySelector(".toolbar").before(alert);
  }
  if(map.coverage){
    const box=document.createElement("aside");box.style.cssText="display:flex;flex-wrap:wrap;gap:8px 18px;align-items:center;margin:20px 0;padding:11px 14px;border:1px solid var(--edge);border-radius:10px;background:var(--panel);font-size:.85rem";
    const label=document.createElement("strong");label.textContent=(map.analysis?.status==="complete"?"File coverage complete":"File coverage in progress") + " ("+(map.coverage.unresolved||0)+" unresolved)";label.style.color="var(--accent)";
    const totals=document.createElement("span");totals.textContent=map.coverage.mapped+" mapped · "+map.coverage.supporting+" supporting · "+map.coverage.excluded+" excluded · "+map.coverage.excludedDirectories+" excluded directories";totals.style.color="var(--muted)";
    const link=document.createElement("a");link.href="file-coverage.json";link.textContent="Open file coverage manifest";link.style.color="var(--accent)";
    box.append(label,totals,link);document.querySelector(".toolbar").before(box);
  }
  const saved=api&&api.getState?api.getState()||{}:{};
  const opened=new Set(saved.opened||map.capabilities.filter(item=>(item.children||[]).length).map(item=>item.id));
  let selected=null,ancestors=[];
  function el(tag,text,cls){const node=document.createElement(tag);if(text!==undefined)node.textContent=text;if(cls)node.className=cls;return node;}
  function persist(){if(api&&api.setState)api.setState({opened:[...opened],selected:selected&&selected.id});}
  function find(id,nodes=map.capabilities,trail=[]){for(const node of nodes){if(node.id===id)return {node,trail};const child=find(id,node.children||[],trail.concat(node));if(child)return child;}return null;}
  function sourceLink(item){const a=el("a",item.path);a.href="../"+item.path;a.title=item.reason||item.path;return a;}
  function scopeSources(node){const found=new Map();function visit(current){for(const item of current.sources||[])if(!found.has(item.path))found.set(item.path,item);for(const child of current.children||[])visit(child);}visit(node);return [...found.values()];}
  function descendants(node){return (node.children||[]).reduce((total,child)=>total+1+descendants(child),0);}
  function matches(node,query){return (node.name+" "+node.purpose).toLowerCase().includes(query)||(node.children||[]).some(child=>matches(child,query));}
  function renderTree(){tree.replaceChildren(el("h2","Explore the project"));const query=search.value.trim().toLowerCase();function add(node,container){if(query&&!matches(node,query))return;const row=el("div",undefined,"tree-row");const hasChildren=(node.children||[]).length>0;const toggle=el("button",hasChildren?(opened.has(node.id)?"▾":"▸"):(node.refined?"·":"+"),"twist");toggle.title=hasChildren?"Expand or collapse this branch":node.refined?"This is a leaf":"Ask the agent to explore this branch";toggle.disabled=!hasChildren&&!!node.refined;toggle.addEventListener("click",()=>{if(hasChildren){if(opened.has(node.id))opened.delete(node.id);else opened.add(node.id);persist();renderTree();}else explore(node);});const pick=el("button",undefined,"node");pick.setAttribute("aria-selected",String(selected&&selected.id===node.id));pick.append(el("strong",node.name),el("small",node.purpose));pick.addEventListener("click",()=>select(node.id));row.append(toggle,pick);container.append(row);if(hasChildren&&(opened.has(node.id)||query)){const branch=el("div",undefined,"tree-children");container.append(branch);for(const child of node.children)add(child,branch);}}for(const node of map.capabilities)add(node,tree);if(tree.children.length===1)tree.append(el("p","No matching capability."));}
  function explore(node){status.textContent="Agent exploring "+node.name+"…";opened.add(node.id);persist();api.postMessage({type:"expandCapability",id:node.id});}
  function select(id){const found=find(id);if(!found)return;selected=found.node;ancestors=found.trail;persist();renderTree();renderDetail();}
  function renderDetail(){const node=selected;detail.replaceChildren();detail.append(el("div",ancestors.map(item=>item.name).concat(node.name).join(" › "),"crumb"),el("span",node.runtimeStatus||"unknown","badge"),el("h2",node.name),el("p",node.purpose));const actions=el("div",undefined,"actions");if(!node.refined){const more=el("button","Explore deeper","action secondary");more.addEventListener("click",()=>explore(node));actions.append(more);}else if((node.children||[]).length){const more=el("button",opened.has(node.id)?"Collapse children":"Show children","action secondary");more.addEventListener("click",()=>{if(opened.has(node.id))opened.delete(node.id);else opened.add(node.id);persist();renderTree();renderDetail();});actions.append(more);}const create=el("button","Create notebook for this scope","action");create.addEventListener("click",()=>{status.textContent="Agent analyzing "+node.name+"…";api.postMessage({type:"analyzeCapability",id:node.id});});actions.append(create);detail.append(actions);
    if((node.flow||[]).length){detail.append(el("h3","How it works"));const flow=el("div",undefined,"flow");node.flow.forEach((step,i)=>{const card=el("article",undefined,"stage");card.append(el("span",String(i+1).padStart(2,"0"),"num"),el("strong",step.label),el("p",step.description));flow.append(card);});detail.append(flow);}
    const scope=el("div",undefined,"scope"),sources=scopeSources(node),count=descendants(node);scope.append(el("h3","Notebook scope"),el("p",count?"Includes this branch, "+count+" explored descendants, and shared code needed to follow their flow.":"Includes this feature and its verified entry, processing, and output code.","scope-note"),el("p",sources.length+" source file"+(sources.length===1?"":"s")+" currently identified.","scope-note"));const refs=el("div",undefined,"sources");sources.forEach(item=>refs.append(sourceLink(item)));scope.append(refs);detail.append(scope);if((node.refinementNotes||[]).length)detail.append(el("p","Unresolved: "+node.refinementNotes.join(" · "),"relation"));}
  search.addEventListener("input",renderTree);uncertain.textContent=(map.uncertainties||[]).length?"Unresolved: "+map.uncertainties.join(" · "):"Every shown capability has source evidence.";const firstExpanded=map.capabilities.find(item=>(item.children||[]).length);const initial=find(saved.selected)||(firstExpanded?find(firstExpanded.id):null)||{node:map.capabilities[0],trail:[]};if(initial&&initial.node)select(initial.node.id);
});
</script></body></html>`;
}

module.exports = {semanticDiagram};
