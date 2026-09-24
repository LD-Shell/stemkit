// # --- 1. System state and environment ---
const canvas = document.getElementById('sandboxCanvas');
const ctx = canvas.getContext('2d');

let particlesArray = [];

// # Evaluating device viewport to optimize particle density and rendering performance
const isMobile = window.innerWidth < 768; 
const numberOfParticles = isMobile ? 800 : 2500; 

// # Parameterizing dynamic mouse physics and interaction states
const mouse = {
    x: null,
    y: null,
    radius: 150,
    isPressed: false,
    blastRadius: 0,
    blastX: 0,
    blastY: 0
};

// Nothing drifts on its own when the visitor asks for reduced motion: the
// field holds still until it is touched.
const calm = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

// Tones of the site accent with a slate, per theme, read each frame so a
// theme switch recolours the field. Fast particles warm to amber, and the
// fastest glow white on the dark ground or deep orange on the light one,
// where white would vanish.
const PALETTES = {
    light: { base: ['#1f5c96', '#3574b0', '#5c93c7', '#92b8dd', '#94a3b8'], warm: '#f59e0b', hot: '#c2410c' },
    dark: { base: ['#3574b0', '#5c93c7', '#92b8dd', '#c0d6ec', '#64748b'], warm: '#fbbf24', hot: '#ffffff' }
};
let palette = PALETTES.light;

// # --- 2. Event bindings ---
function setupCanvas() {
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;
}

window.addEventListener('resize', () => {
    setupCanvas();
    init(); 
});

// Pointer events, so a finger works as well as a mouse: on a touch screen a
// drag gathers the particles and lifting the finger scatters them.
canvas.addEventListener('pointermove', (event) => {
    mouse.x = event.clientX;
    mouse.y = event.clientY;
});

canvas.addEventListener('pointerleave', () => {
    mouse.x = null;
    mouse.y = null;
    mouse.isPressed = false;
});

// # Binding interactive force-state triggers for gamified mechanics
canvas.addEventListener('pointerdown', (event) => {
    mouse.isPressed = true;
    mouse.x = event.clientX;
    mouse.y = event.clientY;
});

canvas.addEventListener('pointerup', (event) => {
    mouse.isPressed = false;
    // The shockwave starts where the pointer was released, which a finger
    // leaves at once.
    mouse.blastX = event.clientX;
    mouse.blastY = event.clientY;
    mouse.blastRadius = 450; // # Initializing the expansion shockwave radius
});

canvas.addEventListener('pointercancel', () => { mouse.isPressed = false; });

// # --- 3. Particle kinematics blueprint ---
class Particle {
    constructor(x, y) {
        this.x = x;
        this.y = y;
        
        // # Integrating momentum vectors for fluid inertia
        this.vx = 0;
        this.vy = 0;
        
        this.size = Math.random() * 2.5 + 1; 
        this.baseX = this.x; 
        this.baseY = this.y; 
        this.density = (Math.random() * 30) + 1; 
        
        // # Parameterizing ambient drift mechanics
        this.angle = Math.random() * Math.PI * 2;
        this.orbitSpeed = calm ? 0 : (Math.random() * 0.02) + 0.005;
        this.orbitRadius = calm ? 0 : (Math.random() * 15) + 5;
        
        this.tone = Math.floor(Math.random() * PALETTES.light.base.length);
        this.heat = 0;
    }

    draw() {
        ctx.fillStyle = this.heat === 2 ? palette.hot : this.heat === 1 ? palette.warm : palette.base[this.tone];
        ctx.beginPath();
        ctx.arc(this.x, this.y, this.size, 0, Math.PI * 2);
        ctx.closePath();
        ctx.fill();
    }

    update() {
        // # I am applying a continuous sine-wave drift to the origin coordinates to simulate ambient fluid flow
        this.angle += this.orbitSpeed;
        const dynamicBaseX = this.baseX + Math.cos(this.angle) * this.orbitRadius;
        const dynamicBaseY = this.baseY + Math.sin(this.angle) * this.orbitRadius;

        let dx = mouse.x - this.x;
        let dy = mouse.y - this.y;
        let distance = Math.sqrt((dx * dx) + (dy * dy));
        
        // # Applying primary continuous interaction forces
        if (mouse.x != null && distance < mouse.radius) {
            let forceDirectionX = dx / distance;
            let forceDirectionY = dy / distance;
            let force = (mouse.radius - distance) / mouse.radius;
            
            if (mouse.isPressed) {
                // # Inducing a singularity effect when active (attraction + tight swirl)
                this.vx += (forceDirectionX + forceDirectionY * 1.5) * force * 1.2;
                this.vy += (forceDirectionY - forceDirectionX * 1.5) * force * 1.2;
            } else {
                // # Executing standard repulsive boundary with tangential scattering
                this.vx -= (forceDirectionX - forceDirectionY * 0.5) * force * 0.8;
                this.vy -= (forceDirectionY + forceDirectionX * 0.5) * force * 0.8;
            }
        }

        // # Executing the release shockwave expansion physics
        const bdx = mouse.blastX - this.x;
        const bdy = mouse.blastY - this.y;
        const blastDistance = Math.sqrt((bdx * bdx) + (bdy * bdy));
        if (mouse.blastRadius > 0 && blastDistance > 0 && blastDistance < mouse.blastRadius) {
            let forceDirectionX = bdx / blastDistance;
            let forceDirectionY = bdy / blastDistance;
            let force = (mouse.blastRadius - blastDistance) / mouse.blastRadius;
            
            // # Injecting massive instantaneous velocity outward
            this.vx -= forceDirectionX * force * (50 / this.density);
            this.vy -= forceDirectionY * force * (50 / this.density);
        }

        // # Applying spring tension to return to ambient equilibrium
        let springX = (dynamicBaseX - this.x) * 0.02;
        let springY = (dynamicBaseY - this.y) * 0.02;
        
        this.vx += springX;
        this.vy += springY;
        
        // # Applying kinetic friction to stabilize the fluid matrix
        this.vx *= 0.92;
        this.vy *= 0.92;
        
        this.x += this.vx;
        this.y += this.vy;
        
        // # Rendering dynamic thermal colors based on current kinetic energy
        let velocitySq = this.vx * this.vx + this.vy * this.vy;
        this.heat = velocitySq > 30 ? 2 : velocitySq > 12 ? 1 : 0;
    }
}

// # --- 4. System compilation and loop execution ---
function init() {
    particlesArray = [];
    for (let i = 0; i < numberOfParticles; i++) {
        // # Populating the initial spatial matrix with randomized vectors
        let x = Math.random() * canvas.width;
        let y = Math.random() * canvas.height;
        particlesArray.push(new Particle(x, y));
    }
}

function animate() {
    // # Dissipating the global shockwave state rapidly
    if (mouse.blastRadius > 0) {
        mouse.blastRadius -= 25;
    }

    ctx.clearRect(0, 0, canvas.width, canvas.height);
    palette = document.documentElement.classList.contains('dark') ? PALETTES.dark : PALETTES.light;
    
    for (let i = 0; i < particlesArray.length; i++) {
        particlesArray[i].update();
        particlesArray[i].draw();
    }
    
    requestAnimationFrame(animate);
}

// # Executing initialization sequence
setupCanvas();
init();
animate();

document.getElementById('btn-reset-particles').addEventListener('click', () => {
    init(); 
});