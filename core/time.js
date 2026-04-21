function pad2(n) {
  return String(n).padStart(2, '0');
}

function pad3(n) {
  return String(n).padStart(3, '0');
}

// Always use China timezone (UTC+08:00) for timestamps, regardless of OS timezone.
function toChinaIso(ms) {
  const t = Number(ms);
  const base = Number.isFinite(t) ? t : Date.now();
  const d = new Date(base + 8 * 60 * 60 * 1000);
  const y = d.getUTCFullYear();
  const m = pad2(d.getUTCMonth() + 1);
  const day = pad2(d.getUTCDate());
  const hh = pad2(d.getUTCHours());
  const mm = pad2(d.getUTCMinutes());
  const ss = pad2(d.getUTCSeconds());
  const sss = pad3(d.getUTCMilliseconds());
  return `${y}-${m}-${day}T${hh}:${mm}:${ss}.${sss}+08:00`;
}

function nowIso() {
  return toChinaIso(Date.now());
}

module.exports = { toChinaIso, nowIso };

