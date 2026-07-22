/* ==========================================================================
   SolarIQ — Solar Panel Energy Prediction Dashboard
   script.js — data layer, prediction engine, charts, UI interactions
   Swap loadData()/predictEnergy() internals with real API calls later.
   ========================================================================== */

'use strict';

/* ============================================================
   1. STATIC REFERENCE DATA
   ============================================================ */
const CITIES = ['Riyadh', 'Jeddah', 'Mecca', 'Medina', 'Dammam'];
const PANEL_TYPES = ['Monocrystalline', 'Polycrystalline', 'Thin-Film'];
const MOUNT_TYPES = ['Rooftop', 'Ground'];
const SEASONS = ['Winter', 'Spring', 'Summer', 'Fall'];
const MONTH_NAMES = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

const CITY_INFO = {
  Riyadh: { lat: 24.71, lon: 46.68, radOffset: 0.20, tempOffset: 1.0, humOffset: -6 },
  Jeddah: { lat: 21.54, lon: 39.17, radOffset: 0.00, tempOffset: 0.0, humOffset: 14 },
  Mecca:  { lat: 21.39, lon: 39.86, radOffset: 0.10, tempOffset: 1.0, humOffset: 6 },
  Medina: { lat: 24.47, lon: 39.61, radOffset: 0.00, tempOffset: 0.0, humOffset: -4 },
  Dammam: { lat: 26.42, lon: 50.09, radOffset: -0.10, tempOffset: 0.0, humOffset: 10 },
};

const PANEL_INFO = {
  Monocrystalline: {
    efficiency: 21, lifetime: '25–30 yrs', factor: 1.15, costScore: 45, durability: 88,
    icon: 'fa-solar-panel',
    pros: ['Highest efficiency per m²', 'Best performance in low light', 'Sleek all-black aesthetic'],
    cons: ['Highest upfront cost', 'Efficiency drops faster in extreme heat'],
  },
  Polycrystalline: {
    efficiency: 17, lifetime: '20–25 yrs', factor: 1.00, costScore: 68, durability: 78,
    icon: 'fa-table-cells-large',
    pros: ['Lower cost per watt', 'Simpler, more sustainable manufacturing', 'Solid reliability'],
    cons: ['Lower efficiency than mono', 'Slightly larger footprint for same output'],
  },
  'Thin-Film': {
    efficiency: 11, lifetime: '10–20 yrs', factor: 0.75, costScore: 82, durability: 60,
    icon: 'fa-layer-group',
    pros: ['Lightweight & flexible', 'Performs better in high heat', 'Low cost per panel'],
    cons: ['Lowest efficiency, needs more space', 'Shorter operational lifetime'],
  },
};

const MOUNT_INFO = { Rooftop: { factor: 0.97 }, Ground: { factor: 1.05 } };
const SEASON_FACTOR = { Winter: 0.82, Spring: 0.96, Summer: 1.06, Fall: 0.92 };
const SEASON_BY_MONTH = { 12: 'Winter', 1: 'Winter', 2: 'Winter', 3: 'Spring', 4: 'Spring', 5: 'Spring', 6: 'Summer', 7: 'Summer', 8: 'Summer', 9: 'Fall', 10: 'Fall', 11: 'Fall' };

// Monthly KSA climate baselines (index 0 = Jan)
const CLIMATE_BASE = {
  radiation: [4.8, 5.4, 6.2, 6.9, 7.6, 8.3, 8.5, 8.2, 7.4, 6.3, 5.2, 4.6],
  temp:      [18, 20, 24, 29, 34, 38, 41, 41, 37, 32, 25, 19],
  cloud:     [28, 24, 18, 14, 8, 4, 3, 4, 7, 12, 20, 27],
  humidity:  [45, 42, 35, 30, 22, 18, 20, 22, 28, 33, 40, 46],
  wind:      [14, 15, 16, 15, 14, 13, 12, 12, 13, 13, 14, 14],
  pressure:  [1015, 1013, 1011, 1009, 1007, 1004, 1002, 1002, 1005, 1009, 1012, 1015],
  dayLength: [10.6, 11.1, 11.9, 12.7, 13.4, 13.8, 13.6, 13.0, 12.2, 11.4, 10.7, 10.4],
};

const MODEL_METRICS = {
  rf: { mae: 0.284, rmse: 0.411, r2: 0.970, r2cv: 0.966, maeCV: 0.295 },
  lr: { mae: 0.924, rmse: 1.146, r2: 0.763 },
};

const FEATURE_IMPORTANCE = [
  ['shortwave_radiation_sum', 0.32], ['cloud_cover_mean', 0.14], ['doy_cos', 0.09],
  ['Panel Efficiency (%)', 0.08], ['doy_sin', 0.07], ['sunshine_duration', 0.06],
  ['Tilt (°)', 0.05], ['temperature_2m_mean', 0.04], ['City_Jeddah', 0.03],
  ['relative_humidity_2m_mean', 0.025], ['wind_speed_10m_mean', 0.02],
  ['Panel Type_Thin-Film', 0.018], ['us_aqi', 0.015], ['surface_pressure_mean', 0.012],
  ['City_Riyadh', 0.01],
];

const COLORS = {
  orange: '#FDB813', orange2: '#FF8A00', yellow: '#FFD54A',
  green: '#38E27C', red: '#FF6B6B', blue: '#4FA0FF',
  text: '#A9B2C6', grid: 'rgba(150,160,190,0.12)',
};

/* ============================================================
   2. APP STATE
   ============================================================ */
const state = {
  records: [],
  predictionHistory: [],
  charts: {},
  units: 'metric',
  table: { search: '', city: 'all', panel: 'all', sortKey: 'date', sortDir: 'desc', page: 1, pageSize: 15 },
  filters: { city: 'all', panel: 'all', season: 'all' },
};

/* ============================================================
   3. CORE PREDICTION ENGINE
   (structured so it can later be swapped for a real backend/API call)
   ============================================================ */
function predictEnergy(input) {
  const city = CITY_INFO[input.city] || CITY_INFO.Riyadh;
  const panel = PANEL_INFO[input.panel] || PANEL_INFO.Monocrystalline;
  const mount = MOUNT_INFO[input.mount] || MOUNT_INFO.Rooftop;
  const seasonFactor = SEASON_FACTOR[input.season] || 1;

  const radiation = num(input.radiation, 6.5);
  const temp = num(input.temp, 30);
  const humidity = num(input.humidity, 35);
  const wind = num(input.wind, 12);
  const cloud = num(input.cloud, 15);
  const dayLength = num(input.dayLength, 12.4);

  const cityFactor = 1 + city.radOffset * 0.05;
  const cloudPenalty = 1 - (cloud / 100) * 0.55;
  const tempPenalty = temp > 25 ? 1 - (temp - 25) * 0.0035 : 1 + (25 - temp) * 0.001;
  const humidityPenalty = 1 - (humidity / 100) * 0.05;
  const windBonus = 1 + Math.min(wind, 30) / 30 * 0.03;
  const dayLengthFactor = dayLength / 12.5;

  let output = radiation * 0.62 * panel.factor * mount.factor * cityFactor *
               cloudPenalty * tempPenalty * humidityPenalty * windBonus *
               dayLengthFactor * seasonFactor;
  output = clamp(output, 0.2, 11);

  // best-case reference for the same city/panel/mount combo, ideal weather → efficiency %
  const best = Math.max(radiation, 9) * 0.62 * panel.factor * mount.factor * cityFactor *
               1 * 1 * 1 * 1.03 * 1 * 1.06;
  const efficiencyPct = clamp((output / Math.max(best, output)) * 100, 4, 100);

  return { output: round2(output), efficiencyPct: round1(efficiencyPct) };
}

function num(v, fallback) { const n = parseFloat(v); return Number.isFinite(n) ? n : fallback; }
function clamp(v, min, max) { return Math.min(max, Math.max(min, v)); }
function round2(v) { return Math.round(v * 100) / 100; }
function round1(v) { return Math.round(v * 10) / 10; }

/* ============================================================
   4. DATA LOADING (sample dataset — swap with fetch() later)
   ============================================================ */
function loadData() {
  state.records = generateRecords(220);
  state.predictionHistory = [];
}

