// Clearway — launch-site weather from Open-Meteo, evaluated against configurable
// go/no-go limits. The default limits are loosely modelled on published launch weather
// commit criteria; every vehicle has its own, so teams should enter theirs.

export const DEFAULT_LIMITS = {
  surfaceWindMs: 15,      // sustained 10 m wind
  gustMs: 18,
  upperWindMs: 60,        // max of 250/200 hPa wind (proxy for upper-level wind shear)
  upperWindCautionMs: 45,
  precipMm: 0.1,          // per hour
  capeCaution: 1000,      // J/kg, convective potential
  capeNoGo: 2500,
  cloudCaution: 90,       // % total cover (thick cloud layer rule proxy)
  tempMinC: -1,
  tempMaxC: 37,
};

const HOURLY = [
  'temperature_2m', 'precipitation', 'cloud_cover', 'visibility', 'wind_speed_10m', 'wind_gusts_10m',
  'wind_direction_10m', 'cape', 'weather_code', 'wind_speed_250hPa', 'wind_speed_200hPa',
];

export const WMO_TEXT = {
  0: 'Clear', 1: 'Mainly clear', 2: 'Partly cloudy', 3: 'Overcast', 45: 'Fog', 48: 'Rime fog',
  51: 'Light drizzle', 53: 'Drizzle', 55: 'Dense drizzle', 61: 'Light rain', 63: 'Rain', 65: 'Heavy rain',
  66: 'Freezing rain', 67: 'Freezing rain', 71: 'Light snow', 73: 'Snow', 75: 'Heavy snow', 77: 'Snow grains',
  80: 'Rain showers', 81: 'Rain showers', 82: 'Violent showers', 85: 'Snow showers', 86: 'Snow showers',
  95: 'Thunderstorm', 96: 'Thunderstorm, hail', 99: 'Thunderstorm, heavy hail',
};

function query(lat, lon) {
  return `latitude=${lat.toFixed(4)}&longitude=${lon.toFixed(4)}&hourly=${HOURLY.join(',')}&wind_speed_unit=ms&timezone=UTC&forecast_days=16`;
}

export async function fetchForecast(lat, lon) {
  const q = query(lat, lon);
  const tryUrl = async (url) => {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 15000);
    try {
      const r = await fetch(url, { signal: ctl.signal });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const j = await r.json();
      if (!j.hourly?.time) throw new Error(j.reason || 'Unexpected response');
      return j;
    } finally { clearTimeout(t); }
  };
  let data;
  try { data = await tryUrl(`api/weather?${q}`); } catch { data = await tryUrl(`https://api.open-meteo.com/v1/forecast?${q}`); }
  const times = data.hourly.time.map((s) => Date.parse(s.endsWith('Z') ? s : s + 'Z'));
  return { lat, lon, times, h: data.hourly, units: data.hourly_units, fetchedAt: Date.now() };
}

function valueAt(fc, key, i) {
  const arr = fc.h[key];
  return arr && arr[i] != null ? arr[i] : null;
}

/** Evaluate the hours bracketing tMs (worst case of the two). */
export function evaluateWeather(fc, tMs, limits = DEFAULT_LIMITS) {
  if (!fc) return { status: 'NO DATA', reasons: ['Forecast unavailable'], values: {} };
  const first = fc.times[0], last = fc.times[fc.times.length - 1];
  if (tMs < first - 3600000 || tMs > last + 3600000) return { status: 'NO DATA', reasons: ['Beyond the 16-day forecast range'], values: {} };
  let i0 = Math.max(0, Math.min(fc.times.length - 1, Math.floor((tMs - first) / 3600000)));
  const idx = [i0, Math.min(fc.times.length - 1, i0 + 1)];
  const worst = (key, fn = Math.max) => {
    const vals = idx.map((i) => valueAt(fc, key, i)).filter((v) => v != null);
    return vals.length ? fn(...vals) : null;
  };
  const v = {
    wind: worst('wind_speed_10m'), gust: worst('wind_gusts_10m'), precip: worst('precipitation'),
    cloud: worst('cloud_cover'), cape: worst('cape'), tempMin: worst('temperature_2m', Math.min), tempMax: worst('temperature_2m'),
    upper: Math.max(worst('wind_speed_250hPa') ?? 0, worst('wind_speed_200hPa') ?? 0) || null,
    code: worst('weather_code'), visibility: worst('visibility', Math.min),
  };
  const nogo = [], caution = [];
  if (v.code != null && v.code >= 95) nogo.push(`${WMO_TEXT[v.code] || 'Thunderstorm'} forecast`);
  if (v.wind != null && v.wind > limits.surfaceWindMs) nogo.push(`Surface wind ${v.wind.toFixed(1)} m/s > ${limits.surfaceWindMs}`);
  if (v.gust != null && v.gust > limits.gustMs) nogo.push(`Gusts ${v.gust.toFixed(1)} m/s > ${limits.gustMs}`);
  if (v.precip != null && v.precip > limits.precipMm) nogo.push(`Precipitation ${v.precip.toFixed(1)} mm/h`);
  if (v.cape != null && v.cape > limits.capeNoGo) nogo.push(`CAPE ${Math.round(v.cape)} J/kg (lightning risk)`);
  else if (v.cape != null && v.cape > limits.capeCaution) caution.push(`CAPE ${Math.round(v.cape)} J/kg`);
  if (v.upper != null && v.upper > limits.upperWindMs) nogo.push(`Upper-level wind ${v.upper.toFixed(0)} m/s`);
  else if (v.upper != null && v.upper > limits.upperWindCautionMs) caution.push(`Upper-level wind ${v.upper.toFixed(0)} m/s`);
  if (v.cloud != null && v.cloud >= limits.cloudCaution) caution.push(`Cloud cover ${Math.round(v.cloud)}%`);
  if (v.tempMin != null && v.tempMin < limits.tempMinC) nogo.push(`Temperature ${v.tempMin.toFixed(1)} °C below limit`);
  if (v.tempMax != null && v.tempMax > limits.tempMaxC) nogo.push(`Temperature ${v.tempMax.toFixed(1)} °C above limit`);
  return { status: nogo.length ? 'NO-GO' : caution.length ? 'CAUTION' : 'GO', reasons: [...nogo, ...caution], values: v };
}
