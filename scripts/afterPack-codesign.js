const { execFile } = require("child_process");
const fs = require("fs");
const path = require("path");

function exec(cmd, args, options = {}) {
    return new Promise((resolve, reject) => {
        execFile(cmd, args, { ...options }, (error, stdout, stderr) => {
            if (error) {
                error.stdout = stdout;
                error.stderr = stderr;
                reject(error);
                return;
            }
            resolve({ stdout: stdout ?? "", stderr: stderr ?? "" });
        });
    });
}

module.exports = async function afterPack(context) {
    // On macOS, Squirrel.Mac (ShipIt) validates code signatures during update.
    // When we build without a Developer ID identity, Electron binaries end up
    // "linker-signed" (adhoc) but the .app bundle isn't properly signed, which
    // triggers: "code has no resources but signature indicates they must be present".
    //
    // We ad-hoc sign the .app bundle to make signatures internally consistent,
    // so auto-update can work in unsigned environments.
    if (context.electronPlatformName !== "darwin") return;

    const appOutDir = context.appOutDir;
    const apps = fs.readdirSync(appOutDir).filter((name) => name.endsWith(".app"));
    if (apps.length === 0) {
        throw new Error(`[afterPack] no .app found in ${appOutDir}`);
    }

    // If multiple exist, pick the first to keep the hook resilient.
    const appPath = path.join(appOutDir, apps[0]);

    await exec("codesign", ["--force", "--deep", "--sign", "-", appPath]);

    // codesign can print warnings to stderr even with exit=0. Treat the known
    // "no resources" warning as a hard failure.
    const verify = await exec("codesign", ["--verify", "--deep", "--strict", "--verbose=4", appPath]);
    const msg = `${verify.stdout}\n${verify.stderr}`.trim();
    if (msg.includes("code has no resources but signature indicates they must be present")) {
        throw new Error(`[afterPack] codesign verify still reports resource warning for ${appPath}:\n${msg}`);
    }
};

