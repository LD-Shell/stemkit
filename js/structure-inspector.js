document.addEventListener("DOMContentLoaded", () => {

// --- 1. State ---
let viewer = null, surfaceID = null, currentModelData = null, currentExtension = null;
let axisShapes = [], isoShapes = [], measureShapes = [], measureLabels = [];
let measureMode = false, measureAtoms = [], trajPlaying = false, trajInterval = null;
let customElementColors = {};

const T = { atomLabels:false, resLabels:false, hydrogens:true, axis:false, spin:false, clickInspect:true, outline:false, fog:false };

const ElementColors = {
    H:'#FFFFFF', C:'#909090', O:'#FF0D0D', N:'#3050F8', S:'#FFFF30', P:'#FF8000',
    F:'#90E050', Cl:'#1FF01F', Br:'#A62929', I:'#940094', Fe:'#E06633', Ca:'#3DFF00',
    Na:'#AB5CF2', K:'#8F40D4', Mg:'#8AFF00', Zn:'#7D80B0', Cu:'#C88033', Mn:'#3DFF00'
};
const defaultAtomColor = '#cccccc';

// --- 2. Element references ---
const $ = id => document.getElementById(id);
const uploadZone=$('uploadZone'), fileInput=$('fileInput'), workspace=$('workspace');
const styleSelect=$('styleSelect'), colorSelect=$('colorSelect');
const perElementColorContainer=$('perElementColorContainer');
const selQuery=$('selQuery'), selStyle=$('selStyle'), applySelStyleBtn=$('applySelStyle'), clearSelStylesBtn=$('clearSelStyles');
const centerBtn=$('centerBtn'), surfaceBtn=$('surfaceBtn'), surfaceType=$('surfaceType');
const surfaceOpacity=$('surfaceOpacity'), surfaceOpacityVal=$('surfaceOpacityVal');
const surfaceColorScheme=$('surfaceColorScheme'), surfaceCustomColor=$('surfaceCustomColor');
const slabNear=$('slabNear'), slabFar=$('slabFar'), slabNearVal=$('slabNearVal'), slabFarVal=$('slabFarVal'), resetSlab=$('resetSlab');
const bgSelect=$('bgSelect'), resetBtn=$('resetBtn');
const downloadBtn=$('downloadBtn'), exportQuality=$('exportQuality');
const axisBtns=document.querySelectorAll('.axis-btn'), viewerCanvas=$('viewerCanvas');
const atomInfoEl=$('atomInfo'), measureInfo=$('measureInfo'), modeBadge=$('modeBadge');
const isoPanel=$('isoPanel'), isoPosVal=$('isoPosVal'), isoNegVal=$('isoNegVal'), isoOpacity=$('isoOpacity');
const isoPosDisplay=$('isoPosDisplay'), isoNegDisplay=$('isoNegDisplay'), isoOpacityDisplay=$('isoOpacityDisplay');
const applyIsoBtn=$('applyIso'), clearIsoBtn=$('clearIso');
const measureModeBtn=$('measureModeBtn'), clearMeasuresBtn=$('clearMeasures');
const focusQuery=$('focusQuery'), focusBtn=$('focusBtn'), isolateBtn=$('isolateBtn'), showAllBtn=$('showAllBtn');
const trajectoryPanel=$('trajectoryPanel'), trajSlider=$('trajSlider'), trajFrame=$('trajFrame');
const trajPrev=$('trajPrev'), trajPlay=$('trajPlay'), trajNext=$('trajNext'), trajSpeed=$('trajSpeed');
const pdbIdInput=$('pdbIdInput'), fetchPdbBtn=$('fetchPdbBtn');

const toggleEls = { atomLabels:$('toggleAtomLabels'), resLabels:$('toggleResLabels'), hydrogens:$('toggleHydrogens'),
    axis:$('toggleAxis'), spin:$('toggleSpin'), clickInspect:$('toggleClickInspect'), outline:$('toggleOutline'), fog:$('toggleFog') };

// --- 3. Format map ---
const FM = {
    '.pdb':{f:'pdb',l:'PDB',b:false},'.ent':{f:'pdb',l:'PDB (ENT)',b:false},
    '.sdf':{f:'sdf',l:'SDF',b:false},'.mol':{f:'sdf',l:'MOL',b:false},
    '.mol2':{f:'mol2',l:'MOL2',b:false},'.xyz':{f:'xyz',l:'XYZ',b:false},
    '.cif':{f:'cif',l:'CIF',b:false},'.mcif':{f:'cif',l:'mmCIF',b:false},
    '.cdjson':{f:'cdjson',l:'CDJSON',b:false},'.json':{f:'cdjson',l:'CDJSON',b:false},
    '.mmtf':{f:'mmtf',l:'MMTF',b:true},'.prmtop':{f:'prmtop',l:'PRMTOP',b:false},
    '.gro':{f:'gro',l:'GRO',b:false},'.pqr':{f:'pqr',l:'PQR',b:false},
    '.cube':{f:'cube',l:'CUBE',b:false},'.vasp':{f:'vasp',l:'VASP',b:false},
    '.poscar':{f:'vasp',l:'POSCAR',b:false},'.contcar':{f:'vasp',l:'CONTCAR',b:false}
};

// --- 4. Helpers ---
function setupToggle(el, key, fn) {
    if (!el) return;
    el.addEventListener('click', () => { T[key]=!T[key]; el.classList.toggle('active',T[key]); el.setAttribute('aria-checked',T[key]); if(fn) fn(T[key]); });
    el.addEventListener('keydown', e => { if(e.key===' '||e.key==='Enter'){e.preventDefault();el.click()} });
}

function showToast(msg,type='info') {
    const c=$('toastContainer'), t=document.createElement('div');
    const cls=type==='success'?'bg-emerald-50 text-emerald-800 border-emerald-200 dark:bg-emerald-950 dark:text-emerald-300 dark:border-emerald-800':type==='error'?'bg-red-50 text-red-800 border-red-200 dark:bg-red-950 dark:text-red-300 dark:border-red-800':'bg-indigo-50 text-indigo-800 border-indigo-200 dark:bg-indigo-950 dark:text-indigo-300 dark:border-indigo-800';
    const ico=type==='success'?'fa-check-circle':type==='error'?'fa-triangle-exclamation':'fa-info-circle';
    t.className=`px-4 py-3 rounded-xl border shadow-lg text-sm font-medium ${cls}`;
    t.style.animation='slideIn .3s forwards';
    t.innerHTML=`<i class="fa-solid ${ico} mr-2"></i>${msg}`;
    c.appendChild(t); setTimeout(()=>{t.style.opacity='0';setTimeout(()=>t.remove(),300)},3000);
}

function getBackgroundColor() {
    const v=bgSelect.value;
    if(v==='black') return '#000'; if(v==='white') return '#fff'; if(v==='grey') return '#64748b';
    return document.documentElement.classList.contains('dark')?'#020617':'#f8fafc';
}

function applyBackground() { if(viewer){viewer.setBackgroundColor(getBackgroundColor());viewer.render()} }
function baseName() { return ($('fileName').innerText||'structure').replace(/\.[^.]+$/,'') }

function parseSelString(s) {
    const sel = {}; if(!s.trim()) return sel;
    s.trim().split(/\s+/).forEach(tok => {
        const [k,v] = tok.split(':');
        if(!v) return;
        if(k==='chain') sel.chain=v;
        else if(k==='resn') sel.resn=v;
        else if(k==='resi') { const m=v.match(/^(\d+)-(\d+)$/); if(m) sel.resi=[parseInt(m[1]),parseInt(m[2])]; else sel.resi=isNaN(v)?v:parseInt(v); }
        else if(k==='elem') sel.elem=v;
        else if(k==='atom') sel.atom=v;
        else sel[k]=v;
    });
    return sel;
}

// --- 5. Tabs & theme ---
document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
        document.querySelectorAll('.tab-btn').forEach(b=>b.classList.remove('active'));
        document.querySelectorAll('.tab-content').forEach(c=>c.classList.add('hidden'));
        btn.classList.add('active');
        const panel = $(btn.dataset.tab);
        if(panel) panel.classList.remove('hidden');
    });
});

