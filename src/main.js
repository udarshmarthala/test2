// ============================================================
// main.js — RouteForge: Full Google Maps-style live navigation
// Features: map rotation, route snap, rerouting, voice, lane
//           guidance, speed display, off-route detection,
//           smooth marker, ETA, arrival screen, multi-route
// ============================================================
import { geocodeSearch, reverseGeocode }      from './geocoding.js';
import { LiveTracker, getCurrentPosition }     from './tracker.js';
import {
  getRoute, haversine, calcBearing, snapToPolyline,
  findCurrentStep, distanceRemaining, durationRemaining, isOffRoute,
  formatDistance, formatDuration, formatSpeed, formatETA,
  getManeuverIcon, speak, buildVoiceInstruction,
  GOOGLE_MAPS_API_KEY
} from './routing.js';

const L = window.L;
if (!L) {
  throw new Error('Leaflet failed to load. Check network access to unpkg.com.');
}

// ─────────────────────────────────────────────
// STATE
// ─────────────────────────────────────────────
let map, tileLayer;
let routeLayers    = [];       // array of L.polyline (for alt routes)
let originMarker   = null;
let destMarker     = null;
let userMarker     = null;
let accuracyCircle = null;
let headingCone    = null;     // direction cone SVG overlay

let origin      = null;
let destination = null;
let travelMode  = 'driving';

let allRoutes    = [];         // parsed route options
let activeRoute  = null;       // chosen route
let isNavigating = false;
let navPaused    = false;

let currentStepIdx = 0;
let lastVoiceStepIdx = -1;
let lastVoiceDist    = Infinity;
let rerouteDebounce  = null;
let offRouteSince    = null;

let tracker      = new LiveTracker();
let followUser   = false;
let mapRotate    = false;      // rotate map to heading like Google
let currentHeading = 0;
let compassStatusTimer = null;

let voiceEnabled = true;
let hasKey       = false;

const REROUTE_THRESHOLD_M   = 60;   // meters off-route before rerouting
const REROUTE_DEBOUNCE_MS   = 4000; // wait before triggering reroute
const ARRIVAL_THRESHOLD_M   = 25;   // meters from dest = arrived
const VOICE_EARLY_M         = 600;  // first voice cue
const VOICE_MEDIUM_M        = 200;  // second voice cue
const VOICE_IMMINENT_M      = 40;   // "now" cue

// ─────────────────────────────────────────────
// MAP INIT
// ─────────────────────────────────────────────
function initMap() {
  map = L.map('map', {
    center: [37.7749, -122.4194],
    zoom: 13,
    zoomControl: false,
    attributionControl: true,
  });

  L.control.zoom({ position: 'bottomright' }).addTo(map);

  tileLayer = L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
    attribution: '© <a href="https://www.openstreetmap.org">OSM</a> © <a href="https://carto.com">CARTO</a>',
    subdomains: 'abcd',
    maxZoom: 20,
  }).addTo(map);

  // Click to set origin/destination
  map.on('click', async e => {
    if (isNavigating) return;
    try {
      const place = await reverseGeocode(e.latlng.lat, e.latlng.lng);
      if (!origin) setOrigin(place);
      else if (!destination) setDestination(place);
    } catch {}
  });

  // Manual pan disables follow
  map.on('dragstart', () => { followUser = false; updateRecenterBtn(); });
}

// ─────────────────────────────────────────────
// USER MARKER (directional arrow, Google-style)
// ─────────────────────────────────────────────
function buildUserIcon(heading, isMoving) {
  const h = heading ?? 0;
  return L.divIcon({
    className: '',
    html: `<div class="um-wrap" style="transform:rotate(${h}deg);transition:transform 0.12s linear;">
      <svg class="um-svg ${isMoving ? 'moving' : ''}" viewBox="0 0 48 48" xmlns="http://www.w3.org/2000/svg">
        <!-- Cone of vision -->
        <path d="M24 24 L12 4 A20 20 0 0 1 36 4 Z" fill="rgba(232,255,71,0.18)" />
        <!-- Arrow body -->
        <polygon points="24,6 33,34 24,28 15,34" fill="#e8ff47" stroke="#1a1a00" stroke-width="1.5" stroke-linejoin="round"/>
        <!-- Center dot -->
        <circle cx="24" cy="24" r="5" fill="#fff" stroke="#1a1a00" stroke-width="1.5"/>
      </svg>
    </div>`,
    iconSize:   [48, 48],
    iconAnchor: [24, 24],
  });
}

