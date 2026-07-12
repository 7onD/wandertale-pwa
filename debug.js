/* ═══════════════════════════════════════════════════════════════
   WanderTale — debug.js
   Debug mode: fake GPS via map click, no real geolocation.
═══════════════════════════════════════════════════════════════ */

const API_BASE = window.location.hostname === 'localhost'
  ? 'http://localhost:3000'
  : 'https://wandertale-backend-production.up.railway.app';

const BACKEND_URL = `${API_BASE}/narrate`;

// ── Debug logger ──────────────────────────────────────────────────────────────
function dbg(msg) {
  console.log(msg);
  const el = document.getElementById('debug-log');
  if (el) {
    const line = document.createElement('div');
    line.textContent = new Date().toLocaleTimeString() + ' — ' + msg;
    el.prepend(line);
  }
}

dbg('Debug mode. API_BASE: ' + API_BASE);
const MIN_DISTANCE_M   = 80;
const MAX_SESSION_HIST = 20;

// ── Fake GPS state ────────────────────────────────────────────────────────────
let fakePos = { lat: 59.9386, lon: 30.3141 }; // Saint Petersburg centre

// ── State ─────────────────────────────────────────────────────────────────────
const state = {
  walking:        false,
  loading:        false,
  pollInterval:   null,
  lastRequestPos: null,
  sessionPlaces:  [],
  currentAudio:   null,
  lastNarration:  '',
  speechUtter:    null,
  audioPlaying:   false,
};

// ── DOM refs ──────────────────────────────────────────────────────────────────
const mainBtn      = document.getElementById('mainBtn');
const btnIcon      = document.getElementById('btnIcon');
const btnLabel     = document.getElementById('btnLabel');
const statusDot    = document.getElementById('statusDot');
const statusTxt    = document.getElementById('statusText');
const cardInner    = document.getElementById('cardInner');
const sessionStats = document.getElementById('sessionStats');
const statsText    = document.getElementById('statsText');

// ── Map ───────────────────────────────────────────────────────────────────────
const userIcon = L.divIcon({
  className: '',
  html: '<div style="width:14px;height:14px;background:#3b82f6;border:2px solid white;border-radius:50%;box-shadow:0 0 8px #3b82f6"></div>',
  iconSize: [14, 14],
  iconAnchor: [7, 7],
});

const placeIcon = L.divIcon({
  className: '',
  html: '<div style="width:12px;height:12px;background:#ef4444;border:2px solid white;border-radius:50%;box-shadow:0 0 6px #ef4444"></div>',
  iconSize: [12, 12],
  iconAnchor: [6, 6],
});

const startIcon = L.divIcon({
  className: '',
  html: '<div style="width:16px;height:16px;background:#22c55e;border:2px solid white;border-radius:50%;box-shadow:0 0 8px #22c55e"></div>',
  iconSize: [16, 16],
  iconAnchor: [8, 8],
});

const endIcon = L.divIcon({
  className: '',
  html: '<div style="width:16px;height:16px;background:#a855f7;border:2px solid white;border-radius:50%;box-shadow:0 0 8px #a855f7"></div>',
  iconSize: [16, 16],
  iconAnchor: [8, 8],
});

const map = L.map('map', { zoomControl: true, attributionControl: false });
L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
  maxZoom: 19,
}).addTo(map);
map.setView([fakePos.lat, fakePos.lon], 14);

let userMarker  = null;
let placeMarker = null;

// Place initial user marker at default fakePos
userMarker = L.marker([fakePos.lat, fakePos.lon], { icon: userIcon })
  .addTo(map)
  .bindTooltip('Фейковая позиция', { permanent: false, direction: 'top' });

// ── Mode & route-simulation state ───────────────────────────────────────────
let debugMode = 'route'; // 'route' | 'point'
const WALK_SPEED_MPS = 1.4; // ~5 km/h, average human walking speed
let speedMultiplier = 20;

const routeState = {
  pointA:        null,
  pointB:        null,
  markerA:       null,
  markerB:       null,
  coords:        [],   // [{lat, lon}] from OSRM
  cumDist:       [],   // cumulative distance (m) up to point i
  totalDist:     0,
  polyline:      null,
  walkingMarker: null,
  traveled:      0,
  timer:         null,
  lastTick:      null,
  active:        false,
};

const modeToggle    = document.getElementById('modeToggle');
const routeControls = document.getElementById('routeControls');
const speedSelect    = document.getElementById('speedSelect');

