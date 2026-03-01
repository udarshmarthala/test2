// Nominatim geocoding — free, no key needed
const BASE = 'https://nominatim.openstreetmap.org';

export async function geocodeSearch(query) {
  if (!query || query.trim().length < 2) return [];
  const url = `${BASE}/search?q=${encodeURIComponent(query)}&format=jsonv2&limit=5&addressdetails=1`;
  const res = await fetch(url, { headers: { 'Accept-Language': 'en', 'User-Agent': 'RouteForge/2.0' } });
  if (!res.ok) throw new Error('Geocode error ' + res.status);
  const data = await res.json();
  return data.map(item => ({
    lat:         parseFloat(item.lat),
    lon:         parseFloat(item.lon),
    displayName: item.display_name,
    name:        item.name || item.display_name.split(',')[0],
    address:     item.display_name.split(',').slice(1, 3).join(',').trim(),
  }));
}

export async function reverseGeocode(lat, lon) {
  const url = `${BASE}/reverse?lat=${lat}&lon=${lon}&format=jsonv2`;
  const res = await fetch(url, { headers: { 'Accept-Language': 'en', 'User-Agent': 'RouteForge/2.0' } });
  if (!res.ok) throw new Error('Reverse geocode error');
  const d = await res.json();
  return {
    lat, lon,
    displayName: d.display_name,
    name:    d.address?.road || d.address?.suburb || d.display_name.split(',')[0],
    address: d.display_name,
  };
}