// Directly mutate the existing marker DOM to rotate — avoids full icon rebuild every frame
function _setMarkerRotation(heading, isMoving) {
  if (!userMarker) return;
  const el = userMarker.getElement();
  if (!el) return;
  const wrap = el.querySelector('.um-wrap');
  const svg  = el.querySelector('.um-svg');
  if (wrap) wrap.style.transform = `rotate(${heading ?? 0}deg)`;
  if (svg)  {
    svg.classList.toggle('moving', !!isMoving);
  }
}

function updateUserMarker(lat, lon, heading, accuracy, speed) {
  const latlng    = [lat, lon];
  const isMoving  = speed != null && speed > 0.5; // > ~1 mph

  if (!userMarker) {
    // First time: create marker with icon (sets up the DOM)
    userMarker = L.marker(latlng, { icon: buildUserIcon(heading, isMoving), zIndexOffset: 2000 }).addTo(map);
  } else {
    // Move position
    userMarker.setLatLng(latlng);
    // Rotate the existing DOM element directly — no icon rebuild, no flicker
    _setMarkerRotation(heading, isMoving);
  }

  // Accuracy halo
  if (accuracy != null) {
    if (!accuracyCircle) {
      accuracyCircle = L.circle(latlng, {
        radius: accuracy, color: '#47d4ff', fillColor: '#47d4ff',
        fillOpacity: 0.07, weight: 1, opacity: 0.35,
      }).addTo(map);
    } else {
      accuracyCircle.setLatLng(latlng).setRadius(accuracy);
    }
  }

  // Map follow + rotate
  if (followUser) {
    if (mapRotate && heading != null) {
      // Rotate map container so heading = up
      rotateMapTo(heading);
      map.panTo(latlng, { animate: true, duration: 0.3 });
    } else {
      map.panTo(latlng, { animate: true, duration: 0.3 });
    }
  }

  // Update mini compass
  currentHeading = heading ?? 0;
  updateCompass(currentHeading);
}

// CSS rotation of the map pane (like Google Maps driving mode)
function rotateMapTo(deg) {
  const pane = map.getPane('mapPane');
  if (pane) pane.style.transform = `rotate(${-deg}deg)`;
  // Counter-rotate UI overlays so they stay upright
  document.getElementById('map-overlay-top').style.transform   = `rotate(${deg}deg)`;
}

function resetMapRotation() {
  const pane = map.getPane('mapPane');
  if (pane) pane.style.transform = '';
  document.getElementById('map-overlay-top').style.transform = '';
}

// ─────────────────────────────────────────────
// COMPASS
// ─────────────────────────────────────────────
function updateCompass(deg) {
  const needle = document.getElementById('compass-needle');
  if (needle) needle.style.transform = `rotate(${deg}deg)`;
  const badge = document.getElementById('compass-badge');
  if (badge) badge.textContent = bearingToCardinal(deg);
}

function bearingToCardinal(deg) {
  const dirs = ['N','NE','E','SE','S','SW','W','NW'];
  return dirs[Math.round(deg / 45) % 8];
}

function updateCompassStatusLabel() {
  const badge = document.getElementById('compass-status');
  if (!badge) return;

  const status = tracker.getCompassStatus();
  badge.classList.remove('available', 'unavailable');

  if (status.available) {
    badge.textContent = 'Compass: Available';
    badge.classList.add('available');
  } else if (!status.supported) {
    badge.textContent = 'Compass: Not available';
    badge.classList.add('unavailable');
  } else {
    badge.textContent = 'Compass: Not available';
    badge.classList.add('unavailable');
  }
}

// ─────────────────────────────────────────────
// PLACE MARKERS
// ─────────────────────────────────────────────
function pinIcon(color, label) {
  return L.divIcon({
    className: '',
    html: `<div class="pin-marker" style="background:${color}"><span>${label}</span></div>`,
    iconSize: [30, 38], iconAnchor: [15, 38],
  });
}

function setOrigin(place) {
  origin = place;
  document.getElementById('origin-input').value = place.name;
  if (originMarker) map.removeLayer(originMarker);
  originMarker = L.marker([place.lat, place.lon], { icon: pinIcon('#47ff8e', 'A') })
    .addTo(map).bindTooltip('Start', { permanent: false });
  map.panTo([place.lat, place.lon]);
  checkReady();
}