document.querySelectorAll('.themeToggle').forEach(b=>b.addEventListener('click',()=>{
    if(bgSelect.value==='theme') applyBackground();
}));

// --- 6. File upload ---
['dragenter','dragover','dragleave','drop'].forEach(e=>uploadZone.addEventListener(e,ev=>{ev.preventDefault();ev.stopPropagation()},false));
uploadZone.addEventListener('dragover',()=>uploadZone.classList.add('border-indigo-500'));
uploadZone.addEventListener('dragleave',()=>uploadZone.classList.remove('border-indigo-500'));
uploadZone.addEventListener('drop',e=>{uploadZone.classList.remove('border-indigo-500');handleFile(e.dataTransfer.files[0])});
uploadZone.addEventListener('click',e=>{if(e.target.closest('#pdbIdInput')||e.target.closest('#fetchPdbBtn'))return;fileInput.click()});
fileInput.addEventListener('change',e=>handleFile(e.target.files[0]));

function handleFile(file) {
    if(!file) return;
    const fn = file.name.toLowerCase();
    const m = Object.entries(FM).find(([ext]) => fn.endsWith(ext));
    if(!m) { showToast('Format not supported.', 'error'); return; }
    
    const [, info] = m; 
    currentExtension = info.f;
    $('fileName').innerText = file.name; 
    $('formatBadge').innerText = info.l;
    showToast('Loading...', 'info');
    
    const r = new FileReader();
    if(info.b) {
        r.onload = e => { currentModelData = new Uint8Array(e.target.result); initViewer(); };
        r.readAsArrayBuffer(file);
    } else {
        r.onload = e => { currentModelData = e.target.result; initViewer(); };
        r.readAsText(file);
    }
}