function climateForDate(city, month, jitter = true) {
  const idx = month - 1;
  const c = CITY_INFO[city];
  const j = (spread) => (jitter ? (Math.random() - 0.5) * spread : 0);
  return {
    radiation: clamp(CLIMATE_BASE.radiation[idx] + c.radOffset + j(0.6), 1, 9.2),
    temp: clamp(CLIMATE_BASE.temp[idx] + c.tempOffset + j(3), 5, 49),
    humidity: clamp(CLIMATE_BASE.humidity[idx] + c.humOffset + j(8), 5, 95),
    wind: clamp(CLIMATE_BASE.wind[idx] + j(5), 2, 45),
    cloud: clamp(CLIMATE_BASE.cloud[idx] + j(10), 0, 90),
    pressure: clamp(CLIMATE_BASE.pressure[idx] + j(3), 985, 1025),
    dayLength: clamp(CLIMATE_BASE.dayLength[idx] + j(0.2), 9, 14),
  };
}

function generateRecords(count) {
  const records = [];
  const today = new Date();
  for (let i = 0; i < count; i++) {
    const daysAgo = Math.floor(Math.random() * 365);
    const date = new Date(today);
    date.setDate(date.getDate() - daysAgo);
    const month = date.getMonth() + 1;
    const city = CITIES[Math.floor(Math.random() * CITIES.length)];
    const panel = PANEL_TYPES[Math.floor(Math.random() * PANEL_TYPES.length)];
    const mount = MOUNT_TYPES[Math.floor(Math.random() * MOUNT_TYPES.length)];
    const season = SEASON_BY_MONTH[month];
    const climate = climateForDate(city, month);
    const { output, efficiencyPct } = predictEnergy({
      city, panel, mount, season, radiation: climate.radiation, temp: climate.temp,
      humidity: climate.humidity, wind: climate.wind, cloud: climate.cloud,
      dayLength: climate.dayLength,
    });
    records.push({
      id: i, date, city, panel, mount, season,
      radiation: round2(climate.radiation), temp: round1(climate.temp),
      humidity: Math.round(climate.humidity), wind: round1(climate.wind),
      cloud: Math.round(climate.cloud), pressure: round1(climate.pressure),
      dayLength: round2(climate.dayLength), output, efficiencyPct,
    });
  }
  records.sort((a, b) => b.date - a.date);
  return records;
}

/* ============================================================
   5. UTILITIES — count-up, toasts, ripple, chart destroy
   ============================================================ */
function countUp(el, target, opts = {}) {
  const duration = opts.duration || 1200;
  const decimals = opts.decimals || 0;
  const start = performance.now();
  const from = 0;
  function frame(now) {
    const p = clamp((now - start) / duration, 0, 1);
    const eased = 1 - Math.pow(1 - p, 3);
    const val = from + (target - from) * eased;
    el.textContent = decimals ? val.toFixed(decimals) : Math.round(val).toLocaleString();
    if (p < 1) requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
}

function toast(message, icon = 'fa-solid fa-circle-check') {
  const container = document.getElementById('toast-container');
  const el = document.createElement('div');
  el.className = 'toast';
  el.innerHTML = `<i class="${icon}"></i><span>${message}</span>`;
  container.appendChild(el);
  setTimeout(() => {
    el.classList.add('leaving');
    setTimeout(() => el.remove(), 350);
  }, 3200);
}

function debounce(fn, wait) {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), wait); };
}

function destroyChart(key) {
  if (state.charts[key]) { state.charts[key].destroy(); delete state.charts[key]; }
}

function downloadBlob(content, filename, type) {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  URL.revokeObjectURL(url);
}

function exportChartAsPNG(canvasId) {
  const chart = state.charts[canvasId] || Chart.getChart(canvasId);
  if (!chart) { toast('Chart not ready yet', 'fa-solid fa-triangle-exclamation'); return; }
  const link = document.createElement('a');
  link.href = chart.toBase64Image();
  link.download = `${canvasId}.png`;
  link.click();
  toast('Chart exported as PNG', 'fa-solid fa-download');
}

Chart.defaults.color = COLORS.text;
Chart.defaults.font.family = "'Inter', sans-serif";
Chart.defaults.font.size = 11.5;

/* ============================================================
   6. KPI CARDS (Dashboard)
   ============================================================ */
function buildKPIList() {
  const now = new Date();
  const month = now.getMonth() + 1;
  const city = 'Riyadh';
  const season = SEASON_BY_MONTH[month];
  const climate = climateForDate(city, month, false);
  const { output, efficiencyPct } = predictEnergy({
    city, panel: 'Monocrystalline', mount: 'Rooftop', season,
    radiation: climate.radiation, temp: climate.temp, humidity: climate.humidity,
    wind: climate.wind, cloud: climate.cloud, dayLength: climate.dayLength,
  });
  const spark = (base, n = 10, spread = 0.18) =>
    Array.from({ length: n }, (_, i) => round2(base * (1 + Math.sin(i / 1.6) * spread + (Math.random() - 0.5) * 0.06)));

  return [
    { icon: 'fa-bolt', label: 'Predicted Output', value: output, unit: 'kWh', decimals: 2, trend: '+4.2%', up: true, spark: spark(output) },
    { icon: 'fa-gauge-high', label: 'Efficiency', value: efficiencyPct, unit: '%', decimals: 1, trend: '+1.1%', up: true, spark: spark(efficiencyPct, 10, 0.08) },
    { icon: 'fa-sun', label: 'Solar Radiation', value: climate.radiation, unit: 'kWh/m²', decimals: 2, trend: '+2.8%', up: true, spark: spark(climate.radiation) },
    { icon: 'fa-temperature-three-quarters', label: 'Temperature', value: climate.temp, unit: '°C', decimals: 1, trend: '+0.6°', up: true, spark: spark(climate.temp, 10, 0.05) },
    { icon: 'fa-droplet', label: 'Humidity', value: climate.humidity, unit: '%', decimals: 0, trend: '-3.0%', up: false, spark: spark(climate.humidity, 10, 0.1) },
    { icon: 'fa-wind', label: 'Wind Speed', value: climate.wind, unit: 'km/h', decimals: 1, trend: '+0.9', up: true, spark: spark(climate.wind, 10, 0.15) },
    { icon: 'fa-cloud', label: 'Cloud Coverage', value: climate.cloud, unit: '%', decimals: 0, trend: '-5.4%', up: false, spark: spark(climate.cloud, 10, 0.3) },
    { icon: 'fa-leaf', label: 'Season', value: season, unit: '', decimals: null, trend: `${MONTH_NAMES[month - 1]}`, up: true, spark: spark(6, 10, 0.25) },
  ];
}

function renderKPICards() {
  const list = buildKPIList();
  const grid = document.getElementById('kpi-grid');
  grid.innerHTML = list.map((k, i) => `
    <div class="kpi-card reveal">
      <div class="kpi-card-top">
        <div class="kpi-icon"><i class="fa-solid ${k.icon}"></i></div>
        <span class="kpi-trend ${k.up ? 'up' : 'down'}"><i class="fa-solid fa-arrow-${k.up ? 'up' : 'down'}"></i> ${k.trend}</span>
      </div>
      <div class="kpi-label">${k.label}</div>
      <div class="kpi-value"><span data-final="${typeof k.value === 'number' ? k.value : ''}" data-decimals="${k.decimals ?? 0}" id="kpi-num-${i}">${typeof k.value === 'number' ? '0' : k.value}</span>${k.unit ? `<span class="unit">${k.unit}</span>` : ''}</div>
      <div class="kpi-spark"><canvas id="kpi-spark-${i}"></canvas></div>
    </div>
  `).join('');

  list.forEach((k, i) => {
    if (typeof k.value === 'number') {
      const el = document.getElementById(`kpi-num-${i}`);
      countUp(el, k.value, { decimals: k.decimals, duration: 1000 + i * 80 });
    }
    const ctx = document.getElementById(`kpi-spark-${i}`);
    new Chart(ctx, {
      type: 'line',
      data: { labels: k.spark.map((_, x) => x), datasets: [{ data: k.spark, borderColor: COLORS.orange, borderWidth: 2, tension: 0.4, pointRadius: 0, fill: true, backgroundColor: 'rgba(253,184,19,0.12)' }] },
      options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false }, tooltip: { enabled: false } }, scales: { x: { display: false }, y: { display: false } }, animation: { duration: 1000 } },
    });
  });

  requestAnimationFrame(() => grid.querySelectorAll('.reveal').forEach((el, i) => setTimeout(() => el.classList.add('in-view'), i * 60)));
}

/* ============================================================
   7. DASHBOARD CHARTS (updateCharts)
   ============================================================ */
function monthlyAverages() {
  return CLIMATE_BASE.radiation.map((_, i) => {
    const month = i + 1;
    const climate = climateForDate('Riyadh', month, false);
    const { output } = predictEnergy({
      city: 'Riyadh', panel: 'Monocrystalline', mount: 'Rooftop', season: SEASON_BY_MONTH[month],
      radiation: climate.radiation, temp: climate.temp, humidity: climate.humidity,
      wind: climate.wind, cloud: climate.cloud, dayLength: climate.dayLength,
    });
    return output;
  });
}

