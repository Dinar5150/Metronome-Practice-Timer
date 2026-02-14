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

const CONFIG = {
  STORAGE_KEY: "metronome-practice-timer:settings:v1",
  MINUTE_SECOND_MIN: 0,
  MINUTE_SECOND_MAX: 59,
  VOLUME_MIN: 0,
  VOLUME_MAX: 100,
  TEMPO_MIN: 30,
  TEMPO_MAX: 300,
  TIMER_TICK_MS: 250,
  SETTINGS_SAVE_DEBOUNCE_MS: 120,
  METRONOME_LOOKAHEAD_MS: 25,
  METRONOME_SCHEDULE_AHEAD_SECONDS: 0.12,
};

let intervalId = null;
let titleIntervalId = null;
let isRunning = false;
let isPaused = false;
let currentPhase = "practice";
let remainingSeconds = 0;
let cycleCount = 1;
let phaseEndsAtMs = null;
let audioContext = null;
let masterGain = null;
let metronomeSchedulerId = null;
let metronomeEnabled = false;
let metronomeAuto = false;
let metronomeBeatIndex = 0;
let metronomeLastBeatMs = null;
let metronomeNextTickTime = null;
let metronomeTempoBpm = clampNumber(metronomeTempoInput.value, CONFIG.TEMPO_MIN, CONFIG.TEMPO_MAX);
let metronomeTempoDirty = false;
let metronomeRequestedStartTime = null;
let isHydratingSettings = false;
let settingsSaveTimeoutId = null;

function clampNumber(value, min, max) {
  const num = Number(value);
  if (Number.isNaN(num)) {
    return min;
  }
  return Math.min(Math.max(num, min), max);
}

const saveSettings = () => {
  if (isHydratingSettings) return;

  const settings = {
    practiceMinutes: clampNumber(practiceMinutesInput.value, CONFIG.MINUTE_SECOND_MIN, CONFIG.MINUTE_SECOND_MAX),
    practiceSeconds: clampNumber(practiceSecondsInput.value, CONFIG.MINUTE_SECOND_MIN, CONFIG.MINUTE_SECOND_MAX),
    restMinutes: clampNumber(restMinutesInput.value, CONFIG.MINUTE_SECOND_MIN, CONFIG.MINUTE_SECOND_MAX),
    restSeconds: clampNumber(restSecondsInput.value, CONFIG.MINUTE_SECOND_MIN, CONFIG.MINUTE_SECOND_MAX),
    timerVolume: clampNumber(timerVolumeRange.value, CONFIG.VOLUME_MIN, CONFIG.VOLUME_MAX),
    metronomeEnabled,
    metronomeAuto,
    metronomeSignature: String(metronomeSignatureSelect.value || "4/4"),
    metronomeTempo: clampNumber(metronomeTempoBpm, CONFIG.TEMPO_MIN, CONFIG.TEMPO_MAX),
    metronomeVolume: clampNumber(metronomeVolumeRange.value, CONFIG.VOLUME_MIN, CONFIG.VOLUME_MAX),
  };

  try {
    localStorage.setItem(CONFIG.STORAGE_KEY, JSON.stringify(settings));
  } catch {
    // ignore storage errors (private mode, quotas, etc.)
  }
};

const queueSaveSettings = () => {
  if (settingsSaveTimeoutId) {
    clearTimeout(settingsSaveTimeoutId);
  }
  settingsSaveTimeoutId = setTimeout(() => {
    settingsSaveTimeoutId = null;
    saveSettings();
  }, CONFIG.SETTINGS_SAVE_DEBOUNCE_MS);
};

