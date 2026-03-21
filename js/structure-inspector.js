// # --- 1. Environment initialization ---
document.addEventListener("DOMContentLoaded", () => {
    
    let viewer = null;
    let surfaceID = null;
    let currentModelData = null;
    let currentExtension = null;

    // Binding interface elements
    const uploadZone = document.getElementById('uploadZone');
    const fileInput = document.getElementById('fileInput');
    const workspace = document.getElementById('workspace');
    
    const styleSelect = document.getElementById('styleSelect');
    const colorSelect = document.getElementById('colorSelect');
    const centerBtn = document.getElementById('centerBtn');
    const surfaceBtn = document.getElementById('surfaceBtn');
    const resetBtn = document.getElementById('resetBtn');
    
    const viewerCanvas = document.getElementById('viewerCanvas');

    // Toggling interface theme
    document.getElementById('themeToggle').addEventListener('click', () => {
        const isDark = document.documentElement.classList.toggle('dark');
        localStorage.theme = isDark ? 'dark' : 'light';
        updateViewerBackground(isDark);
    });

    // Establishing file upload handlers
    ['dragenter', 'dragover', 'dragleave', 'drop'].forEach(eventName => {
        uploadZone.addEventListener(eventName, (e) => { e.preventDefault(); e.stopPropagation(); }, false);
    });

    uploadZone.addEventListener('dragover', () => uploadZone.classList.add('border-indigo-500'));
    uploadZone.addEventListener('dragleave', () => uploadZone.classList.remove('border-indigo-500'));
    uploadZone.addEventListener('drop', (e) => {
        uploadZone.classList.remove('border-indigo-500');
        handleFile(e.dataTransfer.files[0]);
    });

    uploadZone.addEventListener('click', () => fileInput.click());
    fileInput.addEventListener('change', (e) => handleFile(e.target.files[0]));

    // # --- 2. File parsing and viewer instantiation ---
    function handleFile(file) {
        if (!file) return;

        const filename = file.name.toLowerCase();
        if (filename.endsWith('.pdb')) currentExtension = 'pdb';
        else if (filename.endsWith('.xyz')) currentExtension = 'xyz';
        else if (filename.endsWith('.gro')) currentExtension = 'gro';
        else {
            showToast('Format not supported. Please upload PDB, GRO, or XYZ.', 'error');
            return;
        }

        document.getElementById('fileName').innerText = file.name;
        showToast('Loading topology into WebGL canvas...', 'info');
        
        const reader = new FileReader();
        reader.onload = (event) => {
            currentModelData = event.target.result;
            initializeViewer();
        };
        reader.readAsText(file);
    }

    function initializeViewer() {
        uploadZone.classList.add('hidden');
        workspace.classList.remove('hidden');
        workspace.classList.add('flex');

        // I am clearing any existing WebGL context to prevent memory leaks during subsequent uploads
        if (viewer) {
            viewer.clear();
        } else {
            const config = { backgroundColor: document.documentElement.classList.contains('dark') ? '#020617' : '#f8fafc' };
            viewer = $3Dmol.createViewer(viewerCanvas, config);
        }

        try {
            // I am adding the coordinate data to the 3Dmol viewer object
            viewer.addModel(currentModelData, currentExtension);
            
            const numAtoms = viewer.getModel().selectedAtoms({}).length;
            document.getElementById('structureMeta').innerText = `${numAtoms} Atoms Detected`;

            applyStyles();
            viewer.zoomTo();
            viewer.render();
            
            showToast('Structure rendered successfully.', 'success');
        } catch (error) {
            console.error(error);
            showToast('Error interpreting coordinate geometry.', 'error');
        }
    }

    // # --- 3. Viewport control logic ---
    function applyStyles() {
        if (!viewer) return;

        const styleType = styleSelect.value;
        const colorScheme = colorSelect.value;
        
        let styleObj = {};
        let colorObj = {};

        // I am mapping the chosen color scheme to the 3Dmol API parameters
        if (colorScheme === 'element') colorObj = { colorscheme: 'Jmol' };
        else if (colorScheme === 'chain') colorObj = { colorscheme: 'chain' };
        else if (colorScheme === 'residue') colorObj = { colorscheme: 'amino' };
        else if (colorScheme === 'bFactor') colorObj = { colorscheme: 'b' };

        // Applying the primary visual representation
        if (styleType === 'stick') {
            styleObj = { stick: { radius: 0.15, ...colorObj } };
        } else if (styleType === 'sphere') {
            styleObj = { sphere: { ...colorObj } };
        } else if (styleType === 'cross') {
            styleObj = { cross: { linewidth: 2, ...colorObj } };
        } else if (styleType === 'line') {
            styleObj = { line: { ...colorObj } };
        }

        viewer.setStyle({}, styleObj);
        viewer.render();
    }

    function updateViewerBackground(isDark) {
        if (viewer) {
            viewer.setBackgroundColor(isDark ? '#020617' : '#f8fafc');
            viewer.render();
        }
    }

    styleSelect.addEventListener('change', applyStyles);
    colorSelect.addEventListener('change', applyStyles);

    centerBtn.addEventListener('click', () => {
        if (viewer) {
            viewer.zoomTo();
            viewer.render();
        }
    });

    surfaceBtn.addEventListener('click', () => {
        if (!viewer) return;
        
        // I am using surface rendering to inspect the solvent-accessible area of the glycine polymorphs and slab.
        if (surfaceID !== null) {
            viewer.removeSurface(surfaceID);
            surfaceID = null;
        } else {
            surfaceID = viewer.addSurface($3Dmol.SurfaceType.VDW, { opacity: 0.6, color: 'white' });
        }
        viewer.render();
    });

    resetBtn.addEventListener('click', () => {
        if (viewer) viewer.clear();
        surfaceID = null;
        uploadZone.classList.remove('hidden');
        workspace.classList.add('hidden');
        workspace.classList.remove('flex');
    });

    // # --- 4. System notifications ---
    function showToast(msg, type) {
        const container = document.getElementById('toastContainer');
        const toast = document.createElement('div');
        
        const colors = type === 'success' ? 'bg-emerald-50 text-emerald-800 border-emerald-200' : 
                       type === 'error' ? 'bg-red-50 text-red-800 border-red-200' : 
                       'bg-indigo-50 text-indigo-800 border-indigo-200';
        
        toast.className = `px-4 py-3 rounded-xl border shadow-lg text-sm font-medium transition-all ${colors}`;
        toast.style.animation = "slideIn 0.3s forwards";
        
        let icon = 'fa-info-circle';
        if (type === 'success') icon = 'fa-check-circle';
        if (type === 'error') icon = 'fa-triangle-exclamation';
        
        toast.innerHTML = `<i class="fa-solid ${icon} mr-2"></i> ${msg}`;
        
        container.appendChild(toast);
        setTimeout(() => {
            toast.style.opacity = '0';
            setTimeout(() => toast.remove(), 300);
        }, 3000);
    }
});