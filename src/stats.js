const fs = require('fs');
const os = require('os');

const MB = 1024 * 1024;
const DURATION_WINDOW = 1000;
const HISTORY_SIZE = 120;
// Setelah model termuat, sisa alokasi dan garbage dari proses load masih
// terlihat beberapa detik; sampel pada rentang ini tidak dihitung sebagai idle.
const STARTUP_SETTLE_MS = 10000;

function round(value, digits) {
  const factor = Math.pow(10, digits === undefined ? 1 : digits);
  return Math.round(value * factor) / factor;
}

function toMb(bytes) {
  return round(bytes / MB, 1);
}

function increment(map, key) {
  map[key] = (map[key] || 0) + 1;
}

function percentile(sortedValues, p) {
  if (sortedValues.length === 0) return 0;
  const index = Math.min(sortedValues.length - 1, Math.ceil((p / 100) * sortedValues.length) - 1);
  return sortedValues[Math.max(0, index)];
}

function hrtimeMs(start) {
  const diff = process.hrtime(start);
  return diff[0] * 1e3 + diff[1] / 1e6;
}

// os.freemem() menghitung page cache sebagai terpakai. Di Linux, MemAvailable
// lebih mencerminkan memori yang benar-benar masih bisa dipakai.
function availableMemory() {
  try {
    const match = /^MemAvailable:\s+(\d+)\s+kB/m.exec(fs.readFileSync('/proc/meminfo', 'utf8'));
    if (match) return { bytes: Number(match[1]) * 1024, source: 'MemAvailable' };
  } catch (error) {
    // Bukan Linux.
  }
  return { bytes: os.freemem(), source: 'os.freemem' };
}

function createAggregate() {
  return { samples: 0, cpuSum: 0, cpuPeak: 0, rssSum: 0, rssPeak: 0, heapSum: 0, heapPeak: 0 };
}

function addToAggregate(aggregate, sample) {
  aggregate.samples += 1;
  aggregate.cpuSum += sample.cpuPercent;
  aggregate.cpuPeak = Math.max(aggregate.cpuPeak, sample.cpuPercent);
  aggregate.rssSum += sample.rss;
  aggregate.rssPeak = Math.max(aggregate.rssPeak, sample.rss);
  aggregate.heapSum += sample.heapUsed;
  aggregate.heapPeak = Math.max(aggregate.heapPeak, sample.heapUsed);
}

function formatAggregate(aggregate, cores, intervalMs) {
  if (aggregate.samples === 0) return { samples: 0, seconds: 0 };
  const cpuAvg = aggregate.cpuSum / aggregate.samples;
  return {
    samples: aggregate.samples,
    seconds: round((aggregate.samples * intervalMs) / 1000, 0),
    cpu_percent: { avg: round(cpuAvg), peak: round(aggregate.cpuPeak) },
    cpu_percent_all_cores: { avg: round(cpuAvg / cores), peak: round(aggregate.cpuPeak / cores) },
    rss_mb: { avg: toMb(aggregate.rssSum / aggregate.samples), peak: toMb(aggregate.rssPeak) },
    heap_used_mb: { avg: toMb(aggregate.heapSum / aggregate.samples), peak: toMb(aggregate.heapPeak) }
  };
}

// Mengukur CPU/RAM proses secara periodik dan mengelompokkan sampel menjadi
// startup (model belum termuat), idle, dan busy (ada inferensi berjalan).
class ResourceMonitor {
  constructor({ intervalMs, isReady, tensorMemory }) {
    this.intervalMs = intervalMs;
    this.isReady = isReady;
    this.tensorMemory = tensorMemory;
    this.cores = os.cpus().length || 1;
    this.inFlight = 0;
    this.busySinceLastSample = false;
    this.aggregates = { startup: createAggregate(), idle: createAggregate(), busy: createAggregate() };
    this.overall = { rssPeak: 0, heapPeak: 0, cpuPeak: 0 };
    this.history = [];
    this.current = null;
    this.readyAt = null;
    this.inference = {
      count: 0,
      overlapping: 0,
      durations: [],
      wallSum: 0,
      wallMax: 0,
      cpuSum: 0,
      cpuMax: 0,
      cpuPercentMax: 0,
      last: null
    };
    this.timer = null;
  }

  start() {
    this.lastCpu = process.cpuUsage();
    this.lastTime = process.hrtime();
    this.timer = setInterval(() => this.sample(), this.intervalMs);
    if (this.timer.unref) this.timer.unref();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
  }

