const { spawn } = require("child_process");
const path = require("path");

function buildEnvForPlatform(baseEnv) {
    const env = { ...baseEnv };

    // On Windows, electron-builder may auto-discover and try to code-sign if a
    // code-signing cert exists in the cert store, which triggers downloading
    // winCodeSign (7z contains symlinks -> requires admin/developer mode).
    //
    // For internal distribution we default to "no code signing" to make builds
    // reliable on restricted machines.
    const allowCodeSign = env.ALLOW_CODESIGN === "1";
    if (process.platform === "win32" && !allowCodeSign) {
        env.CSC_IDENTITY_AUTO_DISCOVERY = "false";

        const keysToDelete = [
            "CSC_LINK",
            "WIN_CSC_LINK",
            "CSC_KEY_PASSWORD",
            "WIN_CSC_KEY_PASSWORD",
            "CSC_NAME",
            "WIN_CSC_NAME",
            "SIGNTOOL_PATH",
        ];
        for (const k of keysToDelete) delete env[k];
    }

    return env;
}

function main() {
    const cli = path.join(
        __dirname,
        "..",
        "node_modules",
        "electron-builder",
        "out",
        "cli",
        "cli.js",
    );
    const args = process.argv.slice(2);

    const env = buildEnvForPlatform(process.env);

    // Capture output so we can print actionable hints on common Windows issues.
    const child = spawn(process.execPath, [cli, ...args], {
        stdio: ["inherit", "pipe", "pipe"],
        env,
    });

    let combined = "";
    const keep = (chunk) => {
        combined += chunk.toString("utf8");
        if (combined.length > 200_000) combined = combined.slice(-200_000);
    };

    child.stdout.on("data", (d) => {
        process.stdout.write(d);
        keep(d);
    });
    child.stderr.on("data", (d) => {
        process.stderr.write(d);
        keep(d);
    });

    child.on("exit", (code) => {
        process.exitCode = typeof code === "number" ? code : 1;

        if (process.platform === "win32" && process.exitCode) {
            if (combined.includes("Cannot create symbolic link")) {
                process.stderr.write(
                    "\n\n" +
                        "❗ Windows 打包失败：electron-builder 解压 winCodeSign 时需要创建符号链接。\n" +
                        "解决方案（任选其一）：\n" +
                        "  1) 打开 Windows「开发者模式」(Settings → For developers → Developer Mode)\n" +
                        "  2) 用管理员权限运行终端后再执行 npm run dist\n" +
                        "  3) 运行兼容模式（不编辑 exe 资源）：npm run dist:compat\n\n",
                );
            }
        }
    });
}

main();
