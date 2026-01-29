const practiceMinutesInput = document.getElementById("practiceMinutes");
const practiceSecondsInput = document.getElementById("practiceSeconds");
const restMinutesInput = document.getElementById("restMinutes");
const restSecondsInput = document.getElementById("restSeconds");

const timerDisplay = document.getElementById("timerDisplay");
const phaseBadge = document.getElementById("phaseBadge");
const cycleInfo = document.getElementById("cycleInfo");
const nextPhase = document.getElementById("nextPhase");
const loopStatus = document.getElementById("loopStatus");
const baseTitle = document.title;
// summary previews removed from UI; keep function as no-op

const playButton = document.getElementById("playButton");
const pauseButton = document.getElementById("pauseButton");
const stopButton = document.getElementById("stopButton");
const timerVolumeRange = document.getElementById("timerVolumeRange");
const timerVolumeValue = document.getElementById("timerVolumeValue");
const metronomeSignatureSelect = document.getElementById("metronomeSignature");
const metronomeTempoInput = document.getElementById("metronomeTempo");
const metronomeVolumeRange = document.getElementById("metronomeVolumeRange");
const metronomeVolumeValue = document.getElementById("metronomeVolumeValue");
const metronomeToggleCheckbox = document.getElementById("metronomeToggle");
const metronomeAutoToggleCheckbox = document.getElementById("metronomeAutoToggle");

let intervalId = null;
let isRunning = false;
let isPaused = false;
let currentPhase = "practice";
let remainingSeconds = 0;
let cycleCount = 1;
let audioContext = null;
let masterGain = null;
let metronomeSchedulerId = null;
let metronomeEnabled = false;
let metronomeAuto = false;
let metronomeBeatIndex = 0;
let metronomeLastBeatMs = null;
let metronomeNextTickTime = null;
const metronomeLookaheadMs = 25;
const metronomeScheduleAheadTime = 0.12;

const clampNumber = (value, min, max) => {
  const num = Number(value);
  if (Number.isNaN(num)) {
    return min;
  }
  return Math.min(Math.max(num, min), max);
};

const PHASES = {
  PRACTICE: "practice",
  REST: "rest",
};

const formatTime = (totalSeconds) => {
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
};

const phaseInputs = {
  [PHASES.PRACTICE]: {
    minutes: practiceMinutesInput,
    seconds: practiceSecondsInput,
  },
  [PHASES.REST]: {
    minutes: restMinutesInput,
    seconds: restSecondsInput,
  },
};

const getPhaseLabel = (phase) => (phase === PHASES.PRACTICE ? "Practice" : "Rest");

const getOppositePhase = (phase) => (phase === PHASES.PRACTICE ? PHASES.REST : PHASES.PRACTICE);

const getInputDuration = ({ minutes, seconds }) => {
  const minutesValue = clampNumber(minutes.value, 0, 59);
  const secondsValue = clampNumber(seconds.value, 0, 59);
  return minutesValue * 60 + secondsValue;
};

const getDuration = (phase) => getInputDuration(phaseInputs[phase] || phaseInputs[PHASES.PRACTICE]);

const updateSummaries = () => {
  // previews removed; nothing to update here
};

const getStartPhase = () => {
  const practiceDuration = getDuration(PHASES.PRACTICE);
  const restDuration = getDuration(PHASES.REST);
  if (practiceDuration > 0) {
    return { phase: PHASES.PRACTICE, duration: practiceDuration };
  }
  if (restDuration > 0) {
    return { phase: PHASES.REST, duration: restDuration };
  }
  return null;
};

