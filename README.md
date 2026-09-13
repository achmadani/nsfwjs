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

`GET /health` mengembalikan status service dan apakah model sudah selesai dimuat.

`POST /moderate` menerima `multipart/form-data` dengan field `image`:

```bash
curl -F image=@photo.jpg http://localhost:3003/moderate
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
curl -H "Content-Type: application/json" -d '{"name":"Aplikasi Sekolah"}' http://127.0.0.1:3003/admin/keys
curl http://127.0.0.1:3003/admin/keys
curl -X DELETE http://127.0.0.1:3003/admin/keys/<id>
```

| Respons | `code` | Arti |
| --- | --- | --- |
| 401 | `missing_key` | tidak ada key |
| 401 | `invalid_key` | key tidak dikenal |
| 401 | `revoked_key` | key sudah dicabut |
| 403 | `local_only` | route admin diakses dari luar |

Autentikasi berjalan sebelum upload diproses, jadi request tanpa key ditolak tanpa file-nya sempat dibaca ke memori.

## Report

`GET /admin/report` (localhost saja). Tambahkan `?history=1` untuk menyertakan sampel CPU/RAM 2 menit terakhir.

```bash
curl -s http://127.0.0.1:3003/admin/report
```

Isi utama:

- `requests` — `total`, `allowed` (lolos autentikasi), `blocked` (ditolak), `blocked_by_reason`, `by_source` (local/remote), `by_status`, `by_route`. Percobaan ke route yang tidak ada tanpa key tercatat sebagai `(rejected)`.
- `moderation` — jumlah gambar diproses: `safe` (lolos), `nsfw` (diblokir), `errors`, dan `flagged_by_category`.
- `clients` — per API key: jumlah request, gambar dimoderasi, jumlah NSFW, terakhir terlihat.
- `resources`:
  - `idle`, `busy`, `startup` — rata-rata dan peak CPU/RAM per kondisi.
  - `peak` — tertinggi sejak start.
  - `per_inference` — waktu (avg/p50/p95/max) dan CPU saat benar-benar memproses satu gambar. Ini angka yang paling akurat untuk "habis berapa CPU per gambar"; `busy` dirata-rata per detik sehingga lebih rendah.
  - `current`, `system` — kondisi saat ini, termasuk memori tensor TensorFlow dan `MemAvailable` server.

Cara membaca CPU: `cpu_percent` 100 = satu core penuh (bisa > 100 karena TensorFlow multi-thread); `cpu_percent_all_cores` 100 = semua core penuh.

Contoh hasil pengukuran (Mac M-series via Rosetta, gambar 2000px):

| Kondisi | CPU (1 core = 100) | RSS |
| --- | --- | --- |
| idle | ±0% | ±460–790 MB |
| per inferensi | ±280%, ±95 ms | — |
| peak | ±250% (sampel 1 dtk) | ±900 MB |

Inferensi dijalankan berurutan oleh event loop Node, jadi request bersamaan akan antre, bukan diproses paralel.

Statistik disimpan di memori dan **reset saat proses restart** (termasuk restart otomatis PM2). Dengan PM2 cluster/beberapa instance, tiap proses punya report sendiri — karena itu `ecosystem.config.js` memakai 1 instance.

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
           proxy_pass http://127.0.0.1:3003;
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

3. **Firewall**: buka hanya 80/443 (dan SSH). Port 3003 jangan dibuka.

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
   curl -s http://127.0.0.1:3003/admin/report
   ```

Cloudflare Tunnel (`cloudflared`) juga aman karena selalu mengirim `CF-Connecting-IP` dan `X-Forwarded-For`.

Belum ada rate limiting per key. Karena inferensi berat di CPU dan request antre, satu client yang mengirim banyak request bisa memperlambat client lain. Kalau dibutuhkan, batasi dulu di nginx (`limit_req`).

## PM2 production

```bash
npm install --production
pm2 start ecosystem.config.js
pm2 save
pm2 startup
```

`npm ci` tidak dipakai karena repo ini tidak menyimpan `package-lock.json`.

Konfigurasi port default adalah `3003`; override dengan environment variable `PORT`.

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
