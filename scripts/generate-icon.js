const fs = require("fs");
const path = require("path");
const { PNG } = require("pngjs");

function u16le(n) {
    const b = Buffer.alloc(2);
    b.writeUInt16LE(n >>> 0, 0);
    return b;
}

function u32le(n) {
    const b = Buffer.alloc(4);
    b.writeUInt32LE(n >>> 0, 0);
    return b;
}

function u32be(n) {
    const b = Buffer.alloc(4);
    b.writeUInt32BE(n >>> 0, 0);
    return b;
}

function clamp01(x) {
    return Math.max(0, Math.min(1, x));
}

function smoothstep(edge0, edge1, x) {
    const t = clamp01((x - edge0) / (edge1 - edge0));
    return t * t * (3 - 2 * t);
}

function lerp(a, b, t) {
    return a + (b - a) * t;
}

function mix3(c1, c2, t) {
    return [
        lerp(c1[0], c2[0], t),
        lerp(c1[1], c2[1], t),
        lerp(c1[2], c2[2], t),
    ];
}

function add3(a, b) {
    return [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
}

function mul3(a, s) {
    return [a[0] * s, a[1] * s, a[2] * s];
}

function length2(x, y) {
    return Math.sqrt(x * x + y * y);
}

function roundedRectSdf(x, y, hx, hy, r) {
    const qx = Math.abs(x) - hx;
    const qy = Math.abs(y) - hy;
    const ox = Math.max(qx, 0);
    const oy = Math.max(qy, 0);
    return length2(ox, oy) + Math.min(Math.max(qx, qy), 0) - r;
}

function ringSdf(x, y, cx, cy, r, thickness) {
    const d = length2(x - cx, y - cy) - r;
    return Math.abs(d) - thickness * 0.5;
}

function capsuleSdf(px, py, ax, ay, bx, by, r) {
    // Distance to a line segment with rounded ends (capsule).
    const pax = px - ax;
    const pay = py - ay;
    const bax = bx - ax;
    const bay = by - ay;
    const baLen2 = bax * bax + bay * bay;
    const h = baLen2 > 0 ? clamp01((pax * bax + pay * bay) / baLen2) : 0;
    const dx = pax - bax * h;
    const dy = pay - bay * h;
    return Math.sqrt(dx * dx + dy * dy) - r;
}

function hash2(x, y) {
    // deterministic pseudo-noise in [0,1)
    const s = Math.sin(x * 12.9898 + y * 78.233) * 43758.5453123;
    return s - Math.floor(s);
}

function compositeOver(dst, srcRgb, srcA) {
    const a = clamp01(srcA);
    return {
        rgb: add3(mul3(srcRgb, a), mul3(dst.rgb, 1 - a)),
        a: a + dst.a * (1 - a),
    };
}

function render(size) {
    const png = new PNG({ width: size, height: size });

    // Transparent background + modern mark colors
    const cA = [0x2b, 0x6f, 0x6a]; // deep sage-teal
    const cB = [0x7a, 0xa8, 0x7a]; // leaf
    const cHi = [0xff, 0xff, 0xff]; // highlight

    const to01 = (c) => [c[0] / 255, c[1] / 255, c[2] / 255];
    const A = to01(cA);
    const B = to01(cB);
    const HI = to01(cHi);

    const aa = 2.0 / size; // antialias in normalized coords

    // Mark geometry in normalized [-1..1]
    // A soft, friendly "F" built from rounded capsules + a 3-dot "multi-account" hint.
    const r = 0.145;
    const vx = -0.18;
    const yTop = -0.56;
    const yBot = 0.56;
    const xTopEnd = 0.52;
    const xMidEnd = 0.36;
    const yTopBar = -0.46;
    const yMidBar = 0.02;

    for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
            const u = (x + 0.5) / size;
            const v = (y + 0.5) / size;
            const nx = u * 2 - 1;
            const ny = v * 2 - 1;

            // Transparent base
            let out = { rgb: [0, 0, 0], a: 0 };

            // Signed distance for the "F" mark built from capsules.
            const dV = capsuleSdf(nx, ny, vx, yTop, vx, yBot, r);
            const dTop = capsuleSdf(nx, ny, vx, yTopBar, xTopEnd, yTopBar, r);
            // Slight "flow" curvature illusion: mid bar tilts down a touch.
            const dMid = capsuleSdf(nx, ny, vx, yMidBar, xMidEnd, yMidBar + 0.04, r);
            const dMark = Math.min(dV, dTop, dMid);

            // Shadow for legibility on any background (still transparent overall).
            const dShadow = Math.min(
                capsuleSdf(nx, ny, vx + 0.05, yTop + 0.06, vx + 0.05, yBot + 0.06, r),
                capsuleSdf(nx, ny, vx + 0.05, yTopBar + 0.06, xTopEnd + 0.05, yTopBar + 0.06, r),
                capsuleSdf(nx, ny, vx + 0.05, yMidBar + 0.06, xMidEnd + 0.05, yMidBar + 0.10, r),
            );
            const aShadow = (1 - smoothstep(0, aa * 7.0, dShadow)) * 0.22;
            out = compositeOver(out, [0, 0, 0], aShadow);

            // Main fill with gradient
            const aMark = 1 - smoothstep(0, aa * 3.2, dMark);
            const g = clamp01(0.58 * u + 0.42 * (1 - v));
            const base = mix3(A, B, g);
            out = compositeOver(out, base, aMark);

            // Subtle highlight along top-left (gives depth without a background plate)
            const edge = 1 - smoothstep(aa * 0.6, aa * 5.0, dMark);
            const hiG = clamp01(0.78 * (1 - v) + 0.22 * (1 - u));
            const hi = mix3(HI, base, 0.55);
            out = compositeOver(out, hi, edge * 0.12 * hiG);

            // "Multi-account" dots (3) near the lower-left of the mark.
            const dots = [
                [-0.58, 0.18, 0.072],
                [-0.58, 0.34, 0.060],
                [-0.58, 0.48, 0.050],
            ];
            for (const [cx, cy, rr] of dots) {
                const dd = length2(nx - cx, ny - cy) - rr;
                const ad = 1 - smoothstep(0, aa * 3.0, dd);
                const dotCol = mix3(base, HI, 0.16);
                out = compositeOver(out, dotCol, ad * 0.95);
            }

            const i = (y * size + x) * 4;
            png.data[i + 0] = Math.round(clamp01(out.rgb[0]) * 255);
            png.data[i + 1] = Math.round(clamp01(out.rgb[1]) * 255);
            png.data[i + 2] = Math.round(clamp01(out.rgb[2]) * 255);
            png.data[i + 3] = Math.round(clamp01(out.a) * 255);
        }
    }

    return png;
}

