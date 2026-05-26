const fs = require('fs');
const path = require('path');

let loaded = false;

function candidateEnvFiles() {
  const out = [];
  const add = (value) => {
    const filePath = path.resolve(String(value || ''));
    if (!filePath || out.includes(filePath)) return;
    out.push(filePath);
  };
  if (process.env.FLOW_SWITCHER_ENV_FILE) add(process.env.FLOW_SWITCHER_ENV_FILE);
  add(path.join(__dirname, '..', '.env'));
  add(path.join(process.cwd(), '.env'));
  return out;
}

function applyEnvFile(filePath) {
  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) return false;
  const text = fs.readFileSync(filePath, 'utf8');
  for (const rawLine of text.split(/\r?\n/)) {
    const line = String(rawLine || '').trim();
    if (!line || line.startsWith('#') || !line.includes('=')) continue;
    const index = line.indexOf('=');
    const key = line.slice(0, index).trim();
    let value = line.slice(index + 1).trim();
    if (!key) continue;
    if (value.length >= 2 && value[0] === value[value.length - 1] && (value[0] === '"' || value[0] === '\'')) {
      value = value.slice(1, -1);
    }
    if (!Object.prototype.hasOwnProperty.call(process.env, key)) {
      process.env[key] = value;
    }
  }
  return true;
}

function loadEnv() {
  if (loaded) return;
  loaded = true;
  for (const filePath of candidateEnvFiles()) {
    if (applyEnvFile(filePath)) break;
  }
}

module.exports = loadEnv;
