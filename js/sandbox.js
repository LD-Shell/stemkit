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
    blastRadius: 0
};

// # --- 2. Event bindings ---
function setupCanvas() {
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;
}

window.addEventListener('resize', () => {
    setupCanvas();
    init(); 
});

canvas.addEventListener('mousemove', (event) => {
    mouse.x = event.x;
    mouse.y = event.y;
});

canvas.addEventListener('mouseout', () => {
    mouse.x = null;
    mouse.y = null;
    mouse.isPressed = false;
});

// # Binding interactive force-state triggers for gamified mechanics
canvas.addEventListener('mousedown', () => {
    mouse.isPressed = true;
});

canvas.addEventListener('mouseup', () => {
    mouse.isPressed = false;
    mouse.blastRadius = 450; // # Initializing the expansion shockwave radius
});

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
        this.orbitSpeed = (Math.random() * 0.02) + 0.005;
        this.orbitRadius = (Math.random() * 15) + 5;
        
        const colors = ['#4f46e5', '#10b981', '#0ea5e9', '#8b5cf6', '#f43f5e'];
        this.baseColor = colors[Math.floor(Math.random() * colors.length)];
        this.color = this.baseColor;
    }

    draw() {
        ctx.fillStyle = this.color;
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
        if (mouse.blastRadius > 0 && distance < mouse.blastRadius) {
            let forceDirectionX = dx / distance;
            let forceDirectionY = dy / distance;
            let force = (mouse.blastRadius - distance) / mouse.blastRadius;
            
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
        if (velocitySq > 30) {
            this.color = '#ffffff'; 
        } else if (velocitySq > 12) {
            this.color = '#fbbf24'; 
        } else {
            this.color = this.baseColor;
        }
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