function buildIco(pngBuffers) {
    // ICO can embed PNG images (Vista+). We'll include multiple sizes for better scaling.
    // Structure: ICONDIR + ICONDIRENTRY[n] + imageData...
    const count = pngBuffers.length;
    const header = Buffer.concat([u16le(0), u16le(1), u16le(count)]);

    let offset = 6 + 16 * count;
    const entries = [];
    const images = [];

    for (const { size, data } of pngBuffers) {
        const width = size === 256 ? 0 : size;
        const height = size === 256 ? 0 : size;

        const entry = Buffer.concat([
            Buffer.from([width & 0xff]),
            Buffer.from([height & 0xff]),
            Buffer.from([0]), // color count
            Buffer.from([0]), // reserved
            u16le(1), // planes
            u16le(32), // bit count
            u32le(data.length),
            u32le(offset),
        ]);

        entries.push(entry);
        images.push(data);
        offset += data.length;
    }

    return Buffer.concat([header, ...entries, ...images]);
}

function buildIcns(pngByType) {
    // ICNS container with PNG-based icon types.
    // Common PNG types:
    // - ic09: 512x512
    // - ic10: 1024x1024
    const chunks = [];
    let totalSize = 8;

    for (const { type, data } of pngByType) {
        const chunkSize = 8 + data.length;
        chunks.push(Buffer.concat([Buffer.from(type, "ascii"), u32be(chunkSize), data]));
        totalSize += chunkSize;
    }

    return Buffer.concat([Buffer.from("icns", "ascii"), u32be(totalSize), ...chunks]);
}

function main() {
    const outDir = path.join(__dirname, "..", "build");
    fs.mkdirSync(outDir, { recursive: true });

    // PNGs
    const png1024 = PNG.sync.write(render(1024));
    const png512 = PNG.sync.write(render(512));
    const png256 = PNG.sync.write(render(256));
    const png64 = PNG.sync.write(render(64));
    const png48 = PNG.sync.write(render(48));
    const png32 = PNG.sync.write(render(32));
    const png16 = PNG.sync.write(render(16));

    const outPng = path.join(outDir, "icon.png");
    fs.writeFileSync(outPng, png1024);
    process.stdout.write(`✅ Wrote ${outPng}\n`);

    // Windows ICO
    const ico = buildIco([
        { size: 256, data: png256 },
        { size: 64, data: png64 },
        { size: 48, data: png48 },
        { size: 32, data: png32 },
        { size: 16, data: png16 },
    ]);
    const outIco = path.join(outDir, "icon.ico");
    fs.writeFileSync(outIco, ico);
    process.stdout.write(`✅ Wrote ${outIco}\n`);

    // macOS ICNS
    const icns = buildIcns([
        { type: "ic09", data: png512 },
        { type: "ic10", data: png1024 },
    ]);
    const outIcns = path.join(outDir, "icon.icns");
    fs.writeFileSync(outIcns, icns);
    process.stdout.write(`✅ Wrote ${outIcns}\n`);
}

main();
