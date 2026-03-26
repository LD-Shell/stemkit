// # --- 1. Configuration and state management ---
// # I am building an event-driven timer using absolute time to ensure background-tab safety
const MODES = {
    pomodoro: 25 * 60, 
    short: 5 * 60,     
    long: 15 * 60      
};

let currentMode = 'pomodoro';
let timeLeft = MODES[currentMode];
let isRunning = false;
let timerInterval = null;
let endTime = null; 

// # --- 2. Element caching ---
const displayEl = document.getElementById('time-display');
const btnToggle = document.getElementById('btn-toggle');
const btnReset = document.getElementById('btn-reset');
const modeButtons = {
    pomodoro: document.getElementById('btn-mode-pomodoro'),
    short: document.getElementById('btn-mode-short'),
    long: document.getElementById('btn-mode-long')
};

// # --- 3. Audio mixer setup ---
const audioTracks = {
    rain: new Audio('https://stemkit.net/assets/sounds/rain.mp3'),
    cafe: new Audio('https://stemkit.net/assets/sounds/cafe.mp3'),
    noise: new Audio('https://stemkit.net/assets/sounds/brown-noise.mp3')
};

// # Looping audio natively
Object.values(audioTracks).forEach(track => {
    track.loop = true;
    track.volume = 0; 
});

let audioUnlocked = false;

// # --- 4. Core functions ---
function updateDisplay(seconds) {
    const mins = Math.floor(seconds / 60).toString().padStart(2, '0');
    const secs = (seconds % 60).toString().padStart(2, '0');
    const timeString = `${mins}:${secs}`;
    
    displayEl.textContent = timeString;
    
    // # Synchronizing document title for background visibility
    const modeName = currentMode === 'pomodoro' ? 'Focus' : 'Break';
    document.title = `${timeString} - ${modeName} | STEMKit`;
}

function switchMode(mode) {
    if (isRunning) toggleTimer(); 
    
    currentMode = mode;
    timeLeft = MODES[mode];
    updateDisplay(timeLeft);

    // # Updating UI state
    Object.values(modeButtons).forEach(btn => {
        btn.classList.remove('bg-white', 'dark:bg-slate-700', 'shadow-sm', 'text-indigo-600', 'dark:text-indigo-400');
        btn.classList.add('text-slate-500');
    });

    modeButtons[mode].classList.remove('text-slate-500');
    modeButtons[mode].classList.add('bg-white', 'dark:bg-slate-700', 'shadow-sm', 'text-indigo-600', 'dark:text-indigo-400');
}

function toggleTimer() {
    // # I am playing tracks on first user interaction to bypass browser autoplay policies
    if (!audioUnlocked) {
        Object.values(audioTracks).forEach(track => track.play().catch(e => console.log("Audio autoplay suppressed until further interaction.")));
        audioUnlocked = true;
    }

    if (isRunning) {
        // # Executing pause logic
        clearInterval(timerInterval);
        isRunning = false;
        btnToggle.textContent = "START";
        btnToggle.classList.remove('bg-emerald-500', 'hover:bg-emerald-600');
        btnToggle.classList.add('bg-indigo-600', 'hover:bg-indigo-700');
    } else {
        // # Executing start logic
        isRunning = true;
        btnToggle.textContent = "PAUSE";
        btnToggle.classList.remove('bg-indigo-600', 'hover:bg-indigo-700');
        btnToggle.classList.add('bg-emerald-500', 'hover:bg-emerald-600');
        
        // # I am calculating the exact completion timestamp to maintain accuracy during tab throttling
        endTime = Date.now() + (timeLeft * 1000);

        timerInterval = setInterval(() => {
            const remainingMs = endTime - Date.now();
            timeLeft = Math.ceil(remainingMs / 1000);

            if (timeLeft <= 0) {
                clearInterval(timerInterval);
                timeLeft = 0;
                isRunning = false;
                btnToggle.textContent = "START";
                updateDisplay(0);
                
                alert(`${currentMode === 'pomodoro' ? 'Deep work complete! Take a breather.' : 'Break is over! Time to lock in.'}`);
                switchMode(currentMode === 'pomodoro' ? 'short' : 'pomodoro'); 
            } else {
                updateDisplay(timeLeft);
            }
        }, 1000);
    }
}

// # --- 5. Event listeners ---
btnToggle.addEventListener('click', toggleTimer);

btnReset.addEventListener('click', () => {
    if (isRunning) toggleTimer(); 
    timeLeft = MODES[currentMode];
    updateDisplay(timeLeft);
});

// # Binding mode switchers
modeButtons.pomodoro.addEventListener('click', () => switchMode('pomodoro'));
modeButtons.short.addEventListener('click', () => switchMode('short'));
modeButtons.long.addEventListener('click', () => switchMode('long'));

// # Binding volume sliders directly to audio API instances
document.getElementById('vol-rain').addEventListener('input', (e) => audioTracks.rain.volume = e.target.value);
document.getElementById('vol-cafe').addEventListener('input', (e) => audioTracks.cafe.volume = e.target.value);
document.getElementById('vol-noise').addEventListener('input', (e) => audioTracks.noise.volume = e.target.value);

// # Executing UI initialization
updateDisplay(timeLeft);