fetchPdbBtn.addEventListener('click', async () => {
    const id = pdbIdInput.value.trim().toUpperCase();
    if(!id || id.length < 4) { showToast('Enter a valid 4-character PDB ID.', 'error'); return; }
    
    showToast(`Fetching ${id} from RCSB...`, 'info');
    currentExtension = 'pdb';
    $('fileName').innerText = id + '.pdb'; 
    $('formatBadge').innerText = 'PDB — RCSB Fetch';
    
    uploadZone.classList.add('hidden'); 
    workspace.classList.remove('hidden'); 
    workspace.classList.add('flex');
    
    if(viewer) { viewer.clear(); } 
    else { viewer = $3Dmol.createViewer(viewerCanvas, { backgroundColor: getBackgroundColor() }); }
    
    try {
        const res = await fetch(`https://files.rcsb.org/download/${id}.pdb`);
        if(!res.ok) throw new Error('Network response was not ok');
        currentModelData = await res.text();
        initViewer();
    } catch(e) {
        console.error(e);
        showToast(`Failed to fetch ${id}.`, 'error');
    }
});

// --- 7. Viewer initialization ---
function getParserOpts() {
    return { multimodel: true, frames: true, keepH: true };
}

function initViewer() {
    uploadZone.classList.add('hidden'); workspace.classList.remove('hidden'); workspace.classList.add('flex');
    if(viewer){viewer.clear()}else{viewer=$3Dmol.createViewer(viewerCanvas,{backgroundColor:getBackgroundColor()})}
    try {
        viewer.addModel(currentModelData, currentExtension, getParserOpts());
        afterModelLoaded();
        showToast('Structure rendered.','success');
    } catch(e){console.error(e);showToast('Error parsing file.','error')}
}

function afterModelLoaded() {
    const atoms = viewer.getModel().selectedAtoms({});
    const elems = new Set(atoms.map(a => a.elem).filter(Boolean));
    const chains = new Set(atoms.map(a => a.chain).filter(Boolean));
    
    let meta = `${atoms.length} Atoms`;
    if (elems.size > 0) meta += ` · ${elems.size} Elem`;
    if (chains.size > 1) meta += ` · ${chains.size} Chains`;
    $('structureMeta').innerText = meta;
    
    buildPerElementColorUI(Array.from(elems).sort());
    
    isoPanel.classList.toggle('hidden', currentExtension !== 'cube');
    
    const nFrames = viewer.getModel().getNumFrames();
    if (nFrames > 1) {
        trajectoryPanel.classList.remove('hidden');
        trajSlider.max = nFrames - 1;
        trajSlider.value = 0;
        trajFrame.textContent = `1/${nFrames}`;
    } else {
        trajectoryPanel.classList.add('hidden');
    }

    applyStyles(); 
    applyBackground();
    setupClickInspect();
    viewer.zoomTo(); 
    viewer.render();
}

