// Google Maps Directions API routing
// Replace GOOGLE_MAPS_API_KEY with your actual key

export const GOOGLE_MAPS_API_KEY = 'AIzaSyBRgBszbOKxCoTLBRCJ64EGVvi4LdoCLIM';

const DIRECTIONS_BASE = 'https://maps.googleapis.com/maps/api/directions/json';

// We use a CORS proxy for browser-based requests to the Directions REST API.
// Alternatively, load the Google Maps JS SDK — but for simplicity we use the REST API
// via a public CORS proxy. For production, proxy through your own backend.
const CORS_PROXY = 'https://corsproxy.io/?';

export async function getRoute(origin, destination, travelMode = 'driving', alternatives = true) {
  const params = new URLSearchParams({
    origin: `${origin.lat},${origin.lon}`,
    destination: `${destination.lat},${destination.lon}`,
    mode: travelMode,
    units: 'imperial',
    alternatives: alternatives ? 'true' : 'false',
    key: GOOGLE_MAPS_API_KEY,
  });

  const url = `${CORS_PROXY}${encodeURIComponent(`${DIRECTIONS_BASE}?${params}`)}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error('Directions API error: ' + res.status);

  const data = await res.json();

  if (data.status !== 'OK') {
    if (data.status === 'REQUEST_DENIED') throw new Error('Invalid or missing Google Maps API key. Add it to src/routing.js');
    throw new Error(`Directions error: ${data.status} — ${data.error_message || ''}`);
  }

  return data.routes.map(route => {
    const leg = route.legs[0];

    const coords = [];
    const steps = [];

    leg.steps.forEach((step) => {
      const stepCoords = decodePolyline(step.polyline.points);
      coords.push(...stepCoords);

      const instruction = stripHtml(step.html_instructions);
      const streetName = extractStreetName(instruction);

      steps.push({
        instruction,
        distance: step.distance.value,
        distanceText: step.distance.text,
        duration: step.duration.value,
        durationText: step.duration.text,
        maneuver: step.maneuver || '',
        streetName,
        startLat: step.start_location.lat,
        startLon: step.start_location.lng,
        endLat: step.end_location.lat,
        endLon: step.end_location.lng,
        polylineCoords: stepCoords,
      });
    });

    return {
      distance: leg.distance.value,
      distanceText: leg.distance.text,
      duration: leg.duration.value,
      durationText: leg.duration.text,
      summary: route.summary || '',
      warnings: route.warnings || [],
      coords,
      steps,
      bounds: {
        north: route.bounds.northeast.lat,
        south: route.bounds.southwest.lat,
        east: route.bounds.northeast.lng,
        west: route.bounds.southwest.lng,
      },
    };
  });
}

// Google's polyline encoding (precision 5)
export function decodePolyline(encoded) {
  const points = [];
  let index = 0, lat = 0, lng = 0;
  while (index < encoded.length) {
    let shift = 0, result = 0, b;
    do {
      b = encoded.charCodeAt(index++) - 63;
      result |= (b & 0x1f) << shift;
      shift += 5;
    } while (b >= 0x20);
    lat += (result & 1) ? ~(result >> 1) : result >> 1;

    shift = 0; result = 0;
    do {
      b = encoded.charCodeAt(index++) - 63;
      result |= (b & 0x1f) << shift;
      shift += 5;
    } while (b >= 0x20);
    lng += (result & 1) ? ~(result >> 1) : result >> 1;

    points.push([lat * 1e-5, lng * 1e-5]);
  }
  return points;
}

function stripHtml(html) {
  return html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
}

export function formatDistance(meters) {
  if (meters < 160) return `${Math.round(meters * 3.281)} ft`;
  const miles = meters / 1609.34;
  if (miles < 10) return `${miles.toFixed(1)} mi`;
  return `${Math.round(miles)} mi`;
}

export function formatDuration(seconds) {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (h > 0) return `${h}h ${m}m`;
  return `${m} min`;
}

export function formatSpeed(mps) {
  const mph = mps * 2.237;
  return `${Math.round(mph)} mph`;
}

// Map Google maneuver strings to arrow icons
export function getManeuverIcon(maneuver) {
  const map = {
    'turn-right': '→',
    'turn-left': '←',
    'turn-sharp-right': '↱',
    'turn-sharp-left': '↰',
    'turn-slight-right': '↗',
    'turn-slight-left': '↖',
    'keep-right': '↗',
    'keep-left': '↖',
    'uturn-right': '↻',
    'uturn-left': '↺',
    'roundabout-right': '↻',
    'roundabout-left': '↺',
    'merge': '⬆',
    'fork-right': '↗',
    'fork-left': '↖',
    'ramp-right': '↗',
    'ramp-left': '↖',
    'ferry': '⛴',
    'ferry-train': '🚂',
    'straight': '⬆',
    '': '⬆',
  };
  return map[maneuver] || '⬆';
}

// Calculate bearing between two lat/lon points (degrees, 0=North)
export function calcBearing(lat1, lon1, lat2, lon2) {
  const φ1 = lat1 * Math.PI / 180;
  const φ2 = lat2 * Math.PI / 180;
  const Δλ = (lon2 - lon1) * Math.PI / 180;
  const y = Math.sin(Δλ) * Math.cos(φ2);
  const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ);
  return ((Math.atan2(y, x) * 180 / Math.PI) + 360) % 360;
}

// Distance between two lat/lon in meters (Haversine)
export function haversine(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const φ1 = lat1 * Math.PI / 180, φ2 = lat2 * Math.PI / 180;
  const Δφ = (lat2 - lat1) * Math.PI / 180;
  const Δλ = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(Δφ/2)**2 + Math.cos(φ1)*Math.cos(φ2)*Math.sin(Δλ/2)**2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}

// Find which step index we're currently on (closest step start point)
export function findCurrentStep(lat, lon, steps) {
  let minDist = Infinity;
  let idx = 0;
  steps.forEach((step, i) => {
    const d = haversine(lat, lon, step.startLat, step.startLon);
    if (d < minDist) { minDist = d; idx = i; }
  });
  return idx;
}

export function snapToPolyline(lat, lon, coords = []) {
  if (!coords.length) return { lat, lon, dist: Infinity };

  let closest = { lat: coords[0][0], lon: coords[0][1], dist: Infinity };
  for (const [cLat, cLon] of coords) {
    const d = haversine(lat, lon, cLat, cLon);
    if (d < closest.dist) closest = { lat: cLat, lon: cLon, dist: d };
  }
  return closest;
}

export function distanceRemaining(lat, lon, steps = [], currentStepIdx = 0) {
  if (!steps.length) return 0;
  const idx = Math.max(0, Math.min(currentStepIdx, steps.length - 1));
  const current = steps[idx];
  const toCurrentEnd = haversine(lat, lon, current.endLat, current.endLon);
  let rest = 0;
  for (let i = idx + 1; i < steps.length; i++) rest += steps[i].distance || 0;
  return Math.max(0, toCurrentEnd + rest);
}

export function durationRemaining(lat, lon, steps = [], currentStepIdx = 0) {
  if (!steps.length) return 0;
  const idx = Math.max(0, Math.min(currentStepIdx, steps.length - 1));
  const current = steps[idx];
  const stepLen = Math.max(1, current.distance || 1);
  const distToEnd = haversine(lat, lon, current.endLat, current.endLon);
  const currentRemaining = (Math.min(distToEnd, stepLen) / stepLen) * (current.duration || 0);

  let rest = 0;
  for (let i = idx + 1; i < steps.length; i++) rest += steps[i].duration || 0;
  return Math.max(0, Math.round(currentRemaining + rest));
}

export function isOffRoute(lat, lon, coords = [], thresholdMeters = 60) {
  return snapToPolyline(lat, lon, coords).dist > thresholdMeters;
}

export function formatETA(secondsRemaining) {
  const eta = new Date(Date.now() + Math.max(0, secondsRemaining) * 1000);
  return eta.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

export function speak(text) {
  if (!text || typeof window === 'undefined' || !('speechSynthesis' in window)) return;
  window.speechSynthesis.cancel();
  const utterance = new SpeechSynthesisUtterance(text);
  utterance.rate = 1;
  utterance.pitch = 1;
  utterance.volume = 1;
  window.speechSynthesis.speak(utterance);
}

export function buildVoiceInstruction(step, distToNext) {
  if (!step) return '';
  if (distToNext <= 40) return `${step.instruction} now.`;
  if (distToNext <= 200) return `In ${formatDistance(distToNext)}, ${step.instruction}.`;
  return `In ${formatDistance(distToNext)}, prepare to ${step.instruction.toLowerCase()}.`;
}

function extractStreetName(instruction = '') {
  const onMatch = instruction.match(/\bon(?:to)?\s+([^.,;]+)/i);
  if (onMatch?.[1]) return onMatch[1].trim();
  const towardMatch = instruction.match(/\btoward\s+([^.,;]+)/i);
  if (towardMatch?.[1]) return towardMatch[1].trim();
  return '';
}
