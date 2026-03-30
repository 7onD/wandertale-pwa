/* ═══════════════════════════════════════════════════════════════
   WanderTale — app.js
   Plain ES2020, no frameworks, no bundler.
═══════════════════════════════════════════════════════════════ */

const API_BASE = window.location.hostname === 'localhost'
  ? 'http://localhost:3000'
  : 'wandertale-backend-production.up.railway.app';

const BACKEND_URL      = `${API_BASE}/narrate`;
const MIN_DISTANCE_M   = 80;   // metres before we fire a new request
const MAX_SESSION_HIST = 20;   // deduplicate last N place names

// ── State ─────────────────────────────────────────────────────────────────────
const state = {
  walking:       false,
  loading:       false,
  watchId:       null,
  lastRequestPos: null,   // { lat, lon } of the last successful API call
  sessionPlaces: [],      // deduplication history (place names)
  audioCtx:      null,
  currentSource: null,    // active AudioBufferSourceNode
  speechUtter:   null,    // active SpeechSynthesisUtterance
  audioPlaying:  false,
};

// ── DOM refs ──────────────────────────────────────────────────────────────────
const mainBtn   = document.getElementById('mainBtn');
const btnIcon   = document.getElementById('btnIcon');
const btnLabel  = document.getElementById('btnLabel');
const statusDot = document.getElementById('statusDot');
const statusTxt = document.getElementById('statusText');
const cardInner = document.getElementById('cardInner');
const sessionStats = document.getElementById('sessionStats');
const statsText    = document.getElementById('statsText');

// ── Service worker registration ───────────────────────────────────────────────
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js').catch((err) => {
      console.warn('SW registration failed:', err);
    });
  });
}

// ── Haversine formula (returns metres) ───────────────────────────────────────
function haversine(lat1, lon1, lat2, lon2) {
  const R   = 6371000; // Earth radius in metres
  const rad = Math.PI / 180;
  const dLat = (lat2 - lat1) * rad;
  const dLon = (lon2 - lon1) * rad;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * rad) * Math.cos(lat2 * rad) *
    Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// ── UI helpers ────────────────────────────────────────────────────────────────
function setStatus(text, mode = 'idle') {
  statusTxt.textContent = text;
  statusDot.className   = 'status-dot';
  if (mode !== 'idle') statusDot.classList.add(mode);
}

function setButtonState(mode) {
  // mode: 'idle' | 'active' | 'loading'
  mainBtn.disabled = false;
  mainBtn.className = 'btn-main';

  if (mode === 'idle') {
    btnIcon.textContent  = '▶';
    btnLabel.textContent = 'Начать прогулку';
  } else if (mode === 'active') {
    mainBtn.classList.add('is-active');
    btnIcon.textContent  = '■';
    btnLabel.textContent = 'Остановить';
  } else if (mode === 'loading') {
    mainBtn.classList.add('is-loading');
    mainBtn.disabled     = true;
    btnIcon.textContent  = '…';
    btnLabel.textContent = 'Загрузка...';
  }
}

function showCard(placeName, narration, types, audioMode) {
  // audioMode: 'api' | 'tts' | 'none'
  const typeLabel = formatType(types);
  const badgeHTML = audioMode === 'api'
    ? `<div class="card-audio-badge">🔊 Аудио</div>`
    : audioMode === 'tts'
    ? `<div class="card-audio-badge is-tts">🔈 Синтез речи</div>`
    : '';

  cardInner.innerHTML = `
    <div class="card-place-name">${escHtml(placeName)}</div>
    ${typeLabel ? `<span class="card-place-type">${escHtml(typeLabel)}</span>` : ''}
    <p class="card-narration">${escHtml(narration)}</p>
    ${badgeHTML}
  `;

  // Trigger fade-in animation
  cardInner.classList.remove('animate');
  void cardInner.offsetWidth; // reflow
  cardInner.classList.add('animate');
}

function showPlaceholder() {
  cardInner.innerHTML = `
    <div class="card-placeholder">
      <span class="card-placeholder-icon">📍</span>
      <p>Здесь появится информация о ближайшем месте</p>
    </div>
  `;
}

