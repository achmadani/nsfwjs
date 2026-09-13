# NSFW image moderation API

REST API berbasis NSFWJS dan TensorFlow.js untuk memeriksa gambar. Baseline runtime adalah Node.js 12.22+ (butuh N-API v8 untuk binding TensorFlow); Node 14–22 juga didukung.

Catatan kompatibilitas Node 12 di `package.json`:

- `helmet` dikunci di 5.x (6+ butuh Node 14/18).
- `adm-zip` dikunci di 0.5.17 — 0.5.18 memakai optional chaining sehingga install script `@tensorflow/tfjs-node` gagal di Node 12.
- `buffer` dipasang eksplisit karena npm 6 (bawaan Node 12) tidak memasang peer dependency `nsfwjs` otomatis.
- `nodemon` dikunci di 2.x untuk `npm run dev`.

Binding TensorFlow prebuilt hanya tersedia untuk **Linux x64**. Di macOS `npm install` biasa gagal — lihat [Development di macOS](#development-di-macos-apple-silicon-dengan-node-12).

## Syarat server

| Syarat | Minimum | Alasan |
| --- | --- | --- |
| Node.js | 12.22.0 | binding TensorFlow butuh N-API v8 |
| glibc | 2.17 | `libtensorflow` prebuilt |
| CPU | AVX | `libtensorflow` dikompilasi dengan AVX; tanpa AVX proses mati (`Illegal instruction`) |
| OS/arch | Linux x64 | satu-satunya platform dengan binding prebuilt |

Cek di server:

```bash
node -v; node -p process.versions.napi
uname -r; ldd --version | head -1
grep -o avx /proc/cpuinfo | head -1
```

`process.versions.napi` harus `8` atau lebih.

Contoh hasil pengecekan:

| Server | Kernel / glibc | Hasil |
| --- | --- | --- |
| Ubuntu 18.04, Node 12.22.1 | 4.15 / 2.27 | jalan, `npm install` biasa |
| CentOS 7, Node 16.20.2 | 3.10 / 2.17 | memenuhi syarat |
| CentOS 6 | 2.6.32 / 2.12 | **tidak bisa** — glibc terlalu tua untuk Node ≥10, Docker 1.7 tidak bisa menarik image modern, dan kernel 2.6.32 menolak base image modern. Jadikan client HTTP saja. |

## Instalasi (Linux)

```bash
nvm use 12
npm install --production
cp .env.example .env
npm run lint
npm start
```

TensorFlow.js memasang native binding saat `npm install`: `@tensorflow/tfjs-node` mengunduh binding (napi-v8) dan `libtensorflow` (±100 MB) dari `storage.googleapis.com`. Server harus bisa mengakses host itu saat install; kalau terblokir, npm jatuh ke compile dari sumber dan butuh `build-essential` + `python3`.

- Jalankan `npm install` pada OS dan arsitektur yang sama dengan production. Jangan menyalin `node_modules` dari macOS ke Linux.
- Jangan memakai `npm install --ignore-scripts` di Linux — binding tidak akan terpasang.
- npm 6 (bawaan Node 12) memakai `--production`, bukan `--omit=dev`, dan mengabaikan field `overrides`. Karena itu `adm-zip` dipasang sebagai dependency langsung.

Uji cepat setelah install:

```bash
node -e "require('@tensorflow/tfjs-node'); require('nsfwjs'); console.log('ok')"
```

Model default dimuat ketika service mulai dan dapat memerlukan akses internet sekali. Untuk deployment yang deterministik, simpan model NSFWJS di server, set `NSFW_MODEL_PATH` ke direktorinya, lalu jalankan `npm run prepare-model` sebagai langkah dokumentasi/pre-deploy.

## Endpoint

| Route | Dari localhost | Dari luar |
| --- | --- | --- |
| `GET /health` | bebas | butuh API key |
| `POST /moderate` | bebas | butuh API key |
| `GET /admin/report` | bebas | **403** |
| `GET/POST /admin/keys`, `DELETE /admin/keys/:id` | bebas | **403** |
| `GET /admin/dashboard/` (atau `/admin`) | bebas, lewat browser | **403** |

`GET /health` mengembalikan status service dan apakah model sudah selesai dimuat.

`POST /moderate` menerima `multipart/form-data` dengan field `image`:

```bash
curl -F image=@photo.jpg http://localhost:8005/moderate
```

Dari luar, sertakan API key:

```bash
curl -H "X-API-Key: nsfw_xxx" -F image=@photo.jpg https://nsfw.example.com/moderate
```

`Authorization: Bearer nsfw_xxx` juga diterima.

Response memiliki `is_nsfw`, `flagged_categories`, `scores`, `thresholds`, dan seluruh `predictions`. Kategori `Porn`, `Hentai`, atau `Sexy` ter-flag jika probabilitasnya minimal threshold kategori tersebut.

### Threshold

Threshold diatur per kategori. Default:

| Kategori | Default | Alasan |
| --- | --- | --- |
| `Porn` | `0.3` | ketat, false negative lebih mahal |
| `Hentai` | `0.3` | ketat, false negative lebih mahal |
| `Sexy` | `0.8` | longgar, kelas paling noisy (pakaian minim/pose biasa) |

Override lewat `NSFW_THRESHOLD_PORN`, `NSFW_THRESHOLD_HENTAI`, `NSFW_THRESHOLD_SEXY`. `NSFW_THRESHOLD` dipakai sebagai fallback untuk kategori yang tidak diset — mengisinya akan menyamakan semua kategori, jadi biarkan kosong bila ingin default di atas.

## Akses & API key

**Localhost** (`127.0.0.1` / `::1`) boleh mengakses semua route tanpa key. Status localhost ditentukan dari alamat socket TCP, bukan dari header, sehingga tidak bisa dipalsukan dari luar.

Request yang membawa header proxy — `X-Forwarded-For`, `X-Real-IP`, `Forwarded`, `X-Forwarded-Host`, `X-Forwarded-Proto`, `CF-Connecting-IP`, `True-Client-IP`, `X-Client-IP` — **selalu dianggap dari luar**, walaupun socket-nya dari 127.0.0.1. Ini yang membuat service aman di belakang nginx atau Cloudflare Tunnel: trafik internet yang diteruskan proxy tetap wajib pakai key. Konsekuensinya, proxy **wajib** mengirim salah satu header tersebut (lihat konfigurasi nginx di bawah). Set `LOCAL_BYPASS=false` untuk mewajibkan key bahkan dari localhost.

**Dari luar**, setiap request butuh API key. Satu key per user/aplikasi, supaya bisa dicabut sendiri-sendiri dan pemakaiannya terlihat per client di report. Key disimpan sebagai hash SHA-256 di `API_KEYS_FILE` (default `data/api-keys.json`, permission `0600`, sudah di-`.gitignore`); key asli hanya ditampilkan sekali saat dibuat.

Kelola key lewat CLI (bisa saat server berjalan — perubahan terbaca otomatis dalam ±2 detik):

```bash
npm run keys -- create "Aplikasi Sekolah"
npm run keys -- list
npm run keys -- revoke "Aplikasi Sekolah"
```

Atau lewat route admin dari localhost:

```bash
curl -H "Content-Type: application/json" -d '{"name":"Aplikasi Sekolah"}' http://127.0.0.1:8005/admin/keys
curl http://127.0.0.1:8005/admin/keys
curl -X DELETE http://127.0.0.1:8005/admin/keys/<id>
```

Autentikasi berjalan sebelum upload diproses, jadi request tanpa key ditolak tanpa file-nya sempat dibaca ke memori.

### Integrasi dari aplikasi lain

Ringkasan request:

| | |
| --- | --- |
| Method & URL | `POST https://nsfw.example.com/moderate` |
| Header wajib | `X-API-Key: nsfw_xxx` (atau `Authorization: Bearer nsfw_xxx`) |
| Header disarankan | `Accept: application/json` |
| Body | `multipart/form-data` |
| Field | `image` — tepat satu file |
| Tipe file | `image/jpeg`, `image/png`, `image/webp`, `image/gif` (atur lewat `ALLOWED_MIME_TYPES`) |
| Ukuran maksimal | 10 MB (atur lewat `MAX_FILE_SIZE_MB`; samakan dengan `client_max_body_size` nginx) |
| Response | selalu JSON (`Content-Type: application/json`) |

Tidak ada parameter query. Input berupa URL gambar atau base64 **tidak** didukung — kirim file-nya.

Panggil API ini **dari backend**, jangan dari JavaScript di browser atau aplikasi mobile: API key akan terlihat oleh siapa pun yang membuka DevTools atau membongkar aplikasinya.

#### cURL

```bash
curl -X POST https://nsfw.example.com/moderate \
  -H "X-API-Key: nsfw_xxx" \
  -H "Accept: application/json" \
  -F "image=@foto.jpg;type=image/jpeg"
```

Cek service (misalnya untuk monitoring):

```bash
curl -H "X-API-Key: nsfw_xxx" https://nsfw.example.com/health
```

```json
{"status":"ok","model_loaded":true,"uptime_seconds":7}
```

`status` bernilai `loading` selama model belum termuat. Request `/moderate` yang masuk pada saat itu **tidak ditolak**, tetapi menunggu sampai model siap.

#### PHP (5.5+, termasuk 5.6)

```php
<?php
/**
 * Kirim gambar ke NSFW moderation API.
 * Kompatibel PHP 5.5+ (CURLFile).
 *
 * @return array ['ok' => bool, 'status' => int, 'code' => string|null, 'error' => string|null, 'data' => array|null]
 */
function nsfw_moderate($filePath, $originalName = null)
{
    $baseUrl = 'https://nsfw.example.com';   // ganti
    $apiKey  = getenv('NSFW_API_KEY');       // simpan di env/config, jangan di-hardcode

    $finfo = finfo_open(FILEINFO_MIME_TYPE);
    $mime  = finfo_file($finfo, $filePath);
    finfo_close($finfo);

    $ch = curl_init(rtrim($baseUrl, '/') . '/moderate');
    curl_setopt_array($ch, array(
        CURLOPT_POST           => true,
        CURLOPT_POSTFIELDS     => array(
            'image' => new CURLFile($filePath, $mime, $originalName ? $originalName : basename($filePath)),
        ),
        CURLOPT_HTTPHEADER     => array(
            'X-API-Key: ' . $apiKey,
            'Accept: application/json',
            'Expect:',                       // hindari jeda "100 Continue"
        ),
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_CONNECTTIMEOUT => 5,
        CURLOPT_TIMEOUT        => 30,
    ));

    $body   = curl_exec($ch);
    $status = (int) curl_getinfo($ch, CURLINFO_HTTP_CODE);
    $curlError = curl_error($ch);
    curl_close($ch);

    if ($body === false) {
        return array('ok' => false, 'status' => 0, 'code' => 'network_error', 'error' => $curlError, 'data' => null);
    }

    $data = json_decode($body, true);
    if ($status !== 200) {
        return array(
            'ok'     => false,
            'status' => $status,
            'code'   => isset($data['code']) ? $data['code'] : null,
            'error'  => isset($data['error']) ? $data['error'] : 'HTTP ' . $status,
            'data'   => $data,
        );
    }

    return array('ok' => true, 'status' => 200, 'code' => null, 'error' => null, 'data' => $data);
}
```

Pemakaian pada form upload (CodeIgniter / Laravel / PHP native):

```php
<?php
$file = $_FILES['foto'];
$result = nsfw_moderate($file['tmp_name'], $file['name']);

if (!$result['ok']) {
    // Service gagal/tidak bisa dihubungi. Tentukan kebijakan: tolak (aman) atau terima lalu review manual.
    error_log('NSFW API: ' . $result['status'] . ' ' . $result['error']);
    exit('Gambar belum bisa diverifikasi, coba lagi nanti.');
}

if ($result['data']['is_nsfw']) {
    exit('Gambar ditolak karena mengandung konten tidak pantas.');
}

// Lolos — simpan file.
move_uploaded_file($file['tmp_name'], $tujuan);
```

MIME dideteksi dari isi file (`finfo`), bukan dari ekstensi atau data kiriman browser — file bukan gambar yang di-rename jadi `.jpg` langsung ditolak dengan `400`.

#### Node.js (8+, tanpa dependency)

```js
// Kirim gambar ke NSFW moderation API tanpa dependency.
// Kompatibel Node.js 8+.
const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const crypto = require('crypto');
const URL = require('url').URL;

const MIME_TYPES = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.gif': 'image/gif' };

function moderateImage(filePath, options) {
  const url = new URL('/moderate', options.baseUrl);
  const boundary = '----nsfw' + crypto.randomBytes(12).toString('hex');
  const filename = options.filename || path.basename(filePath);
  const mimeType = MIME_TYPES[path.extname(filename).toLowerCase()] || 'application/octet-stream';

  const body = Buffer.concat([
    Buffer.from(
      '--' + boundary + '\r\n' +
      'Content-Disposition: form-data; name="image"; filename="' + filename.replace(/"/g, '') + '"\r\n' +
      'Content-Type: ' + mimeType + '\r\n\r\n'
    ),
    fs.readFileSync(filePath),
    Buffer.from('\r\n--' + boundary + '--\r\n')
  ]);

  const transport = url.protocol === 'https:' ? https : http;

  return new Promise((resolve) => {
    const request = transport.request({
      method: 'POST',
      hostname: url.hostname,
      port: url.port,
      path: url.pathname,
      headers: {
        'X-API-Key': options.apiKey,
        'Accept': 'application/json',
        'Content-Type': 'multipart/form-data; boundary=' + boundary,
        'Content-Length': body.length
      },
      timeout: options.timeoutMs || 30000
    }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => {
        let data = null;
        try {
          data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        } catch (error) {
          data = null;
        }
        const ok = response.statusCode === 200;
        resolve({
          ok: ok,
          status: response.statusCode,
          code: ok ? null : (data && data.code) || null,
          error: ok ? null : (data && data.error) || 'HTTP ' + response.statusCode,
          data: data
        });
      });
    });

    request.on('timeout', () => request.destroy(new Error('Request timed out')));
    request.on('error', (error) => resolve({ ok: false, status: 0, code: 'network_error', error: error.message, data: null }));
    request.end(body);
  });
}

module.exports = moderateImage;
```

Pemakaian:

```js
const moderateImage = require('./moderate');

moderateImage('/tmp/upload/foto.jpg', {
  baseUrl: 'https://nsfw.example.com',
  apiKey: process.env.NSFW_API_KEY,
  filename: 'foto.jpg',
  timeoutMs: 30000
}).then((result) => {
  if (!result.ok) {
    console.error('NSFW API gagal:', result.status, result.code, result.error);
    return;
  }
  console.log(result.data.is_nsfw ? 'Diblokir' : 'Lolos');
});
```

Contoh di atas menentukan MIME dari ekstensi file. Kalau file berasal dari upload user, validasi dulu bahwa isinya benar-benar gambar.

#### Response sukses — `200 OK`

Gambar lolos (`is_nsfw: false`):

```json
{
  "is_nsfw": false,
  "thresholds": { "Porn": 0.3, "Hentai": 0.3, "Sexy": 0.8 },
  "predictions": [
    { "className": "Sexy", "probability": 0.4606899917125702 },
    { "className": "Neutral", "probability": 0.2623153626918793 },
    { "className": "Drawing", "probability": 0.12814347445964813 },
    { "className": "Hentai", "probability": 0.07721778005361557 },
    { "className": "Porn", "probability": 0.0716334730386734 }
  ],
  "scores": {
    "Sexy": 0.4606899917125702,
    "Neutral": 0.2623153626918793,
    "Drawing": 0.12814347445964813,
    "Hentai": 0.07721778005361557,
    "Porn": 0.0716334730386734
  },
  "flagged_categories": [],
  "filename": "test.jpg",
  "mime_type": "image/jpeg",
  "size_bytes": 44622
}
```

Gambar diblokir (`is_nsfw: true`). Contoh ini diambil dengan `NSFW_THRESHOLD_SEXY=0.5`:

```json
{
  "is_nsfw": true,
  "thresholds": { "Porn": 0.3, "Hentai": 0.3, "Sexy": 0.5 },
  "predictions": [
    { "className": "Sexy", "probability": 0.6956664323806763 },
    { "className": "Neutral", "probability": 0.21039915084838867 },
    { "className": "Drawing", "probability": 0.04875286668539047 },
    { "className": "Porn", "probability": 0.023141205310821533 },
    { "className": "Hentai", "probability": 0.022040363401174545 }
  ],
  "scores": {
    "Sexy": 0.6956664323806763,
    "Neutral": 0.21039915084838867,
    "Drawing": 0.04875286668539047,
    "Porn": 0.023141205310821533,
    "Hentai": 0.022040363401174545
  },
  "flagged_categories": [
    { "category": "Sexy", "probability": 0.6956664323806763, "threshold": 0.5 }
  ],
  "filename": "big.jpg",
  "mime_type": "image/jpeg",
  "size_bytes": 409695
}
```

| Field | Tipe | Arti |
| --- | --- | --- |
| `is_nsfw` | boolean | **keputusan akhir** — `true` jika minimal satu kategori mencapai threshold-nya |
| `flagged_categories` | array | kategori yang menyebabkan blokir, beserta skor dan threshold yang dipakai; kosong jika lolos |
| `thresholds` | object | threshold aktif di server saat request diproses |
| `predictions` | array | 5 kelas beserta probabilitas, urut dari tertinggi |
| `scores` | object | isi yang sama dengan `predictions`, dalam bentuk `{ kelas: probabilitas }` |
| `filename`, `mime_type`, `size_bytes` | | metadata file yang diterima server |

Probabilitas kelima kelas berjumlah ±1. `Neutral` dan `Drawing` adalah kelas aman; hanya `Porn`, `Hentai`, dan `Sexy` yang bisa memicu blokir. Cukup gunakan `is_nsfw` untuk keputusan, supaya perubahan threshold di server langsung berlaku tanpa mengubah aplikasi client.

#### Response gagal

Semua error berbentuk `{"error": "...", "code": "..."}`; `code` tidak selalu ada, jadi gunakan status HTTP sebagai acuan utama.

| Status | `code` | Body | Penyebab | Tindakan client |
| --- | --- | --- | --- | --- |
| 400 | — | `{"error":"An image file is required in multipart field \"image\"."}` | tidak ada file, **atau** tipe file tidak didukung | perbaiki request; jangan diulang |
| 400 | `LIMIT_UNEXPECTED_FILE` | `{"error":"Unexpected field","code":"LIMIT_UNEXPECTED_FILE"}` | nama field bukan `image`, atau lebih dari satu file | perbaiki nama field |
| 401 | `missing_key` | `{"error":"API key required. Send it in the \"X-API-Key\" header.","code":"missing_key"}` | header key tidak dikirim | periksa konfigurasi |
| 401 | `invalid_key` | `{"error":"Invalid API key.","code":"invalid_key"}` | key salah atau salah ketik | periksa konfigurasi |
| 401 | `revoked_key` | `{"error":"API key has been revoked.","code":"revoked_key"}` | key sudah dicabut | minta key baru |
| 403 | `local_only` | `{"error":"This route is only available from localhost.","code":"local_only"}` | mengakses `/admin/*` dari luar | tidak bisa; route khusus server |
| 403 | `cross_site` | `{"error":"Cross-origin requests are not allowed.","code":"cross_site"}` | `/admin/*` dengan `Host` bukan localhost atau dari origin lain | akses lewat `127.0.0.1`/`localhost` |
| 404 | — | `{"error":"Not found."}` | URL atau method salah (misalnya `GET /moderate`) | perbaiki URL/method |
| 413 | `LIMIT_FILE_SIZE` | `{"error":"File too large","code":"LIMIT_FILE_SIZE"}` | file melebihi `MAX_FILE_SIZE_MB` | kecilkan gambar dulu |
| 413 | — | halaman HTML nginx | file melebihi `client_max_body_size` nginx | kecilkan gambar dulu |
| 422 | — | `{"error":"The file could not be decoded or classified."}` | file rusak, atau bukan gambar walau MIME-nya gambar | tolak file |
| 502 / 504 | — | halaman HTML nginx | service mati/restart, atau timeout | ulangi dengan jeda |
| — | — | — | koneksi gagal / timeout di sisi client | ulangi dengan jeda |

Catatan untuk client:

- **Tentukan kebijakan saat service gagal** (5xx, timeout, koneksi gagal): *fail-closed* (tolak upload) lebih aman untuk aplikasi sekolah/anak; *fail-open* (terima lalu review manual) lebih ramah pengguna. Jangan diam-diam menganggap gambar lolos.
- Status `400`, `401`, `403`, `404`, `413`, dan `422` adalah kesalahan request — mengulang request yang sama akan menghasilkan error yang sama.
- Error dari nginx (`413`, `502`, `504`) berupa HTML, bukan JSON. Periksa status HTTP sebelum `json_decode` / `JSON.parse`.
- Waktu proses ±100 ms per gambar, tetapi request diproses bergantian. Saat ramai, request akan antre, jadi pakai timeout yang longgar (contoh di atas: 30 detik).
- Mengecilkan gambar sebelum dikirim (misalnya sisi terpanjang 1000 px) mempercepat upload tanpa menurunkan akurasi berarti, karena model memproses gambar pada 224×224 px.

## Report

`GET /admin/report` (localhost saja) mengembalikan JSON untuk dikonsumsi sistem lain. Untuk dilihat manusia, pakai [Dashboard](#dashboard).

Parameter opsional:

- `?history=1` — sertakan sampel CPU/RAM dan counter per detik, maksimal 15 menit terakhir.
- `?history_since=<epoch ms>` — hanya sampel setelah waktu tersebut (dipakai dashboard agar tiap refresh tidak mengunduh ulang semua riwayat).

```bash
curl -s http://127.0.0.1:8005/admin/report
```

Isi utama:

- `requests` — `total`, `allowed` (lolos autentikasi), `blocked` (ditolak), `blocked_by_reason`, `by_source` (local/remote), `by_status`, `by_route`. Percobaan ke route yang tidak ada tanpa key tercatat sebagai `(rejected)`. Request admin dari localhost yang diizinkan (dashboard, report, kelola key) **tidak** masuk hitungan ini, melainkan ke `admin`, supaya polling dashboard tidak menggelembungkan angka request masuk. Percobaan akses admin dari luar tetap tercatat sebagai `blocked`.
- `moderation` — jumlah gambar diproses: `safe` (lolos), `nsfw` (diblokir), `errors`, dan `flagged_by_category`.
- `clients` — per API key: jumlah request, gambar dimoderasi, jumlah NSFW, terakhir terlihat.
- `resources`:
  - `idle`, `busy`, `startup` — rata-rata dan peak CPU/RAM per kondisi.
  - `peak` — tertinggi sejak start.
  - `per_inference` — waktu (avg/p50/p95/max) dan CPU saat benar-benar memproses satu gambar. Ini angka yang paling akurat untuk "habis berapa CPU per gambar"; `busy` dirata-rata per detik sehingga lebih rendah.
  - `current`, `system` — kondisi saat ini, termasuk memori tensor TensorFlow dan `MemAvailable` server (di macOS memakai `os.freemem`, yang tidak akurat).
  - `history` (opsional) — per detik: `state`, `cpu_percent`, `rss_mb`, `heap_used_mb`, `in_flight`, dan `counters` kumulatif.
- `keys` — jumlah key total/aktif/dicabut.
- `service`, `config` — hostname, PID, versi Node/TensorFlow.js, sumber model, threshold, batas ukuran file, dan tipe file.

Cara membaca CPU: `cpu_percent` 100 = satu core penuh (bisa > 100 karena TensorFlow multi-thread); `cpu_percent_all_cores` 100 = semua core penuh.

Contoh hasil pengukuran (Mac M-series via Rosetta, gambar 2000px):

| Kondisi | CPU (1 core = 100) | RSS |
| --- | --- | --- |
| idle | ±0% | ±460–790 MB |
| per inferensi | ±280%, ±95 ms | — |
| peak | ±250% (sampel 1 dtk) | ±900 MB |

Inferensi dijalankan berurutan oleh event loop Node, jadi request bersamaan akan antre, bukan diproses paralel.

Statistik disimpan di memori dan **reset saat proses restart** (termasuk restart otomatis PM2). Dengan PM2 cluster/beberapa instance, tiap proses punya report sendiri — karena itu `ecosystem.config.js` memakai 1 instance.

## Dashboard

Tampilan visual dari report: `http://127.0.0.1:8005/admin/dashboard/` (atau cukup `/admin`). Hanya bisa dibuka dari localhost server — dari laptop, pakai [SSH tunnel](#akses-admin-dari-laptop-ssh-tunnel) lalu buka `http://127.0.0.1:8005/admin/dashboard/` di browser.

Isi:

- **Ringkasan** — total gambar dimoderasi (lolos / diblokir NSFW / error), request masuk, tingkat blokir, CPU & RAM saat ini beserta puncaknya, p95 inferensi, memori server, uptime, dan jumlah API key aktif.
- **Aktivitas** (rentang 1 / 5 / 15 menit) — grafik CPU dengan penanda saat sedang memproses, memori (RSS & heap), request per interval (lolos vs diblokir), dan hasil moderasi dalam rentang.
- **Performa** — waktu 60 inferensi terakhir dengan garis p95, perbandingan CPU/RAM saat idle vs busy.
- **Keamanan & kategori** — request diblokir per alasan, kategori yang ter-flag, status HTTP.
- **Client & API key** — pemakaian per client, daftar key (hanya prefix), dan request per route.
- **Service** — konfigurasi dan versi yang sedang berjalan.

Setiap grafik punya tombol **Tabel** untuk melihat angka persisnya, dan tooltip saat kursor diarahkan. Dashboard refresh otomatis (2/5/10 detik atau dijeda), mengikuti tema terang/gelap sistem dengan tombol untuk menggantinya, dan menjeda polling saat tab tidak terlihat. Kalau server tidak bisa dihubungi, status berubah menjadi **Terputus** dan data terakhir tetap ditampilkan dengan warna redup.

Dashboard tidak memuat apa pun dari internet (tanpa CDN), jadi tetap jalan di server tanpa akses keluar. File-nya ada di `src/dashboard/`.

**Keamanan route admin.** Karena dashboard dibuka lewat browser, route `/admin/*` punya pengaman tambahan selain cek localhost:

- Header `Host` wajib `localhost`, `127.0.0.1`, atau `[::1]` — mencegah *DNS rebinding* (domain milik orang lain yang diarahkan ke 127.0.0.1).
- Request dengan `Origin` berbeda atau `Sec-Fetch-Site: cross-site` ditolak, dan CORS tidak aktif untuk `/admin` — situs lain yang terbuka di browser yang sama tidak bisa membaca report atau membuat key (*CSRF*).
- Ditolak dengan `403` dan `code: "cross_site"`.

Konsekuensinya, akses admin memakai hostname server (misalnya `curl http://nama-server:8005/admin/report` dari server itu sendiri) ditolak — pakai `127.0.0.1` atau `localhost`.

## Deploy ke internet (Linux)

1. **Bind ke localhost**, biarkan nginx yang menghadap internet. Di `.env`:

   ```
   HOST=127.0.0.1
   ```

2. **nginx sebagai reverse proxy + HTTPS.** API key dikirim di header, jadi wajib HTTPS — tanpa itu key bisa disadap. Header `X-Forwarded-For` / `X-Real-IP` **wajib** ada; tanpa itu semua trafik dari nginx terlihat sebagai localhost dan lolos tanpa key.

   ```nginx
   server {
       listen 443 ssl;
       server_name nsfw.example.com;

       # sertifikat, misalnya dari certbot
       ssl_certificate     /etc/letsencrypt/live/nsfw.example.com/fullchain.pem;
       ssl_certificate_key /etc/letsencrypt/live/nsfw.example.com/privkey.pem;

       client_max_body_size 10m;   # samakan dengan MAX_FILE_SIZE_MB

       location / {
           proxy_pass http://127.0.0.1:8005;
           proxy_set_header Host $host;
           proxy_set_header X-Real-IP $remote_addr;
           proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
           proxy_set_header X-Forwarded-Proto $scheme;
           proxy_read_timeout 60s;
       }

       # Opsional, lapisan kedua: tutup route admin di level nginx
       location /admin/ {
           return 404;
       }
   }
   ```

3. **Firewall**: buka hanya 80/443 (dan SSH). Port 8005 jangan dibuka.

   ```bash
   sudo ufw allow OpenSSH && sudo ufw allow 'Nginx Full' && sudo ufw enable
   ```

4. **Verifikasi setelah deploy** — dari mesin lain, harus ditolak:

   ```bash
   curl -i https://nsfw.example.com/health
   curl -i https://nsfw.example.com/admin/report
   ```

   Hasil yang benar: `401 missing_key` dan `403`/`404`. Kalau `/health` malah `200` tanpa key, proxy tidak mengirim header forwarding — perbaiki sebelum lanjut.

5. **Buat key** di server untuk tiap client, lalu cek report dari server itu sendiri:

   ```bash
   npm run keys -- create "Aplikasi A"
   curl -s http://127.0.0.1:8005/admin/report
   ```

Cloudflare Tunnel (`cloudflared`) juga aman karena selalu mengirim `CF-Connecting-IP` dan `X-Forwarded-For`.

Belum ada rate limiting per key. Karena inferensi berat di CPU dan request antre, satu client yang mengirim banyak request bisa memperlambat client lain. Kalau dibutuhkan, batasi dulu di nginx (`limit_req`).

## PM2 production

### 1. Install PM2

```bash
nvm use 12
npm install -g pm2@5
pm2 -v
```

PM2 6.x/7.x resminya butuh Node 16+. PM2 5.x mendukung Node 12 dan sudah diuji dengan project ini. PM2 terpasang per versi Node di nvm, jadi install saat versi Node yang akan dipakai production sedang aktif.

### 2. Jalankan service

```bash
cd /path/ke/NSFWJS
npm install --production
cp .env.example .env
pm2 start ecosystem.config.js
pm2 status
curl -s http://127.0.0.1:8005/health
```

`npm ci` tidak dipakai karena repo ini tidak menyimpan `package-lock.json`.

Tunggu sampai `/health` menunjukkan `"model_loaded": true` (beberapa detik).

### 3. Nyala otomatis saat server restart

```bash
pm2 startup systemd
```

Perintah ini **tidak langsung memasang apa pun** — ia mencetak satu perintah `sudo` yang harus disalin dan dijalankan, bentuknya kira-kira:

```bash
sudo env PATH=$PATH:/home/yayan/.nvm/versions/node/v12.22.1/bin /home/yayan/.nvm/versions/node/v12.22.1/lib/node_modules/pm2/bin/pm2 startup systemd -u yayan --hp /home/yayan
```

Setelah itu simpan daftar proses yang sedang berjalan — inilah yang dihidupkan kembali saat boot:

```bash
pm2 save
```

Verifikasi:

```bash
systemctl status pm2-yayan
```

```bash
sudo reboot
```

Setelah server hidup lagi, cek `pm2 status` dan `curl -s http://127.0.0.1:8005/health`.

Hal yang perlu diingat:

- `pm2 save` harus dijalankan ulang setiap kali daftar proses berubah (menambah/menghapus app). Restart biasa tidak perlu.
- Unit systemd menyimpan path Node dari nvm. Kalau versi Node diganti (`nvm use 16`, dll.), pasang ulang: `pm2 unstartup systemd`, lalu ulangi langkah 3.
- Jalankan `pm2` sebagai user biasa, bukan `sudo pm2 ...` — daemon root terpisah dari daemon user dan daftar prosesnya berbeda.

### Operasional sehari-hari

```bash
pm2 status
pm2 logs nsfw-moderation-api
pm2 monit
pm2 restart nsfw-moderation-api
```

Setelah mengubah `.env`, cukup `pm2 restart nsfw-moderation-api` — `.env` dibaca ulang saat proses start. Hindari `--update-env`: opsi itu menyuntikkan environment shell saat ini ke proses, dan karena `dotenv` tidak menimpa env yang sudah ada, variabel dari shell bisa mengalahkan `.env`. Perubahan API key **tidak** perlu restart.

Update kode:

```bash
git pull
npm install --production
pm2 restart nsfw-moderation-api
```

Rotasi log, supaya file log di `~/.pm2/logs` tidak membengkak:

```bash
pm2 install pm2-logrotate
pm2 set pm2-logrotate:max_size 10M
pm2 set pm2-logrotate:retain 7
```

### Tentang `ecosystem.config.js`

- `PORT`/`HOST` **tidak** diset di file ini. `dotenv` tidak menimpa environment yang sudah ada, jadi nilai di ecosystem akan mengalahkan `.env` — misalnya `HOST=127.0.0.1` untuk deploy di belakang nginx jadi tidak berlaku. Atur keduanya di `.env`.
- `cwd: __dirname` memastikan `.env` dan `data/api-keys.json` terbaca dari folder project, termasuk saat dihidupkan otomatis waktu boot.
- `max_memory_restart: 1G` — pemakaian RAM terukur ±500–900 MB; naikkan jika sering restart (cek kolom `↺` di `pm2 status`). Restart mereset statistik `/admin/report`.
- `min_uptime`, `max_restarts`, `restart_delay` mencegah restart beruntun tanpa jeda kalau service gagal start (misalnya model tidak bisa diunduh).

Port diatur lewat `PORT` di `.env` (`.env.example`: `8005`). Jika `PORT` tidak diset sama sekali, service memakai `3003`.

## Development di macOS (Apple Silicon) dengan Node 12

Node 12 tidak punya build arm64, jadi di Mac Apple Silicon Node 12 berjalan sebagai **x86_64 lewat Rosetta**. Akibatnya `npm install` biasa gagal:

- `@tensorflow/tfjs-node` 4.22.0 tidak punya binding prebuilt untuk macOS, jadi harus compile.
- node-gyp 5 bawaan npm 6 tidak kompatibel dengan Python modern (`invalid mode: 'rU'`).
- Python 3.12+ sudah membuang `distutils`.
- Xcode Command Line Tools terbaru tidak lagi menyediakan `xcrun` x86_64, jadi `make` dari proses x86_64 gagal.

Langkah build yang terbukti jalan:

```bash
nvm use 12

# Sekali saja: node-gyp yang lebih baru + Python dengan setuptools
npm install -g node-gyp@9
python3 -m venv ~/.venvs/node-gyp
~/.venvs/node-gyp/bin/pip install setuptools

# Pasang dependency tanpa install script
npm install --ignore-scripts

# Unduh libtensorflow (tahap compile di akhir akan gagal — itu wajar)
cd node_modules/@tensorflow/tfjs-node
PATH="$PWD/../../.bin:$PATH" node scripts/install.js

# Compile binding: configure di Node 12, make sebagai proses arm64
# yang meng-cross-compile ke x86_64
npm_config_python=~/.venvs/node-gyp/bin/python node-gyp configure \
  --module="$PWD/lib/napi-v8/tfjs_binding.node" \
  --module_name=tfjs_binding \
  --module_path="$PWD/lib/napi-v8" \
  --napi_build_version=8
cd build && arch -arm64 make BUILDTYPE=Release
cd ../../../..
```

Hasilnya `node_modules/@tensorflow/tfjs-node/lib/napi-v8/tfjs_binding.node` (Mach-O x86_64). Library TensorFlow dirujuk dengan path relatif, jadi `node_modules` ini tetap jalan walau folder project dipindah.

Menjalankan service di Mac:

```bash
ROSETTA_ADVERTISE_AVX=1 npm start
```

```bash
ROSETTA_ADVERTISE_AVX=1 npm run dev
```

`ROSETTA_ADVERTISE_AVX=1` wajib (macOS 15+). Rosetta mendukung AVX tapi menyembunyikannya secara default; tanpa variabel ini TensorFlow berhenti dengan pesan *"compiled to use AVX instructions, but these aren't available on your machine"*. Variabel ini tidak diperlukan di Linux.

## Troubleshooting

| Gejala | Penyebab | Solusi |
| --- | --- | --- |
| `SyntaxError: Unexpected token '.'` di `adm-zip/methods/inflater.js` saat install | `adm-zip` 0.5.18 memakai optional chaining (Node 14+) | pastikan `adm-zip` 0.5.17 terpasang di root `node_modules` |
| `Cannot find module 'buffer/'` dari `nsfwjs` | npm 6 tidak memasang peer dependency | pastikan dependency `buffer` terpasang |
| `SyntaxError: Unexpected token '?'` saat `npm run dev` | `nodemon` 3 tidak mendukung Node 12 | pakai `nodemon` 2.x |
| `Illegal instruction` saat start | CPU tanpa AVX | pindah ke server dengan AVX |
| `GLIBCXX_3.4.xx not found` (CentOS 7) | `libstdc++` sistem terlalu tua | pasang `devtoolset`, atau arahkan `LD_LIBRARY_PATH` ke `libstdc++` yang lebih baru |
| `404` saat unduh `CPU-darwin-4.22.0.tar.gz` | tidak ada binding prebuilt macOS | ikuti langkah build macOS di atas |
| `FATAL: kernel too old` di container | base image modern di kernel 2.6.x | server tidak bisa dipakai; lihat tabel syarat server |


## Akses admin dari laptop (SSH tunnel)

Route `/admin/*` hanya bisa diakses dari localhost server. Dengan SSH tunnel, request dari laptop diteruskan oleh `sshd` di server ke `127.0.0.1`, sehingga dianggap localhost — report dan pengelolaan key bisa dibuka dari laptop **tanpa membuka port apa pun ke internet**.

Format `-L <port-laptop>:127.0.0.1:<PORT-di-server>`. Port kanan harus sama dengan `PORT` service di server (`8005` sesuai `.env.example`); port kiri bebas, asal belum dipakai di laptop. Kalau di laptop juga sedang menjalankan service ini di 8005, ganti port kiri, misalnya `18005:127.0.0.1:8005`, lalu akses `http://127.0.0.1:18005`.

Login SSH sekaligus tunnel (tunnel tertutup saat keluar dari shell):

```bash
ssh -L 8005:127.0.0.1:8005 user@192.168.1.10
```

Tunnel saja, tanpa shell (terminal tertahan sampai `Ctrl+C`):

```bash
ssh -N -L 8005:127.0.0.1:8005 user@192.168.1.10
```

Tunnel di background (terminal langsung bisa dipakai lagi):

```bash
ssh -f -N -o ExitOnForwardFailure=yes -L 8005:127.0.0.1:8005 user@192.168.1.10
```

`ExitOnForwardFailure=yes` membuat ssh langsung gagal kalau port 8005 di laptop sudah terpakai. Tanpa opsi ini, ssh tetap jalan di background tanpa tunnel dan tidak ada pesan error.

Lalu dari laptop, buka dashboard di browser:

```
http://127.0.0.1:8005/admin/dashboard/
```

Atau ambil JSON-nya:

```bash
curl -s http://127.0.0.1:8005/admin/report
```

Menutup tunnel background:

```bash
pkill -f "ssh -f -N -o ExitOnForwardFailure=yes -L 8005"
```

Tunnel yang benar tidak mengirim header `X-Forwarded-For`, jadi tetap terhitung localhost. Kalau yang diteruskan adalah port nginx (443/80), request akan membawa header proxy dan diperlakukan sebagai akses dari luar.
