const fs = require('fs');
const path = require('path');

function writeFileAtomicSync(filePath, contents) {
  const fp = String(filePath || '').trim();
  if (!fp) throw new Error('filePath required');
  const dir = path.dirname(fp);
  fs.mkdirSync(dir, { recursive: true });

  const base = path.basename(fp);
  const tmp = path.join(dir, `.${base}.tmp-${process.pid}-${Date.now()}`);
  fs.writeFileSync(tmp, contents, 'utf8');

  try {
    fs.renameSync(tmp, fp);
  } catch (e) {
    // Windows: rename over existing file can fail; try remove + rename, then fallback copy.
    try {
      fs.rmSync(fp, { force: true });
    } catch {
      // ignore
    }
    try {
      fs.renameSync(tmp, fp);
    } catch (e2) {
      try {
        fs.copyFileSync(tmp, fp);
      } finally {
        try {
          fs.rmSync(tmp, { force: true });
        } catch {
          // ignore
        }
      }
      try {
        fs.accessSync(fp, fs.constants.F_OK);
      } catch {
        throw e2 || e;
      }
    }
  }
}

function writeJsonAtomicSync(filePath, obj) {
  writeFileAtomicSync(filePath, JSON.stringify(obj, null, 2));
}

module.exports = {
  writeFileAtomicSync,
  writeJsonAtomicSync,
};