function updateCharts() {
  destroyChart('chartMonthly');
  const monthly = monthlyAverages();
  state.charts.chartMonthly = new Chart(document.getElementById('chartMonthly'), {
    type: 'line',
    data: {
      labels: MONTH_NAMES,
      datasets: [{
        label: 'Avg. Output (kWh/day)', data: monthly, borderColor: COLORS.orange, borderWidth: 3,
        tension: 0.4, fill: true,
        backgroundColor: (ctx) => {
          const g = ctx.chart.ctx.createLinearGradient(0, 0, 0, 260);
          g.addColorStop(0, 'rgba(253,184,19,0.35)'); g.addColorStop(1, 'rgba(253,184,19,0)');
          return g;
        },
        pointBackgroundColor: COLORS.orange, pointBorderColor: '#000', pointRadius: 4, pointHoverRadius: 6,
      }],
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: { legend: { display: false } },
      scales: { x: { grid: { color: COLORS.grid } }, y: { grid: { color: COLORS.grid }, title: { display: true, text: 'kWh / day' } } },
      animation: { duration: 1200, easing: 'easeOutQuart' },
    },
  });

  destroyChart('chartCityPie');
  const cityAvg = CITIES.map(c => avgOutputBy('city', c));
  state.charts.chartCityPie = new Chart(document.getElementById('chartCityPie'), {
    type: 'doughnut',
    data: { labels: CITIES, datasets: [{ data: cityAvg, backgroundColor: [COLORS.orange, COLORS.orange2, COLORS.yellow, COLORS.blue, COLORS.green], borderColor: 'rgba(0,0,0,0.4)', borderWidth: 2, hoverOffset: 10 }] },
    options: { responsive: true, maintainAspectRatio: false, cutout: '62%', plugins: { legend: { position: 'bottom', labels: { boxWidth: 10, padding: 14 } } }, animation: { animateRotate: true, duration: 1200 } },
  });

  destroyChart('chartPanelBar');
  const panelAvg = PANEL_TYPES.map(p => avgOutputBy('panel', p));
  state.charts.chartPanelBar = new Chart(document.getElementById('chartPanelBar'), {
    type: 'bar',
    data: { labels: PANEL_TYPES, datasets: [{ label: 'Avg Output (kWh)', data: panelAvg, backgroundColor: [COLORS.orange, COLORS.orange2, COLORS.yellow], borderRadius: 10, maxBarThickness: 60 }] },
    options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false } }, scales: { x: { grid: { display: false } }, y: { grid: { color: COLORS.grid } } } },
  });

  renderPredictionHistoryCharts();
}

function avgOutputBy(key, val) {
  const rows = state.records.filter(r => r[key] === val);
  if (!rows.length) return 0;
  return round2(rows.reduce((s, r) => s + r.output, 0) / rows.length);
}

function renderPredictionHistoryCharts() {
  const labels = state.predictionHistory.map(p => p.label);
  const data = state.predictionHistory.map(p => p.output);
  ['chartPredHistoryHome', 'chartPredHistory'].forEach(id => {
    destroyChart(id);
    const el = document.getElementById(id);
    if (!el) return;
    state.charts[id] = new Chart(el, {
      type: 'line',
      data: { labels: labels.length ? labels : ['—'], datasets: [{ label: 'Predicted kWh', data: data.length ? data : [0], borderColor: COLORS.yellow, backgroundColor: 'rgba(255,213,74,0.15)', borderWidth: 3, tension: 0.35, fill: true, pointRadius: 4, pointBackgroundColor: COLORS.yellow }] },
      options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false } }, scales: { x: { grid: { display: false } }, y: { grid: { color: COLORS.grid } } } },
    });
  });
}

/* ============================================================
   8. updateDashboard — refreshes KPIs + charts together
   ============================================================ */
function updateDashboard() {
  renderKPICards();
  updateCharts();
}

/* ============================================================
   9. PREDICTION PAGE
   ============================================================ */
function readPredictionForm() {
  return {
    city: val('in-city'), panel: val('in-panel'), mount: val('in-mount'), season: val('in-season'),
    radiation: val('in-radiation'), temp: val('in-temp'), humidity: val('in-humidity'),
    wind: val('in-wind'), cloud: val('in-cloud'), pressure: val('in-pressure'),
    dayLength: val('in-daylength'), month: val('in-month'), day: val('in-day'),
  };
}
function val(id) { return document.getElementById(id).value; }

function initPredictionForm() {
  ['in-radiation', 'in-temp', 'in-humidity', 'in-wind', 'in-cloud'].forEach(id => {
    const input = document.getElementById(id);
    const out = document.getElementById('val-' + id.replace('in-', ''));
    const sync = () => {
      const pct = ((input.value - input.min) / (input.max - input.min)) * 100;
      input.style.setProperty('--fill', pct + '%');
      out.textContent = input.value;
    };
    input.addEventListener('input', sync);
    sync();
  });

  document.getElementById('prediction-form').addEventListener('submit', (e) => {
    e.preventDefault();
    runPrediction();
  });

  document.getElementById('btn-clear').addEventListener('click', () => {
    document.getElementById('prediction-form').reset();
    ['in-radiation', 'in-temp', 'in-humidity', 'in-wind', 'in-cloud'].forEach(id => document.getElementById(id).dispatchEvent(new Event('input')));
    document.getElementById('result-content').hidden = true;
    document.getElementById('result-loading').hidden = true;
    document.getElementById('result-idle').hidden = false;
    toast('Form cleared', 'fa-solid fa-rotate-left');
  });

  document.getElementById('btn-random').addEventListener('click', () => {
    document.getElementById('in-city').value = pick(CITIES);
    document.getElementById('in-panel').value = pick(PANEL_TYPES);
    document.getElementById('in-mount').value = pick(MOUNT_TYPES);
    const season = pick(SEASONS);
    document.getElementById('in-season').value = season;
    const monthOptions = { Winter: [12, 1, 2], Spring: [3, 4, 5], Summer: [6, 7, 8], Fall: [9, 10, 11] }[season];
    const month = pick(monthOptions);
    document.getElementById('in-month').value = month;
    document.getElementById('in-day').value = 1 + Math.floor(Math.random() * 28);
    const climate = climateForDate(document.getElementById('in-city').value, month);
    setRange('in-radiation', climate.radiation.toFixed(1));
    setRange('in-temp', climate.temp.toFixed(1));
    setRange('in-humidity', Math.round(climate.humidity));
    setRange('in-wind', climate.wind.toFixed(1));
    setRange('in-cloud', Math.round(climate.cloud));
    document.getElementById('in-pressure').value = climate.pressure.toFixed(1);
    document.getElementById('in-daylength').value = climate.dayLength.toFixed(1);
    toast('Random example loaded', 'fa-solid fa-dice');
  });

  document.getElementById('btn-report').addEventListener('click', downloadPredictionReport);
}
function pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }
function setRange(id, v) { const el = document.getElementById(id); el.value = v; el.dispatchEvent(new Event('input')); }

let lastPrediction = null;

function runPrediction() {
  const input = readPredictionForm();
  document.getElementById('result-idle').hidden = true;
  document.getElementById('result-content').hidden = true;
  document.getElementById('result-loading').hidden = false;

  setTimeout(() => {
    const { output, efficiencyPct } = predictEnergy(input);
    lastPrediction = { input, output, efficiencyPct, ts: new Date() };

    document.getElementById('result-loading').hidden = true;
    document.getElementById('result-content').hidden = false;

    const numEl = document.getElementById('result-number');
    countUp(numEl, output, { decimals: 2, duration: 900 });

    const ring = document.getElementById('ring-fg');
    const circumference = 2 * Math.PI * 60;
    ring.style.strokeDasharray = `${circumference}`;
    ring.style.strokeDashoffset = `${circumference}`;
    requestAnimationFrame(() => {
      ring.style.strokeDashoffset = `${circumference * (1 - efficiencyPct / 100)}`;
    });

    document.getElementById('result-efficiency').textContent = `${efficiencyPct}%`;
    document.getElementById('result-co2').textContent = `${round2(output * 0.45)} kg`;
    document.getElementById('result-homes').textContent = `${round2(output / 9.5).toFixed(2)}`;

    state.predictionHistory.push({ label: `${input.city.slice(0, 3)} #${state.predictionHistory.length + 1}`, output });
    if (state.predictionHistory.length > 10) state.predictionHistory.shift();
    renderPredictionHistoryCharts();

    toast(`Predicted ${output} kWh for ${input.city}`, 'fa-solid fa-bolt');
  }, 1100);
}