// ── Map click → route mode branches to route/point handling ────────────────
map.on('click', (e) => {
  const { lat, lng } = e.latlng;
  if (debugMode === 'route') {
    handleRouteClick(lat, lng);
  } else {
    handlePointClick(lat, lng);
  }
});

function handlePointClick(lat, lng) {
  fakePos = { lat, lon: lng };
  dbg('📍 Fake GPS set: ' + lat.toFixed(4) + ', ' + lng.toFixed(4));

  if (userMarker) {
    userMarker.setLatLng([lat, lng]);
  } else {
    userMarker = L.marker([lat, lng], { icon: userIcon }).addTo(map);
  }
  map.setView([lat, lng], map.getZoom());

  if (state.walking && !state.loading && !state.audioPlaying) {
    onPositionUpdate(lat, lng);
  }
}

function handleRouteClick(lat, lng) {
  if (routeState.active) {
    dbg('Симуляция маршрута активна — нажмите «Очистить маршрут», чтобы начать заново');
    return;
  }
  if (!routeState.pointA) {
    routeState.pointA = { lat, lon: lng };
    if (routeState.markerA) routeState.markerA.remove();
    routeState.markerA = L.marker([lat, lng], { icon: startIcon })
      .addTo(map)
      .bindTooltip('Старт (А)', { permanent: true, direction: 'top' });
    setStatus('Точка А задана. Нажмите вторую точку (Б) маршрута.', 'active');
    dbg('Точка А: ' + lat.toFixed(4) + ', ' + lng.toFixed(4));
  } else if (!routeState.pointB) {
    routeState.pointB = { lat, lon: lng };
    if (routeState.markerB) routeState.markerB.remove();
    routeState.markerB = L.marker([lat, lng], { icon: endIcon })
      .addTo(map)
      .bindTooltip('Финиш (Б)', { permanent: true, direction: 'top' });
    dbg('Точка Б: ' + lat.toFixed(4) + ', ' + lng.toFixed(4));
    buildAndStartRoute();
  }
}

// ── Route building (OSRM) + walking simulation ──────────────────────────────
async function buildAndStartRoute() {
  setStatus('Построение маршрута...', 'loading');
  dbg('→ Запрос маршрута к OSRM...');

  const a = routeState.pointA;
  const b = routeState.pointB;
  const url = `https://router.project-osrm.org/route/v1/foot/${a.lon},${a.lat};${b.lon},${b.lat}?overview=full&geometries=geojson`;

  let data;
  try {
    const resp = await fetch(url);
    data = await resp.json();
  } catch (err) {
    dbg('Ошибка OSRM: ' + err.message);
    setStatus('Не удалось построить маршрут (OSRM недоступен)', 'error');
    return;
  }

  if (!data.routes || !data.routes.length) {
    dbg('OSRM: маршрут не найден');
    setStatus('Маршрут между точками не найден', 'error');
    return;
  }

  const route  = data.routes[0];
  const coords = route.geometry.coordinates.map(([lon, lat]) => ({ lat, lon }));

  const cum = [0];
  for (let i = 1; i < coords.length; i++) {
    cum.push(cum[i - 1] + haversine(coords[i - 1].lat, coords[i - 1].lon, coords[i].lat, coords[i].lon));
  }

  routeState.coords    = coords;
  routeState.cumDist   = cum;
  routeState.totalDist = route.distance;

  if (routeState.polyline) routeState.polyline.remove();
  routeState.polyline = L.polyline(coords.map(c => [c.lat, c.lon]), {
    color: '#3b82f6', weight: 4, opacity: 0.8,
  }).addTo(map);
  map.fitBounds(routeState.polyline.getBounds(), { padding: [30, 30] });

  const distKm = (routeState.totalDist / 1000).toFixed(2);
  const etaMin = Math.round(routeState.totalDist / WALK_SPEED_MPS / 60);
  dbg(`Маршрут построен: ${distKm} км, ~${etaMin} мин пешком`);

  startRouteSimulation();
}

function startRouteSimulation() {
  routeState.traveled = 0;
  routeState.active   = true;
  routeState.lastTick = performance.now();

  state.lastRequestPos = null;
  state.sessionPlaces  = [];
  updateStats();

  if (routeState.walkingMarker) routeState.walkingMarker.remove();
  if (userMarker) { userMarker.remove(); userMarker = null; }

  const start = routeState.coords[0];
  routeState.walkingMarker = L.marker([start.lat, start.lon], { icon: userIcon })
    .addTo(map)
    .bindTooltip('Симуляция ходьбы', { permanent: false, direction: 'top' });

  dbg('▶ Симуляция ходьбы запущена (x' + speedMultiplier + ')');
  routeState.timer = setInterval(routeTick, 200);
}