function updateStats() {
  const count = state.sessionPlaces.length;
  if (count === 0) {
    sessionStats.hidden = true;
    return;
  }
  sessionStats.hidden  = false;
  statsText.textContent = `Мест за сессию: ${count}`;
}

function formatType(types) {
  if (!types || types.length === 0) return '';
  const labels = {
    museum:              'Музей',
    restaurant:          'Ресторан',
    cafe:                'Кафе',
    park:                'Парк',
    church:              'Церковь',
    bar:                 'Бар',
    store:               'Магазин',
    tourist_attraction:  'Достопримечательность',
    point_of_interest:   'Интересное место',
    establishment:       'Заведение',
    locality:            'Местность',
    sublocality:         'Район',
    transit_station:     'Транспортный узел',
    subway_station:      'Метро',
    train_station:       'Вокзал',
  };
  for (const t of types) {
    if (labels[t]) return labels[t];
  }
  return types[0].replace(/_/g, ' ');
}

function escHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ── Audio helpers ─────────────────────────────────────────────────────────────
function getAudioCtx() {
  if (!state.audioCtx) {
    state.audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  }
  return state.audioCtx;
}

function stopAllAudio() {
  // Stop Web Audio API source
  if (state.currentSource) {
    try { state.currentSource.stop(); } catch (_) {}
    state.currentSource = null;
  }
  // Stop SpeechSynthesis
  if (window.speechSynthesis) {
    window.speechSynthesis.cancel();
  }
  state.speechUtter = null;
  state.audioPlaying = false;
}

function playMp3Buffer(arrayBuffer) {
  return new Promise((resolve, reject) => {
    const ctx = getAudioCtx();

    ctx.decodeAudioData(arrayBuffer, (decoded) => {
      const source = ctx.createBufferSource();
      source.buffer = decoded;
      source.connect(ctx.destination);

      source.onended = () => {
        state.currentSource = null;
        state.audioPlaying  = false;
        resolve();
      };

      state.currentSource = source;
      state.audioPlaying  = true;
      source.start(0);
    }, (err) => {
      state.audioPlaying = false;
      reject(err);
    });
  });
}

function speakText(text) {
  return new Promise((resolve) => {
    if (!window.speechSynthesis) {
      resolve();
      return;
    }

    const utter = new SpeechSynthesisUtterance(text);
    utter.lang  = 'ru-RU';
    utter.rate  = 0.95;
    utter.pitch = 1.0;

    utter.onend   = () => { state.audioPlaying = false; resolve(); };
    utter.onerror = () => { state.audioPlaying = false; resolve(); }; // non-fatal

    state.speechUtter = utter;
    state.audioPlaying = true;
    window.speechSynthesis.speak(utter);
  });
}

// ── Core: fetch narration ─────────────────────────────────────────────────────
async function fetchNarration(lat, lon) {
  state.loading = true;
  setButtonState('loading');
  setStatus('Запрос к серверу...', 'loading');

  let response;
  try {
    response = await fetch(BACKEND_URL, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ lat, lon }),
    });
  } catch (networkErr) {
    state.loading = false;
    setButtonState('active');
    setStatus('Нет связи с сервером. Проверьте интернет-соединение.', 'error');
    return;
  }

  const contentType = response.headers.get('content-type') || '';

  // ── Audio/mpeg response — play via Web Audio API ─────────────────────────
  if (contentType.includes('audio/mpeg')) {
    const placeName = response.headers.get('x-place') || 'Место рядом';

    setStatus(`▶ Воспроизведение: ${placeName}`, 'active');
    setButtonState('active');

    let arrayBuffer;
    try {
      arrayBuffer = await response.arrayBuffer();
    } catch (e) {
      state.loading = false;
      setStatus('Ошибка получения аудио', 'error');
      return;
    }

    // Add to dedup history — use placeholder since we only have the name from header
    addToHistory(placeName);

    // Show card immediately with audio playing badge
    showCard(placeName, '🎧 Аудио воспроизводится...', [], 'api');

    state.loading = false;
    state.lastRequestPos = { lat, lon };
    updateStats();

    // Wait for audio to finish before allowing next request
    await playMp3Buffer(arrayBuffer);

    if (state.walking) {
      setStatus('Идём... GPS активен', 'active');
    }
    return;
  }

  // ── JSON response ─────────────────────────────────────────────────────────
  let data;
  try {
    data = await response.json();
  } catch (e) {
    state.loading = false;
    setButtonState('active');
    setStatus('Неожиданный ответ от сервера', 'error');
    return;
  }

  // Hard error from server
  if (data.error === true) {
    state.loading = false;
    setButtonState('active');
    setStatus(`Ошибка сервиса: ${data.failed_service} — ${data.message}`, 'error');
    return;
  }

  // Successful JSON (SpeechKit fallback or normal)
  const placeName  = data.place    || 'Место рядом';
  const narration  = data.narration || '';
  const audioFailed = data.audio === false;

  addToHistory(placeName);
  state.lastRequestPos = { lat, lon };
  state.loading = false;
  updateStats();

  const audioMode = audioFailed ? 'tts' : 'none';
  showCard(placeName, narration, [], audioMode);

  if (audioFailed) {
    setStatus(`▶ Синтез речи: ${placeName}`, 'active');
    setButtonState('active');
    await speakText(narration);
  } else {
    setStatus(`📍 ${placeName}`, 'active');
    setButtonState('active');
  }

  if (state.walking) {
    setStatus('Идём... GPS активен', 'active');
  }
}