function downloadPredictionReport() {
  if (!lastPrediction) return;
  const { input, output, efficiencyPct, ts } = lastPrediction;
  const report = `SolarIQ — Prediction Report
Generated: ${ts.toLocaleString()}

INPUT CONDITIONS
----------------
City:            ${input.city}
Panel Type:      ${input.panel}
Mount Type:      ${input.mount}
Season:          ${input.season}
Solar Radiation: ${input.radiation} kWh/m²/day
Temperature:     ${input.temp} °C
Humidity:        ${input.humidity} %
Wind Speed:      ${input.wind} km/h
Cloud Cover:     ${input.cloud} %
Pressure:        ${input.pressure} hPa
Day Length:      ${input.dayLength} h
Month / Day:     ${input.month} / ${input.day}

PREDICTION RESULT
------------------
Predicted Output:  ${output} kWh/day
Efficiency vs Peak: ${efficiencyPct}%
Est. CO2 Offset:    ${round2(output * 0.45)} kg
Model:              Random Forest Regressor (R² = ${MODEL_METRICS.rf.r2})
`;
  downloadBlob(report, `solariq-prediction-${Date.now()}.txt`, 'text/plain');
  toast('Report downloaded', 'fa-solid fa-file-arrow-down');
}

/* ============================================================
   10. ANALYTICS PAGE
   ============================================================ */
function filteredRecords() {
  return state.records.filter(r =>
    (state.filters.city === 'all' || r.city === state.filters.city) &&
    (state.filters.panel === 'all' || r.panel === state.filters.panel) &&
    (state.filters.season === 'all' || r.season === state.filters.season)
  );
}

function renderAnalytics() {
  const rows = filteredRecords();
  const avg = rows.length ? round2(rows.reduce((s, r) => s + r.output, 0) / rows.length) : 0;

  const bySeason = SEASONS.map(s => ({ s, v: avgFrom(rows.filter(r => r.season === s)) }));
  const bestSeason = bySeason.sort((a, b) => b.v - a.v)[0]?.s || '—';
  const byCity = CITIES.map(c => ({ c, v: avgFrom(rows.filter(r => r.city === c)) }));
  const bestCity = byCity.sort((a, b) => b.v - a.v)[0]?.c || '—';
  const byPanel = PANEL_TYPES.map(p => ({ p, v: avgFrom(rows.filter(r => r.panel === p)) }));
  const bestPanel = byPanel.sort((a, b) => b.v - a.v)[0]?.p || '—';
  const avgCloud = rows.length ? rows.reduce((s, r) => s + r.cloud, 0) / rows.length : 0;
  const weatherImpact = clamp(100 - avgCloud, 0, 100);
  const efficiencyScore = rows.length ? round1(rows.reduce((s, r) => s + r.efficiencyPct, 0) / rows.length) : 0;

  const stats = [
    { icon: 'fa-chart-line', label: 'Average Production', value: avg, unit: 'kWh' },
    { icon: 'fa-sun', label: 'Best Season', value: bestSeason, unit: '' },
    { icon: 'fa-city', label: 'Best City', value: bestCity, unit: '' },
    { icon: 'fa-solar-panel', label: 'Best Panel Type', value: bestPanel, unit: '' },
    { icon: 'fa-cloud-sun', label: 'Weather Impact', value: round1(weatherImpact), unit: '%' },
    { icon: 'fa-gauge-high', label: 'Efficiency Score', value: efficiencyScore, unit: '%' },
  ];
  document.getElementById('analytics-stats').innerHTML = stats.map((k, i) => `
    <div class="kpi-card reveal in-view">
      <div class="kpi-card-top"><div class="kpi-icon"><i class="fa-solid ${k.icon}"></i></div></div>
      <div class="kpi-label">${k.label}</div>
      <div class="kpi-value">${typeof k.value === 'number' ? k.value : k.value}<span class="unit">${k.unit}</span></div>
    </div>
  `).join('');

  // Seasonal radar
  destroyChart('chartSeasonRadar');
  state.charts.chartSeasonRadar = new Chart(document.getElementById('chartSeasonRadar'), {
    type: 'radar',
    data: { labels: SEASONS, datasets: [{ label: 'Avg Output (kWh)', data: bySeason.map(x => x.v), backgroundColor: 'rgba(253,184,19,0.25)', borderColor: COLORS.orange, pointBackgroundColor: COLORS.orange, borderWidth: 2 }] },
    options: { responsive: true, maintainAspectRatio: false, scales: { r: { grid: { color: COLORS.grid }, angleLines: { color: COLORS.grid }, pointLabels: { color: COLORS.text } } }, plugins: { legend: { display: false } } },
  });

  // Panel comparison
  destroyChart('chartPanelCompare');
  state.charts.chartPanelCompare = new Chart(document.getElementById('chartPanelCompare'), {
    type: 'bar',
    data: { labels: PANEL_TYPES, datasets: [{ label: 'Avg Output (kWh)', data: byPanel.map(x => x.v), backgroundColor: [COLORS.orange, COLORS.orange2, COLORS.yellow], borderRadius: 10 }] },
    options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false } }, scales: { x: { grid: { display: false } }, y: { grid: { color: COLORS.grid } } } },
  });

  // City comparison
  destroyChart('chartCityCompare');
  state.charts.chartCityCompare = new Chart(document.getElementById('chartCityCompare'), {
    type: 'polarArea',
    data: { labels: CITIES, datasets: [{ data: byCity.map(x => x.v), backgroundColor: [COLORS.orange, COLORS.orange2, COLORS.yellow, COLORS.blue, COLORS.green].map(c => c + 'CC') }] },
    options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { position: 'bottom', labels: { boxWidth: 10 } } }, scales: { r: { grid: { color: COLORS.grid }, ticks: { display: false } } } },
  });

  // Scatter: cloud cover vs output
  destroyChart('chartScatter');
  state.charts.chartScatter = new Chart(document.getElementById('chartScatter'), {
    type: 'scatter',
    data: { datasets: [{ label: 'Records', data: rows.map(r => ({ x: r.cloud, y: r.output })), backgroundColor: 'rgba(253,184,19,0.65)' }] },
    options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false } }, scales: { x: { title: { display: true, text: 'Cloud Cover (%)' }, grid: { color: COLORS.grid } }, y: { title: { display: true, text: 'Output (kWh)' }, grid: { color: COLORS.grid } } } },
  });

  renderHeatmap(rows);
  renderTopLocations(rows);

  document.querySelectorAll('#page-analytics .reveal').forEach((el, i) => setTimeout(() => el.classList.add('in-view'), i * 50));
}
function avgFrom(rows) { return rows.length ? round2(rows.reduce((s, r) => s + r.output, 0) / rows.length) : 0; }

function renderHeatmap(rows) {
  const el = document.getElementById('heatmap');
  const matrix = CITIES.map(c => MONTH_NAMES.map((_, mi) => {
    const cellRows = rows.filter(r => r.city === c && r.date.getMonth() === mi);
    return cellRows.length ? avgFrom(cellRows) : null;
  }));
  const flat = matrix.flat().filter(v => v !== null);
  const max = Math.max(...flat, 1), min = Math.min(...flat, 0);

  let html = `<div class="heatmap-label"></div>` + MONTH_NAMES.map(m => `<div class="heatmap-label" style="justify-content:center;">${m}</div>`).join('');
  CITIES.forEach((c, ci) => {
    html += `<div class="heatmap-label">${c}</div>`;
    matrix[ci].forEach(v => {
      const t = v === null ? 0 : (v - min) / (max - min || 1);
      const bg = v === null ? 'rgba(255,255,255,0.04)' : mixColor(t);
      html += `<div class="heatmap-cell" style="background:${bg};color:${t > 0.55 ? '#05070D' : '#A9B2C6'}">${v === null ? '–' : v}</div>`;
    });
  });
  el.innerHTML = html;
}
function mixColor(t) {
  // interpolate deep navy -> solar orange
  const c1 = [15, 21, 38], c2 = [253, 184, 19];
  const c = c1.map((v, i) => Math.round(v + (c2[i] - v) * t));
  return `rgb(${c[0]},${c[1]},${c[2]})`;
}

