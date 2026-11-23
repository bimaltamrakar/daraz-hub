module.exports = {
  apps: [
    {
      name: process.env.PM2_APP || "daraz-hub",
      script: "dist/src/server.js",
      cwd: __dirname,
      instances: 1,
      exec_mode: "fork",
      autorestart: true,
      max_memory_restart: "512M",
      env: {
        NODE_ENV: "production",
        PORT: process.env.PORT || 4000,
      },
    },
  ],
};
