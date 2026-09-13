module.exports = {
  apps: [{
    name: 'nsfw-moderation',
    script: 'src/server.js',
    // .env dan data/api-keys.json dibaca relatif ke cwd; pastikan tetap folder
    // project walaupun PM2 dijalankan dari tempat lain atau saat boot.
    cwd: __dirname,
    instances: 1,
    exec_mode: 'fork',
    autorestart: true,
    watch: false,
    max_memory_restart: '1G',
    // Beri waktu model termuat sebelum dianggap crash-loop.
    min_uptime: '30s',
    max_restarts: 10,
    restart_delay: 5000,
    kill_timeout: 10000,
    time: true,
    // PORT/HOST sengaja tidak diset di sini: dotenv tidak menimpa env yang
    // sudah ada, sehingga nilai di sini akan mengalahkan .env.
    env: {
      NODE_ENV: 'production'
    }
  }]
};