function renderTopLocations(rows) {
  const groups = {};
  rows.forEach(r => {
    const key = `${r.city} · ${r.panel}`;
    (groups[key] ||= []).push(r.output);
  });
  const list = Object.entries(groups)
    .map(([key, vals]) => ({ key, avg: round2(vals.reduce((a, b) => a + b, 0) / vals.length), n: vals.length }))
    .sort((a, b) => b.avg - a.avg).slice(0, 5);
  const max = list.length ? list[0].avg : 1;
  document.getElementById('top-locations').innerHTML = list.map((l, i) => `
    <div class="top-loc-row">
      <span class="top-loc-rank">#${i + 1}</span>
      <span>${l.key}</span>
      <span>${l.n} records</span>
      <div class="top-loc-bar"><div class="top-loc-bar-fill" style="width:${(l.avg / max) * 100}%"></div></div>
      <span class="output-strong">${l.avg} kWh</span>
    </div>
  `).join('') || '<p style="color:var(--text-3);font-size:13px;">No records match the current filters.</p>';
}

function initAnalyticsFilters() {
  ['filter-city', 'filter-panel', 'filter-season'].forEach(id => {
    document.getElementById(id).addEventListener('change', (e) => {
      const map = { 'filter-city': 'city', 'filter-panel': 'panel', 'filter-season': 'season' };
      state.filters[map[id]] = e.target.value;
      renderAnalytics();
    });
  });
  document.getElementById('btn-reset-filters').addEventListener('click', () => {
    state.filters = { city: 'all', panel: 'all', season: 'all' };
    document.getElementById('filter-city').value = 'all';
    document.getElementById('filter-panel').value = 'all';
    document.getElementById('filter-season').value = 'all';
    renderAnalytics();
    toast('Filters reset');
  });
}

/* ============================================================
   11. WEATHER PAGE
   ============================================================ */
function renderWeather() {
  const now = new Date();
  const month = now.getMonth() + 1;
  const climate = climateForDate('Riyadh', month, false);
  const uv = clamp(round1(climate.radiation * 1.15), 0, 11);

  const cards = [
    { icon: 'fa-temperature-three-quarters', cls: '', label: 'Temperature', value: `${toTemp(climate.temp)}${state.units === 'metric' ? '°C' : '°F'}` },
    { icon: 'fa-droplet', cls: 'bounce', label: 'Humidity', value: `${Math.round(climate.humidity)}%` },
    { icon: 'fa-wind', cls: '', label: 'Wind Speed', value: `${toWind(climate.wind)} ${state.units === 'metric' ? 'km/h' : 'mph'}` },
    { icon: 'fa-gauge-simple', cls: '', label: 'Pressure', value: `${round1(climate.pressure)} hPa` },
    { icon: 'fa-cloud', cls: 'bounce', label: 'Cloud Cover', value: `${Math.round(climate.cloud)}%` },
    { icon: 'fa-sun', cls: 'spin-slow', label: 'Solar Radiation', value: `${round2(climate.radiation)} kWh/m²` },
    { icon: 'fa-eye', cls: '', label: 'UV Index', value: `${uv}` },
  ];
  document.getElementById('weather-grid').innerHTML = cards.map(c => `
    <div class="glass-card weather-card reveal in-view">
      <i class="fa-solid ${c.icon} weather-icon ${c.cls}"></i>
      <div class="weather-value">${c.value}</div>
      <div class="weather-label">${c.label}</div>
    </div>
  `).join('');

  // 7-day trend + forecast
  const days = []; const temps = []; const hums = []; const rads = [];
  const forecastHTML = [];
  for (let i = 0; i < 7; i++) {
    const d = new Date(now); d.setDate(d.getDate() + i);
    const c = climateForDate('Riyadh', d.getMonth() + 1);
    days.push(d.toLocaleDateString(undefined, { weekday: 'short' }));
    temps.push(round1(c.temp)); hums.push(Math.round(c.humidity)); rads.push(round2(c.radiation));
    const icon = c.cloud < 8 ? 'fa-sun' : c.cloud < 20 ? 'fa-cloud-sun' : 'fa-cloud';
    forecastHTML.push(`
      <div class="glass-card forecast-card reveal in-view">
        <div class="forecast-day">${i === 0 ? 'Today' : d.toLocaleDateString(undefined, { weekday: 'short' })}</div>
        <i class="fa-solid ${icon}"></i>
        <div class="forecast-temp">${toTemp(c.temp)}°</div>
      </div>
    `);
  }
  document.getElementById('forecast-row').innerHTML = forecastHTML.join('');

  destroyChart('chartWeatherTrend');
  state.charts.chartWeatherTrend = new Chart(document.getElementById('chartWeatherTrend'), {
    data: {
      labels: days,
      datasets: [
        { type: 'line', label: 'Temperature (°C)', data: temps, borderColor: COLORS.orange, backgroundColor: 'rgba(253,184,19,0.1)', yAxisID: 'y', tension: 0.4, fill: true, pointRadius: 3 },
        { type: 'line', label: 'Humidity (%)', data: hums, borderColor: COLORS.blue, yAxisID: 'y1', tension: 0.4, pointRadius: 3 },
        { type: 'bar', label: 'Radiation (kWh/m²)', data: rads, backgroundColor: 'rgba(255,213,74,0.35)', yAxisID: 'y', borderRadius: 6 },
      ],
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      scales: {
        y: { position: 'left', grid: { color: COLORS.grid }, title: { display: true, text: 'Temp °C / Radiation' } },
        y1: { position: 'right', grid: { display: false }, title: { display: true, text: 'Humidity %' }, min: 0, max: 100 },
      },
      plugins: { legend: { position: 'bottom' } },
    },
  });
}
function toTemp(c) { return state.units === 'metric' ? Math.round(c) : Math.round(c * 9 / 5 + 32); }
function toWind(w) { return state.units === 'metric' ? round1(w) : round1(w * 0.621371); }

/* ============================================================
   12. SOLAR PANELS PAGE
   ============================================================ */
function renderPanels() {
  const grid = document.getElementById('panel-cards');
  grid.innerHTML = PANEL_TYPES.map(p => {
    const info = PANEL_INFO[p];
    const est = predictEnergy({ city: 'Riyadh', panel: p, mount: 'Rooftop', season: 'Summer', radiation: 7.5, temp: 35, humidity: 25, wind: 12, cloud: 8, dayLength: 13.2 });
    return `
      <div class="glass-card panel-card reveal in-view">
        <div class="panel-card-head">
          <div class="panel-card-icon"><i class="fa-solid ${info.icon}"></i></div>
          <div><h4>${p}</h4><span>Solar PV Technology</span></div>
        </div>
        <div class="panel-stat-row"><span>Efficiency</span><b>${info.efficiency}%</b></div>
        <div class="panel-stat-row"><span>Lifetime</span><b>${info.lifetime}</b></div>
        <div class="panel-stat-row"><span>Est. Daily Output</span><b>${est.output} kWh</b></div>
        <div class="panel-list-title">Advantages</div>
        <ul class="panel-list pros">${info.pros.map(x => `<li><i class="fa-solid fa-circle-check"></i>${x}</li>`).join('')}</ul>
        <div class="panel-list-title">Disadvantages</div>
        <ul class="panel-list cons">${info.cons.map(x => `<li><i class="fa-solid fa-circle-xmark"></i>${x}</li>`).join('')}</ul>
      </div>
    `;
  }).join('');

  destroyChart('chartPanelRadar');
  state.charts.chartPanelRadar = new Chart(document.getElementById('chartPanelRadar'), {
    type: 'radar',
    data: {
      labels: ['Efficiency', 'Lifetime', 'Output', 'Cost Efficiency', 'Durability'],
      datasets: PANEL_TYPES.map((p, i) => {
        const info = PANEL_INFO[p];
        const colors = [COLORS.orange, COLORS.orange2, COLORS.yellow];
        return {
          label: p,
          data: [info.efficiency * 4, parseInt(info.lifetime) * 3, info.factor * 80, info.costScore, info.durability],
          borderColor: colors[i], backgroundColor: colors[i] + '22', pointBackgroundColor: colors[i], borderWidth: 2,
        };
      }),
    },
    options: { responsive: true, maintainAspectRatio: false, scales: { r: { grid: { color: COLORS.grid }, angleLines: { color: COLORS.grid }, pointLabels: { color: COLORS.text } } }, plugins: { legend: { position: 'bottom' } } },
  });
}

/* ============================================================
   13. HISTORICAL DATA TABLE
   ============================================================ */
function getTableRows() {
  let rows = state.records.filter(r => {
    if (state.table.city !== 'all' && r.city !== state.table.city) return false;
    if (state.table.panel !== 'all' && r.panel !== state.table.panel) return false;
    const q = state.table.search.toLowerCase();
    if (!q) return true;
    return `${r.city} ${r.panel} ${r.mount} ${r.season}`.toLowerCase().includes(q);
  });
  const { sortKey, sortDir } = state.table;
  rows = [...rows].sort((a, b) => {
    let av = a[sortKey], bv = b[sortKey];
    if (sortKey === 'date') { av = a.date.getTime(); bv = b.date.getTime(); }
    if (typeof av === 'string') return sortDir === 'asc' ? av.localeCompare(bv) : bv.localeCompare(av);
    return sortDir === 'asc' ? av - bv : bv - av;
  });
  return rows;
}

