/**
 * 生成 PWA 图标（纯 Node，无外部依赖）。
 * 目的：仓库里必须有真实存在的 192/512 PNG，否则 PWA 安装与构建都会出问题。
 * 用法：npm run icons
 */
import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = resolve(__dirname, '../public/icons');

/** CRC32 表 */
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) {
    c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}

function encodePng(width, height, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type: RGBA
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // interlace

  // 每行前置 filter byte 0
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y += 1) {
    raw[y * (stride + 1)] = 0;
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** 点到线段距离（归一化坐标），用于画对勾 */
function distanceToSegment(px, py, ax, ay, bx, by) {
  const dx = bx - ax;
  const dy = by - ay;
  const lenSq = dx * dx + dy * dy;
  const t = lenSq === 0 ? 0 : Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / lenSq));
  const cx = ax + t * dx;
  const cy = ay + t * dy;
  return Math.hypot(px - cx, py - cy);
}

function clamp01(v) {
  return Math.max(0, Math.min(1, v));
}

/**
 * 画一枚图标：靛蓝渐变底 + 白色对勾。
 * padding：内容安全边距（maskable 图标需要更大留白）
 */
function drawIcon(size, padding) {
  const rgba = Buffer.alloc(size * size * 4);
  const stroke = 0.062 + (size <= 192 ? 0.004 : 0); // 小图稍微加粗，避免视觉过细
  const s = 1 - padding * 2;

  // 对勾三点（以内容区域 0..1 归一化，再映射到 padding 内）
  const map = (v) => padding + v * s;
  const p1 = [map(0.24), map(0.54)];
  const p2 = [map(0.44), map(0.73)];
  const p3 = [map(0.77), map(0.33)];

  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const nx = (x + 0.5) / size;
      const ny = (y + 0.5) / size;

      // 垂直渐变：#4F46E5 -> #7C3AED
      const t = y / (size - 1);
      const r0 = Math.round(79 + (124 - 79) * t);
      const g0 = Math.round(70 + (58 - 70) * t);
      const b0 = Math.round(229 + (237 - 229) * t);

      // 对勾覆盖率（带 1px 软边）
      const d = Math.min(
        distanceToSegment(nx, ny, p1[0], p1[1], p2[0], p2[1]),
        distanceToSegment(nx, ny, p2[0], p2[1], p3[0], p3[1]),
      );
      const soft = 1.2 / size;
      const coverage = clamp01((stroke / 2 + soft - d) / (soft * 2));

      const r = Math.round(r0 * (1 - coverage) + 255 * coverage);
      const g = Math.round(g0 * (1 - coverage) + 255 * coverage);
      const b = Math.round(b0 * (1 - coverage) + 255 * coverage);

      const idx = (y * size + x) * 4;
      rgba[idx] = r;
      rgba[idx + 1] = g;
      rgba[idx + 2] = b;
      rgba[idx + 3] = 255;
    }
  }

  return encodePng(size, size, rgba);
}

mkdirSync(OUT_DIR, { recursive: true });

const targets = [
  { file: 'icon-192.png', size: 192, padding: 0.06 },
  { file: 'icon-512.png', size: 512, padding: 0.06 },
  // maskable 需要把关键内容收进内切圆安全区
  { file: 'icon-maskable-512.png', size: 512, padding: 0.19 },
];

for (const target of targets) {
  const png = drawIcon(target.size, target.padding);
  writeFileSync(resolve(OUT_DIR, target.file), png);
  console.log(`已生成 public/icons/${target.file} (${target.size}x${target.size}, ${png.length} bytes)`);
}