const loadSettings = () => {
  let raw = null;
  try {
    raw = localStorage.getItem(CONFIG.STORAGE_KEY);
  } catch {
    raw = null;
  }
  if (!raw) return;

  let settings;
  try {
    settings = JSON.parse(raw);
  } catch {
    return;
  }
  if (!settings || typeof settings !== "object") return;

  isHydratingSettings = true;

  practiceMinutesInput.value = String(clampNumber(settings.practiceMinutes, CONFIG.MINUTE_SECOND_MIN, CONFIG.MINUTE_SECOND_MAX));
  practiceSecondsInput.value = String(clampNumber(settings.practiceSeconds, CONFIG.MINUTE_SECOND_MIN, CONFIG.MINUTE_SECOND_MAX));
  restMinutesInput.value = String(clampNumber(settings.restMinutes, CONFIG.MINUTE_SECOND_MIN, CONFIG.MINUTE_SECOND_MAX));
  restSecondsInput.value = String(clampNumber(settings.restSeconds, CONFIG.MINUTE_SECOND_MIN, CONFIG.MINUTE_SECOND_MAX));

  timerVolumeRange.value = String(clampNumber(settings.timerVolume, CONFIG.VOLUME_MIN, CONFIG.VOLUME_MAX));

  metronomeEnabled = Boolean(settings.metronomeEnabled);
  metronomeAuto = Boolean(settings.metronomeAuto);

  if (typeof settings.metronomeSignature === "string") {
    metronomeSignatureSelect.value = settings.metronomeSignature;
  }

  metronomeTempoBpm = clampNumber(settings.metronomeTempo, CONFIG.TEMPO_MIN, CONFIG.TEMPO_MAX);
  metronomeTempoInput.value = String(metronomeTempoBpm);
  metronomeTempoDirty = false;

  metronomeVolumeRange.value = String(clampNumber(settings.metronomeVolume, CONFIG.VOLUME_MIN, CONFIG.VOLUME_MAX));

  isHydratingSettings = false;
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
  const minutesValue = clampNumber(minutes.value, CONFIG.MINUTE_SECOND_MIN, CONFIG.MINUTE_SECOND_MAX);
  const secondsValue = clampNumber(seconds.value, CONFIG.MINUTE_SECOND_MIN, CONFIG.MINUTE_SECOND_MAX);
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

const startTitleUpdater = () => {
  if (titleIntervalId) {
    clearInterval(titleIntervalId);
  }
  titleIntervalId = setInterval(() => {
    if (!isRunning) {
      return;
    }
    tick();
  }, 1000);
};

const stopTitleUpdater = () => {
  if (!titleIntervalId) {
    return;
  }
  clearInterval(titleIntervalId);
  titleIntervalId = null;
};

const updateControls = () => {
  playButton.disabled = isRunning && !isPaused;
  pauseButton.disabled = !isRunning;
  stopButton.disabled = !isRunning && !isPaused;
};

const stopTimer = () => {
  clearInterval(intervalId);
  intervalId = null;
  stopTitleUpdater();
  isRunning = false;
  isPaused = false;
  phaseEndsAtMs = null;
  stopMetronome();
  currentPhase = PHASES.PRACTICE;
  const practiceDuration = getDuration(PHASES.PRACTICE);
  const restDuration = getDuration(PHASES.REST);
  remainingSeconds = practiceDuration;
  loopStatus.textContent = (practiceDuration > 0 || restDuration > 0) ? "Stopped" : "Set a duration";
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
  const value = clampNumber(timerVolumeRange.value, CONFIG.VOLUME_MIN, CONFIG.VOLUME_MAX);
  timerVolumeRange.value = value;
  timerVolumeValue.textContent = `${value}%`;
  queueSaveSettings();
};

const updateMetronomeVolume = () => {
  const value = clampNumber(metronomeVolumeRange.value, CONFIG.VOLUME_MIN, CONFIG.VOLUME_MAX);
  metronomeVolumeRange.value = value;
  metronomeVolumeValue.textContent = `${value}%`;
  queueSaveSettings();
};

const parseTimeSignature = () => {
  const value = String(metronomeSignatureSelect.value || "4/4");
  const [beatsRaw] = value.split("/").map((part) => Number(part));
  const beats = Number.isNaN(beatsRaw) ? 4 : beatsRaw;
  return { beats };
};

const getTempo = () => metronomeTempoBpm;

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
  const earliestStart = context.currentTime + 0.02;
  metronomeNextTickTime = Math.max(earliestStart, metronomeRequestedStartTime ?? earliestStart);
  metronomeRequestedStartTime = null;
  const scheduler = () => {
    if (!shouldMetronomeRun()) {
      stopMetronome();
      return;
    }
    while (metronomeNextTickTime < context.currentTime + CONFIG.METRONOME_SCHEDULE_AHEAD_SECONDS) {
      const beatInBar = metronomeBeatIndex % beats;
      playMetronomeClick(beatInBar === 0, metronomeNextTickTime);
      metronomeBeatIndex += 1;
      metronomeNextTickTime += beatSeconds;
    }
  };
  scheduler();
  metronomeSchedulerId = setInterval(scheduler, CONFIG.METRONOME_LOOKAHEAD_MS);
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
  gain.gain.value = clampNumber(volume, CONFIG.VOLUME_MIN, CONFIG.VOLUME_MAX) / 100;
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
  const context = getAudioContext();
  const startAt = context.currentTime + 0.15;
  metronomeRequestedStartTime = startAt;
  playTone(740, 0.18, "triangle", volume, startAt);
  playTone(980, 0.18, "triangle", volume, startAt + 0.09);
};

const playRestStartSfx = () => {
  // Play the same two notes as practice but reversed
  const volume = timerVolumeRange ? timerVolumeRange.value : 100;
  const context = getAudioContext();
  const startAt = context.currentTime + 0.15;
  metronomeRequestedStartTime = startAt;
  playTone(980, 0.18, "triangle", volume, startAt);
  playTone(740, 0.18, "triangle", volume, startAt + 0.09);
};

