const { spawn } = require('child_process');
const path = require('path');

const appRoot = path.resolve(__dirname, '..');
const electronBin = path.join(appRoot, 'node_modules', 'electron', 'dist', 'Electron.app', 'Contents', 'MacOS', 'Electron');

const child = spawn(electronBin, [appRoot], {
  cwd: appRoot,
  stdio: 'inherit',
  env: {
    ...process.env,
    FMA_APP_NAME: process.env.FMA_APP_NAME || 'Flow Studio (Dev)',
    FMA_WINDOW_TITLE: process.env.FMA_WINDOW_TITLE || 'Flow Studio Control',
  },
});

child.on('spawn', () => {
  console.log(`[start-dev] spawned electron: ${electronBin} ${appRoot}`);
});

child.on('error', (err) => {
  console.error(`[start-dev] spawn error: ${err?.stack || err}`);
  process.exit(1);
});

child.on('exit', (code, signal) => {
  console.log(`[start-dev] child exit code=${code} signal=${signal || ''}`);
  if (signal) process.kill(process.pid, signal);
  process.exit(code ?? 0);
});
