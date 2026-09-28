(() => {
  'use strict';

  const STORAGE_KEYS = {
    tasks: 'focusspace.tasks.v1',
    settings: 'focusspace.settings.v1',
    sessions: 'focusspace.sessions.v1',
    theme: 'focusspace.theme.v1',
    sound: 'focusspace.sound.v1',
    customSounds: 'focusspace.customSounds.v1',
    removedDefaultSounds: 'focusspace.removedDefaultSounds.v1',
  };
  const DEFAULTS = { focus: 25, shortBreak: 5, longBreak: 15, cycleCount: 0 };
  const MODE_INFO = {
    focus: { title: 'Focus', caption: 'TIME TO FOCUS', subtitle: 'One thing at a time.' },
    shortBreak: { title: 'Short break', caption: 'A MOMENT TO RESET', subtitle: 'Stretch. Sip some water.' },
    longBreak: { title: 'Long break', caption: 'YOU HAVE EARNED THIS', subtitle: 'Step away for a while.' },
  };
  const SOUND_PROFILES = {
    rain: { title: 'Rain', filter: 'highpass', frequency: 750, q: .35 },
    cafe: { title: 'Café', filter: 'bandpass', frequency: 680, q: .7 },
    forest: { title: 'Forest birds', filter: 'lowpass', frequency: 850, q: .35 },
    waves: { title: 'Ocean waves', filter: 'lowpass', frequency: 380, q: .35 },
    stream: { title: 'Forest stream', icon: '💧', subtitle: 'A gentle running creek', filter: 'bandpass', frequency: 920, q: .5 },
    fireplace: { title: 'Fireplace', icon: '🔥', subtitle: 'A quiet crackling fire', filter: 'lowpass', frequency: 390, q: .45 },
    wind: { title: 'Soft wind', icon: '🍃', subtitle: 'Wind through the trees', filter: 'lowpass', frequency: 260, q: .3 },
  };
  const DEFAULT_SOUND_IDS = ['rain', 'cafe', 'forest', 'waves'];
  const EXTRA_SOUND_IDS = ['stream', 'fireplace', 'wind'];
  const DAILY_GOAL = 4;
  const CIRCLE_LENGTH = 2 * Math.PI * 116;
  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
  const readStorage = (key, fallback) => {
    try {
      const value = localStorage.getItem(key);
      return value === null ? fallback : JSON.parse(value);
    } catch {
      return fallback;
    }
  };
  const writeStorage = (key, value) => {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch { showToast('Storage is unavailable in this browser.'); }
  };
  const isValidTask = task => task && typeof task.id === 'string' && typeof task.title === 'string';
  const clamp = (value, min, max) => Math.max(min, Math.min(max, Number(value) || min));

  const savedSettings = readStorage(STORAGE_KEYS.settings, {});
  const settings = {
    focus: clamp(savedSettings.focus ?? DEFAULTS.focus, 1, 180),
    shortBreak: clamp(savedSettings.shortBreak ?? DEFAULTS.shortBreak, 1, 60),
    longBreak: clamp(savedSettings.longBreak ?? DEFAULTS.longBreak, 1, 90),
    cycleCount: Math.max(0, Number(savedSettings.cycleCount) || 0),
  };
  let tasks = readStorage(STORAGE_KEYS.tasks, []);
  if (!Array.isArray(tasks)) tasks = [];
  tasks = tasks.filter(isValidTask).map(task => ({
    id: task.id,
    title: task.title.slice(0, 120),
    target: clamp(task.target, 1, 20),
    completed: Math.max(0, Number(task.completed) || 0),
    done: Boolean(task.done),
  }));
  let sessions = readStorage(STORAGE_KEYS.sessions, []);
  if (!Array.isArray(sessions)) sessions = [];
  sessions = sessions.filter(session => session && typeof session.completedAt === 'string' && Number.isFinite(Number(session.minutes)));
  let activeMode = 'focus';
  let remainingSeconds = settings.focus * 60;
  let intervalId = null;
  let deadline = null;
  let selectedTaskId = null;
  let dragTaskId = null;
  let toastTimeout = null;
  let audioContext = null;
  let localSongDatabasePromise = null;
  const soundChannels = new Map();
  const localSongPlayers = new Map();

  const timerDisplay = $('#timer-display');
  const ringProgress = $('#ring-progress');
  const startButton = $('#start-button');
  const taskList = $('#task-list');
  const toast = $('#toast');
  let taskAttachments = [];
  const taskAttachmentUrls = new Set();

  function saveSettings() { writeStorage(STORAGE_KEYS.settings, settings); }
  function saveTasks() { writeStorage(STORAGE_KEYS.tasks, tasks); }
  function saveSessions() { writeStorage(STORAGE_KEYS.sessions, sessions); }

  function showToast(message) {
    toast.textContent = message;
    toast.classList.add('is-visible');
    clearTimeout(toastTimeout);
    toastTimeout = window.setTimeout(() => toast.classList.remove('is-visible'), 2600);
  }

  function localDateKey(date = new Date()) {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
  }

  function todaySessions() {
    const today = localDateKey();
    return sessions.filter(session => localDateKey(new Date(session.completedAt)) === today);
  }

  function renderStats() {
    const completedToday = todaySessions();
    const totalMinutes = completedToday.reduce((total, session) => total + Number(session.minutes), 0);
    $('#sessions-today').textContent = String(completedToday.length);
    $('#minutes-today').textContent = String(totalMinutes);
    $('#history-count').textContent = `${completedToday.length} TODAY`;
    $('#daily-progress').style.width = `${Math.min(100, completedToday.length / DAILY_GOAL * 100)}%`;
    $('#daily-caption').textContent = completedToday.length >= DAILY_GOAL
      ? 'Daily intention met. Lovely work.'
      : `${Math.max(0, DAILY_GOAL - completedToday.length)} more ${DAILY_GOAL - completedToday.length === 1 ? 'session' : 'sessions'} to your daily intention.`;
    renderHistory();
  }

  function renderHistory() {
    const historyList = $('#history-list');
    const visibleSessions = sessions.slice(-6).reverse();
    historyList.replaceChildren();
    $('#empty-history').hidden = visibleSessions.length > 0;
    for (const session of visibleSessions) {
      const item = document.createElement('li');
      item.className = 'history-entry';
      const mark = document.createElement('span');
      mark.className = 'history-mark';
      mark.textContent = '✓';
      const title = document.createElement('span');
      title.className = 'history-task';
      title.textContent = session.taskTitle || 'Free focus';
      const time = document.createElement('time');
      time.className = 'history-time';
      const date = new Date(session.completedAt);
      time.dateTime = date.toISOString();
      time.textContent = date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      const minutes = document.createElement('span');
      minutes.className = 'history-minutes';
      minutes.textContent = `+${session.minutes}m`;
      item.append(mark, title, time, minutes);
      historyList.append(item);
    }
  }

  function renderTasks() {
    taskAttachmentUrls.forEach(url => URL.revokeObjectURL(url));
    taskAttachmentUrls.clear();
    taskList.replaceChildren();
    const remainingTasks = tasks.filter(task => !task.done);
    $('#empty-tasks').hidden = tasks.length > 0;
    $('#task-count').textContent = String(remainingTasks.length);

    tasks.forEach((task, index) => {
      const item = document.createElement('li');
      item.className = `task-item${task.done ? ' is-complete' : ''}`;
      item.draggable = true;
      item.dataset.taskId = task.id;

      const check = document.createElement('input');
      check.className = 'task-check';
      check.type = 'checkbox';
      check.checked = task.done;
      check.setAttribute('aria-label', `${task.done ? 'Reopen' : 'Complete'} task: ${task.title}`);
      check.addEventListener('change', () => {
        task.done = check.checked;
        if (task.done && selectedTaskId === task.id) selectedTaskId = null;
        saveTasks();
        renderTasks();
        updateSessionLabel();
      });

      const main = document.createElement('div');
      main.className = 'task-main';
      const title = document.createElement('span');
      title.className = 'task-title';
      title.textContent = task.title;
      const progress = document.createElement('span');
      progress.className = 'task-progress';
      progress.innerHTML = `<b>${task.completed}</b> / ${task.target} pomodoros`;
      main.append(title, progress);
      renderTaskAttachments(task.id, main);

      const actions = document.createElement('div');
      actions.className = 'task-actions';
      const attachButton = makeTaskAction('📎', 'Add a document to this task', () => attachmentInput.click());
      const attachmentInput = document.createElement('input');
      attachmentInput.className = 'visually-hidden';
      attachmentInput.type = 'file';
      attachmentInput.multiple = true;
      attachmentInput.accept = '.pdf,.doc,.docx,.txt,.md,.rtf,.csv,.xls,.xlsx,.ppt,.pptx';
      attachmentInput.setAttribute('aria-label', `Choose documents for ${task.title}`);
      attachmentInput.addEventListener('change', async () => {
        const files = [...attachmentInput.files];
        attachmentInput.value = '';
        let added = 0;
        for (const file of files) {
          const attachment = {
            id: localSongId(),
            taskId: task.id,
            name: file.name,
            type: file.type,
            blob: file,
          };
          try {
            await storeTaskDocument(attachment);
            taskAttachments.push(attachment);
            added += 1;
          } catch {
            showToast(`Could not save “${file.name}”.`);
          }
        }
        if (added) {
          renderTasks();
          showToast(`${added} ${added === 1 ? 'document' : 'documents'} attached.`);
        }
      });
      attachButton.title = taskAttachments.some(attachment => attachment.taskId === task.id)
        ? 'Add another document'
        : 'Add a document to this task';
      actions.append(attachButton, attachmentInput);
      const focusButton = document.createElement('button');
      focusButton.className = `task-action${selectedTaskId === task.id ? ' is-selected' : ''}`;
      focusButton.type = 'button';
      focusButton.textContent = '◎';
      focusButton.title = selectedTaskId === task.id ? 'Currently selected for focus sessions' : 'Select for focus sessions';
      focusButton.setAttribute('aria-label', focusButton.title);
      focusButton.addEventListener('click', () => {
        selectedTaskId = selectedTaskId === task.id ? null : task.id;
        renderTasks();
        updateSessionLabel();
      });

      const upButton = makeTaskAction('↑', 'Move task up', () => moveTask(index, -1));
      upButton.disabled = index === 0;
      const downButton = makeTaskAction('↓', 'Move task down', () => moveTask(index, 1));
      downButton.disabled = index === tasks.length - 1;
      const deleteButton = makeTaskAction('×', 'Delete task', () => {
        tasks = tasks.filter(entry => entry.id !== task.id);
        taskAttachments = taskAttachments.filter(attachment => attachment.taskId !== task.id);
        deleteTaskDocuments(task.id).catch(() => showToast('Could not remove this task’s saved documents.'));
        if (selectedTaskId === task.id) selectedTaskId = null;
        saveTasks();
        renderTasks();
        updateSessionLabel();
      });
      actions.append(focusButton, upButton, downButton, deleteButton);
      item.append(check, main, actions);

      item.addEventListener('dragstart', event => {
        dragTaskId = task.id;
        item.classList.add('is-dragging');
        event.dataTransfer.effectAllowed = 'move';
        event.dataTransfer.setData('text/plain', task.id);
      });
      item.addEventListener('dragend', () => {
        dragTaskId = null;
        $$('.task-item', taskList).forEach(row => row.classList.remove('is-dragging', 'is-drop-target'));
      });
      item.addEventListener('dragover', event => {
        event.preventDefault();
        event.dataTransfer.dropEffect = 'move';
        item.classList.add('is-drop-target');
      });
      item.addEventListener('dragleave', () => item.classList.remove('is-drop-target'));
      item.addEventListener('drop', event => {
        event.preventDefault();
        const sourceId = event.dataTransfer.getData('text/plain') || dragTaskId;
        reorderTask(sourceId, task.id);
      });
      taskList.append(item);
    });
  }

  function makeTaskAction(symbol, label, action) {
    const button = document.createElement('button');
    button.className = 'task-action';
    button.type = 'button';
    button.textContent = symbol;
    button.title = label;
    button.setAttribute('aria-label', label);
    button.addEventListener('click', action);
    return button;
  }

  function renderTaskAttachments(taskId, container) {
    const attachments = taskAttachments.filter(attachment => attachment.taskId === taskId);
    if (attachments.length === 0) return;
    const list = document.createElement('div');
    list.className = 'task-attachments';
    for (const attachment of attachments) {
      const entry = document.createElement('div');
      entry.className = 'task-attachment';
      const link = document.createElement('a');
      const url = URL.createObjectURL(attachment.blob);
      taskAttachmentUrls.add(url);
      link.href = url;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      link.textContent = attachment.name;
      link.title = `Open ${attachment.name}`;
      const removeButton = makeTaskAction('×', `Remove ${attachment.name}`, () => {
        deleteTaskDocument(attachment.id).then(() => {
          taskAttachments = taskAttachments.filter(item => item.id !== attachment.id);
          renderTasks();
        }).catch(() => showToast(`Could not remove “${attachment.name}”.`));
      });
      removeButton.classList.add('task-attachment-remove');
      entry.append(link, removeButton);
      list.append(entry);
    }
    container.append(list);
  }

  function moveTask(index, direction) {
    const destination = index + direction;
    if (destination < 0 || destination >= tasks.length) return;
    [tasks[index], tasks[destination]] = [tasks[destination], tasks[index]];
    saveTasks();
    renderTasks();
  }

  function reorderTask(sourceId, destinationId) {
    if (!sourceId || sourceId === destinationId) return;
    const sourceIndex = tasks.findIndex(task => task.id === sourceId);
    const destinationIndex = tasks.findIndex(task => task.id === destinationId);
    if (sourceIndex < 0 || destinationIndex < 0) return;
    const [moved] = tasks.splice(sourceIndex, 1);
    tasks.splice(destinationIndex, 0, moved);
    saveTasks();
    renderTasks();
  }

  function updateSessionLabel() {
    const selected = tasks.find(task => task.id === selectedTaskId && !task.done);
    $('#session-label').textContent = selected ? `Working on: ${selected.title}` : (intervalId ? 'A focus session is in progress' : 'Ready when you are');
  }

  function renderTimer() {
    const minutes = Math.floor(remainingSeconds / 60);
    const seconds = remainingSeconds % 60;
    const time = `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
    timerDisplay.textContent = time;
    const fullDuration = settings[activeMode] * 60;
    const progress = fullDuration ? remainingSeconds / fullDuration : 1;
    ringProgress.style.strokeDasharray = String(CIRCLE_LENGTH);
    ringProgress.style.strokeDashoffset = String(CIRCLE_LENGTH * (1 - progress));
    $('#timer-caption').textContent = MODE_INFO[activeMode].caption;
    $('#timer-subtitle').textContent = MODE_INFO[activeMode].subtitle;
    $('#cycle-count').textContent = `ROUND ${String((settings.cycleCount % 4) + 1).padStart(2, '0')}`;
    $$('[data-mode]').forEach(button => {
      const active = button.dataset.mode === activeMode;
      button.classList.toggle('is-active', active);
      button.setAttribute('aria-selected', String(active));
    });
    document.body.dataset.mode = activeMode;
    document.title = `(${time}) ${MODE_INFO[activeMode].title} - FocusSpace`;
    startButton.innerHTML = intervalId ? '<span aria-hidden="true">Ⅱ</span> Pause' : '<span aria-hidden="true">▶</span> Start focus';
    startButton.setAttribute('aria-label', intervalId ? 'Pause timer' : 'Start timer');
  }

  function setMode(mode) {
    if (!MODE_INFO[mode]) return;
    clearInterval(intervalId);
    intervalId = null;
    deadline = null;
    activeMode = mode;
    remainingSeconds = settings[mode] * 60;
    renderTimer();
    updateSessionLabel();
  }

  async function ensureAudioContext() {
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextClass) return null;
    if (!audioContext) audioContext = new AudioContextClass();
    if (audioContext.state === 'suspended') await audioContext.resume();
    return audioContext;
  }

  function startTimer() {
    if (intervalId) {
      clearInterval(intervalId);
      intervalId = null;
      deadline = null;
      renderTimer();
      updateSessionLabel();
      return;
    }
    ensureAudioContext().catch(() => {});
    deadline = Date.now() + remainingSeconds * 1000;
    intervalId = window.setInterval(tick, 250);
    renderTimer();
    updateSessionLabel();
  }

  function tick() {
    remainingSeconds = Math.max(0, Math.ceil((deadline - Date.now()) / 1000));
    renderTimer();
    if (remainingSeconds === 0) completeMode();
  }

  function resetTimer() {
    clearInterval(intervalId);
    intervalId = null;
    deadline = null;
    remainingSeconds = settings[activeMode] * 60;
    renderTimer();
    updateSessionLabel();
  }

  function advanceMode(completed) {
    clearInterval(intervalId);
    intervalId = null;
    deadline = null;
    if (activeMode === 'focus') {
      if (completed) {
        recordFocusSession();
        settings.cycleCount += 1;
        saveSettings();
      }
      activeMode = completed && settings.cycleCount % 4 === 0 ? 'longBreak' : 'shortBreak';
    } else {
      activeMode = 'focus';
    }
    remainingSeconds = settings[activeMode] * 60;
    renderTimer();
    updateSessionLabel();
    if (completed) {
      playChime();
      showToast(activeMode === 'focus' ? 'Break complete. Ready for another round?' : 'Focus session complete. Take a small break.');
    }
  }

  function completeMode() { advanceMode(true); }

  function recordFocusSession() {
    const selected = tasks.find(task => task.id === selectedTaskId && !task.done);
    const minutes = settings.focus;
    sessions.push({
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      completedAt: new Date().toISOString(),
      minutes,
      taskTitle: selected ? selected.title : '',
    });
    sessions = sessions.slice(-200);
    if (selected) {
      selected.completed += 1;
      if (selected.completed >= selected.target) {
        selected.done = true;
        selectedTaskId = null;
        showToast(`Lovely work. “${selected.title}” reached its Pomodoro target.`);
      }
      saveTasks();
      renderTasks();
    }
    saveSessions();
    renderStats();
  }

  function playChime() {
    if (!audioContext || audioContext.state !== 'running') return;
    const now = audioContext.currentTime;
    [659.25, 783.99, 987.77].forEach((frequency, index) => {
      const oscillator = audioContext.createOscillator();
      const gain = audioContext.createGain();
      oscillator.type = 'sine';
      oscillator.frequency.value = frequency;
      gain.gain.setValueAtTime(0.0001, now + index * .13);
      gain.gain.exponentialRampToValueAtTime(.12, now + index * .13 + .025);
      gain.gain.exponentialRampToValueAtTime(.0001, now + index * .13 + .65);
      oscillator.connect(gain).connect(audioContext.destination);
      oscillator.start(now + index * .13);
      oscillator.stop(now + index * .13 + .7);
    });
  }

  function createNoiseBuffer(context) {
    const buffer = context.createBuffer(1, context.sampleRate * 3, context.sampleRate);
    const data = buffer.getChannelData(0);
    let previous = 0;
    for (let index = 0; index < data.length; index += 1) {
      const white = Math.random() * 2 - 1;
      previous = previous * .18 + white * .82;
      data[index] = previous;
    }
    return buffer;
  }

  function buildSound(name, row) {
    if (soundChannels.has(name)) return soundChannels.get(name);
    const context = audioContext;
    const profile = SOUND_PROFILES[name];
    if (!profile) throw new Error(`Unknown sound channel: ${name}`);
    const source = context.createBufferSource();
    const filter = context.createBiquadFilter();
    const channelGain = context.createGain();
    source.buffer = createNoiseBuffer(context);
    source.loop = true;
    filter.type = profile.filter;
    filter.frequency.value = profile.frequency;
    filter.Q.value = profile.q;
    channelGain.gain.value = Number($(`#volume-${name}`).value) / 100 * .25;
    source.connect(filter);

    const nodes = { source, filter, channelGain, extras: [], timers: [], row };
    if (name === 'waves') {
      const swell = context.createGain();
      const lfo = context.createOscillator();
      const depth = context.createGain();
      swell.gain.value = .62;
      lfo.type = 'sine';
      lfo.frequency.value = .12;
      depth.gain.value = .38;
      lfo.connect(depth).connect(swell.gain);
      filter.connect(swell).connect(channelGain);
      lfo.start();
      nodes.extras.push(lfo, swell);
    } else {
      filter.connect(channelGain);
    }
    channelGain.connect(context.destination);
    source.start();
    if (name === 'cafe') {
      const hum = context.createOscillator();
      const humGain = context.createGain();
      hum.type = 'sine';
      hum.frequency.value = 112;
      humGain.gain.value = .009;
      hum.connect(humGain).connect(channelGain);
      hum.start();
      nodes.extras.push(hum);
    }
    if (name === 'forest') scheduleBirdsong(nodes);
    if (name === 'fireplace') scheduleFireCrackle(nodes);
    soundChannels.set(name, nodes);
    return nodes;
  }

  function scheduleFireCrackle(nodes) {
    const crackle = () => {
      if (nodes.row.querySelector('.sound-toggle').getAttribute('aria-pressed') !== 'true') return;
      const now = audioContext.currentTime;
      const oscillator = audioContext.createOscillator();
      const envelope = audioContext.createGain();
      const duration = .035 + Math.random() * .08;
      oscillator.type = 'triangle';
      oscillator.frequency.value = 100 + Math.random() * 260;
      envelope.gain.setValueAtTime(.0001, now);
      envelope.gain.exponentialRampToValueAtTime(.035, now + .008);
      envelope.gain.exponentialRampToValueAtTime(.0001, now + duration);
      oscillator.connect(envelope).connect(nodes.channelGain);
      oscillator.start(now);
      oscillator.stop(now + duration + .01);
      nodes.timers.push(window.setTimeout(crackle, 300 + Math.random() * 1000));
    };
    nodes.timers.push(window.setTimeout(crackle, 450));
  }

  function scheduleBirdsong(nodes) {
    const chirp = () => {
      if (nodes.row.querySelector('.sound-toggle').getAttribute('aria-pressed') !== 'true') return;
      const now = audioContext.currentTime;
      const oscillator = audioContext.createOscillator();
      const envelope = audioContext.createGain();
      oscillator.type = 'sine';
      oscillator.frequency.setValueAtTime(1800 + Math.random() * 500, now);
      oscillator.frequency.exponentialRampToValueAtTime(2500 + Math.random() * 600, now + .12);
      oscillator.frequency.exponentialRampToValueAtTime(1500 + Math.random() * 500, now + .28);
      envelope.gain.setValueAtTime(.0001, now);
      envelope.gain.exponentialRampToValueAtTime(.035, now + .04);
      envelope.gain.exponentialRampToValueAtTime(.0001, now + .3);
      oscillator.connect(envelope).connect(nodes.channelGain);
      oscillator.start(now);
      oscillator.stop(now + .32);
      nodes.timers.push(window.setTimeout(chirp, 1800 + Math.random() * 2600));
    };
    nodes.timers.push(window.setTimeout(chirp, 900));
  }

  function stopSound(name) {
    const nodes = soundChannels.get(name);
    if (!nodes) return;
    nodes.timers.forEach(clearTimeout);
    nodes.extras.forEach(node => { try { node.stop(); } catch { /* Already stopped. */ } });
    try { nodes.source.stop(); } catch { /* Already stopped. */ }
    soundChannels.delete(name);
  }

  function openLocalSongDatabase() {
    if (!('indexedDB' in window)) return Promise.reject(new Error('IndexedDB is unavailable.'));
    if (!localSongDatabasePromise) {
      localSongDatabasePromise = new Promise((resolve, reject) => {
        const request = window.indexedDB.open('focusspace-local-songs', 2);
        request.onupgradeneeded = () => {
          const database = request.result;
          if (!database.objectStoreNames.contains('songs')) database.createObjectStore('songs', { keyPath: 'id' });
          if (!database.objectStoreNames.contains('taskDocuments')) database.createObjectStore('taskDocuments', { keyPath: 'id' });
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error || new Error('Could not open song storage.'));
      });
    }
    return localSongDatabasePromise;
  }

  async function readLocalSongs() {
    const database = await openLocalSongDatabase();
    return new Promise((resolve, reject) => {
      const request = database.transaction('songs', 'readonly').objectStore('songs').getAll();
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error('Could not read saved songs.'));
    });
  }

  async function storeLocalSong(song) {
    const database = await openLocalSongDatabase();
    return new Promise((resolve, reject) => {
      const transaction = database.transaction('songs', 'readwrite');
      transaction.objectStore('songs').put(song);
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error || new Error('Could not save this song.'));
      transaction.onabort = () => reject(transaction.error || new Error('Song storage was interrupted.'));
    });
  }

  async function deleteLocalSong(id) {
    const database = await openLocalSongDatabase();
    return new Promise((resolve, reject) => {
      const transaction = database.transaction('songs', 'readwrite');
      transaction.objectStore('songs').delete(id);
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error || new Error('Could not remove this song.'));
    });
  }

  async function readTaskDocuments() {
    const database = await openLocalSongDatabase();
    return new Promise((resolve, reject) => {
      const request = database.transaction('taskDocuments', 'readonly').objectStore('taskDocuments').getAll();
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error('Could not read task documents.'));
    });
  }

  async function storeTaskDocument(attachment) {
    const database = await openLocalSongDatabase();
    return new Promise((resolve, reject) => {
      const transaction = database.transaction('taskDocuments', 'readwrite');
      transaction.objectStore('taskDocuments').put(attachment);
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error || new Error('Could not save the task document.'));
      transaction.onabort = () => reject(transaction.error || new Error('Document storage was interrupted.'));
    });
  }

  async function deleteTaskDocument(id) {
    const database = await openLocalSongDatabase();
    return new Promise((resolve, reject) => {
      const transaction = database.transaction('taskDocuments', 'readwrite');
      transaction.objectStore('taskDocuments').delete(id);
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error || new Error('Could not remove the task document.'));
    });
  }

  async function deleteTaskDocuments(taskId) {
    const attachments = await readTaskDocuments();
    await Promise.all(attachments.filter(attachment => attachment.taskId === taskId).map(attachment => deleteTaskDocument(attachment.id)));
  }

  async function restoreTaskDocuments() {
    try {
      const attachments = await readTaskDocuments();
      const taskIds = new Set(tasks.map(task => task.id));
      taskAttachments = attachments.filter(attachment => taskIds.has(attachment.taskId));
      const orphaned = attachments.filter(attachment => !taskIds.has(attachment.taskId));
      await Promise.all(orphaned.map(attachment => deleteTaskDocument(attachment.id)));
      renderTasks();
    } catch {
      showToast('Saved task documents could not be loaded.');
    }
  }

  function formatFileSize(size) {
    if (size < 1024 * 1024) return `${Math.max(1, Math.round(size / 1024))} KB`;
    return `${(size / (1024 * 1024)).toFixed(1)} MB`;
  }

  function localSongId() {
    return window.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  }

  function addLocalSongRow(song) {
    const soundList = $('.sound-list');
    if ($$('.sound-row-local', soundList).some(row => row.dataset.localSongId === song.id)) return;
    const row = document.createElement('div');
    row.className = 'sound-row sound-row-custom sound-row-local';
    row.dataset.localSongId = song.id;

    const icon = document.createElement('span');
    icon.className = 'sound-emoji';
    icon.setAttribute('aria-hidden', 'true');
    icon.textContent = '♫';
    const label = document.createElement('span');
    label.className = 'sound-name';
    label.append(document.createTextNode(song.name));
    const subtitle = document.createElement('small');
    subtitle.textContent = `From your computer · ${formatFileSize(song.blob.size)}`;
    label.append(subtitle);

    const toggle = document.createElement('button');
    toggle.className = 'sound-toggle';
    toggle.type = 'button';
    toggle.textContent = '▶';
    toggle.setAttribute('aria-label', `Play ${song.name}`);
    toggle.setAttribute('aria-pressed', 'false');
    const volumeLabel = document.createElement('label');
    volumeLabel.className = 'visually-hidden';
    volumeLabel.htmlFor = `volume-local-${song.id}`;
    volumeLabel.textContent = `${song.name} volume`;
    const volume = document.createElement('input');
    volume.className = 'volume-slider';
    volume.id = `volume-local-${song.id}`;
    volume.type = 'range';
    volume.min = '0';
    volume.max = '100';
    volume.value = String(clamp(readStorage(STORAGE_KEYS.sound, {})[`local:${song.id}`] ?? 70, 0, 100));
    volume.setAttribute('aria-label', `${song.name} volume`);

    const removeButton = document.createElement('button');
    removeButton.className = 'sound-remove';
    removeButton.type = 'button';
    removeButton.textContent = '×';
    removeButton.title = `Remove ${song.name}`;
    removeButton.setAttribute('aria-label', `Remove ${song.name}`);
    row.append(icon, label, toggle, volumeLabel, volume, removeButton);
    $('.sound-list').append(row);

    const objectUrl = URL.createObjectURL(song.blob);
    const player = new Audio(objectUrl);
    player.preload = 'metadata';
    player.volume = Number(volume.value) / 100;
    localSongPlayers.set(song.id, { player, objectUrl, row });

    const syncButton = playing => {
      toggle.textContent = playing ? 'Ⅱ' : '▶';
      toggle.setAttribute('aria-pressed', String(playing));
      toggle.setAttribute('aria-label', `${playing ? 'Pause' : 'Play'} ${song.name}`);
    };
    toggle.addEventListener('click', async () => {
      if (toggle.disabled) return;
      toggle.disabled = true;
      try {
        if (player.paused) {
          await player.play();
          syncButton(true);
        } else {
          player.pause();
          syncButton(false);
        }
      } catch {
        showToast(`Unable to play “${song.name}” in this browser.`);
      } finally {
        toggle.disabled = false;
      }
    });
    player.addEventListener('ended', () => syncButton(false));
    player.addEventListener('error', () => {
      syncButton(false);
      showToast(`This audio file could not be read: “${song.name}”.`);
    });
    volume.addEventListener('input', () => {
      player.volume = Number(volume.value) / 100;
      const preferences = readStorage(STORAGE_KEYS.sound, {});
      preferences[`local:${song.id}`] = Number(volume.value);
      writeStorage(STORAGE_KEYS.sound, preferences);
    });
    removeButton.addEventListener('click', () => {
      player.pause();
      URL.revokeObjectURL(objectUrl);
      localSongPlayers.delete(song.id);
      row.remove();
      const preferences = readStorage(STORAGE_KEYS.sound, {});
      delete preferences[`local:${song.id}`];
      writeStorage(STORAGE_KEYS.sound, preferences);
      deleteLocalSong(song.id).catch(() => showToast('Could not remove the saved audio file.'));
    });
  }

  function setupLocalSongPicker() {
    const input = $('#local-song-input');
    $('#add-song-button').addEventListener('click', () => input.click());
    input.addEventListener('change', async () => {
      const files = [...input.files];
      input.value = '';
      for (const file of files) {
        const extension = file.name.split('.').pop().toLowerCase();
        if (!file.type.startsWith('audio/') && !['mp3', 'wav', 'ogg', 'm4a', 'aac', 'flac', 'opus', 'webm'].includes(extension)) {
          showToast(`“${file.name}” is not a supported audio file.`);
          continue;
        }
        const song = { id: localSongId(), name: file.name, type: file.type, blob: file };
        try {
          await storeLocalSong(song);
          addLocalSongRow(song);
          showToast(`${song.name} added to your soundboard.`);
        } catch {
          addLocalSongRow(song);
          showToast(`${song.name} is available until this tab closes; browser storage was unavailable.`);
        }
      }
    });
    readLocalSongs().then(songs => songs.forEach(addLocalSongRow)).catch(() => {});
  }

  function setSoundButton(row, playing, name) {
    const button = $('.sound-toggle', row);
    button.textContent = playing ? 'Ⅱ' : '▶';
    button.setAttribute('aria-pressed', String(playing));
    button.setAttribute('aria-label', `${playing ? 'Pause' : 'Play'} ${SOUND_PROFILES[name].title.toLowerCase()} ambience`);
  }

  function bindSoundChannel(row) {
    const name = row.dataset.sound;
    const volume = $(`#volume-${name}`);
    const savedSound = readStorage(STORAGE_KEYS.sound, {});
    volume.value = String(savedSound[name] === undefined ? Number(volume.value) : clamp(savedSound[name], 0, 100));
    const button = $('.sound-toggle', row);
    button.addEventListener('click', async () => {
      if (button.disabled) return;
      button.disabled = true;
      try {
        await ensureAudioContext();
        const playing = button.getAttribute('aria-pressed') === 'true';
        if (playing) stopSound(name);
        else buildSound(name, row);
        setSoundButton(row, !playing, name);
      } catch {
        showToast('Ambient sound is not supported by this browser.');
      } finally {
        button.disabled = false;
      }
    });
    volume.addEventListener('input', () => {
      const preferences = readStorage(STORAGE_KEYS.sound, {});
      preferences[name] = Number(volume.value);
      writeStorage(STORAGE_KEYS.sound, preferences);
      const channel = soundChannels.get(name);
      if (channel) channel.channelGain.gain.setTargetAtTime(Number(volume.value) / 100 * .25, audioContext.currentTime, .04);
    });
    const removeButton = $('.sound-remove', row);
    if (removeButton) {
      removeButton.addEventListener('click', () => {
        if (DEFAULT_SOUND_IDS.includes(name)) {
          deleteDefaultSound(name, row);
          return;
        }
        stopSound(name);
        const preferences = readStorage(STORAGE_KEYS.sound, {});
        delete preferences[name];
        writeStorage(STORAGE_KEYS.sound, preferences);
        const customSounds = readStorage(STORAGE_KEYS.customSounds, []).filter(id => id !== name);
        writeStorage(STORAGE_KEYS.customSounds, customSounds);
        row.remove();
        renderSoundPicker();
      });
    }
  }

  function deleteDefaultSound(name, row) {
    if (!DEFAULT_SOUND_IDS.includes(name)) return;
    stopSound(name);
    const removedDefaults = readStorage(STORAGE_KEYS.removedDefaultSounds, []);
    const savedRemovals = Array.isArray(removedDefaults) ? removedDefaults : [];
    if (!savedRemovals.includes(name)) savedRemovals.push(name);
    writeStorage(STORAGE_KEYS.removedDefaultSounds, savedRemovals);
    const preferences = readStorage(STORAGE_KEYS.sound, {});
    delete preferences[name];
    writeStorage(STORAGE_KEYS.sound, preferences);
    row.hidden = true;
    updateRestoreDefaultsButton();
  }

  function updateRestoreDefaultsButton() {
    const removedDefaults = readStorage(STORAGE_KEYS.removedDefaultSounds, []);
    $('#restore-default-sounds').hidden = !Array.isArray(removedDefaults) || removedDefaults.length === 0;
  }

  function createExtraSoundRow(name) {
    const profile = SOUND_PROFILES[name];
    const row = document.createElement('div');
    row.className = 'sound-row sound-row-custom';
    row.dataset.sound = name;

    const icon = document.createElement('span');
    icon.className = 'sound-emoji';
    icon.setAttribute('aria-hidden', 'true');
    icon.textContent = profile.icon;
    const label = document.createElement('span');
    label.className = 'sound-name';
    label.append(document.createTextNode(profile.title));
    const subtitle = document.createElement('small');
    subtitle.textContent = profile.subtitle;
    label.append(subtitle);

    const toggle = document.createElement('button');
    toggle.className = 'sound-toggle';
    toggle.type = 'button';
    toggle.textContent = '▶';
    toggle.setAttribute('aria-label', `Play ${profile.title.toLowerCase()} ambience`);
    toggle.setAttribute('aria-pressed', 'false');
    const volumeLabel = document.createElement('label');
    volumeLabel.className = 'visually-hidden';
    volumeLabel.htmlFor = `volume-${name}`;
    volumeLabel.textContent = `${profile.title} volume`;
    const volume = document.createElement('input');
    volume.className = 'volume-slider';
    volume.id = `volume-${name}`;
    volume.type = 'range';
    volume.min = '0';
    volume.max = '100';
    volume.value = '30';
    volume.setAttribute('aria-label', `${profile.title} volume`);

    const removeButton = document.createElement('button');
    removeButton.className = 'sound-remove';
    removeButton.type = 'button';
    removeButton.textContent = '×';
    removeButton.title = `Remove ${profile.title}`;
    removeButton.setAttribute('aria-label', `Remove ${profile.title}`);
    row.append(icon, label, toggle, volumeLabel, volume, removeButton);
    return row;
  }

  function renderSoundPicker() {
    const picker = $('#sound-preset');
    const confirmButton = $('#confirm-add-sound');
    const addButton = $('#add-sound-button');
    const customSounds = readStorage(STORAGE_KEYS.customSounds, []).filter(id => EXTRA_SOUND_IDS.includes(id));
    const available = EXTRA_SOUND_IDS.filter(id => !customSounds.includes(id));
    picker.replaceChildren();
    if (available.length === 0) {
      const option = document.createElement('option');
      option.value = '';
      option.textContent = 'All extra sounds have been added';
      picker.append(option);
      picker.disabled = true;
      confirmButton.disabled = true;
      addButton.disabled = true;
      addButton.textContent = 'All sounds added';
      return;
    }

    picker.disabled = false;
    confirmButton.disabled = false;
    addButton.disabled = false;
    addButton.textContent = '＋ Add sound';
    for (const id of available) {
      const option = document.createElement('option');
      option.value = id;
      option.textContent = SOUND_PROFILES[id].title;
      picker.append(option);
    }
  }

  function setupSoundboard() {
    const soundList = $('.sound-list');
    const removedDefaults = readStorage(STORAGE_KEYS.removedDefaultSounds, []);
    const savedCustomSounds = readStorage(STORAGE_KEYS.customSounds, []);
    const customSounds = Array.isArray(savedCustomSounds)
      ? [...new Set(savedCustomSounds.filter(id => EXTRA_SOUND_IDS.includes(id)))]
      : [];
    writeStorage(STORAGE_KEYS.customSounds, customSounds);
    $$('.sound-row-default', soundList).forEach(row => {
      row.hidden = Array.isArray(removedDefaults) && removedDefaults.includes(row.dataset.sound);
      bindSoundChannel(row);
    });
    customSounds.forEach(name => {
      const row = createExtraSoundRow(name);
      soundList.append(row);
      bindSoundChannel(row);
    });

    const dialog = $('#sound-dialog');
    $('#add-sound-button').addEventListener('click', () => dialog.showModal());
    $('#close-sound-dialog').addEventListener('click', () => dialog.close());
    $('#cancel-add-sound').addEventListener('click', () => dialog.close());
    $('#restore-default-sounds').addEventListener('click', () => {
      writeStorage(STORAGE_KEYS.removedDefaultSounds, []);
      $$('.sound-row-default', soundList).forEach(row => { row.hidden = false; });
      updateRestoreDefaultsButton();
    });
    $('#add-sound-form').addEventListener('submit', event => {
      event.preventDefault();
      const name = $('#sound-preset').value;
      if (!EXTRA_SOUND_IDS.includes(name) || customSounds.includes(name)) return;
      customSounds.push(name);
      writeStorage(STORAGE_KEYS.customSounds, customSounds);
      const row = createExtraSoundRow(name);
      soundList.append(row);
      bindSoundChannel(row);
      renderSoundPicker();
      dialog.close();
      showToast(`${SOUND_PROFILES[name].title} added to your soundboard.`);
    });
    updateRestoreDefaultsButton();
    renderSoundPicker();
    setupLocalSongPicker();
  }

  function applyTheme(theme) {
    const selected = theme === 'dark' ? 'dark' : 'light';
    document.documentElement.dataset.theme = selected;
    $('.theme-icon').textContent = selected === 'dark' ? '☼' : '☾';
    $('#theme-toggle').setAttribute('aria-label', `Switch to ${selected === 'dark' ? 'light' : 'dark'} theme`);
    document.querySelector('meta[name="theme-color"]').content = selected === 'dark' ? '#202923' : '#f2f3ed';
  }

  function setupSettings() {
    for (const mode of Object.keys(MODE_INFO)) {
      const input = $(`#${mode}-minutes`);
      input.value = String(settings[mode]);
      input.addEventListener('change', () => {
        const limits = mode === 'focus' ? 180 : mode === 'shortBreak' ? 60 : 90;
        settings[mode] = clamp(input.value, 1, limits);
        input.value = String(settings[mode]);
        saveSettings();
        if (activeMode === mode) resetTimer();
        renderTimer();
      });
    }
  }

  function setupTaskForm() {
    $('#task-form').addEventListener('submit', event => {
      event.preventDefault();
      const input = $('#task-input');
      const title = input.value.trim();
      if (!title) return;
      tasks.push({
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        title,
        target: clamp($('#task-target').value, 1, 20),
        completed: 0,
        done: false,
      });
      saveTasks();
      renderTasks();
      input.value = '';
      $('#task-target').value = '1';
      input.focus();
    });
  }

  function initialize() {
    const today = new Date();
    $('#today-label').textContent = today.toLocaleDateString('vi-VN', { weekday: 'short', day: 'numeric', month: 'short' });
    applyTheme(readStorage(STORAGE_KEYS.theme, 'light'));
    $('#theme-toggle').addEventListener('click', () => {
      const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
      applyTheme(next);
      writeStorage(STORAGE_KEYS.theme, next);
    });
    $$('[data-mode]').forEach(button => button.addEventListener('click', () => setMode(button.dataset.mode)));
    startButton.addEventListener('click', startTimer);
    $('#reset-button').addEventListener('click', resetTimer);
    $('#skip-button').addEventListener('click', () => advanceMode(false));
    setupSettings();
    setupTaskForm();
    setupSoundboard();
    renderTasks();
    restoreTaskDocuments();
    renderStats();
    renderTimer();
    updateSessionLabel();
    window.addEventListener('beforeunload', () => {
      soundChannels.forEach((_, name) => stopSound(name));
      localSongPlayers.forEach(({ player, objectUrl }) => {
        player.pause();
        URL.revokeObjectURL(objectUrl);
      });
      taskAttachmentUrls.forEach(url => URL.revokeObjectURL(url));
    });
  }

  initialize();
})();