const getNextPhase = () => {
  const practiceDuration = getDuration(PHASES.PRACTICE);
  const restDuration = getDuration(PHASES.REST);
  if (practiceDuration === 0 && restDuration === 0) {
    return null;
  }
  if (currentPhase === PHASES.PRACTICE) {
    if (restDuration > 0) {
      return { phase: PHASES.REST, duration: restDuration, incrementCycle: false };
    }
    return { phase: PHASES.PRACTICE, duration: practiceDuration, incrementCycle: true };
  }
  if (practiceDuration > 0) {
    return { phase: PHASES.PRACTICE, duration: practiceDuration, incrementCycle: true };
  }
  return { phase: PHASES.REST, duration: restDuration, incrementCycle: false };
};

const updateDisplay = () => {
  timerDisplay.textContent = formatTime(remainingSeconds);
  const nextKey = getOppositePhase(currentPhase);
  nextPhase.textContent = getPhaseLabel(nextKey);
  phaseBadge.textContent = getPhaseLabel(currentPhase);
  phaseBadge.classList.toggle("rest", currentPhase === PHASES.REST);
  cycleInfo.textContent = `Cycle ${cycleCount}`;
  if (isRunning) {
    document.title = `${formatTime(remainingSeconds)} · ${getPhaseLabel(currentPhase)}`;
  } else {
    document.title = baseTitle;
  }
};

const updateControls = () => {
  playButton.disabled = isRunning && !isPaused;
  pauseButton.disabled = !isRunning;
  stopButton.disabled = !isRunning && !isPaused;
};

const stopTimer = () => {
  clearInterval(intervalId);
  intervalId = null;
  isRunning = false;
  isPaused = false;
  stopMetronome();
  currentPhase = PHASES.PRACTICE;
  const currentDuration = getDuration(currentPhase);
  if (currentDuration > 0) {
    remainingSeconds = currentDuration;
    loopStatus.textContent = "Stopped";
  } else {
    const startPhase = getStartPhase();
    if (startPhase) {
      currentPhase = startPhase.phase;
      remainingSeconds = startPhase.duration;
      loopStatus.textContent = "Stopped";
    } else {
      currentPhase = "practice";
      remainingSeconds = 0;
      loopStatus.textContent = "Set a duration";
    }
  }
  updateDisplay();
  updateControls();
};

const getAudioContext = () => {
  if (!audioContext) {
    audioContext = new (window.AudioContext || window.webkitAudioContext)();
    masterGain = audioContext.createGain();
    masterGain.connect(audioContext.destination);
  }
  if (audioContext.state === "suspended") {
    audioContext.resume().catch(() => {});
  }
  return audioContext;
};

const updateTimerVolume = () => {
  const value = clampNumber(timerVolumeRange.value, 0, 100);
  timerVolumeRange.value = value;
  timerVolumeValue.textContent = `${value}%`;
};

const updateMetronomeVolume = () => {
  const value = clampNumber(metronomeVolumeRange.value, 0, 100);
  metronomeVolumeRange.value = value;
  metronomeVolumeValue.textContent = `${value}%`;
};

const parseTimeSignature = () => {
  const value = String(metronomeSignatureSelect.value || "4/4");
  const [beatsRaw] = value.split("/").map((part) => Number(part));
  const beats = Number.isNaN(beatsRaw) ? 4 : beatsRaw;
  return { beats };
};

const getTempo = () => clampNumber(metronomeTempoInput.value, 30, 300);

const getMetronomeBeatMs = () => 60000 / getTempo();

const playMetronomeClick = (accent, startTime = null) => {
  const frequency = accent ? 1100 : 820;
  const volume = metronomeVolumeRange ? metronomeVolumeRange.value : 100;
  playTone(frequency, 0.06, accent ? "square" : "triangle", volume, startTime);
};

const stopMetronome = () => {
  if (metronomeSchedulerId) {
    clearInterval(metronomeSchedulerId);
    metronomeSchedulerId = null;
  }
  metronomeBeatIndex = 0;
  metronomeNextTickTime = null;
};

const shouldMetronomeRun = () => {
  if (!metronomeEnabled) return false;
  if (metronomeAuto && currentPhase === PHASES.REST) return false;
  return isRunning;
};

