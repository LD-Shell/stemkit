// ============================================================
// STEMKit Ambient Pomodoro
// Absolute-timestamp timer, lazy-loaded ambient mixer,
// synthesized completion chime, persisted settings.
// ============================================================

// --- 1. Settings & state ---------------------------------------------------

const DEFAULTS = {
    pomodoro: 25,
    short: 5,
    long: 15,
    cyclesBeforeLong: 4,
    autoStart: true
};

const STORAGE_KEY = 'stemkit.pomodoro.v1';

function clamp(value, min, max, fallback) {
    const n = Number(value);
    if (!Number.isFinite(n)) return fallback;
    return Math.min(max, Math.max(min, Math.round(n)));
}

const BOUNDS = {
    pomodoro: [1, 180],
    short: [1, 60],
    long: [1, 120],
    cyclesBeforeLong: [2, 12]
};

function loadSettings() {
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (!raw) return { ...DEFAULTS };
        const p = JSON.parse(raw);
        return {
            pomodoro: clamp(p.pomodoro, ...BOUNDS.pomodoro, DEFAULTS.pomodoro),
            short: clamp(p.short, ...BOUNDS.short, DEFAULTS.short),
            long: clamp(p.long, ...BOUNDS.long, DEFAULTS.long),
            cyclesBeforeLong: clamp(p.cyclesBeforeLong, ...BOUNDS.cyclesBeforeLong, DEFAULTS.cyclesBeforeLong),
            autoStart: typeof p.autoStart === 'boolean' ? p.autoStart : DEFAULTS.autoStart
        };
    } catch {
        return { ...DEFAULTS };
    }
}

function saveSettings() {
    try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
    } catch {
        // Private browsing — run without persistence.
    }
}

let settings = loadSettings();

let currentMode = 'pomodoro';
let timeLeft = settings.pomodoro * 60;
let isRunning = false;
let timerInterval = null;
let endTime = null;
let completedFocusSessions = 0;

const durationFor = mode => settings[mode] * 60;

// --- 2. Elements -----------------------------------------------------------

const dial = document.getElementById('dial');
const displayEl = document.getElementById('time-display');
const labelEl = document.getElementById('session-label');
const btnToggle = document.getElementById('btn-toggle');
const btnReset = document.getElementById('btn-reset');
const btnSkip = document.getElementById('btn-skip');
const progressRing = document.getElementById('progress-ring');
const cycleDotsEl = document.getElementById('cycle-dots');
const modeSwitch = document.getElementById('mode-switch');

const MODE_ORDER = ['pomodoro', 'short', 'long'];
const modeButtons = {
    pomodoro: document.getElementById('btn-mode-pomodoro'),
    short: document.getElementById('btn-mode-short'),
    long: document.getElementById('btn-mode-long')
};

const settingsPanel = document.getElementById('settings-panel');
const btnSettings = document.getElementById('btn-settings');
const inputs = {
    pomodoro: document.getElementById('set-pomodoro'),
    short: document.getElementById('set-short'),
    long: document.getElementById('set-long'),
    cyclesBeforeLong: document.getElementById('set-cycles'),
    autoStart: document.getElementById('set-autostart')
};

const RING_CIRCUMFERENCE = 2 * Math.PI * 146;

// --- 3. Ambient mixer ------------------------------------------------------

const TRACK_SOURCES = {
    rain: 'sound/rain.mp3',
    cafe: 'sound/cafe.mp3'
};

const audioTracks = {};
let brownNoise = null;
let audioCtx = null;

function getAudioContext() {
    if (!audioCtx) {
        const Ctx = window.AudioContext || window.webkitAudioContext;
        if (!Ctx) return null;
        audioCtx = new Ctx();
    }
    if (audioCtx.state === 'suspended') audioCtx.resume();
    return audioCtx;
}

function rowFor(name) {
    return document.querySelector(`.pm-row[data-track="${name}"]`);
}

// Reflects level on the slider track, the numeric readout, and the icon tint.
function paintChannel(name, value) {
    const pct = Math.round(value * 100);
    const slider = document.getElementById(`vol-${name}`);
    const readout = document.getElementById(`val-${name}`);
    const row = rowFor(name);

    if (slider) slider.style.setProperty('--pm-fill', pct + '%');
    if (readout) readout.textContent = pct + '%';
    if (row) row.dataset.active = pct > 0 ? 'true' : 'false';
}

// The <audio> element is created on first use, so a user who only wants
// rain never downloads the cafe file.
function getTrack(name) {
    if (!audioTracks[name]) {
        const el = new Audio(TRACK_SOURCES[name]);
        el.loop = true;
        el.preload = 'none';
        el.volume = 0;
        el.addEventListener('error', () => {
            const slider = document.getElementById(`vol-${name}`);
            const row = rowFor(name);
            if (slider) {
                slider.disabled = true;
                slider.value = 0;
                slider.title = 'This sound could not be loaded.';
            }
            if (row) row.dataset.failed = 'true';
            const readout = document.getElementById(`val-${name}`);
            if (readout) readout.textContent = '—';
        });
        audioTracks[name] = el;
    }
    return audioTracks[name];
}

