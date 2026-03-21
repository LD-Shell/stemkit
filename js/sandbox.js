/**
 * STEMKit - Kinetic Sandbox Engine
 * Handles 2D particle kinematics and mouse interaction physics.
 */

const canvas = document.getElementById('sandboxCanvas');
const ctx = canvas.getContext('2d');

let particlesArray = [];
// Detect if user is on mobile to reduce particle count and save battery
const isMobile = window.innerWidth < 768; 
const numberOfParticles = isMobile ? 800 : 2500; 

// Mouse physics state
const mouse = {
    x: null,
    y: null,
    radius: 120 // The size of the repulsive force field
};

// Step 1: Handle Screen Resizing dynamically
function setupCanvas() {
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;
}
window.addEventListener('resize', () => {
    setupCanvas();
    init(); // Re-roll particles if screen changes size drastically
});

// Step 2: Track Mouse Position
canvas.addEventListener('mousemove', (event) => {
    mouse.x = event.x;
    mouse.y = event.y;
});

// Remove mouse force field when it leaves the canvas
canvas.addEventListener('mouseout', () => {
    mouse.x = null;
    mouse.y = null;
});

// Step 3: The Particle Blueprint
class Particle {
    constructor(x, y) {
        this.x = x;
        this.y = y;
        this.size = Math.random() * 2.5 + 1; // Random size between 1 and 3.5
        this.baseX = this.x; // Remember origin X
        this.baseY = this.y; // Remember origin Y
        this.density = (Math.random() * 30) + 1; // Determines "weight" or how fast it moves
        
        // Pick a color from the STEMKit palette based on random chance
        const colors = ['#4f46e5', '#10b981', '#0ea5e9', '#8b5cf6'];
        this.color = colors[Math.floor(Math.random() * colors.length)];
    }

    draw() {
        ctx.fillStyle = this.color;
        ctx.beginPath();
        ctx.arc(this.x, this.y, this.size, 0, Math.PI * 2);
        ctx.closePath();
        ctx.fill();
    }

    update() {
        // Only run the heavy math if the mouse is actually on the screen
        if (mouse.x != null) {
            // Pythagorean theorem to find distance
            let dx = mouse.x - this.x;
            let dy = mouse.y - this.y;
            let distance = Math.sqrt((dx * dx) + (dy * dy));
            
            // If the particle is inside the mouse's radius, repel it!
            if (distance < mouse.radius) {
                // Calculate the unit vector (direction of the push)
                let forceDirectionX = dx / distance;
                let forceDirectionY = dy / distance;
                
                // Calculate the strength of the push. 
                // Close to mouse = high force (near 1). Edge of radius = low force (near 0).
                let force = (mouse.radius - distance) / mouse.radius;
                
                // Apply density mass (lighter particles move faster)
                let directionX = forceDirectionX * force * this.density;
                let directionY = forceDirectionY * force * this.density;
                
                // Move the particle away (subtract the vector)
                this.x -= directionX;
                this.y -= directionY;
            } else {
                // Not near mouse? Snap back to original base coordinates using a simple spring logic
                if (this.x !== this.baseX) {
                    let dx = this.x - this.baseX;
                    this.x -= dx / 15; // The 15 is the "stiffness" of the spring
                }
                if (this.y !== this.baseY) {
                    let dy = this.y - this.baseY;
                    this.y -= dy / 15;
                }
            }
        } else {
             // Mouse is off screen, slowly return everything to base
             if (this.x !== this.baseX) {
                let dx = this.x - this.baseX;
                this.x -= dx / 20;
            }
            if (this.y !== this.baseY) {
                let dy = this.y - this.baseY;
                this.y -= dy / 20;
            }
        }
    }
}

// Step 4: System Initialization
function init() {
    particlesArray = [];
    for (let i = 0; i < numberOfParticles; i++) {
        // Randomly scatter coordinates across the screen
        let x = Math.random() * canvas.width;
        let y = Math.random() * canvas.height;
        particlesArray.push(new Particle(x, y));
    }
}

// Step 5: The Master Animation Loop
function animate() {
    // Clear the previous frame. 
    // We use clearRect instead of drawing a solid rectangle to support the Dark Mode background beneath it.
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    
    // Update math and redraw every single particle
    for (let i = 0; i < particlesArray.length; i++) {
        particlesArray[i].update();
        particlesArray[i].draw();
    }
    
    // Request the next frame recursively
    requestAnimationFrame(animate);
}

// Boot up sequence
setupCanvas();
init();
animate();

// UI Reset Button Logic
document.getElementById('btn-reset-particles').addEventListener('click', () => {
    init(); // Scrambles the particles into new random base positions
});