function setDestination(place) {
  destination = place;
  document.getElementById('dest-input').value = place.name;
  if (destMarker) map.removeLayer(destMarker);
  destMarker = L.marker([place.lat, place.lon], { icon: pinIcon('#ff4785', 'B') })
    .addTo(map).bindTooltip(place.name, { permanent: false });
  map.panTo([place.lat, place.lon]);
  checkReady();
}

function checkReady() {
  const btn = document.getElementById('route-btn');
  btn.disabled = !(origin && destination && hasKey);
}

// ─────────────────────────────────────────────
// AUTOCOMPLETE
// ─────────────────────────────────────────────
const searchTimers = {};
function setupAutocomplete(inputId, sugId, onSelect) {
  const inp = document.getElementById(inputId);
  const sug = document.getElementById(sugId);
  inp.addEventListener('input', () => {
    clearTimeout(searchTimers[inputId]);
    const q = inp.value.trim();
    if (q.length < 2) { hideSug(sug); return; }
    searchTimers[inputId] = setTimeout(async () => {
      try { showSug(sug, await geocodeSearch(q), place => { onSelect(place); hideSug(sug); }); }
      catch {}
    }, 300);
  });
  inp.addEventListener('keydown', e => {
    if (!sug.classList.contains('active')) return;
    const items = sug.querySelectorAll('.sug-item');
    const hi    = sug.querySelector('.hi');
    let idx     = -1;
    if (hi) items.forEach((el, i) => { if (el === hi) idx = i; });
    if (e.key === 'ArrowDown')  { e.preventDefault(); hi?.classList.remove('hi'); items[Math.min(idx+1, items.length-1)]?.classList.add('hi'); }
    if (e.key === 'ArrowUp')    { e.preventDefault(); hi?.classList.remove('hi'); items[Math.max(idx-1, 0)]?.classList.add('hi'); }
    if (e.key === 'Enter')      { e.preventDefault(); sug.querySelector('.hi')?.click(); }
    if (e.key === 'Escape')     { hideSug(sug); }
  });
  inp.addEventListener('blur', () => setTimeout(() => hideSug(sug), 200));
}

function showSug(el, results, onSelect) {
  el.innerHTML = '';
  if (!results.length) {
    el.innerHTML = '<div class="sug-item muted">No results</div>';
    el.classList.add('active'); return;
  }
  results.forEach(p => {
    const d = document.createElement('div');
    d.className = 'sug-item';
    d.innerHTML = `<div class="sug-main">${p.name}</div><div class="sug-sub">${p.address}</div>`;
    d.addEventListener('mousedown', e => { e.preventDefault(); onSelect(p); });
    el.appendChild(d);
  });
  el.classList.add('active');
}
function hideSug(el) { el.classList.remove('active'); }

// ─────────────────────────────────────────────
// ROUTE CALCULATION
// ─────────────────────────────────────────────
async function calculateRoute() {
  if (!origin || !destination) return;
  setLoadingState(true);

  try {
    // Get 1 primary + up to 3 alternatives
    const routes = await getRoute(origin, destination, travelMode, true);
    allRoutes = routes;
    displayRouteOptions(routes);
    selectRoute(0);
  } catch (err) {
    showToast(err.message || 'Route calculation failed', 'error');
  } finally {
    setLoadingState(false);
  }
}

function displayRouteOptions(routes) {
  // Clear old layers
  routeLayers.forEach(l => map.removeLayer(l));
  routeLayers = [];

  routes.forEach((route, i) => {
    const isMain = i === 0;
    const layer  = L.polyline(route.coords, {
      color:    isMain ? '#e8ff47' : '#5a6a8a',
      weight:   isMain ? 6 : 4,
      opacity:  isMain ? 0.9 : 0.6,
      lineJoin: 'round', lineCap: 'round',
    }).addTo(map);

    layer.on('click', () => selectRoute(i));
    routeLayers.push(layer);
  });

  // Fit to primary route
  const r = routes[0];
  map.fitBounds([[r.bounds.south, r.bounds.west],[r.bounds.north, r.bounds.east]], { padding: [70, 70] });
}