const playPhaseStartSfx = () => {
  if (currentPhase === PHASES.PRACTICE) {
    playPracticeStartSfx();
  } else {
    playRestStartSfx();
  }
};

const applyPhaseTransition = ({ phase, duration, incrementCycle = false, playSfx = true, endAtMs }) => {
  currentPhase = phase;
  if (incrementCycle) {
    cycleCount += 1;
  }
  remainingSeconds = duration;
  phaseEndsAtMs = endAtMs;

  if (playSfx) {
    if (phase === PHASES.PRACTICE) {
      playPracticeStartSfx();
    } else {
      playRestStartSfx();
    }
  }

  updateDisplay();
  updateMetronomeState({ forceRestart: true });
};

const nextPhaseCycle = ({ playSfx = true, anchorMs = Date.now() } = {}) => {
  const next = getNextPhase();
  if (!next) {
    stopTimer();
    return;
  }

  applyPhaseTransition({
    phase: next.phase,
    duration: next.duration,
    incrementCycle: next.incrementCycle,
    playSfx,
    endAtMs: anchorMs + next.duration * 1000,
  });
};

const tick = () => {
  if (!isRunning) return;

  const now = Date.now();
  if (phaseEndsAtMs === null) {
    phaseEndsAtMs = now + remainingSeconds * 1000;
  }

  const shortDelayThresholdMs = CONFIG.TIMER_TICK_MS * 2;
  while (phaseEndsAtMs !== null && now >= phaseEndsAtMs) {
    const lagMs = now - phaseEndsAtMs;
    const shouldPlaySfx = lagMs <= shortDelayThresholdMs;
    const anchorMs = shouldPlaySfx ? now : phaseEndsAtMs;
    nextPhaseCycle({ playSfx: shouldPlaySfx, anchorMs });
    if (!isRunning || phaseEndsAtMs === null) {
      return;
    }
  }

  remainingSeconds = Math.max(0, Math.ceil((phaseEndsAtMs - now) / 1000));
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
      phaseEndsAtMs = Date.now() + remainingSeconds * 1000;
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
      phaseEndsAtMs = Date.now() + remainingSeconds * 1000;
    }
  }
  clearInterval(intervalId);
  intervalId = setInterval(tick, CONFIG.TIMER_TICK_MS);
  startTitleUpdater();
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
  tick();
  clearInterval(intervalId);
  intervalId = null;
  stopTitleUpdater();
  isRunning = false;
  isPaused = true;
  phaseEndsAtMs = null;
  loopStatus.textContent = "Paused";
  updateControls();
  stopMetronome();
};

const syncTimerDisplayFromClock = () => {
  if (!isRunning) {
    return;
  }
  tick();
};

const handleInputChange = (event) => {
  const input = event.target;
  const max = Number(input.max || CONFIG.MINUTE_SECOND_MAX);
  const min = Number(input.min || CONFIG.MINUTE_SECOND_MIN);
  let num = Number(input.value);
  if (Number.isNaN(num)) {
    num = 0;
  }
  num = Math.min(Math.max(num, min), max);
  input.value = String(num);
  queueSaveSettings();
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

const markTempoDirty = () => {
  metronomeTempoDirty = true;
};

const commitTempoIfChanged = () => {
  if (!metronomeTempoDirty) {
    return;
  }
  metronomeTempoDirty = false;

  const raw = String(metronomeTempoInput.value ?? "").trim();
  const parsed = Number(raw);
  if (Number.isNaN(parsed)) {
    metronomeTempoInput.value = String(metronomeTempoBpm);
    return;
  }
  const nextTempo = clampNumber(parsed, CONFIG.TEMPO_MIN, CONFIG.TEMPO_MAX);
  metronomeTempoInput.value = String(nextTempo);
  if (nextTempo !== metronomeTempoBpm) {
    metronomeTempoBpm = nextTempo;
    updateMetronomeState({ forceRestart: true });
  }

  saveSettings();
};

metronomeSignatureSelect.addEventListener("change", () => {
  updateMetronomeState({ forceRestart: true });
  saveSettings();
});

metronomeTempoInput.addEventListener("input", markTempoDirty);
metronomeTempoInput.addEventListener("change", commitTempoIfChanged);
metronomeTempoInput.addEventListener("blur", commitTempoIfChanged);

metronomeToggleCheckbox.addEventListener("change", () => {
  metronomeEnabled = metronomeToggleCheckbox.checked;
  updateMetronomeState({ forceRestart: true });
  saveSettings();
});

metronomeAutoToggleCheckbox.addEventListener("change", () => {
  metronomeAuto = metronomeAutoToggleCheckbox.checked;
  updateMetronomeState({ forceRestart: true });
  saveSettings();
});

document.addEventListener("visibilitychange", syncTimerDisplayFromClock);
window.addEventListener("focus", syncTimerDisplayFromClock);

loadSettings();
updateMetronomeButtons();
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