function reloadModel() {
    if(!viewer||!currentModelData) return;
    const had=surfaceID!==null; removeSurface(); removeAxisIndicator(); viewer.removeAllLabels(); viewer.clear();
    try{
        viewer.addModel(currentModelData, currentExtension, getParserOpts());
        afterModelLoaded();
        if(T.axis) drawAxisIndicator(); updateLabels();
        if(had) addSurface(); if(T.spin) viewer.spin('y',1);
        viewer.zoomTo(); viewer.render();
    }catch(e){console.error(e);showToast('Error reloading.','error')}
}

// --- 8. Styles and colors ---
function buildPerElementColorUI(elements) {
    perElementColorContainer.innerHTML = '<div class="text-[10px] font-bold text-slate-500 uppercase tracking-wider mb-1 sticky top-0 bg-slate-50 dark:bg-slate-900/50 z-10 pb-1">Per-Element Colors</div>';
    customElementColors = {};

    elements.forEach(el => {
        const defCol = ElementColors[el] || defaultAtomColor;
        customElementColors[el] = defCol;

        const row = document.createElement('div');
        row.className = 'flex items-center justify-between gap-2';

        const label = document.createElement('span');
        label.className = 'text-[11px] font-mono font-bold text-slate-700 dark:text-slate-300 w-8';
        label.innerText = el;

        const picker = document.createElement('input');
        picker.type = 'color';
        picker.value = defCol;
        picker.className = 'w-6 h-6 rounded cursor-pointer border-0 p-0 flex-grow bg-transparent';

        const defBtn = document.createElement('button');
        defBtn.className = 'sidebar-btn px-2 py-1 text-[9px] font-bold';
        defBtn.innerText = 'Reset';

        picker.addEventListener('input', (e) => {
            customElementColors[el] = e.target.value;
            applyStyles();
        });

        defBtn.addEventListener('click', () => {
            picker.value = defCol;
            customElementColors[el] = defCol;
            applyStyles();
        });

        row.appendChild(label);
        row.appendChild(picker);
        row.appendChild(defBtn);
        perElementColorContainer.appendChild(row);
    });
}

function getColorObj() {
    const c=colorSelect.value;
    if(c==='element') return {colorscheme:'Jmol'};
    if(c==='chain') return {colorscheme:'chain'};
    if(c==='residue') return {colorscheme:'amino'};
    if(c==='bFactor') return {colorscheme:'bFactor'};
    if(c==='spectrum') return {color:'spectrum'};
    if(c==='ss') return {colorscheme:'ssJmol'};
    return {};
}

function buildStyleObj(type, colObj) {
    if(type==='stick') return {stick:{radius:.15,...colObj}};
    if(type==='ballstick') return {stick:{radius:.12,...colObj},sphere:{scale:.25,...colObj}};
    if(type==='sphere') return {sphere:{...colObj}};
    if(type==='cross') return {cross:{linewidth:2,...colObj}};
    if(type==='line') return {line:{...colObj}};
    if(type==='cartoon') return {cartoon:{...colObj},stick:{radius:.08,...colObj}};
    if(type==='hidden') return {};
    return {stick:{radius:.15,...colObj}};
}

function applyStyles() {
    if(!viewer) return;
    const styleType = styleSelect.value;
    const colorMode = colorSelect.value;

    if (colorMode === 'custom') {
        viewer.setStyle({}, {hidden: true});
        for (const [el, col] of Object.entries(customElementColors)) {
            viewer.addStyle({elem: el}, buildStyleObj(styleType, {color: col}));
        }
    } else {
        viewer.setStyle({}, buildStyleObj(styleType, getColorObj()));
    }

    if(!T.hydrogens) viewer.setStyle({elem:'H'},{hidden:true});
    viewer.render();
}

colorSelect.addEventListener('change', () => {
    perElementColorContainer.classList.toggle('hidden', colorSelect.value !== 'custom');
    applyStyles();
});

styleSelect.addEventListener('change', applyStyles);
bgSelect.addEventListener('change', applyBackground);

// I am ensuring the manual selection target inherits the element color array when running in custom mode.
applySelStyleBtn.addEventListener('click', () => {
    if(!viewer) return;
    const sel = parseSelString(selQuery.value);
    const sType = selStyle.value;
    
    if (sType === 'hidden') {
        viewer.addStyle(sel, {hidden: true});
    } else if (colorSelect.value === 'custom') {
        for (const [el, col] of Object.entries(customElementColors)) {
            const subSel = { ...sel, elem: el };
            viewer.addStyle(subSel, buildStyleObj(sType, {color: col}));
        }
    } else {
        viewer.addStyle(sel, buildStyleObj(sType, getColorObj()));
    }
    
    viewer.render();
    showToast('Selection style applied.', 'success');
});