  sample() {
    const elapsedMs = hrtimeMs(this.lastTime);
    const cpu = process.cpuUsage(this.lastCpu);
    this.lastCpu = process.cpuUsage();
    this.lastTime = process.hrtime();
    if (elapsedMs <= 0) return;

    const memory = process.memoryUsage();
    const ready = this.isReady();
    // Sampel pertama setelah model siap mencakup sisa proses load, jadi
    // readyAt dicatat di sini dan masa settle dihitung dari titik ini.
    if (ready && this.readyAt === null) this.readyAt = Date.now();
    const busy = this.busySinceLastSample || this.inFlight > 0;
    const settling = !ready || Date.now() - this.readyAt < STARTUP_SETTLE_MS;
    let state = 'idle';
    if (busy) state = 'busy';
    else if (settling) state = 'startup';
    this.busySinceLastSample = this.inFlight > 0;

    const sample = {
      at: new Date().toISOString(),
      state,
      cpuPercent: ((cpu.user + cpu.system) / 1000 / elapsedMs) * 100,
      rss: memory.rss,
      heapUsed: memory.heapUsed
    };
    this.current = sample;
    addToAggregate(this.aggregates[state], sample);
    this.overall.rssPeak = Math.max(this.overall.rssPeak, sample.rss);
    this.overall.heapPeak = Math.max(this.overall.heapPeak, sample.heapUsed);
    this.overall.cpuPeak = Math.max(this.overall.cpuPeak, sample.cpuPercent);

    this.history.push(sample);
    if (this.history.length > HISTORY_SIZE) this.history.shift();
  }

  // Membungkus satu inferensi untuk mengukur waktu, CPU, dan RAM-nya.
  async track(task) {
    const overlapping = this.inFlight > 0;
    this.inFlight += 1;
    this.busySinceLastSample = true;
    const cpuStart = process.cpuUsage();
    const timeStart = process.hrtime();
    try {
      return await task();
    } finally {
      this.inFlight -= 1;
      const wallMs = hrtimeMs(timeStart);
      const cpu = process.cpuUsage(cpuStart);
      const cpuMs = (cpu.user + cpu.system) / 1000;
      const memory = process.memoryUsage();
      const cpuPercent = wallMs > 0 ? (cpuMs / wallMs) * 100 : 0;

      const stats = this.inference;
      stats.count += 1;
      if (overlapping || this.inFlight > 0) stats.overlapping += 1;
      stats.durations.push(wallMs);
      if (stats.durations.length > DURATION_WINDOW) stats.durations.shift();
      stats.wallSum += wallMs;
      stats.wallMax = Math.max(stats.wallMax, wallMs);
      stats.cpuSum += cpuMs;
      stats.cpuMax = Math.max(stats.cpuMax, cpuMs);
      stats.cpuPercentMax = Math.max(stats.cpuPercentMax, cpuPercent);
      stats.last = {
        at: new Date().toISOString(),
        wall_ms: round(wallMs),
        cpu_ms: round(cpuMs),
        cpu_percent: round(cpuPercent),
        rss_mb: toMb(memory.rss)
      };
      this.overall.rssPeak = Math.max(this.overall.rssPeak, memory.rss);
      this.overall.heapPeak = Math.max(this.overall.heapPeak, memory.heapUsed);
    }
  }