function renderHistoricalTable() {
  const rows = getTableRows();
  const { page, pageSize } = state.table;
  const totalPages = Math.max(1, Math.ceil(rows.length / pageSize));
  state.table.page = clamp(page, 1, totalPages);
  const start = (state.table.page - 1) * pageSize;
  const pageRows = rows.slice(start, start + pageSize);

  document.getElementById('table-body').innerHTML = pageRows.map(r => `
    <tr>
      <td>${r.date.toLocaleDateString()}</td>
      <td><span class="badge-city">${r.city}</span></td>
      <td>${r.panel}</td>
      <td>${r.mount}</td>
      <td>${r.radiation} kWh/m²</td>
      <td>${r.temp}°C</td>
      <td>${r.cloud}%</td>
      <td class="output-strong">${r.output} kWh</td>
    </tr>
  `).join('') || `<tr><td colspan="8" style="text-align:center;color:var(--text-3);padding:30px;">No matching records</td></tr>`;

  document.getElementById('table-info').textContent = `Showing ${pageRows.length ? start + 1 : 0}–${start + pageRows.length} of ${rows.length} records`;

  document.querySelectorAll('.data-table th').forEach(th => {
    th.classList.toggle('sorted', th.dataset.key === state.table.sortKey);
    const icon = th.querySelector('i');
    icon.className = th.dataset.key === state.table.sortKey
      ? (state.table.sortDir === 'asc' ? 'fa-solid fa-sort-up' : 'fa-solid fa-sort-down')
      : 'fa-solid fa-sort';
  });

  renderPagination(totalPages);
}

function renderPagination(totalPages) {
  const cur = state.table.page;
  const win = 2;
  let pages = [];
  for (let i = 1; i <= totalPages; i++) {
    if (i === 1 || i === totalPages || (i >= cur - win && i <= cur + win)) pages.push(i);
    else if (pages[pages.length - 1] !== '…') pages.push('…');
  }
  const el = document.getElementById('pagination');
  el.innerHTML = `
    <button class="page-btn" id="page-prev" ${cur === 1 ? 'disabled' : ''}><i class="fa-solid fa-chevron-left"></i></button>
    ${pages.map(p => p === '…' ? `<span class="page-btn" style="border:none;cursor:default;">…</span>` : `<button class="page-btn ${p === cur ? 'active' : ''}" data-page="${p}">${p}</button>`).join('')}
    <button class="page-btn" id="page-next" ${cur === totalPages ? 'disabled' : ''}><i class="fa-solid fa-chevron-right"></i></button>
  `;
  el.querySelectorAll('[data-page]').forEach(btn => btn.addEventListener('click', () => { state.table.page = parseInt(btn.dataset.page); renderHistoricalTable(); }));
  document.getElementById('page-prev')?.addEventListener('click', () => { state.table.page--; renderHistoricalTable(); });
  document.getElementById('page-next')?.addEventListener('click', () => { state.table.page++; renderHistoricalTable(); });
}

function initTableControls() {
  document.getElementById('table-search').addEventListener('input', (e) => { state.table.search = e.target.value; state.table.page = 1; renderHistoricalTable(); });
  document.getElementById('table-filter-city').addEventListener('change', (e) => { state.table.city = e.target.value; state.table.page = 1; renderHistoricalTable(); });
  document.getElementById('table-filter-panel').addEventListener('change', (e) => { state.table.panel = e.target.value; state.table.page = 1; renderHistoricalTable(); });
  document.getElementById('table-page-size').addEventListener('change', (e) => { state.table.pageSize = parseInt(e.target.value); state.table.page = 1; renderHistoricalTable(); });
  document.querySelectorAll('.data-table th').forEach(th => {
    th.addEventListener('click', () => {
      const key = th.dataset.key;
      if (state.table.sortKey === key) state.table.sortDir = state.table.sortDir === 'asc' ? 'desc' : 'asc';
      else { state.table.sortKey = key; state.table.sortDir = 'asc'; }
      renderHistoricalTable();
    });
  });
  document.getElementById('btn-download-csv').addEventListener('click', () => {
    const rows = getTableRows();
    const header = 'Date,City,Panel Type,Mount Type,Radiation (kWh/m2/day),Temperature (C),Humidity (%),Wind (km/h),Cloud Cover (%),Output (kWh)';
    const csv = [header, ...rows.map(r => [r.date.toISOString().slice(0, 10), r.city, r.panel, r.mount, r.radiation, r.temp, r.humidity, r.wind, r.cloud, r.output].join(','))].join('\n');
    downloadBlob(csv, 'solariq_historical_data.csv', 'text/csv');
    toast('CSV downloaded', 'fa-solid fa-file-csv');
  });
}

/* ============================================================
   14. PERFORMANCE PAGE
   ============================================================ */
function renderGauge(id, opts) {
  const pct = clamp(opts.fillPct, 0, 100);
  state.charts[id] = new Chart(document.getElementById(id), {
    type: 'doughnut',
    data: { datasets: [{ data: [pct, 100 - pct], backgroundColor: [opts.color || COLORS.orange, 'rgba(255,255,255,0.08)'], borderWidth: 0 }] },
    options: { responsive: true, maintainAspectRatio: false, cutout: '78%', rotation: -90, circumference: 360, plugins: { legend: { display: false }, tooltip: { enabled: false } }, animation: { duration: 1400, easing: 'easeOutQuart' } },
  });
}

function renderPerformance() {
  const gauges = [
    { id: 'gauge-1', label: 'Model Accuracy', sub: 'R² Score (test set)', value: MODEL_METRICS.rf.r2 * 100, decimals: 1, suffix: '%', fillPct: MODEL_METRICS.rf.r2 * 100, color: COLORS.orange },
    { id: 'gauge-2', label: 'Mean Abs. Error', sub: 'MAE (kWh/day)', value: MODEL_METRICS.rf.mae, decimals: 3, suffix: '', fillPct: (1 - MODEL_METRICS.rf.mae / 1.2) * 100, color: COLORS.green },
    { id: 'gauge-3', label: 'Root Mean Sq. Error', sub: 'RMSE (kWh/day)', value: MODEL_METRICS.rf.rmse, decimals: 3, suffix: '', fillPct: (1 - MODEL_METRICS.rf.rmse / 1.5) * 100, color: COLORS.blue },
    { id: 'gauge-4', label: 'Cross-Validated R²', sub: '5-Fold CV mean', value: MODEL_METRICS.rf.r2cv * 100, decimals: 1, suffix: '%', fillPct: MODEL_METRICS.rf.r2cv * 100, color: COLORS.yellow },
  ];
  document.getElementById('gauge-grid').innerHTML = gauges.map(g => `
    <div class="glass-card gauge-card reveal in-view">
      <div class="gauge-wrap"><canvas id="${g.id}"></canvas><div class="gauge-value"><b><span id="${g.id}-num">0</span>${g.suffix ? `<em>${g.suffix}</em>` : ''}</b><span>${g.sub}</span></div></div>
      <div class="gauge-title">${g.label}</div>
    </div>
  `).join('');
  gauges.forEach((g, i) => {
    renderGauge(g.id, g);
    const numEl = document.getElementById(`${g.id}-num`);
    setTimeout(() => countUp(numEl, g.value, { decimals: g.decimals, duration: 1300 }), i * 120);
  });

  destroyChart('chartModelCompare');
  state.charts.chartModelCompare = new Chart(document.getElementById('chartModelCompare'), {
    type: 'bar',
    data: {
      labels: ['MAE', 'RMSE', 'R² Score'],
      datasets: [
        { label: 'Linear Regression', data: [MODEL_METRICS.lr.mae, MODEL_METRICS.lr.rmse, MODEL_METRICS.lr.r2], backgroundColor: 'rgba(169,178,198,0.55)', borderRadius: 8 },
        { label: 'Random Forest', data: [MODEL_METRICS.rf.mae, MODEL_METRICS.rf.rmse, MODEL_METRICS.rf.r2], backgroundColor: COLORS.orange, borderRadius: 8 },
      ],
    },
    options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { position: 'bottom' } }, scales: { x: { grid: { display: false } }, y: { grid: { color: COLORS.grid } } } },
  });

  destroyChart('chartLoss');
  const epochs = Array.from({ length: 25 }, (_, i) => i + 1);
  const trainLoss = epochs.map(e => round2(0.28 + 1.2 * Math.exp(-e / 6) + Math.random() * 0.03));
  const valLoss = epochs.map(e => round2(0.34 + 1.3 * Math.exp(-e / 6.4) + Math.random() * 0.04));
  state.charts.chartLoss = new Chart(document.getElementById('chartLoss'), {
    type: 'line',
    data: { labels: epochs, datasets: [
      { label: 'Training Loss (RMSE)', data: trainLoss, borderColor: COLORS.orange, backgroundColor: 'transparent', tension: 0.3, pointRadius: 0, borderWidth: 2.5 },
      { label: 'Validation Loss (RMSE)', data: valLoss, borderColor: COLORS.blue, backgroundColor: 'transparent', tension: 0.3, pointRadius: 0, borderWidth: 2.5, borderDash: [5, 4] },
    ] },
    options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { position: 'bottom' } }, scales: { x: { grid: { display: false }, title: { display: true, text: 'Epoch' } }, y: { grid: { color: COLORS.grid } } } },
  });

  destroyChart('chartFeatureImportance');
  const sorted = [...FEATURE_IMPORTANCE].sort((a, b) => a[1] - b[1]);
  state.charts.chartFeatureImportance = new Chart(document.getElementById('chartFeatureImportance'), {
    type: 'bar',
    data: { labels: sorted.map(x => x[0]), datasets: [{ label: 'Importance', data: sorted.map(x => x[1]), backgroundColor: COLORS.orange, borderRadius: 6 }] },
    options: { indexAxis: 'y', responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false } }, scales: { x: { grid: { color: COLORS.grid } }, y: { grid: { display: false } } } },
  });
}