function selectRoute(idx) {
  activeRoute = allRoutes[idx];

  // Style layers
  routeLayers.forEach((l, i) => {
    l.setStyle({ color: i === idx ? '#e8ff47' : '#4a5a78', weight: i === idx ? 6 : 4, opacity: i === idx ? 0.9 : 0.5 });
    if (i === idx) l.bringToFront();
  });

  // Update summary panel
  document.getElementById('stat-distance').textContent = activeRoute.distanceText;
  document.getElementById('stat-duration').textContent = activeRoute.durationText;
  if (activeRoute.summary) document.getElementById('route-summary').textContent = 'via ' + activeRoute.summary;

  // Populate step list
  const list = document.getElementById('steps-list');
  list.innerHTML = '';
  document.getElementById('steps-count').textContent = `${activeRoute.steps.length} STEPS`;
  activeRoute.steps.forEach((step, i) => {
    const li = document.createElement('li');
    li.className = 'step-item';
    li.dataset.stepIdx = i;
    li.style.animationDelay = `${i * 20}ms`;
    li.innerHTML = `
      <div class="step-icon">${getManeuverIcon(step.maneuver)}</div>
      <div class="step-body">
        <div class="step-text">${step.instruction}</div>
        <div class="step-meta">${step.distanceText} · ${step.durationText}</div>
      </div>`;
    li.addEventListener('click', () => map.panTo([step.startLat, step.startLon]));
    list.appendChild(li);
  });

  // Warnings
  if (activeRoute.warnings?.length) {
    showToast(activeRoute.warnings[0], 'warn');
  }

  showPanel('route-info');
}

// ─────────────────────────────────────────────
// LIVE NAVIGATION
// ─────────────────────────────────────────────
function startNavigation() {
  if (!activeRoute) return;
  isNavigating    = true;
  followUser      = true;
  navPaused       = false;
  currentStepIdx  = 0;
  lastVoiceStepIdx = -1;
  lastVoiceDist    = Infinity;
  offRouteSince    = null;

  // Hide planning UI, show nav UI
  showPanel('nav-hud');
  document.getElementById('sidebar').classList.add('nav-mode');
  document.getElementById('recenter-btn').classList.remove('hidden');
  document.getElementById('compass-widget').classList.remove('hidden');
  document.getElementById('compass-status').classList.remove('hidden');
  document.getElementById('rotate-btn').classList.remove('hidden');

  // Dim alt route layers
  routeLayers.forEach((l, i) => { if (allRoutes[i] !== activeRoute) l.setStyle({ opacity: 0.15 }); });

  // Zoom in for navigation
  map.setZoom(17);

  // Voice: announce start
  if (voiceEnabled) speak(`Starting navigation. ${activeRoute.durationText} to your destination.`);

  // Start GPS
  tracker.start(pos => handleNavUpdate(pos), err => showToast(err, 'error'));
  updateCompassStatusLabel();
  compassStatusTimer = setInterval(updateCompassStatusLabel, 500);
}

function stopNavigation(arrived = false) {
  if (!isNavigating) return;
  isNavigating = false;
  followUser   = false;
  tracker.stop();
  if (compassStatusTimer) {
    clearInterval(compassStatusTimer);
    compassStatusTimer = null;
  }

  // Reset map rotation
  mapRotate = false;
  resetMapRotation();
  document.getElementById('rotate-btn').classList.add('active-rotate');
  document.getElementById('rotate-btn').classList.remove('active-rotate');

  // Remove nav overlays
  if (userMarker)     { map.removeLayer(userMarker);     userMarker = null; }
  if (accuracyCircle) { map.removeLayer(accuracyCircle); accuracyCircle = null; }

  document.getElementById('sidebar').classList.remove('nav-mode');
  document.getElementById('recenter-btn').classList.add('hidden');
  document.getElementById('compass-widget').classList.add('hidden');
  document.getElementById('compass-status').classList.add('hidden');
  document.getElementById('rotate-btn').classList.add('hidden');

  if (arrived) {
    showArrivalScreen();
  } else {
    showPanel('route-info');
    if (voiceEnabled) { window.speechSynthesis?.cancel(); }
  }
}

