/**
 * STEMKit - Ambient Pomodoro Logic
 * Architecture: Event-driven timer using absolute time (Date.now) for background-tab safety.
 */

// Step 1: Configuration & State Management
const MODES = {
    pomodoro: 25 * 60, // 25 minutes in seconds
    short: 5 * 60,     // 5 minutes
    long: 15 * 60      // 15 minutes
};

let currentMode = 'pomodoro';
let timeLeft = MODES[currentMode];
let isRunning = false;
let timerInterval = null;
let endTime = null; // Stores the absolute timestamp when the timer should ring

// Step 2: DOM Element Caching (Avoids repeatedly querying the DOM)
const displayEl = document.getElementById('time-display');
const btnToggle = document.getElementById('btn-toggle');
const btnReset = document.getElementById('btn-reset');
const modeButtons = {
    pomodoro: document.getElementById('btn-mode-pomodoro'),
    short: document.getElementById('btn-mode-short'),
    long: document.getElementById('btn-mode-long')
};

// Step 3: Audio Setup (Assumes standard assets structure)
// Note: Create these files or replace URLs with valid .mp3 URLs.
const audioTracks = {
    rain: new Audio('https://stemkit.net/assets/sounds/rain.mp3'),
    cafe: new Audio('https://stemkit.net/assets/sounds/cafe.mp3'),
    noise: new Audio('https://stemkit.net/assets/sounds/brown-noise.mp3')
};

// Loop all audio natively
Object.values(audioTracks).forEach(track => {
    track.loop = true;
    track.volume = 0; // Initialize at zero
});

let audioUnlocked = false;

// Step 4: Core Functions

/**
 * Formats seconds into MM:SS and updates the DOM & Document Title
 */
function updateDisplay(seconds) {
    const mins = Math.floor(seconds / 60).toString().padStart(2, '0');
    const secs = (seconds % 60).toString().padStart(2, '0');
    const timeString = `${mins}:${secs}`;
    
    displayEl.textContent = timeString;
    
    // SEO / Pro Feature: Keep the tab title updated
    const modeName = currentMode === 'pomodoro' ? 'Focus' : 'Break';
    document.title = `${timeString} - ${modeName} | STEMKit`;
}

/**
 * Handles switching between Focus, Short Break, and Long Break
 */
function switchMode(mode) {
    if (isRunning) toggleTimer(); // Pause if running
    
    currentMode = mode;
    timeLeft = MODES[mode];
    updateDisplay(timeLeft);

    // UI Updates: Reset all buttons, then highlight the active one
    Object.values(modeButtons).forEach(btn => {
        btn.classList.remove('bg-white', 'dark:bg-slate-700', 'shadow-sm', 'text-indigo-600', 'dark:text-indigo-400');
        btn.classList.add('text-slate-500');
    });

    modeButtons[mode].classList.remove('text-slate-500');
    modeButtons[mode].classList.add('bg-white', 'dark:bg-slate-700', 'shadow-sm', 'text-indigo-600', 'dark:text-indigo-400');
}

/**
 * The core timer logic calculating against absolute time
 */
function toggleTimer() {
    // Audio Policy Workaround: Play tracks on first user interaction
    if (!audioUnlocked) {
        Object.values(audioTracks).forEach(track => track.play().catch(e => console.log("Audio autoplay suppressed until further interaction.")));
        audioUnlocked = true;
    }

    if (isRunning) {
        // PAUSE LOGIC
        clearInterval(timerInterval);
        isRunning = false;
        btnToggle.textContent = "START";
        btnToggle.classList.remove('bg-emerald-500', 'hover:bg-emerald-600');
        btnToggle.classList.add('bg-indigo-600', 'hover:bg-indigo-700');
    } else {
        // START LOGIC
        isRunning = true;
        btnToggle.textContent = "PAUSE";
        btnToggle.classList.remove('bg-indigo-600', 'hover:bg-indigo-700');
        btnToggle.classList.add('bg-emerald-500', 'hover:bg-emerald-600');
        
        // Calculate the exact timestamp when this timer should hit 0
        endTime = Date.now() + (timeLeft * 1000);

        timerInterval = setInterval(() => {
            // Delta time ensures accuracy even if the browser throttles the interval
            const remainingMs = endTime - Date.now();
            timeLeft = Math.ceil(remainingMs / 1000);

            if (timeLeft <= 0) {
                clearInterval(timerInterval);
                timeLeft = 0;
                isRunning = false;
                btnToggle.textContent = "START";
                updateDisplay(0);
                
                // Fire an alert or a nice chime here
                alert(`${currentMode === 'pomodoro' ? 'Deep work complete! Take a breather.' : 'Break is over! Time to lock in.'}`);
                switchMode(currentMode === 'pomodoro' ? 'short' : 'pomodoro'); // Auto-toggle mode
            } else {
                updateDisplay(timeLeft);
            }
        }, 1000);
    }
}

// Step 5: Event Listeners
btnToggle.addEventListener('click', toggleTimer);

btnReset.addEventListener('click', () => {
    if (isRunning) toggleTimer(); // Pause it first
    timeLeft = MODES[currentMode];
    updateDisplay(timeLeft);
});

// Mode switchers
modeButtons.pomodoro.addEventListener('click', () => switchMode('pomodoro'));
modeButtons.short.addEventListener('click', () => switchMode('short'));
modeButtons.long.addEventListener('click', () => switchMode('long'));

// Volume Sliders (Link DOM input value directly to Audio API volume)
document.getElementById('vol-rain').addEventListener('input', (e) => audioTracks.rain.volume = e.target.value);
document.getElementById('vol-cafe').addEventListener('input', (e) => audioTracks.cafe.volume = e.target.value);
document.getElementById('vol-noise').addEventListener('input', (e) => audioTracks.noise.volume = e.target.value);

// Initialize UI
updateDisplay(timeLeft);