/* ============================================================
   15. NAVIGATION / SPA PAGE SWITCHING
   ============================================================ */
const PAGE_META = {
  dashboard: ['Dashboard', "Overview & live production metrics"],
  prediction: ['Prediction', 'AI-powered daily output forecasting'],
  analytics: ['Analytics', 'Deep-dive performance analysis'],
  weather: ['Weather', 'Live atmospheric conditions'],
  panels: ['Solar Panels', 'Technology comparison & specs'],
  history: ['Historical Data', 'Browse, search & export records'],
  performance: ['Performance', 'Model accuracy & diagnostics'],
  settings: ['Settings', 'Personalize your experience'],
};

function showPage(id) {
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  document.getElementById(`page-${id}`).classList.add('active');
  document.querySelectorAll('.nav-link').forEach(a => a.classList.toggle('active', a.dataset.page === id));
  const [title, crumb] = PAGE_META[id];
  document.getElementById('page-title').textContent = title;
  document.getElementById('page-crumb').textContent = crumb;

  document.querySelectorAll(`#page-${id} .reveal`).forEach((el, i) => {
    el.classList.remove('in-view');
    setTimeout(() => el.classList.add('in-view'), 40 + i * 45);
  });

  document.getElementById('sidebar').classList.remove('mobile-open');
  document.getElementById('sidebar-overlay').classList.remove('show');
  document.getElementById('content').scrollTo?.({ top: 0 });
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function initNavigation() {
  document.querySelectorAll('.nav-link').forEach(a => {
    a.addEventListener('click', (e) => { e.preventDefault(); showPage(a.dataset.page); });
  });
  document.querySelectorAll('[data-goto]').forEach(btn => {
    btn.addEventListener('click', () => showPage(btn.dataset.goto));
  });
}

/* ============================================================
   16. EFFECTS: clock, theme, particles, cursor glow, ripple,
       scroll reveal, back-to-top, FAB, fullscreen, notifications
   ============================================================ */
function initClock() {
  const el = document.getElementById('clock-time');
  const tick = () => { el.textContent = new Date().toLocaleTimeString(undefined, { hour12: false }); };
  tick(); setInterval(tick, 1000);
}

function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  document.getElementById('theme-toggle-btn').innerHTML = theme === 'light' ? '<i class="fa-solid fa-moon"></i>' : '<i class="fa-solid fa-sun"></i>';
  document.getElementById('setting-theme').checked = theme === 'light';
  localStorage.setItem('solariq-theme', theme);
}
function toggleTheme() {
  const cur = document.documentElement.getAttribute('data-theme');
  applyTheme(cur === 'light' ? 'dark' : 'light');
}
function initTheme() {
  applyTheme(localStorage.getItem('solariq-theme') || 'dark');
  document.getElementById('theme-toggle-btn').addEventListener('click', toggleTheme);
  document.getElementById('setting-theme').addEventListener('change', toggleTheme);
}

