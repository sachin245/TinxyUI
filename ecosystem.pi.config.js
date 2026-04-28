module.exports = {
  apps: [
    {
      name: 'tinxy-ui',
      script: 'tinxy-ui/serve.js',
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: '128M',
      env: {
        NODE_ENV: 'production',
        PORT: 6001,
      },
    },
  ],
};
