// ============================================================
// tracker.js — Live GPS with heading, compass, interpolation
// ============================================================
import { calcBearing, haversine } from './routing.js';

export class LiveTracker {
  constructor() {
    this.watchId          = null;
    this.lastPos          = null;
    this.heading          = 0;
    this.speed            = 0;
    this.compassHeading   = null;
    this._onUpdate        = null;
    this._onError         = null;
    this._orientHandler   = null;
    this._orientTimer     = null;   // Orientation fallback timer
    this._interpTimer     = null;
    this._prevPos         = null;
    this._currPos         = null;
    this._interpStart     = null;
    this._interpDuration  = 500;   // CHANGED: 500ms interpolation window (was 1000ms)
    this._smoothHeading   = 0;
    this._rawCompassAlpha = null;
    this._compassSupported = !!window.DeviceOrientationEvent;
    this._compassActive    = false;
    this._lastCompassAt    = 0;
  }

  start(onUpdate, onError) {
    this._onUpdate = onUpdate;
    this._onError  = onError;

    if (!navigator.geolocation) { onError('Geolocation not supported'); return; }

    this._tryCompass();

    this.watchId = navigator.geolocation.watchPosition(
      pos => this._onGPS(pos),
      err => onError(this._errMsg(err)),
      {
        enableHighAccuracy: true,
        maximumAge:         0,
        timeout:            10000,  // CHANGED: tighter timeout (was 15000)
      }
    );

    // Smooth interpolation loop at 30fps
    this._interpTimer = setInterval(() => this._interpolate(), 33);

    // Orientation fallback update every 200ms
    this._orientTimer = setInterval(() => this._applyCompassTick(), 200);
  }

  stop() {
    if (this.watchId != null)  { navigator.geolocation.clearWatch(this.watchId); this.watchId = null; }
    if (this._interpTimer)     { clearInterval(this._interpTimer);  this._interpTimer = null; }
    if (this._orientTimer)     { clearInterval(this._orientTimer);  this._orientTimer = null; }  // NEW
    this._compassActive = false;
    this._stopCompass();
  }

  getCompassStatus() {
    const freshMs = 1500;
    const available = this._compassActive && (Date.now() - this._lastCompassAt) <= freshMs;
    return {
      supported: this._compassSupported,
      available,
    };
  }

  // Push latest compass reading into the heading pipeline
  _applyCompassTick() {
    if (this.compassHeading == null) return;

    // Only override if we don't have a moving GPS heading (i.e. standing still or slow)
    const isMovingFast = this.speed > 1.0; // > ~3.6 km/h
    if (!isMovingFast) {
      // Snap smoothHeading toward compass faster when stationary
      const target = this.compassHeading;
      let diff = ((target - this._smoothHeading) + 540) % 360 - 180;
      this._smoothHeading = (this._smoothHeading + diff * 0.8 + 360) % 360;

      if (this._currPos) {
        this._emit({
          lat:      this._currPos.lat,
          lon:      this._currPos.lon,
          heading:  this._smoothHeading,
          speed:    this._currPos.speed,
          accuracy: this._currPos.accuracy,
          interpolated: true,
        });
      }
    }
  }

  _onGPS(pos) {
    const { latitude: lat, longitude: lon, heading, speed, accuracy } = pos.coords;

    // Calculate movement bearing from last fix
    let moveBearing = null;
    if (this.lastPos) {
      const dist = haversine(this.lastPos.lat, this.lastPos.lon, lat, lon);
      if (dist > 2) moveBearing = calcBearing(this.lastPos.lat, this.lastPos.lon, lat, lon);
    }

    // Priority: GPS heading > compass > movement bearing > last known
    let resolvedHeading =
      (heading != null && !isNaN(heading) && heading >= 0) ? heading :
      this.compassHeading != null                           ? this.compassHeading :
      moveBearing != null                                   ? moveBearing :
      this._smoothHeading;

    this.heading      = resolvedHeading;
    this.speed        = speed != null && speed >= 0 ? speed : 0;
    this._prevPos     = this._currPos || { lat, lon };
    this._currPos     = { lat, lon, heading: resolvedHeading, speed: this.speed, accuracy };
    this._interpStart = performance.now();
    this.lastPos      = { lat, lon };

    // Emit immediately
    this._emit({ lat, lon, heading: resolvedHeading, speed: this.speed, accuracy });
  }

  _interpolate() {
    if (!this._prevPos || !this._currPos || !this._interpStart) return;
    const elapsed = performance.now() - this._interpStart;
    const t       = Math.min(elapsed / this._interpDuration, 1);

    // Linear interpolate position
    const lat = this._prevPos.lat + (this._currPos.lat - this._prevPos.lat) * t;
    const lon = this._prevPos.lon + (this._currPos.lon - this._prevPos.lon) * t;

    // Smooth heading with lerp (shortest path) — CHANGED: 0.3 factor (was 0.15) for snappier response
    const target = this._currPos.heading ?? this._smoothHeading;
    let diff      = ((target - this._smoothHeading) + 540) % 360 - 180;
    this._smoothHeading = (this._smoothHeading + diff * 0.3 + 360) % 360;

    this._emit({
      lat,
      lon,
      heading:  this._smoothHeading,
      speed:    this._currPos.speed,
      accuracy: this._currPos.accuracy,
      interpolated: true,
    });
  }

  _emit(data) {
    if (this._onUpdate) this._onUpdate(data);
  }

  _tryCompass() {
    if (!window.DeviceOrientationEvent) {
      this._compassSupported = false;
      return;
    }
    this._compassSupported = true;

    // Store compass values and immediately apply for low-latency facing updates
    const handler = e => {
      if (e.webkitCompassHeading != null) {
        this.compassHeading = e.webkitCompassHeading;
        this._compassActive = true;
        this._lastCompassAt = Date.now();
      } else if (e.alpha != null) {
        this.compassHeading = (360 - e.alpha) % 360;
        this._compassActive = true;
        this._lastCompassAt = Date.now();
      }

      this._applyCompassTick();
    };

    if (typeof DeviceOrientationEvent.requestPermission === 'function') {
      DeviceOrientationEvent.requestPermission()
        .then(s => {
          if (s === 'granted') {
            window.addEventListener('deviceorientation', handler, true);
            this._orientHandler = handler;
          }
        })
        .catch(() => {});
    } else {
      window.addEventListener('deviceorientation', handler, true);
      this._orientHandler = handler;
    }
  }

  _stopCompass() {
    if (this._orientHandler) {
      window.removeEventListener('deviceorientation', this._orientHandler, true);
      this._orientHandler = null;
    }
    this._compassActive = false;
  }

  _errMsg(e) {
    return ['', 'Location access denied.', 'Location unavailable.', 'Location timed out.'][e.code] || 'Location error.';
  }
}

// One-shot position
export function getCurrentPosition() {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) return reject(new Error('Geolocation not supported'));
    navigator.geolocation.getCurrentPosition(
      p => resolve({ lat: p.coords.latitude, lon: p.coords.longitude, heading: p.coords.heading, speed: p.coords.speed, accuracy: p.coords.accuracy }),
      err => reject(err),
      { enableHighAccuracy: true, timeout: 10000, maximumAge: 0 }
    );
  });
}