function initParticles() {
  const canvas = document.getElementById('particles-canvas');
  const ctx = canvas.getContext('2d');
  let particles = []; let running = true;
  function resize() {
    const rect = canvas.parentElement.getBoundingClientRect();
    canvas.width = rect.width; canvas.height = rect.height;
  }
  function init() {
    resize();
    const count = Math.floor((canvas.width * canvas.height) / 18000);
    particles = Array.from({ length: count }, () => ({
      x: Math.random() * canvas.width, y: Math.random() * canvas.height,
      r: Math.random() * 1.8 + 0.6, vx: (Math.random() - 0.5) * 0.25, vy: (Math.random() - 0.5) * 0.25,
      a: Math.random() * 0.5 + 0.2,
    }));
  }
  function frame() {
    if (!running) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    particles.forEach(p => {
      p.x += p.vx; p.y += p.vy;
      if (p.x < 0 || p.x > canvas.width) p.vx *= -1;
      if (p.y < 0 || p.y > canvas.height) p.vy *= -1;
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(253,184,19,${p.a})`;
      ctx.fill();
    });
    requestAnimationFrame(frame);
  }
  init(); frame();
  window.addEventListener('resize', init);
  document.getElementById('setting-particles').addEventListener('change', (e) => {
    running = e.target.checked;
    canvas.style.opacity = e.target.checked ? '1' : '0';
    if (running) frame();
  });
}

function initCursorGlow() {
  const glow = document.getElementById('cursor-glow');
  if (window.matchMedia('(pointer: coarse)').matches) { glow.style.display = 'none'; return; }
  document.addEventListener('mousemove', (e) => {
    glow.style.left = e.clientX + 'px';
    glow.style.top = e.clientY + 'px';
  });
}

function initRipple() {
  document.addEventListener('click', (e) => {
    const btn = e.target.closest('.ripple');
    if (!btn) return;
    const rect = btn.getBoundingClientRect();
    const size = Math.max(rect.width, rect.height);
    const circle = document.createElement('span');
    circle.className = 'ripple-effect';
    circle.style.width = circle.style.height = size + 'px';
    circle.style.left = (e.clientX - rect.left - size / 2) + 'px';
    circle.style.top = (e.clientY - rect.top - size / 2) + 'px';
    btn.appendChild(circle);
    setTimeout(() => circle.remove(), 650);
  });
}

function initScrollObserver() {
  const obs = new IntersectionObserver((entries) => {
    entries.forEach(e => { if (e.isIntersecting) e.target.classList.add('in-view'); });
  }, { threshold: 0.12 });
  document.querySelectorAll('.reveal').forEach(el => obs.observe(el));
}

function initBackToTop() {
  const btn = document.getElementById('back-to-top');
  window.addEventListener('scroll', () => btn.classList.toggle('show', window.scrollY > 400));
  btn.addEventListener('click', () => window.scrollTo({ top: 0, behavior: 'smooth' }));
}

function initFAB() {
  const wrap = document.getElementById('fab-wrap');
  document.getElementById('fab-main').addEventListener('click', () => wrap.classList.toggle('open'));
  wrap.querySelectorAll('.fab-item').forEach(btn => {
    btn.addEventListener('click', () => {
      const action = btn.dataset.action;
      if (action === 'predict') showPage('prediction');
      if (action === 'theme') toggleTheme();
      if (action === 'export') {
        const activePage = document.querySelector('.page.active');
        const canvas = activePage?.querySelector('canvas[id]');
        if (canvas) exportChartAsPNG(canvas.id); else toast('No chart to export on this page', 'fa-solid fa-triangle-exclamation');
      }
      wrap.classList.remove('open');
    });
  });
}

function initFullscreen() {
  document.getElementById('fullscreen-btn').addEventListener('click', () => {
    if (!document.fullscreenElement) document.documentElement.requestFullscreen?.();
    else document.exitFullscreen?.();
  });
}

function initNotifications() {
  document.getElementById('notif-btn').addEventListener('click', () => {
    toast('Peak production expected in Riyadh today (8.4 kWh/m²)', 'fa-solid fa-bell');
  });
}

/* ============================================================
   16b. CINEMATIC HERO: panel field, energy pulses, parallax, tilt
   ============================================================ */
function buildCinematicPanelField() {
  const field = document.getElementById('cine-panel-field');
  if (!field) return;
  const count = window.innerWidth < 860 ? 6 : 11;
  field.innerHTML = '';
  for (let i = 0; i < count; i++) {
    const p = document.createElement('div');
    p.className = 'cine-panel';
    const sheenDur = 5 + Math.random() * 3;
    p.style.animationName = 'panelRise, panelSheen';
    p.style.animationDuration = `1.1s, ${sheenDur}s`;
    p.style.animationTimingFunction = 'cubic-bezier(0.16,1,0.3,1), ease-in-out';
    p.style.animationIterationCount = '1, infinite';
    p.style.animationFillMode = 'forwards, none';
    p.style.animationDelay = `${0.15 + i * 0.08}s, ${1.2 + Math.random() * 3}s`;
    field.appendChild(p);
  }
  drawEnergyPulses(count);
}

function drawEnergyPulses(count) {
  const old = document.getElementById('cine-energy-svg');
  if (old) old.remove();
  const field = document.getElementById('cine-panel-field');
  if (!field) return;
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('id', 'cine-energy-svg');
  svg.setAttribute('class', 'cine-energy-svg');
  svg.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;overflow:visible;pointer-events:none;';
  field.appendChild(svg);

  requestAnimationFrame(() => {
    const panels = field.querySelectorAll('.cine-panel');
    if (!panels.length) return;
    const fieldRect = field.getBoundingClientRect();
    const points = Array.from(panels).map(p => {
      const r = p.getBoundingClientRect();
      return { x: r.left - fieldRect.left + r.width / 2, y: r.top - fieldRect.top + 6 };
    });
    for (let i = 0; i < points.length - 1; i++) {
      const a = points[i], b = points[i + 1];
      const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      const d = `M${a.x},${a.y} L${b.x},${b.y}`;
      path.setAttribute('d', d);
      path.setAttribute('id', `epath-${i}`);
      path.setAttribute('stroke', 'rgba(253,184,19,0.18)');
      path.setAttribute('stroke-width', '1');
      path.setAttribute('fill', 'none');
      svg.appendChild(path);

      const dot = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
      dot.setAttribute('r', '2.6');
      dot.setAttribute('fill', COLORS.yellow);
      dot.style.filter = 'drop-shadow(0 0 4px rgba(255,213,74,0.9))';
      const anim = document.createElementNS('http://www.w3.org/2000/svg', 'animateMotion');
      anim.setAttribute('dur', `${2 + Math.random() * 1.5}s`);
      anim.setAttribute('repeatCount', 'indefinite');
      anim.setAttribute('begin', `${Math.random() * 2}s`);
      anim.setAttribute('path', d);
      dot.appendChild(anim);
      svg.appendChild(dot);
    }
  });
}

function initParallax() {
  const hero = document.getElementById('hero');
  const aura = document.getElementById('mouse-aura');
  if (!hero) return;
  const layers = hero.querySelectorAll('.parallax-layer');
  hero.addEventListener('mousemove', (e) => {
    const rect = hero.getBoundingClientRect();
    const nx = (e.clientX - rect.left) / rect.width - 0.5;
    const ny = (e.clientY - rect.top) / rect.height - 0.5;
    layers.forEach(layer => {
      const depth = parseFloat(layer.dataset.depth) || 8;
      layer.style.transform = `translate3d(${nx * depth}px, ${ny * depth}px, 0)`;
    });
    if (aura) { aura.style.left = (e.clientX - rect.left) + 'px'; aura.style.top = (e.clientY - rect.top) + 'px'; }
  });
  hero.addEventListener('mouseleave', () => {
    layers.forEach(layer => { layer.style.transform = 'translate3d(0,0,0)'; });
  });
}

function initTiltCards() {
  if (window.matchMedia('(pointer: coarse)').matches) return;
  const selector = '.kpi-card, .weather-card, .panel-card, .gauge-card, .chart-card';
  document.body.addEventListener('mouseenter', (e) => {
    const card = e.target.closest?.(selector);
    if (!card || !document.body.contains(card)) return;
  }, true);

  document.addEventListener('mousemove', (e) => {
    const card = e.target.closest?.(selector);
    if (!card) return;
    const rect = card.getBoundingClientRect();
    const px = (e.clientX - rect.left) / rect.width - 0.5;
    const py = (e.clientY - rect.top) / rect.height - 0.5;
    card.style.transition = 'transform 0.06s linear';
    card.style.transform = `perspective(900px) rotateX(${(-py * 6).toFixed(2)}deg) rotateY(${(px * 6).toFixed(2)}deg) translateY(-4px)`;
  });
  document.addEventListener('mouseout', (e) => {
    const card = e.target.closest?.(selector);
    if (!card) return;
    const related = e.relatedTarget;
    if (related && card.contains(related)) return;
    card.style.transition = 'transform 0.45s cubic-bezier(0.22,1,0.36,1)';
    card.style.transform = '';
  });
}

function initMobileSidebar() {
  const sidebar = document.getElementById('sidebar');
  const overlay = document.getElementById('sidebar-overlay');
  document.getElementById('mobile-menu-btn').addEventListener('click', () => {
    sidebar.classList.add('mobile-open'); overlay.classList.add('show');
  });
  overlay.addEventListener('click', () => { sidebar.classList.remove('mobile-open'); overlay.classList.remove('show'); });
  document.getElementById('sidebar-collapse-btn').addEventListener('click', () => sidebar.classList.toggle('collapsed'));
}

function initExportButtons() {
  document.querySelectorAll('.export-btn').forEach(btn => btn.addEventListener('click', () => exportChartAsPNG(btn.dataset.chart)));
}

function initSettings() {
  document.getElementById('setting-anim').addEventListener('change', (e) => {
    document.body.style.setProperty('scroll-behavior', e.target.checked ? 'smooth' : 'auto');
    toast(e.target.checked ? 'Animations enabled' : 'Animations reduced');
  });
  document.getElementById('setting-notif').addEventListener('change', (e) => toast(e.target.checked ? 'Notifications enabled' : 'Notifications muted'));
  document.querySelectorAll('#setting-units button').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('#setting-units button').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      state.units = btn.dataset.val;
      renderWeather();
      toast(`Units switched to ${btn.dataset.val}`);
    });
  });
  document.getElementById('btn-reset-data').addEventListener('click', () => {
    loadData();
    updateDashboard();
    renderAnalytics();
    renderHistoricalTable();
    toast('Sample data regenerated', 'fa-solid fa-arrows-rotate');
  });
}

function initHeroStats() {
  document.querySelectorAll('.hero-stat-num[data-count]').forEach((el, i) => {
    const target = parseFloat(el.dataset.count);
    setTimeout(() => countUp(el, target, { duration: 1300 }), 400 + i * 150);
  });
}

/* ============================================================
   17. LOADING SCREEN
   ============================================================ */
function setLoaderProgress(pct) {
  const circumference = 2 * Math.PI * 52;
  document.getElementById('loader-bar-fill').style.width = pct + '%';
  document.getElementById('loader-ring-fg').style.strokeDashoffset = circumference * (1 - pct / 100);
  document.getElementById('loader-pct').textContent = Math.round(pct) + '%';
}
function hideLoader() {
  setLoaderProgress(100);
  setTimeout(() => document.getElementById('loading-screen').classList.add('hidden'), 500);
}

/* ============================================================
   18. INIT
   ============================================================ */
document.addEventListener('DOMContentLoaded', () => {
  setLoaderProgress(15);

  loadData();
  setLoaderProgress(35);
  renderKPICards();
  updateCharts();
  setLoaderProgress(55);
  renderWeather();
  renderPanels();
  renderHistoricalTable();
  renderPerformance();
  setLoaderProgress(75);

  initNavigation();
  initAnalyticsFilters();
  renderAnalytics();
  initPredictionForm();
  initTableControls();
  initSettings();
  setLoaderProgress(90);

  initClock();
  initTheme();
  initParticles();
  initCursorGlow();
  initRipple();
  initScrollObserver();
  initBackToTop();
  initFAB();
  initFullscreen();
  initNotifications();
  initMobileSidebar();
  initExportButtons();
  buildCinematicPanelField();
  initParallax();
  initTiltCards();
  window.addEventListener('resize', debounce(buildCinematicPanelField, 400));

  document.querySelectorAll('#page-dashboard .reveal').forEach((el, i) => setTimeout(() => el.classList.add('in-view'), 100 + i * 60));
  initHeroStats();

  setTimeout(hideLoader, 900);
});
