# NSFW image moderation API

REST API berbasis NSFWJS dan TensorFlow.js untuk memeriksa gambar. Baseline runtime adalah Node.js 16.14+; gunakan Node.js 20/22 bila binary TensorFlow native di server target tidak tersedia untuk Node 16.

## Instalasi

```bash
nvm use 16
npm install
cp .env.example .env
npm run lint
npm start
```

TensorFlow.js memasang native binding saat `npm install`. Karena itu, jalankan `npm install`/`npm ci` pada OS dan arsitektur yang sama dengan production. Jangan memakai `npm install --ignore-scripts`.

Model default dimuat ketika service mulai dan dapat memerlukan akses internet sekali. Untuk deployment yang deterministik, simpan model NSFWJS di server, set `NSFW_MODEL_PATH` ke direktorinya, lalu jalankan `npm run prepare-model` sebagai langkah dokumentasi/pre-deploy.

## Endpoint

`GET /health` mengembalikan status service dan apakah model sudah selesai dimuat.

`POST /moderate` menerima `multipart/form-data` dengan field `image`:

```bash
curl -F image=@photo.jpg http://localhost:3003/moderate
```

Response memiliki `is_nsfw`, `flagged_categories`, `scores`, `thresholds`, dan seluruh `predictions`. Kategori `Porn`, `Hentai`, atau `Sexy` ter-flag jika probabilitasnya minimal threshold kategori tersebut.

### Threshold

Threshold diatur per kategori. Default:

| Kategori | Default | Alasan |
| --- | --- | --- |
| `Porn` | `0.3` | ketat, false negative lebih mahal |
| `Hentai` | `0.3` | ketat, false negative lebih mahal |
| `Sexy` | `0.8` | longgar, kelas paling noisy (pakaian minim/pose biasa) |

Override lewat `NSFW_THRESHOLD_PORN`, `NSFW_THRESHOLD_HENTAI`, `NSFW_THRESHOLD_SEXY`. `NSFW_THRESHOLD` dipakai sebagai fallback untuk kategori yang tidak diset — mengisinya akan menyamakan semua kategori, jadi biarkan kosong bila ingin default di atas.

## PM2 production

```bash
npm ci --omit=dev
pm2 start ecosystem.config.js
pm2 save
pm2 startup
```

Konfigurasi port default adalah `3003`; override dengan environment variable `PORT`.