clearSelStylesBtn.addEventListener('click',()=>{applyStyles();showToast('Selection styles cleared.')});

// --- 9. Labels ---
function updateLabels() {
    if(!viewer) return; 
    
    viewer.removeAllLabels();
    measureLabels.forEach(lbl => viewer.addLabel(lbl.text, lbl.options));

    if(T.atomLabels) {
        const atoms=viewer.getModel().selectedAtoms({}), max=Math.min(atoms.length,2000);
        for(let i=0;i<max;i++){const a=atoms[i];if(!T.hydrogens&&a.elem==='H')continue;
            viewer.addLabel(a.elem,{position:{x:a.x,y:a.y,z:a.z},fontSize:10,fontColor:'white',backgroundColor:'rgba(30,41,59,.7)',backgroundOpacity:.7,borderRadius:4,padding:1,showBackground:true,inFront:true})}
        if(atoms.length>2000) showToast(`Labels capped at 2000/${atoms.length}.`);
    }
    if(T.resLabels) {
        const atoms=viewer.getModel().selectedAtoms({}), rm=new Map();
        atoms.forEach(a=>{const k=`${a.chain||''}_${a.resn||''}_${a.resi||''}`;if(!rm.has(k))rm.set(k,a);if(a.atom==='CA')rm.set(k,a)});
        rm.forEach(a=>viewer.addLabel(`${a.resn||'?'}${a.resi||''}`,{position:{x:a.x,y:a.y,z:a.z},fontSize:9,fontColor:'#c7d2fe',backgroundColor:'rgba(67,56,202,.75)',backgroundOpacity:.75,borderRadius:4,padding:2,showBackground:true,inFront:true}));
    }
    viewer.render();
}

// --- 10. Axis indicator ---
function drawAxisIndicator() {
    removeAxisIndicator(); if(!viewer||!T.axis) return;
    const atoms=viewer.getModel().selectedAtoms({}); if(!atoms.length) return;
    let mx=Infinity,my=Infinity,mz=Infinity;
    atoms.forEach(a=>{mx=Math.min(mx,a.x);my=Math.min(my,a.y);mz=Math.min(mz,a.z)});
    const ox=mx-6,oy=my-6,oz=mz-6,len=4;
    [{d:{x:len,y:0,z:0},c:'#ef4444',l:'X'},{d:{x:0,y:len,z:0},c:'#22c55e',l:'Y'},{d:{x:0,y:0,z:len},c:'#3b82f6',l:'Z'}].forEach(({d,c,l})=>{
        axisShapes.push(viewer.addArrow({start:{x:ox,y:oy,z:oz},end:{x:ox+d.x,y:oy+d.y,z:oz+d.z},radius:.15,color:c,radiusRatio:2.5,mid:.75}));
        viewer.addLabel(l,{position:{x:ox+d.x*1.2,y:oy+d.y*1.2,z:oz+d.z*1.2},fontSize:12,fontColor:c,backgroundColor:'transparent',showBackground:false,inFront:true});
    }); viewer.render();
}

function removeAxisIndicator(){axisShapes.forEach(s=>{try{viewer.removeShape(s)}catch(e){}});axisShapes=[]}

// --- 11. Surface ---
function getSurfType(){const v=surfaceType.value;if(v==='SAS')return $3Dmol.SurfaceType.SAS;if(v==='SES')return $3Dmol.SurfaceType.SES;if(v==='MS')return $3Dmol.SurfaceType.MS;return $3Dmol.SurfaceType.VDW}

function getSurfColorSpec(){
    const s=surfaceColorScheme.value;
    if(s==='white') return {color:'white'};
    if(s==='element') return {colorscheme:'Jmol'};
    if(s==='chain') return {colorscheme:'chain'};
    if(s==='bFactor') return {colorscheme:'bFactor'};
    if(s==='spectrum') return {color:'spectrum'};
    if(s==='custom') return {color:surfaceCustomColor.value};
    return {color:'white'};
}