function handleNavUpdate({ lat, lon, heading, speed, accuracy, interpolated }) {
  if (!isNavigating || !activeRoute) return;

  // Snap position to route polyline
  const snapped = snapToPolyline(lat, lon, activeRoute.coords);
  const displayLat = snapped.dist < 40 ? snapped.lat : lat;
  const displayLon = snapped.dist < 40 ? snapped.lon : lon;

  // Update marker
  updateUserMarker(displayLat, displayLon, heading, accuracy, speed);

  // Off-route detection
  if (snapped.dist > REROUTE_THRESHOLD_M) {
    if (!offRouteSince) {
      offRouteSince = Date.now();
      showOffRouteBanner(true);
    } else if (Date.now() - offRouteSince > REROUTE_DEBOUNCE_MS) {
      offRouteSince = null;
      showOffRouteBanner(false);
      triggerReroute(lat, lon);
      return;
    }
  } else {
    if (offRouteSince) { offRouteSince = null; showOffRouteBanner(false); }
  }

  // Step progression
  const newStepIdx = findCurrentStep(lat, lon, activeRoute.steps, currentStepIdx);
  if (newStepIdx !== currentStepIdx) {
    currentStepIdx = newStepIdx;
    highlightStep(currentStepIdx);
  }

  // Distances
  const distRem  = distanceRemaining(lat, lon, activeRoute.steps, currentStepIdx);
  const durRem   = durationRemaining(lat, lon, activeRoute.steps, currentStepIdx);
  const nextStep = activeRoute.steps[Math.min(currentStepIdx + 1, activeRoute.steps.length - 1)];
  const distToNext = nextStep
    ? haversine(lat, lon, nextStep.startLat, nextStep.startLon)
    : haversine(lat, lon, activeRoute.steps[currentStepIdx].endLat, activeRoute.steps[currentStepIdx].endLon);

  // Update HUD
  updateHUD({ speed, distRem, durRem, distToNext, step: activeRoute.steps[currentStepIdx], nextStep });

  // Voice guidance (skip on interpolated frames)
  if (!interpolated) triggerVoice(currentStepIdx, distToNext, nextStep || activeRoute.steps[currentStepIdx]);

  // Arrival check
  const distToDest = haversine(lat, lon,
    activeRoute.steps[activeRoute.steps.length - 1].endLat,
    activeRoute.steps[activeRoute.steps.length - 1].endLon);
  if (distToDest < ARRIVAL_THRESHOLD_M) {
    stopNavigation(true);
  }
}

// ─────────────────────────────────────────────
// HUD UPDATE
// ─────────────────────────────────────────────
function updateHUD({ speed, distRem, durRem, distToNext, step, nextStep }) {
  // Speed
  document.getElementById('hud-speed').textContent      = formatSpeed(speed);
  document.getElementById('hud-speed-unit').textContent = 'MPH';

  // Next maneuver card
  const curStep = nextStep || step;
  document.getElementById('hud-maneuver-icon').textContent  = getManeuverIcon(curStep?.maneuver);
  document.getElementById('hud-maneuver-dist').textContent  = formatDistance(distToNext);
  document.getElementById('hud-maneuver-text').textContent  = curStep?.instruction || '';

  // Street name of next step
  document.getElementById('hud-street').textContent = nextStep?.streetName || step?.streetName || '';

  // Bottom bar
  document.getElementById('hud-eta').textContent       = formatETA(durRem);
  document.getElementById('hud-remaining').textContent = formatDistance(distRem);
  document.getElementById('hud-time-left').textContent = formatDuration(durRem);

  // Distance warning gradient (close = more urgent)
  const urgency = Math.max(0, 1 - distToNext / 300);
  const hue     = Math.round(urgency * 20); // 0=yellow, 20=orange
  document.getElementById('hud-maneuver-icon').style.color = `hsl(${60 - hue*2}, 100%, 55%)`;
}

// ─────────────────────────────────────────────
// VOICE GUIDANCE
// ─────────────────────────────────────────────
function triggerVoice(stepIdx, distToNext, step) {
  if (!voiceEnabled || !step) return;

  const cues = [VOICE_EARLY_M, VOICE_MEDIUM_M, VOICE_IMMINENT_M];

  // Check if we're newly in a cue zone
  for (const cue of cues) {
    if (distToNext <= cue && lastVoiceDist > cue) {
      const text = buildVoiceInstruction(step, distToNext);
      speak(text);
      break;
    }
  }

  // New step announcement
  if (stepIdx !== lastVoiceStepIdx) {
    lastVoiceStepIdx = stepIdx;
    if (stepIdx > 0) speak(`In ${formatDistance(step.distance)}, ${step.instruction}`);
  }

  lastVoiceDist = distToNext;
}