function setTrackVolume(name, raw) {
    const vol = parseFloat(raw);
    paintChannel(name, vol);

    const track = getTrack(name);
    track.volume = vol;

    if (vol > 0 && track.paused) {
        track.play().catch(() => {});
    } else if (vol === 0 && !track.paused) {
        track.pause();
    }
}

// Brown noise is pure math — no file, no bandwidth, no audible loop point.
function setNoiseVolume(raw) {
    const vol = parseFloat(raw);
    paintChannel('noise', vol);

    const ctx = getAudioContext();
    if (!ctx) return;

    if (!brownNoise) {
        const bufferSize = 4 * ctx.sampleRate;
        const buffer = ctx.createBuffer(1, bufferSize, ctx.sampleRate);
        const data = buffer.getChannelData(0);
        let last = 0;
        for (let i = 0; i < bufferSize; i++) {
            const white = Math.random() * 2 - 1;
            last = (last + 0.02 * white) / 1.02;
            data[i] = last * 3.5;
        }
        const source = ctx.createBufferSource();
        source.buffer = buffer;
        source.loop = true;
        const gain = ctx.createGain();
        gain.gain.value = 0;
        source.connect(gain).connect(ctx.destination);
        source.start();
        brownNoise = { source, gain };
    }

    brownNoise.gain.gain.setTargetAtTime(vol * 0.6, ctx.currentTime, 0.05);
}

// Two-tone chime. Replaces the blocking alert().
function playChime(isBreakEnding) {
    const ctx = getAudioContext();
    if (!ctx) return;
    try {
        const now = ctx.currentTime;
        const notes = isBreakEnding ? [523.25, 659.25] : [659.25, 523.25];
        notes.forEach((freq, i) => {
            const osc = ctx.createOscillator();
            const gain = ctx.createGain();
            osc.type = 'sine';
            osc.frequency.value = freq;
            const start = now + i * 0.22;
            gain.gain.setValueAtTime(0, start);
            gain.gain.linearRampToValueAtTime(0.25, start + 0.02);
            gain.gain.exponentialRampToValueAtTime(0.001, start + 0.9);
            osc.connect(gain).connect(ctx.destination);
            osc.start(start);
            osc.stop(start + 0.95);
        });
    } catch {
        // Visual state change is still the signal.
    }
}

// --- 4. Notifications ------------------------------------------------------

function notify(title, body) {
    if (!('Notification' in window) || Notification.permission !== 'granted') return;
    if (document.visibilityState === 'visible') return;
    try {
        new Notification(title, { body, icon: 'https://stemkit.net/assets/favicon-32x32.png' });
    } catch {
        // Some browsers require a service worker for notifications.
    }
}

// --- 5. Display ------------------------------------------------------------

const MODE_LABELS = {
    pomodoro: 'Focus',
    short: 'Short break',
    long: 'Long break'
};

function updateDisplay(seconds) {
    const safe = Math.max(0, seconds);
    const mins = Math.floor(safe / 60).toString().padStart(2, '0');
    const secs = (safe % 60).toString().padStart(2, '0');
    const timeString = `${mins}:${secs}`;

    displayEl.textContent = timeString;
    document.title = `${timeString} — ${MODE_LABELS[currentMode]} | STEMKit`;

    const total = durationFor(currentMode);
    const fraction = total > 0 ? safe / total : 0;
    progressRing.style.strokeDashoffset = RING_CIRCUMFERENCE * (1 - fraction);
}

function updateCycleDots() {
    const done = completedFocusSessions % settings.cyclesBeforeLong;
    let html = '';
    for (let i = 0; i < settings.cyclesBeforeLong; i++) {
        html += `<span class="pm-dot" data-on="${i < done}"></span>`;
    }
    cycleDotsEl.innerHTML = html;
    cycleDotsEl.setAttribute(
        'aria-label',
        `${done} of ${settings.cyclesBeforeLong} focus sessions before the long break`
    );
}

function setToggleButton(running) {
    btnToggle.textContent = running ? 'Pause' : 'Start';
    btnToggle.dataset.running = String(running);
    btnToggle.setAttribute('aria-pressed', String(running));
    dial.dataset.running = String(running);
}

function paintModeButtons() {
    MODE_ORDER.forEach((mode, i) => {
        const active = mode === currentMode;
        modeButtons[mode].setAttribute('aria-selected', String(active));
        if (active) modeSwitch.style.setProperty('--pm-i', i);
    });
    dial.dataset.mode = currentMode;
    labelEl.textContent = MODE_LABELS[currentMode];
}

// --- 6. Timer --------------------------------------------------------------

function stopTicking() {
    clearInterval(timerInterval);
    timerInterval = null;
    isRunning = false;
    setToggleButton(false);
}

function startTicking() {
    isRunning = true;
    setToggleButton(true);
    endTime = Date.now() + timeLeft * 1000;

    timerInterval = setInterval(() => {
        timeLeft = Math.round((endTime - Date.now()) / 1000);
        if (timeLeft <= 0) {
            timeLeft = 0;
            stopTicking();
            updateDisplay(0);
            completeSession();
        } else {
            updateDisplay(timeLeft);
        }
    }, 250);
}