function addSurface(){if(!viewer)return;surfaceID=viewer.addSurface(getSurfType(),{opacity:parseFloat(surfaceOpacity.value),...getSurfColorSpec()});viewer.render()}
function removeSurface(){if(!viewer||surfaceID===null)return;viewer.removeSurface(surfaceID);surfaceID=null}

surfaceBtn.addEventListener('click',()=>{if(!viewer)return;surfaceID!==null?removeSurface():addSurface();viewer.render()});
surfaceOpacity.addEventListener('input',()=>{surfaceOpacityVal.textContent=parseFloat(surfaceOpacity.value).toFixed(2);if(surfaceID!==null){removeSurface();addSurface()}});
surfaceColorScheme.addEventListener('change',()=>{surfaceCustomColor.classList.toggle('hidden',surfaceColorScheme.value!=='custom');if(surfaceID!==null){removeSurface();addSurface()}});
surfaceCustomColor.addEventListener('input',()=>{if(surfaceID!==null){removeSurface();addSurface()}});

// --- 12. Slab and clipping ---
function applySlab(){
    if(!viewer) return;
    const n=parseInt(slabNear.value), f=parseInt(slabFar.value);
    slabNearVal.textContent=n===-100?'Off':n; slabFarVal.textContent=f===100?'Off':f;
    viewer.setSlab(n,f); viewer.render();
}

slabNear.addEventListener('input',applySlab); slabFar.addEventListener('input',applySlab);
resetSlab.addEventListener('click',()=>{slabNear.value=-100;slabFar.value=100;applySlab()});

// --- 13. Outline and fog ---
function applyOutline(){if(!viewer)return;if(T.outline)viewer.setViewStyle({style:'outline',color:'black',width:.02});else viewer.setViewStyle({});viewer.render()}

function applyFog(){
    if(!viewer)return;
}

// --- 14. Click to inspect ---
function setupClickInspect(){
    if(!viewer) return;
    viewer.setClickable({},true,atom=>{
        if(measureMode){handleMeasureClick(atom);return}
        if(!T.clickInspect) return;
        let info=`<b>${atom.elem}</b>`;
        if(atom.atom) info+=` — ${atom.atom}`;
        if(atom.resn) info+=`<br>Res: ${atom.resn} ${atom.resi||''}`;
        if(atom.chain) info+=`<br>Chain: ${atom.chain}`;
        info+=`<br>Pos: (${atom.x.toFixed(2)}, ${atom.y.toFixed(2)}, ${atom.z.toFixed(2)})`;
        if(atom.b) info+=`<br>B: ${atom.b.toFixed(2)}`;
        if(atom.serial!==undefined) info+=`<br>Serial: ${atom.serial}`;
        atomInfoEl.innerHTML=info; atomInfoEl.classList.add('visible');
        setTimeout(()=>atomInfoEl.classList.remove('visible'),4000);
    });
}

// --- 15. Distance measurement ---
measureModeBtn.addEventListener('click',()=>{
    measureMode=!measureMode; measureAtoms=[];
    measureModeBtn.style.background=measureMode?'#f59e0b':'';
    measureModeBtn.style.color=measureMode?'#fff':'';
    modeBadge.classList.toggle('hidden',!measureMode);
    modeBadge.classList.toggle('measure',measureMode);
    modeBadge.textContent=measureMode?'Measure Mode':'';
});

function handleMeasureClick(atom) {
    measureAtoms.push(atom);
    
    measureShapes.push(viewer.addSphere({center:{x:atom.x,y:atom.y,z:atom.z},radius:.4,color:'#facc15',opacity:.7}));
    viewer.render();
    
    if(measureAtoms.length===2){
        const [a,b]=measureAtoms;
        const dx=a.x-b.x,dy=a.y-b.y,dz=a.z-b.z;
        const dist=Math.sqrt(dx*dx+dy*dy+dz*dz);
        const mid={x:(a.x+b.x)/2,y:(a.y+b.y)/2,z:(a.z+b.z)/2};
        
        measureShapes.push(viewer.addCylinder({start:{x:a.x,y:a.y,z:a.z},end:{x:b.x,y:b.y,z:b.z},radius:.04,color:'#facc15',dashed:true,fromCap:true,toCap:true}));
        
        const labelText = `${dist.toFixed(2)} Å`;
        const labelOpts = {position:mid,fontSize:11,fontColor:'#fef08a',backgroundColor:'rgba(120,53,15,.8)',backgroundOpacity:.8,borderRadius:4,padding:2,showBackground:true,inFront:true};
        
        viewer.addLabel(labelText, labelOpts);
        measureLabels.push({ text: labelText, options: labelOpts });
        
        viewer.render();
        measureInfo.innerHTML+= `<div>${a.elem}${a.serial||''} ↔ ${b.elem}${b.serial||''}: <b>${dist.toFixed(2)} Å</b></div>`;
        measureAtoms=[];
    }
}

