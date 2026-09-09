module.exports = {
  apps: [{
    name: 'nsfw-moderation-api',
    script: 'src/server.js',
    instances: 1,
    exec_mode: 'fork',
    autorestart: true,
    watch: false,
    max_memory_restart: '1G',
    env: {
      NODE_ENV: 'production',
      PORT: 3003,
      HOST: '0.0.0.0'
    }
  }]
};
