// pm2 process config for running Buddy 24/7 on a server (EC2 / Lightsail / any VM).
// app.js loads secrets from .env itself (via dotenv), so none are needed here.
// Usage:  pm2 start ecosystem.config.cjs   then   pm2 save && pm2 startup
module.exports = {
  apps: [
    {
      name: 'buddy',
      script: 'app.js',
      instances: 1,
      autorestart: true,
      max_restarts: 10,
      // Socket Mode is outbound-only — no ports to expose.
      env: { NODE_ENV: 'production' },
    },
  ],
};