// ─────────────────────────────────────────────
// REROUTING
// ─────────────────────────────────────────────
async function triggerReroute(lat, lon) {
  if (!destination) return;
  showToast('Rerouting...', 'info');
  if (voiceEnabled) speak('Recalculating.');

  try {
    const tmpOrigin = { lat, lon };
    const routes    = await getRoute(tmpOrigin, destination, travelMode, false);
    allRoutes  = routes;
    activeRoute = routes[0];
    currentStepIdx = 0;
    lastVoiceStepIdx = -1;
    lastVoiceDist    = Infinity;

    // Redraw route
    routeLayers.forEach(l => map.removeLayer(l));
    routeLayers = [];
    const layer = L.polyline(activeRoute.coords, {
      color: '#e8ff47', weight: 6, opacity: 0.9, lineJoin: 'round', lineCap: 'round',
    }).addTo(map);
    routeLayers = [layer];

    // Refresh step list
    selectRoute(0);
    showPanel('nav-hud');

    showToast('Route updated', 'success');
    if (voiceEnabled) speak(`Route updated. ${activeRoute.durationText} remaining.`);
  } catch (err) {
    showToast('Reroute failed: ' + err.message, 'error');
  }
}

// ─────────────────────────────────────────────
// STEP HIGHLIGHT
// ─────────────────────────────────────────────
function highlightStep(idx) {
  document.querySelectorAll('.step-item').forEach(el => el.classList.remove('active-step'));
  const el = document.querySelector(`.step-item[data-step-idx="${idx}"]`);
  if (el) { el.classList.add('active-step'); el.scrollIntoView({ behavior: 'smooth', block: 'nearest' }); }
}

// ─────────────────────────────────────────────
// PANELS
// ─────────────────────────────────────────────
const PANELS = ['route-info', 'nav-hud', 'arrival-screen', 'search-panel'];
function showPanel(id) {
  PANELS.forEach(p => {
    const el = document.getElementById(p);
    if (el) el.classList.toggle('hidden', p !== id);
  });
}

// ─────────────────────────────────────────────
// ARRIVAL SCREEN
// ─────────────────────────────────────────────
function showArrivalScreen() {
  if (voiceEnabled) speak('You have arrived at your destination.');
  showPanel('arrival-screen');
  document.getElementById('arrival-dest').textContent = destination?.name || 'Destination';
  // Confetti burst
  burstConfetti();
}

function burstConfetti() {
  const canvas = document.getElementById('confetti-canvas');
  if (!canvas) return;
  canvas.width  = canvas.offsetWidth;
  canvas.height = canvas.offsetHeight;
  const ctx     = canvas.getContext('2d');
  const pieces  = Array.from({ length: 80 }, () => ({
    x: Math.random() * canvas.width,
    y: -20,
    r: 4 + Math.random() * 6,
    d: 2 + Math.random() * 4,
    color: ['#e8ff47','#47ff8e','#47d4ff','#ff4785','#ff6b47'][Math.floor(Math.random() * 5)],
    tilt: Math.random() * 10 - 5,
    tiltSpeed: Math.random() * 0.1 - 0.05,
  }));

  let frame;
  function draw() {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    pieces.forEach(p => {
      p.y += p.d;
      p.tilt += p.tiltSpeed;
      p.x += Math.sin(p.tilt);
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
      ctx.fillStyle = p.color;
      ctx.fill();
    });
    if (pieces.some(p => p.y < canvas.height + 20)) frame = requestAnimationFrame(draw);
  }
  draw();
  setTimeout(() => cancelAnimationFrame(frame), 4000);
}

// ─────────────────────────────────────────────
// OFF-ROUTE BANNER
// ─────────────────────────────────────────────
function showOffRouteBanner(show) {
  const el = document.getElementById('off-route-banner');
  if (el) el.classList.toggle('hidden', !show);
}

// ─────────────────────────────────────────────
// RECENTER + ROTATE
// ─────────────────────────────────────────────
function updateRecenterBtn() {
  const btn = document.getElementById('recenter-btn');
  if (!btn) return;
  btn.classList.toggle('dim', !followUser);
}

// ─────────────────────────────────────────────
// TOAST NOTIFICATIONS
// ─────────────────────────────────────────────
let toastTimeout;
function showToast(msg, type = 'error') {
  const toast = document.getElementById('toast');
  const text  = document.getElementById('toast-msg');
  if (!toast || !text) return;
  text.textContent = msg;
  toast.className  = `toast toast-${type}`;
  toast.classList.remove('hidden');
  clearTimeout(toastTimeout);
  toastTimeout = setTimeout(() => toast.classList.add('hidden'), type === 'error' ? 8000 : 4000);
}