function toggleTimer() {
    getAudioContext();
    if (isRunning) {
        stopTicking();
        timeLeft = Math.max(0, Math.round((endTime - Date.now()) / 1000));
        updateDisplay(timeLeft);
    } else {
        if (timeLeft <= 0) timeLeft = durationFor(currentMode);
        startTicking();
    }
}

function setMode(mode) {
    currentMode = mode;
    timeLeft = durationFor(mode);
    paintModeButtons();
    updateCycleDots();
    updateDisplay(timeLeft);
}

function switchMode(mode) {
    if (isRunning) stopTicking();
    setMode(mode);
}

function nextMode() {
    if (currentMode !== 'pomodoro') return 'pomodoro';
    return completedFocusSessions % settings.cyclesBeforeLong === 0 ? 'long' : 'short';
}

function completeSession() {
    const wasFocus = currentMode === 'pomodoro';
    if (wasFocus) completedFocusSessions++;

    playChime(!wasFocus);

    const upcoming = nextMode();
    notify(
        wasFocus ? 'Focus session done' : 'Break over',
        wasFocus ? `Next up: ${MODE_LABELS[upcoming].toLowerCase()}.` : 'Back to focus.'
    );

    setMode(upcoming);
    if (settings.autoStart) startTicking();
}

// --- 7. Events -------------------------------------------------------------

btnToggle.addEventListener('click', toggleTimer);

btnReset.addEventListener('click', () => {
    if (isRunning) stopTicking();
    timeLeft = durationFor(currentMode);
    updateDisplay(timeLeft);
});

btnSkip.addEventListener('click', () => {
    if (isRunning) stopTicking();
    if (currentMode === 'pomodoro') completedFocusSessions++;
    setMode(nextMode());
});

MODE_ORDER.forEach(mode => {
    modeButtons[mode].addEventListener('click', () => switchMode(mode));
});

// Arrow-key navigation across the tablist.
modeSwitch.addEventListener('keydown', e => {
    if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
    e.preventDefault();
    const i = MODE_ORDER.indexOf(currentMode);
    const next = e.key === 'ArrowRight'
        ? (i + 1) % MODE_ORDER.length
        : (i - 1 + MODE_ORDER.length) % MODE_ORDER.length;
    switchMode(MODE_ORDER[next]);
    modeButtons[MODE_ORDER[next]].focus();
});

document.getElementById('vol-rain').addEventListener('input', e => setTrackVolume('rain', e.target.value));
document.getElementById('vol-cafe').addEventListener('input', e => setTrackVolume('cafe', e.target.value));
document.getElementById('vol-noise').addEventListener('input', e => setNoiseVolume(e.target.value));

btnSettings.addEventListener('click', () => {
    const nowOpen = settingsPanel.classList.toggle('hidden') === false;
    btnSettings.setAttribute('aria-expanded', String(nowOpen));
});

Object.entries(inputs).forEach(([key, el]) => {
    el.addEventListener('change', () => {
        if (key === 'autoStart') {
            settings.autoStart = el.checked;
        } else {
            settings[key] = clamp(el.value, ...BOUNDS[key], DEFAULTS[key]);
            el.value = settings[key];
        }
        saveSettings();
        updateCycleDots();
        if (!isRunning) {
            timeLeft = durationFor(currentMode);
            updateDisplay(timeLeft);
        }
    });
});

// Permission is requested on first start, not page load — an unprompted
// dialog is the fastest way to get denied permanently.
btnToggle.addEventListener('click', function askOnce() {
    if ('Notification' in window && Notification.permission === 'default') {
        Notification.requestPermission().catch(() => {});
    }
    btnToggle.removeEventListener('click', askOnce);
});

document.addEventListener('keydown', e => {
    const tag = e.target.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || e.target.isContentEditable) return;
    if (e.code === 'Space') {
        e.preventDefault();
        toggleTimer();
    } else if (e.key === 'r' || e.key === 'R') {
        btnReset.click();
    } else if (e.key === 's' || e.key === 'S') {
        btnSkip.click();
    }
});

// setInterval throttles in background tabs, so endTime is the source of truth.
document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && isRunning) {
        timeLeft = Math.max(0, Math.round((endTime - Date.now()) / 1000));
        updateDisplay(timeLeft);
    }
});

window.addEventListener('beforeunload', e => {
    if (isRunning) {
        e.preventDefault();
        e.returnValue = '';
    }
});

// --- 8. Init ---------------------------------------------------------------

progressRing.style.strokeDasharray = RING_CIRCUMFERENCE;

inputs.pomodoro.value = settings.pomodoro;
inputs.short.value = settings.short;
inputs.long.value = settings.long;
inputs.cyclesBeforeLong.value = settings.cyclesBeforeLong;
inputs.autoStart.checked = settings.autoStart;

['rain', 'cafe', 'noise'].forEach(n => paintChannel(n, 0));

paintModeButtons();
updateCycleDots();
setToggleButton(false);
updateDisplay(timeLeft);