clearMeasuresBtn.addEventListener('click',()=>{
    if(!viewer) return;
    
    measureShapes.forEach(s=>{try{viewer.removeShape(s)}catch(e){}});
    measureShapes = [];
    measureLabels = [];
    measureAtoms = [];
    measureInfo.innerHTML = '';
    
    viewer.removeAllLabels();
    updateLabels();
    if(T.axis) drawAxisIndicator();
    
    viewer.render();
});

// --- 16. Selection and focus ---
focusBtn.addEventListener('click',()=>{
    if(!viewer) return;
    const sel=parseSelString(focusQuery.value);
    viewer.zoomTo(sel); viewer.render();
});

isolateBtn.addEventListener('click',()=>{
    if(!viewer) return;
    const sel=parseSelString(focusQuery.value);
    viewer.setStyle({},{hidden:true}); 
    viewer.setStyle(sel, buildStyleObj(styleSelect.value, getColorObj()));
    viewer.zoomTo(sel); viewer.render();
});

showAllBtn.addEventListener('click',()=>{applyStyles();if(viewer){viewer.zoomTo();viewer.render()}});

document.querySelectorAll('.sel-guide-btn').forEach(btn => {
    btn.addEventListener('click', () => {
        const content = btn.nextElementSibling;
        const icon = btn.querySelector('i');
        content.classList.toggle('hidden');
        icon.style.transform = content.classList.contains('hidden') ? '' : 'rotate(180deg)';
    });
});

// --- 17. Trajectory ---
trajSlider.addEventListener('input',()=>{
    if(!viewer) return;
    const f=parseInt(trajSlider.value);
    viewer.setFrame(f); viewer.render();
    trajFrame.textContent=`${f+1}/${parseInt(trajSlider.max)+1}`;
});

trajPrev.addEventListener('click',()=>{if(parseInt(trajSlider.value)>0){trajSlider.value=parseInt(trajSlider.value)-1;trajSlider.dispatchEvent(new Event('input'))}});
trajNext.addEventListener('click',()=>{if(parseInt(trajSlider.value)<parseInt(trajSlider.max)){trajSlider.value=parseInt(trajSlider.value)+1;trajSlider.dispatchEvent(new Event('input'))}});

trajPlay.addEventListener('click',()=>{
    if(trajPlaying){clearInterval(trajInterval);trajPlaying=false;trajPlay.innerHTML='<i class="fa-solid fa-play mr-1"></i>Play';return}
    trajPlaying=true; trajPlay.innerHTML='<i class="fa-solid fa-pause mr-1"></i>Pause';
    const speed=parseInt(trajSpeed.value)||100;
    trajInterval=setInterval(()=>{
        let f=parseInt(trajSlider.value)+1;
        if(f>parseInt(trajSlider.max)) f=0;
        trajSlider.value=f; trajSlider.dispatchEvent(new Event('input'));
    },speed);
});

// --- 18. Isosurface (cube) ---
isoPosVal.addEventListener('input',()=>isoPosDisplay.textContent=parseFloat(isoPosVal.value).toFixed(3));
isoNegVal.addEventListener('input',()=>isoNegDisplay.textContent=parseFloat(isoNegVal.value).toFixed(3));
isoOpacity.addEventListener('input',()=>isoOpacityDisplay.textContent=parseFloat(isoOpacity.value).toFixed(2));

applyIsoBtn.addEventListener('click',()=>{
    if(!viewer||!currentModelData||currentExtension!=='cube') return;
    clearIsoSurfaces();
    try{
        const voldata=new $3Dmol.VolumeData(currentModelData,'cube');
        const op=parseFloat(isoOpacity.value);
        isoShapes.push(viewer.addIsosurface(voldata,{isoval:parseFloat(isoPosVal.value),color:'#3b82f6',opacity:op}));
        isoShapes.push(viewer.addIsosurface(voldata,{isoval:parseFloat(isoNegVal.value),color:'#ef4444',opacity:op}));
        viewer.render(); showToast('Isosurface rendered.','success');
    }catch(e){console.error(e);showToast('Error rendering isosurface.','error')}
});

