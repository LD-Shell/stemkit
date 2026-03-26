// # --- 1. The STEM dictionary ---
const wordList = [
    "YIELD", "REACT", "ARRAY", "PIPET", "FLUID", 
    "SCOPE", "LOGIC", "CYCLE", "FLASK", "JOULE",
    "QUARK", "LASER", "VIRUS", "AXION", "GRAPH"
];

// # --- 2. Daily hash math ---
// # I am calculating the target term using modulo arithmetic against the global epoch to ensure consistency across clients
const MS_IN_DAY = 1000 * 60 * 60 * 24;
const epochDays = Math.floor(Date.now() / MS_IN_DAY);
const todayIndex = epochDays % wordList.length;
const targetWord = wordList[todayIndex].toUpperCase();

// # --- 3. Game state initialization ---
const maxGuesses = 6;
const wordLength = 5;
let currentGuess = "";
let currentRow = 0;
let isGameOver = false;

// # Loading history from local storage
let stats = JSON.parse(localStorage.getItem('stemdleStats')) || { streak: 0, played: 0 };
document.getElementById('streak-counter').innerHTML = `<i class="fa-solid fa-fire text-orange-500"></i> Streak: ${stats.streak}`;
document.getElementById('games-played').textContent = `Played: ${stats.played}`;

const lastPlayedDate = localStorage.getItem('stemdleLastPlayed');
if (lastPlayedDate == epochDays) {
    isGameOver = true;
    alert("You already played today! Come back tomorrow for a new word.");
}

// # --- 4. User interface construction ---
const grid = document.getElementById('grid');
for (let i = 0; i < maxGuesses; i++) {
    const row = document.createElement('div');
    row.className = "grid grid-cols-5 gap-2";
    for (let j = 0; j < wordLength; j++) {
        const tile = document.createElement('div');
        tile.className = "tile w-full aspect-square border-2 border-slate-300 dark:border-slate-700 flex items-center justify-center text-3xl font-black uppercase text-slate-800 dark:text-white bg-white dark:bg-slate-900";
        tile.id = `tile-${i}-${j}`;
        row.appendChild(tile);
    }
    grid.appendChild(row);
}

// # --- 5. Input parsing ---
function handleInput(key) {
    if (isGameOver) return;

    if (key === 'Backspace' || key === 'Delete') {
        currentGuess = currentGuess.slice(0, -1);
        updateGrid();
    } else if (key === 'Enter') {
        if (currentGuess.length === wordLength) {
            submitGuess();
        } else {
            alert("Not enough letters!");
        }
    } else if (currentGuess.length < wordLength && /^[a-zA-Z]$/.test(key)) {
        currentGuess += key.toUpperCase();
        updateGrid();
    }
}

document.addEventListener('keydown', (e) => handleInput(e.key));

document.querySelectorAll('.key').forEach(button => {
    button.addEventListener('click', () => handleInput(button.dataset.key));
});

function updateGrid() {
    for (let i = 0; i < wordLength; i++) {
        const tile = document.getElementById(`tile-${currentRow}-${i}`);
        tile.textContent = currentGuess[i] || "";
        
        if (currentGuess[i]) {
            tile.classList.add('border-slate-500', 'dark:border-slate-500');
        } else {
            tile.classList.remove('border-slate-500', 'dark:border-slate-500');
        }
    }
}

// # --- 6. Verification algorithm ---
function submitGuess() {
    // # I am executing a two-pass verification scan to prevent false positives when characters are repeated
    const guessArray = currentGuess.split('');
    const targetArray = targetWord.split('');
    const tileColors = new Array(wordLength).fill('gray'); 

    for (let i = 0; i < wordLength; i++) {
        if (guessArray[i] === targetArray[i]) {
            tileColors[i] = 'green';
            targetArray[i] = null; 
            guessArray[i] = null; 
        }
    }

    for (let i = 0; i < wordLength; i++) {
        if (guessArray[i] !== null && targetArray.includes(guessArray[i])) {
            tileColors[i] = 'yellow';
            const matchedIndex = targetArray.indexOf(guessArray[i]);
            targetArray[matchedIndex] = null;
        }
    }

    // # --- 7. Animation sequencing ---
    for (let i = 0; i < wordLength; i++) {
        const tile = document.getElementById(`tile-${currentRow}-${i}`);
        const keyboardKey = document.querySelector(`.key[data-key="${currentGuess[i].toLowerCase()}"]`);
        
        setTimeout(() => {
            tile.classList.add('flip');
            
            setTimeout(() => {
                tile.classList.remove('border-slate-300', 'dark:border-slate-700', 'dark:border-slate-500', 'bg-white', 'dark:bg-slate-900', 'text-slate-800');
                tile.classList.add('text-white', 'border-transparent');
                
                if (tileColors[i] === 'green') {
                    tile.classList.add('bg-emerald-500');
                    if(keyboardKey) keyboardKey.classList.add('bg-emerald-500', 'text-white');
                } else if (tileColors[i] === 'yellow') {
                    tile.classList.add('bg-amber-500');
                    if(keyboardKey && !keyboardKey.classList.contains('bg-emerald-500')) {
                        keyboardKey.classList.add('bg-amber-500', 'text-white');
                    }
                } else {
                    tile.classList.add('bg-slate-400', 'dark:bg-slate-600');
                    if(keyboardKey && !keyboardKey.classList.contains('bg-emerald-500') && !keyboardKey.classList.contains('bg-amber-500')) {
                        keyboardKey.classList.add('opacity-30'); 
                    }
                }
                
                tile.classList.remove('flip');
            }, 200); 
            
        }, i * 300); 
    }

    setTimeout(() => {
        if (currentGuess === targetWord) {
            endGame(true);
        } else if (currentRow === maxGuesses - 1) {
            endGame(false);
        } else {
            currentRow++;
            currentGuess = "";
        }
    }, wordLength * 300 + 300);
}

function endGame(won) {
    isGameOver = true;
    stats.played++;
    
    if (won) {
        stats.streak++;
        alert(`Genius! You got it in ${currentRow + 1}. Your streak is now ${stats.streak}.`);
    } else {
        stats.streak = 0;
        alert(`Game Over. The correct word was ${targetWord}. Streak reset to 0.`);
    }

    localStorage.setItem('stemdleStats', JSON.stringify(stats));
    localStorage.setItem('stemdleLastPlayed', epochDays);
    
    document.getElementById('streak-counter').innerHTML = `<i class="fa-solid fa-fire text-orange-500"></i> Streak: ${stats.streak}`;
    document.getElementById('games-played').textContent = `Played: ${stats.played}`;
}