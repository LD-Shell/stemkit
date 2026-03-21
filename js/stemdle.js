/**
 * STEMKit - STEMdle Logic
 * Implements a daily seeded word game with two-pass color verification.
 */

// Step 1: The STEM Dictionary
// You can easily expand this array to 365+ words. 
const wordList = [
    "YIELD", "REACT", "ARRAY", "PIPET", "FLUID", 
    "SCOPE", "LOGIC", "CYCLE", "FLASK", "JOULE",
    "QUARK", "LASER", "VIRUS", "AXION", "GRAPH"
];

// Step 2: The Daily Hash Math
const MS_IN_DAY = 1000 * 60 * 60 * 24;
const epochDays = Math.floor(Date.now() / MS_IN_DAY);
const todayIndex = epochDays % wordList.length;
const targetWord = wordList[todayIndex].toUpperCase();

// Step 3: Game State
const maxGuesses = 6;
const wordLength = 5;
let currentGuess = "";
let currentRow = 0;
let isGameOver = false;

// Load Stats from LocalStorage
let stats = JSON.parse(localStorage.getItem('stemdleStats')) || { streak: 0, played: 0 };
document.getElementById('streak-counter').innerHTML = `<i class="fa-solid fa-fire text-orange-500"></i> Streak: ${stats.streak}`;
document.getElementById('games-played').textContent = `Played: ${stats.played}`;

// Check if user already played today
const lastPlayedDate = localStorage.getItem('stemdleLastPlayed');
if (lastPlayedDate == epochDays) {
    isGameOver = true;
    alert("You already played today! Come back tomorrow for a new word.");
}

// Step 4: Build the UI Grid
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

// Step 5: Input Handling (Physical and On-Screen Keyboard)
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

// Listen to Physical Keyboard
document.addEventListener('keydown', (e) => handleInput(e.key));

// Listen to On-Screen Keyboard
document.querySelectorAll('.key').forEach(button => {
    button.addEventListener('click', () => handleInput(button.dataset.key));
});

function updateGrid() {
    for (let i = 0; i < wordLength; i++) {
        const tile = document.getElementById(`tile-${currentRow}-${i}`);
        tile.textContent = currentGuess[i] || "";
        
        // Add a little pop animation when a letter is typed
        if (currentGuess[i]) {
            tile.classList.add('border-slate-500', 'dark:border-slate-500');
        } else {
            tile.classList.remove('border-slate-500', 'dark:border-slate-500');
        }
    }
}

// Step 6: The Two-Pass Verification Algorithm (The Pitfall Fix)
function submitGuess() {
    const guessArray = currentGuess.split('');
    const targetArray = targetWord.split('');
    const tileColors = new Array(wordLength).fill('gray'); // Default everything to gray

    // Pass 1: Find all exact matches (GREENS)
    for (let i = 0; i < wordLength; i++) {
        if (guessArray[i] === targetArray[i]) {
            tileColors[i] = 'green';
            // "Cross out" the letter in the target array so it can't be matched again
            targetArray[i] = null; 
            // Cross out in guess array so we don't double count it in Pass 2
            guessArray[i] = null; 
        }
    }

    // Pass 2: Find remaining matches (YELLOWS)
    for (let i = 0; i < wordLength; i++) {
        // Only check letters that weren't already marked green
        if (guessArray[i] !== null && targetArray.includes(guessArray[i])) {
            tileColors[i] = 'yellow';
            // Find the index of the letter we just matched and "cross it out"
            const matchedIndex = targetArray.indexOf(guessArray[i]);
            targetArray[matchedIndex] = null;
        }
    }

    // Step 7: Apply Colors and Animations
    for (let i = 0; i < wordLength; i++) {
        const tile = document.getElementById(`tile-${currentRow}-${i}`);
        const keyboardKey = document.querySelector(`.key[data-key="${currentGuess[i].toLowerCase()}"]`);
        
        // Stagger the flip animation based on the column index
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
                        keyboardKey.classList.add('opacity-30'); // Dim incorrect keys
                    }
                }
                
                tile.classList.remove('flip');
            }, 200); // Apply colors halfway through the flip
            
        }, i * 300); // 300ms delay between each letter flipping
    }

    // Check Win/Loss State (Wait for animations to finish before alerting)
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
        alert(`Genius! You got it in ${currentRow + 1}. Your streak is now ${stats.streak} 🔥`);
    } else {
        stats.streak = 0;
        alert(`Game Over. The correct word was ${targetWord}. Streak reset to 0.`);
    }

    // Save to LocalStorage
    localStorage.setItem('stemdleStats', JSON.stringify(stats));
    localStorage.setItem('stemdleLastPlayed', epochDays);
    
    // Update UI
    document.getElementById('streak-counter').innerHTML = `<i class="fa-solid fa-fire text-orange-500"></i> Streak: ${stats.streak}`;
    document.getElementById('games-played').textContent = `Played: ${stats.played}`;
}