function routeTick() {
  const now = performance.now();
  const dt  = (now - routeState.lastTick) / 1000;
  routeState.lastTick = now;

  routeState.traveled += WALK_SPEED_MPS * speedMultiplier * dt;

  if (routeState.traveled >= routeState.totalDist) {
    const last = routeState.coords[routeState.coords.length - 1];
    routeState.walkingMarker.setLatLng([last.lat, last.lon]);
    fakePos = last;
    onPositionUpdate(last.lat, last.lon);
    finishRoute();
    return;
  }

  const pos = interpolateRoutePosition(routeState.traveled);
  routeState.walkingMarker.setLatLng([pos.lat, pos.lon]);
  fakePos = pos;

  onPositionUpdate(pos.lat, pos.lon);

  if (!state.loading && !state.audioPlaying) {
    const pct = Math.round((routeState.traveled / routeState.totalDist) * 100);
    setStatus(`Симуляция маршрута: ${pct}%`, 'active');
  }
}

function interpolateRoutePosition(dist) {
  const cum = routeState.cumDist;
  let i = 1;
  while (i < cum.length && cum[i] < dist) i++;
  if (i >= cum.length) return routeState.coords[routeState.coords.length - 1];

  const segStart = cum[i - 1];
  const segEnd   = cum[i];
  const t = segEnd === segStart ? 0 : (dist - segStart) / (segEnd - segStart);
  const p1 = routeState.coords[i - 1];
  const p2 = routeState.coords[i];
  return {
    lat: p1.lat + (p2.lat - p1.lat) * t,
    lon: p1.lon + (p2.lon - p1.lon) * t,
  };
}

function finishRoute() {
  if (routeState.timer) clearInterval(routeState.timer);
  routeState.timer   = null;
  routeState.active  = false;
  dbg('Маршрут завершён');
  setStatus('Маршрут завершён. Нажмите «Очистить маршрут» для нового.', 'idle');
}

function clearRoute() {
  if (routeState.timer) clearInterval(routeState.timer);
  stopAllAudio();

  if (routeState.markerA)       routeState.markerA.remove();
  if (routeState.markerB)       routeState.markerB.remove();
  if (routeState.polyline)      routeState.polyline.remove();
  if (routeState.walkingMarker) routeState.walkingMarker.remove();

  routeState.pointA        = null;
  routeState.pointB        = null;
  routeState.markerA       = null;
  routeState.markerB       = null;
  routeState.polyline      = null;
  routeState.walkingMarker = null;
  routeState.coords        = [];
  routeState.cumDist       = [];
  routeState.totalDist     = 0;
  routeState.traveled      = 0;
  routeState.timer         = null;
  routeState.active        = false;

  if (placeMarker) { placeMarker.remove(); placeMarker = null; }
  if (!userMarker) {
    userMarker = L.marker([fakePos.lat, fakePos.lon], { icon: userIcon }).addTo(map);
  }

  state.lastRequestPos = null;
  state.sessionPlaces  = [];
  updateStats();
  showPlaceholder();
  setStatus('Нажмите на карту, чтобы выбрать точку А маршрута', 'idle');
}

function setMode(mode) {
  if (routeState.active || state.walking) {
    dbg('Сначала остановите текущую симуляцию, затем меняйте режим');
    return;
  }
  debugMode = mode;
  document.querySelectorAll('.mode-btn').forEach(b => {
    b.classList.toggle('is-active', b.dataset.mode === mode);
  });
  routeControls.hidden = mode !== 'route';
  mainBtn.hidden        = mode !== 'point';

  clearRoute();
  if (mode === 'point') {
    setStatus('Нажмите на карту, чтобы выбрать точку', 'idle');
  }
}

function onSpeedChange() {
  speedMultiplier = Number(speedSelect.value);
  dbg('Множитель скорости симуляции: x' + speedMultiplier);
}

// ── Haversine formula (returns metres) ───────────────────────────────────────
function haversine(lat1, lon1, lat2, lon2) {
  const R   = 6371000;
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
  mainBtn.disabled  = false;
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
  cardInner.classList.remove('animate');
  void cardInner.offsetWidth;
  cardInner.classList.add('animate');
}

function showPlaceholder() {
  cardInner.innerHTML = `
    <div class="card-placeholder">
      <span class="card-placeholder-icon">📍</span>
      <p>Нажмите на карту для симуляции GPS-координат</p>
    </div>
  `;
}