// ─────────────────────────────────────────────
// LOADING STATE
// ─────────────────────────────────────────────
function setLoadingState(on) {
  const btn    = document.getElementById('route-btn');
  const text   = document.getElementById('route-btn-text');
  const loader = document.getElementById('route-btn-loader');
  if (on) { text.classList.add('hidden'); loader.classList.remove('hidden'); btn.disabled = true; }
  else    { text.classList.remove('hidden'); loader.classList.add('hidden'); checkReady(); }
}

// ─────────────────────────────────────────────
// BOOT
// ─────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  initMap();

  hasKey = !!(GOOGLE_MAPS_API_KEY && GOOGLE_MAPS_API_KEY !== 'YOUR_GOOGLE_MAPS_API_KEY');
  if (!hasKey) {
    showToast('⚠ Add your Google Maps API key in src/routing.js', 'warn');
    document.getElementById('key-warning').classList.remove('hidden');
  }
  checkReady();

  // Autocomplete
  setupAutocomplete('origin-input', 'origin-sug', setOrigin);
  setupAutocomplete('dest-input', 'dest-sug', setDestination);

  // Route btn
  document.getElementById('route-btn').addEventListener('click', calculateRoute);

  // Locate me
  document.getElementById('locate-btn').addEventListener('click', async () => {
    const btn = document.getElementById('locate-btn');
    btn.classList.add('spinning');
    try {
      const pos = await getCurrentPosition();
      const place = await reverseGeocode(pos.lat, pos.lon);
      setOrigin(place);
    } catch { showToast('Location unavailable', 'error'); }
    finally { btn.classList.remove('spinning'); }
  });

  // Swap
  document.getElementById('swap-btn').addEventListener('click', () => {
    [origin, destination] = [destination, origin];
    if (origin) setOrigin(origin);
    if (destination) setDestination(destination);
    routeLayers.forEach(l => map.removeLayer(l)); routeLayers = [];
    activeRoute = null; allRoutes = [];
    showPanel('search-panel');
  });

  // Travel modes
  document.querySelectorAll('.mode-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.mode-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      travelMode = btn.dataset.mode;
      routeLayers.forEach(l => map.removeLayer(l)); routeLayers = [];
      activeRoute = null; allRoutes = [];
      showPanel('search-panel');
    });
  });

  // Start nav
  document.getElementById('start-nav-btn').addEventListener('click', startNavigation);

  // Stop nav
  document.getElementById('stop-nav-btn').addEventListener('click', () => stopNavigation(false));

  // Recenter
  document.getElementById('recenter-btn').addEventListener('click', () => {
    followUser = true;
    updateRecenterBtn();
    if (userMarker) map.panTo(userMarker.getLatLng(), { animate: true });
  });

  // Map rotate toggle
  document.getElementById('rotate-btn').addEventListener('click', () => {
    mapRotate = !mapRotate;
    document.getElementById('rotate-btn').classList.toggle('active-rotate', mapRotate);
    if (!mapRotate) resetMapRotation();
  });

  // Voice toggle
  document.getElementById('voice-btn').addEventListener('click', () => {
    voiceEnabled = !voiceEnabled;
    const btn = document.getElementById('voice-btn');
    btn.classList.toggle('muted', !voiceEnabled);
    btn.title = voiceEnabled ? 'Mute voice' : 'Unmute voice';
    if (!voiceEnabled) window.speechSynthesis?.cancel();
  });

  // Toggle sidebar
  document.getElementById('toggle-sidebar-btn').addEventListener('click', () => {
    document.getElementById('sidebar').classList.toggle('collapsed');
    setTimeout(() => map.invalidateSize(), 320);
  });

  // Toast close
  document.getElementById('toast-close').addEventListener('click', () => {
    document.getElementById('toast').classList.add('hidden');
  });

  // New trip from arrival screen
  document.getElementById('new-trip-btn').addEventListener('click', () => {
    origin = destination = null;
    document.getElementById('origin-input').value = '';
    document.getElementById('dest-input').value = '';
    routeLayers.forEach(l => map.removeLayer(l)); routeLayers = [];
    activeRoute = null; allRoutes = [];
    if (destMarker) { map.removeLayer(destMarker); destMarker = null; }
    if (originMarker) { map.removeLayer(originMarker); originMarker = null; }
    showPanel('search-panel');
    checkReady();
  });
});