  report({ includeHistory }) {
    const memory = process.memoryUsage();
    const stats = this.inference;
    const sorted = stats.durations.slice().sort((a, b) => a - b);
    const avgWall = stats.count ? stats.wallSum / stats.count : 0;
    const avgCpu = stats.count ? stats.cpuSum / stats.count : 0;
    const available = availableMemory();
    let tensors = null;
    try {
      const tfMemory = this.tensorMemory();
      if (tfMemory) tensors = { count: tfMemory.numTensors, mb: toMb(tfMemory.numBytes) };
    } catch (error) {
      tensors = null;
    }

    const result = {
      notes: {
        cpu_percent: '100 = satu core penuh; bisa > 100 karena TensorFlow memakai banyak thread.',
        cpu_percent_all_cores: '100 = seluruh core server penuh.',
        states: 'startup = model sedang dimuat atau belum 10 detik sejak termuat, idle = tidak ada inferensi, busy = ada inferensi selama interval sampel.',
        busy_vs_per_inference: 'busy dirata-rata per interval sampel sehingga lebih rendah dari beban sesaat; lihat per_inference untuk CPU saat benar-benar memproses.',
        inference_cpu: 'CPU per inferensi diukur dari seluruh proses; saat inferensi tumpang tindih (overlapping) angkanya ikut tercampur.'
      },
      sample_interval_ms: this.intervalMs,
      cpu_cores: this.cores,
      current: {
        state: this.current ? this.current.state : null,
        in_flight: this.inFlight,
        cpu_percent: this.current ? round(this.current.cpuPercent) : null,
        rss_mb: toMb(memory.rss),
        heap_used_mb: toMb(memory.heapUsed),
        heap_total_mb: toMb(memory.heapTotal),
        external_mb: toMb(memory.external),
        tensors
      },
      idle: formatAggregate(this.aggregates.idle, this.cores, this.intervalMs),
      busy: formatAggregate(this.aggregates.busy, this.cores, this.intervalMs),
      startup: formatAggregate(this.aggregates.startup, this.cores, this.intervalMs),
      peak: {
        cpu_percent: round(this.overall.cpuPeak),
        cpu_percent_all_cores: round(this.overall.cpuPeak / this.cores),
        rss_mb: toMb(this.overall.rssPeak),
        heap_used_mb: toMb(this.overall.heapPeak)
      },
      per_inference: {
        count: stats.count,
        overlapping: stats.overlapping,
        wall_ms: {
          avg: round(avgWall),
          p50: round(percentile(sorted, 50)),
          p95: round(percentile(sorted, 95)),
          max: round(stats.wallMax)
        },
        cpu_ms: { avg: round(avgCpu), max: round(stats.cpuMax) },
        cpu_percent: { avg: avgWall ? round((avgCpu / avgWall) * 100) : 0, max: round(stats.cpuPercentMax) },
        last: stats.last
      },
      system: {
        load_avg: os.loadavg().map((value) => round(value, 2)),
        total_mem_mb: toMb(os.totalmem()),
        available_mem_mb: toMb(available.bytes),
        available_mem_source: available.source
      }
    };

    if (includeHistory) {
      result.history = this.history.map((sample) => ({
        at: sample.at,
        state: sample.state,
        cpu_percent: round(sample.cpuPercent),
        rss_mb: toMb(sample.rss)
      }));
    }
    return result;
  }
}

// Menghitung request (lolos/diblokir oleh autentikasi) dan hasil moderasi
// (gambar lolos/diblokir sebagai NSFW). Disimpan di memori; reset saat restart.
class RequestStats {
  constructor() {
    this.startedAt = new Date();
    this.requests = {
      total: 0,
      allowed: 0,
      blocked: 0,
      aborted: 0,
      blocked_by_reason: {},
      by_source: { local: 0, remote: 0 },
      by_status: {},
      by_route: {}
    };
    this.clients = {};
    this.moderation = {
      total: 0,
      safe: 0,
      nsfw: 0,
      errors: 0,
      flagged_by_category: {}
    };
  }

  middleware() {
    return (request, response, next) => {
      if (request.method === 'OPTIONS') return next();
      this.requests.total += 1;
      let finished = false;
      response.on('finish', () => {
        finished = true;
        increment(this.requests.by_status, `${String(response.statusCode).charAt(0)}xx`);
        let route = '(unmatched)';
        if (request.access && !request.access.allowed) route = '(rejected)';
        else if (request.route) route = `${request.method} ${request.baseUrl}${request.route.path}`;
        increment(this.requests.by_route, route);
      });
      response.on('close', () => {
        if (!finished) this.requests.aborted += 1;
      });
      next();
    };
  }

  recordAccess(access) {
    this.requests.by_source[access.local ? 'local' : 'remote'] += 1;
    if (!access.allowed) {
      this.requests.blocked += 1;
      increment(this.requests.blocked_by_reason, access.reason);
      return;
    }
    this.requests.allowed += 1;
    const client = access.client;
    if (!this.clients[client.id]) {
      this.clients[client.id] = { name: client.name, requests: 0, moderated: 0, nsfw: 0, last_seen_at: null };
    }
    this.clients[client.id].requests += 1;
    this.clients[client.id].last_seen_at = new Date().toISOString();
  }

  recordModeration(access, result) {
    this.moderation.total += 1;
    this.moderation[result.is_nsfw ? 'nsfw' : 'safe'] += 1;
    result.flagged_categories.forEach(({ category }) => increment(this.moderation.flagged_by_category, category));
    const client = access && access.client && this.clients[access.client.id];
    if (client) {
      client.moderated += 1;
      if (result.is_nsfw) client.nsfw += 1;
    }
  }

  recordModerationError() {
    this.moderation.errors += 1;
  }

  report() {
    return {
      started_at: this.startedAt.toISOString(),
      uptime_seconds: Math.round(process.uptime()),
      requests: this.requests,
      moderation: this.moderation,
      clients: this.clients
    };
  }
}

module.exports = { RequestStats, ResourceMonitor };