// ── Deduplication ─────────────────────────────────────────────────────────────
function addToHistory(placeName) {
  state.sessionPlaces.push(placeName);
  if (state.sessionPlaces.length > MAX_SESSION_HIST) {
    state.sessionPlaces.shift();
  }
}

function isPlaceSeen(placeName) {
  return state.sessionPlaces.includes(placeName);
}

// ── GPS position handler ──────────────────────────────────────────────────────
function onPosition(pos) {
  const { latitude: lat, longitude: lon } = pos.coords;

  // Don't fire if audio is still playing or another request is in flight
  if (state.loading || state.audioPlaying) return;

  // Check minimum distance from last request
  if (state.lastRequestPos) {
    const dist = haversine(
      state.lastRequestPos.lat,
      state.lastRequestPos.lon,
      lat,
      lon
    );
    if (dist < MIN_DISTANCE_M) return;
  }

  fetchNarration(lat, lon);
}

function onPositionError(err) {
  let msg;
  switch (err.code) {
    case err.PERMISSION_DENIED:
      msg = 'Доступ к геолокации запрещён. Разрешите в настройках браузера.';
      break;
    case err.POSITION_UNAVAILABLE:
      msg = 'Геолокация недоступна. Проверьте GPS.';
      break;
    case err.TIMEOUT:
      msg = 'Время ожидания геолокации истекло.';
      break;
    default:
      msg = 'Неизвестная ошибка геолокации.';
  }
  setStatus(msg, 'error');
  setButtonState('idle');
  state.walking = false;
  state.watchId = null;
}

// ── Toggle walk (main button) ─────────────────────────────────────────────────
function toggleWalk() {
  if (state.walking) {
    stopWalk();
  } else {
    startWalk();
  }
}

function startWalk() {
  if (!('geolocation' in navigator)) {
    setStatus('Геолокация не поддерживается этим браузером.', 'error');
    return;
  }

  setStatus('Получение координат...', 'loading');
  setButtonState('loading');

  state.walkId = navigator.geolocation.watchPosition(
    onPosition,
    onPositionError,
    {
      enableHighAccuracy: true,
      maximumAge:         10000,
      timeout:            15000,
    }
  );

  state.walking = true;
  state.watchId = state.walkId;
  setButtonState('active');
  setStatus('GPS активен. Начните движение...', 'active');
}

function stopWalk() {
  if (state.watchId !== null) {
    navigator.geolocation.clearWatch(state.watchId);
    state.watchId = null;
  }

  stopAllAudio();

  state.walking        = false;
  state.loading        = false;
  state.lastRequestPos = null;
  state.sessionPlaces  = [];

  setButtonState('idle');
  setStatus('Прогулка остановлена', 'idle');
  showPlaceholder();

  sessionStats.hidden = true;
}