const startMetronome = () => {
  stopMetronome();
  if (!shouldMetronomeRun()) {
    return;
  }
  const context = getAudioContext();
  const { beats } = parseTimeSignature();
  const beatSeconds = 60 / getTempo();
  metronomeLastBeatMs = beatSeconds * 1000;
  metronomeNextTickTime = context.currentTime + 0.02;
  const scheduler = () => {
    if (!shouldMetronomeRun()) {
      stopMetronome();
      return;
    }
    while (metronomeNextTickTime < context.currentTime + metronomeScheduleAheadTime) {
      const beatInBar = metronomeBeatIndex % beats;
      playMetronomeClick(beatInBar === 0, metronomeNextTickTime);
      metronomeBeatIndex += 1;
      metronomeNextTickTime += beatSeconds;
    }
  };
  scheduler();
  metronomeSchedulerId = setInterval(scheduler, metronomeLookaheadMs);
};

const updateMetronomeButtons = () => {
  metronomeToggleCheckbox.checked = metronomeEnabled;
  metronomeAutoToggleCheckbox.checked = metronomeAuto;
};

const updateMetronomeState = ({ forceRestart = false } = {}) => {
  const beatMs = getMetronomeBeatMs();
  const shouldRun = shouldMetronomeRun();
  const tempoChanged = metronomeLastBeatMs !== null && Math.abs(metronomeLastBeatMs - beatMs) > 0.5;
  if (!shouldRun) {
    stopMetronome();
    return;
  }
  if (forceRestart || tempoChanged || !metronomeSchedulerId) {
    startMetronome();
  }
};

const playTone = (frequency, duration, type = "sine", volume = 100, startTime = null) => {
  const context = getAudioContext();
  const oscillator = context.createOscillator();
  const gain = context.createGain();
  const now = startTime ?? context.currentTime;
  gain.gain.value = clampNumber(volume, 0, 100) / 100;
  oscillator.type = type;
  oscillator.frequency.value = frequency;
  oscillator.connect(gain);
  gain.connect(masterGain || context.destination);
  gain.gain.setValueAtTime(gain.gain.value, now);
  gain.gain.exponentialRampToValueAtTime(0.0001, now + duration);
  oscillator.start(now);
  oscillator.stop(now + duration);
};

const playPracticeStartSfx = () => {
  const volume = timerVolumeRange ? timerVolumeRange.value : 100;
  playTone(740, 0.18, "triangle", volume);
  setTimeout(() => playTone(980, 0.18, "triangle", volume), 90);
};

const playRestStartSfx = () => {
  // Play the same two notes as practice but reversed
  const volume = timerVolumeRange ? timerVolumeRange.value : 100;
  playTone(980, 0.18, "triangle", volume);
  setTimeout(() => playTone(740, 0.18, "triangle", volume), 90);
};

const playPhaseStartSfx = () => {
  if (currentPhase === PHASES.PRACTICE) {
    playPracticeStartSfx();
  } else {
    playRestStartSfx();
  }
};

const nextPhaseCycle = () => {
  const next = getNextPhase();
  if (!next) {
    stopTimer();
    return;
  }
  currentPhase = next.phase;
  if (next.incrementCycle) {
    cycleCount += 1;
    playPracticeStartSfx();
  } else {
    playRestStartSfx();
  }
  remainingSeconds = next.duration;
  updateDisplay();
  updateMetronomeState({ forceRestart: true });
};

const tick = () => {
  if (remainingSeconds <= 0) {
    nextPhaseCycle();
    return;
  }
  remainingSeconds -= 1;
  updateDisplay();
};