clearIsoBtn.addEventListener('click',()=>{clearIsoSurfaces();if(viewer)viewer.render()});
function clearIsoSurfaces(){isoShapes.forEach(s=>{try{viewer.removeShape(s)}catch(e){}});isoShapes=[]}

// --- 19. Toggle bindings ---
setupToggle(toggleEls.atomLabels,'atomLabels',()=>{updateLabels();if(T.axis)drawAxisIndicator()});
setupToggle(toggleEls.resLabels,'resLabels',()=>{updateLabels();if(T.axis)drawAxisIndicator()});
setupToggle(toggleEls.hydrogens,'hydrogens',()=>{applyStyles();updateLabels();if(T.axis)drawAxisIndicator()});
setupToggle(toggleEls.axis,'axis',()=>{updateLabels();drawAxisIndicator()});
setupToggle(toggleEls.spin,'spin',()=>{if(!viewer)return;T.spin?viewer.spin('y',1):viewer.spin(false)});
setupToggle(toggleEls.clickInspect,'clickInspect',v=>{if(!v)atomInfoEl.classList.remove('visible')});
setupToggle(toggleEls.outline,'outline',()=>applyOutline());
setupToggle(toggleEls.fog,'fog',()=>applyFog());

// --- 20. Axis camera presets ---
const AQ={'xy-pos':{x:0,y:0,z:0,w:1},'xy-neg':{x:0,y:1,z:0,w:0},'xz-pos':{x:-Math.SQRT1_2,y:0,z:0,w:Math.SQRT1_2},'xz-neg':{x:Math.SQRT1_2,y:0,z:0,w:Math.SQRT1_2},'yz-pos':{x:0,y:Math.SQRT1_2,z:0,w:Math.SQRT1_2},'yz-neg':{x:0,y:-Math.SQRT1_2,z:0,w:Math.SQRT1_2}};
axisBtns.forEach(b=>b.addEventListener('click',()=>{if(!viewer)return;const q=AQ[b.dataset.axis];if(q){viewer.setView([0,0,0,0,q.x,q.y,q.z,q.w]);viewer.zoomTo();viewer.render()}}));
centerBtn.addEventListener('click',()=>{if(viewer){viewer.zoomTo();viewer.render()}});

// --- 21. Export options ---
function captureCanvas(mult){
    const c=viewerCanvas.querySelector('canvas'); if(!c)throw new Error('No canvas');
    if(mult<=1)return c;
    const ow=c.width,oh=c.height; c.width=ow*mult;c.height=oh*mult;viewer.resize();viewer.render();
    const tc=document.createElement('canvas');tc.width=c.width;tc.height=c.height;tc.getContext('2d').drawImage(c,0,0);
    c.width=ow;c.height=oh;viewer.resize();viewer.render(); return tc;
}

function triggerDL(url,name){const a=document.createElement('a');a.download=name;a.href=url;a.click()}

downloadBtn.addEventListener('click', () => {
    if (!viewer) return; 
    const m = parseInt(exportQuality.value) || 2;
    
    showToast(`Generating ${m}× PNG...`, 'info');
    
    setTimeout(() => {
        try {
            const c = captureCanvas(m);
            triggerDL(c.toDataURL('image/png'), `${baseName()}_${m}x.png`);
            showToast(`PNG ${m}× saved.`, 'success');
        } catch(e) {
            console.error(e);
            showToast('Export failed. Canvas too large?', 'error');
        }
    }, 50);
});

// --- 22. Reset ---
resetBtn.addEventListener('click',()=>{
    if(viewer){viewer.spin(false);viewer.removeAllLabels();viewer.removeAllShapes();removeSurface();viewer.clear()}
    clearInterval(trajInterval); trajPlaying=false;
    surfaceID=null;currentModelData=null;currentExtension=null;axisShapes=[];isoShapes=[]; measureShapes=[]; measureLabels=[];
    
    $('formatBadge').innerText=''; atomInfoEl.classList.remove('visible'); atomInfoEl.innerHTML='';
    uploadZone.classList.remove('hidden'); workspace.classList.add('hidden'); workspace.classList.remove('flex');
    fileInput.value='';
});

});