function updateStats() {
  const count = state.sessionPlaces.length;
  if (count === 0) { sessionStats.hidden = true; return; }
  sessionStats.hidden   = false;
  statsText.textContent = `Мест за сессию: ${count}`;
}

function formatType(types) {
  if (!types || types.length === 0) return '';
  const labels = {
    museum:             'Музей',
    restaurant:         'Ресторан',
    cafe:               'Кафе',
    park:               'Парк',
    church:             'Церковь',
    bar:                'Бар',
    store:              'Магазин',
    tourist_attraction: 'Достопримечательность',
    point_of_interest:  'Интересное место',
    establishment:      'Заведение',
    locality:           'Местность',
    sublocality:        'Район',
    transit_station:    'Транспортный узел',
    subway_station:     'Метро',
    train_station:      'Вокзал',
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
function stopAllAudio() {
  if (state.currentAudio) {
    state.currentAudio.pause();
    state.currentAudio = null;
  }
  if (window.speechSynthesis) window.speechSynthesis.cancel();
  state.speechUtter  = null;
  state.audioPlaying = false;
}

async function playAudioBuffer(arrayBuffer) {
  try {
    if (state.currentAudio) {
      state.currentAudio.pause();
      state.currentAudio = null;
    }
    const blob  = new Blob([arrayBuffer], { type: 'audio/mpeg' });
    const url   = URL.createObjectURL(blob);
    const audio = new Audio(url);
    audio.volume = 1.0;
    state.currentAudio = audio;
    audio.onended = () => {
      state.audioPlaying = false;
      URL.revokeObjectURL(url);
      dbg('Audio finished');
    };
    audio.onerror = (e) => {
      dbg('Audio element error: ' + (e.message || 'unknown'));
      state.audioPlaying = false;
    };
    await audio.play();
    state.audioPlaying = true;
  } catch (err) {
    dbg('Audio play failed: ' + err.name + ': ' + err.message + ' — fallback to speechSynthesis');
    state.audioPlaying = false;
    const text  = state.lastNarration ? decodeURIComponent(state.lastNarration) : 'Информация о месте';
    const utter = new SpeechSynthesisUtterance(text);
    utter.lang  = 'ru-RU';
    utter.onend = () => { state.audioPlaying = false; };
    speechSynthesis.speak(utter);
    state.audioPlaying = true;
  }
}

function speakText(text) {
  return new Promise((resolve) => {
    if (!window.speechSynthesis) { resolve(); return; }
    const utter   = new SpeechSynthesisUtterance(text);
    utter.lang    = 'ru-RU';
    utter.rate    = 0.95;
    utter.pitch   = 1.0;
    utter.onend   = () => { state.audioPlaying = false; resolve(); };
    utter.onerror = () => { state.audioPlaying = false; resolve(); };
    state.speechUtter  = utter;
    state.audioPlaying = true;
    window.speechSynthesis.speak(utter);
  });
}

// ── Core: fetch narration ─────────────────────────────────────────────────────
async function fetchNarration(lat, lon) {
  state.loading = true;
  setButtonState('loading');
  setStatus('Запрос к серверу...', 'loading');

  dbg('→ Запрос к серверу...');
  let response;
  try {
    response = await fetch(BACKEND_URL, {
      method:      'POST',
      mode:        'cors',
      credentials: 'omit',
      headers:     { 'Content-Type': 'application/json' },
      body:        JSON.stringify({ lat, lon }),
    });
  } catch (networkErr) {
    dbg('Fetch error: ' + networkErr.message);
    state.loading = false;
    setButtonState('active');
    setStatus('Нет связи с сервером.', 'error');
    return;
  }

  dbg('← Ответ: ' + response.status + ' ' + (response.headers.get('content-type') || ''));

  // 204 — no interesting places nearby, skip silently
  if (response.status === 204) {
    state.loading = false;
    setButtonState('active');
    dbg('No POI nearby — skipped');
    if (state.walking) setStatus('Симуляция активна. Нажмите на карту.', 'active');
    return;
  }

  const contentType = response.headers.get('content-type') || '';

  if (contentType.includes('audio/mpeg')) {
    const placeName = decodeURIComponent(response.headers.get('x-place') || 'Место рядом');
    const placeAddr = decodeURIComponent(response.headers.get('x-address') || '—');
    const placeType = decodeURIComponent(response.headers.get('x-type') || '—');
    state.lastNarration = response.headers.get('x-narration') || '';

    dbg('📍 Место: ' + placeName);
    dbg('🏠 Адрес: ' + placeAddr);
    dbg('🏷 Тип: ' + placeType);

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

    addToHistory(placeName);

    if (placeMarker) placeMarker.remove();
    placeMarker = L.marker([lat, lon], { icon: placeIcon })
      .addTo(map)
      .bindTooltip(placeName, { permanent: false, direction: 'top' });

    showCard(placeName, '🎧 Аудио воспроизводится...', [], 'api');
    state.loading = false;
    state.lastRequestPos = { lat, lon };
    updateStats();

    await playAudioBuffer(arrayBuffer);
    if (state.walking) setStatus('Симуляция активна. Нажмите на карту.', 'active');
    return;
  }

  let data;
  try {
    data = await response.json();
  } catch (e) {
    state.loading = false;
    setButtonState('active');
    setStatus('Неожиданный ответ от сервера', 'error');
    return;
  }

  if (data.error === true) {
    state.loading = false;
    setButtonState('active');
    setStatus(`Ошибка сервиса: ${data.failed_service} — ${data.message}`, 'error');
    return;
  }

  const placeName   = data.place     || 'Место рядом';
  const narration   = data.narration || '';
  const audioFailed = data.audio === false;

  if (isPlaceSeen(placeName)) {
    dbg('Skipped (already seen): ' + placeName);
    state.loading = false;
    setButtonState('active');
    if (state.walking) setStatus('Симуляция активна. Нажмите на карту.', 'active');
    return;
  }

  addToHistory(placeName);
  state.lastRequestPos = { lat, lon };
  state.loading = false;
  updateStats();

  if (placeMarker) placeMarker.remove();
  placeMarker = L.marker([lat, lon], { icon: placeIcon })
    .addTo(map)
    .bindTooltip(placeName, { permanent: false, direction: 'top' });

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

  if (state.walking) setStatus('Симуляция активна. Нажмите на карту.', 'active');
}

// ── Deduplication ─────────────────────────────────────────────────────────────
function addToHistory(placeName) {
  state.sessionPlaces.push(placeName);
  if (state.sessionPlaces.length > MAX_SESSION_HIST) state.sessionPlaces.shift();
}

function isPlaceSeen(placeName) {
  return state.sessionPlaces.includes(placeName);
}

// ── Fake GPS position handler ─────────────────────────────────────────────────
function onPositionUpdate(lat, lon) {
  if (state.loading || state.audioPlaying) return;

  if (state.lastRequestPos) {
    const dist = haversine(state.lastRequestPos.lat, state.lastRequestPos.lon, lat, lon);
    if (dist < MIN_DISTANCE_M) return;
  }

  fetchNarration(lat, lon);
}

// ── Fake GPS polling loop ─────────────────────────────────────────────────────
function startGPSPolling() {
  // Fire immediately with current fakePos
  onPositionUpdate(fakePos.lat, fakePos.lon);
  // Then poll every 15s using whatever fakePos is at that time
  state.pollInterval = setInterval(() => {
    onPositionUpdate(fakePos.lat, fakePos.lon);
  }, 15000);
}

function stopGPSPolling() {
  if (state.pollInterval) {
    clearInterval(state.pollInterval);
    state.pollInterval = null;
  }
}

// ── Toggle walk (main button) ─────────────────────────────────────────────────
function toggleWalk() {
  if (state.walking) {
    stopWalk();
  } else {
    startWalk();
  }
}

async function unlockAudio() {
  try {
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtx) return;
    const ctx = new AudioCtx();
    const buf = ctx.createBuffer(1, 1, 22050);
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.connect(ctx.destination);
    src.start(0);
    await ctx.close();
  } catch (e) {
    dbg('ОШИБКА разблокировки аудио: ' + e.message);
  }
}

async function startWalk() {
  await unlockAudio();

  setStatus('Симуляция активна. Нажмите на карту.', 'loading');
  setButtonState('loading');
  dbg('GPS: симуляция запущена (' + fakePos.lat.toFixed(4) + ', ' + fakePos.lon.toFixed(4) + ')');

  state.walking = true;
  setButtonState('active');
  setStatus('Симуляция активна. Нажмите на карту.', 'active');

  startGPSPolling();
}

function stopWalk() {
  stopGPSPolling();
  stopAllAudio();

  state.walking        = false;
  state.loading        = false;
  state.lastRequestPos = null;
  state.sessionPlaces  = [];

  setButtonState('idle');
  setStatus('Симуляция остановлена', 'idle');
  showPlaceholder();

  sessionStats.hidden = true;
}