const startTimer = () => {
  const practiceDuration = getDuration(PHASES.PRACTICE);
  const restDuration = getDuration(PHASES.REST);
  if (practiceDuration === 0 && restDuration === 0) {
    loopStatus.textContent = "Set a duration";
    return;
  }
  if (!isRunning) {
    if (!isPaused) {
      // fresh start: start from the first non-zero phase
      const startPhase = getStartPhase();
      currentPhase = startPhase ? startPhase.phase : PHASES.PRACTICE;
      cycleCount = 1;
      remainingSeconds = startPhase ? startPhase.duration : 0;
      // Play SFX only when starting fresh (not when resuming from pause)
      playPhaseStartSfx();
    } else {
      // resuming from pause: preserve current phase and remaining time
      if (remainingSeconds <= 0) {
        const currentDuration = getDuration(currentPhase);
        if (currentDuration > 0) {
          remainingSeconds = currentDuration;
        } else {
          const next = getNextPhase();
          if (!next) {
            stopTimer();
            return;
          }
          currentPhase = next.phase;
          if (next.incrementCycle) {
            cycleCount += 1;
          }
          remainingSeconds = next.duration;
        }
      }
    }
  }
  clearInterval(intervalId);
  intervalId = setInterval(tick, 1000);
  isRunning = true;
  isPaused = false;
  loopStatus.textContent = "Running";
  updateDisplay();
  updateControls();
  updateMetronomeState({ forceRestart: true });
};

const pauseTimer = () => {
  if (!isRunning) {
    return;
  }
  clearInterval(intervalId);
  intervalId = null;
  isRunning = false;
  isPaused = true;
  loopStatus.textContent = "Paused";
  updateControls();
  stopMetronome();
};

const handleInputChange = (event) => {
  const input = event.target;
  const max = Number(input.max || 59);
  const min = Number(input.min || 0);
  let num = Number(input.value);
  if (Number.isNaN(num)) {
    num = 0;
  }
  num = Math.min(Math.max(num, min), max);
  input.value = String(num);
  updateSummaries();
  if (!isRunning && !isPaused) {
    const currentDuration = getDuration(currentPhase);
    remainingSeconds = currentDuration;
    updateDisplay();
  }
};

[
  practiceMinutesInput,
  practiceSecondsInput,
  restMinutesInput,
  restSecondsInput,
].forEach((input) => {
  input.addEventListener("change", handleInputChange);
  input.addEventListener("input", handleInputChange);
});

playButton.addEventListener("click", startTimer);
pauseButton.addEventListener("click", pauseTimer);
stopButton.addEventListener("click", stopTimer);
timerVolumeRange.addEventListener("input", updateTimerVolume);
timerVolumeRange.addEventListener("change", updateTimerVolume);
metronomeVolumeRange.addEventListener("input", updateMetronomeVolume);
metronomeVolumeRange.addEventListener("change", updateMetronomeVolume);

const handleTempoInput = () => {
  const value = clampNumber(metronomeTempoInput.value, 30, 300);
  metronomeTempoInput.value = value;
  updateMetronomeState({ forceRestart: true });
};

metronomeSignatureSelect.addEventListener("change", () => {
  updateMetronomeState({ forceRestart: true });
});

metronomeTempoInput.addEventListener("input", handleTempoInput);
metronomeTempoInput.addEventListener("change", handleTempoInput);

metronomeToggleCheckbox.addEventListener("change", () => {
  metronomeEnabled = metronomeToggleCheckbox.checked;
  updateMetronomeState({ forceRestart: true });
});

metronomeAutoToggleCheckbox.addEventListener("change", () => {
  metronomeAuto = metronomeAutoToggleCheckbox.checked;
  updateMetronomeState({ forceRestart: true });
});

updateSummaries();
const initialPhase = getStartPhase();
if (initialPhase) {
  currentPhase = initialPhase.phase;
  remainingSeconds = initialPhase.duration;
} else {
  currentPhase = PHASES.PRACTICE;
  remainingSeconds = 0;
}
updateDisplay();
updateControls();
updateTimerVolume();
updateMetronomeVolume();
updateMetronomeButtons();
