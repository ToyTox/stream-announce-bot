// Рисует иконки трея в desktop/assets/. Запуск: node scripts/make-icons.mjs
// Готовые PNG лежат в репозитории, скрипт нужен только чтобы их перерисовать.
import { mkdirSync, writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';

const OUT = new URL('../desktop/assets/', import.meta.url);
mkdirSync(OUT, { recursive: true });

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf) {
  let c = 0xffffffff;
  for (const byte of buf) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}
function png(size, rgba) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header.set([8, 6, 0, 0, 0], 8); // 8 бит, RGBA
  const rows = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    rows[y * (size * 4 + 1)] = 0;
    rgba.copy(rows, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(rows)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// Фигуры в координатах 0..1; true — точка закрашена.
const dist = (x, y) => Math.hypot(x - 0.5, y - 0.5);
const ring = (x, y) => dist(x, y) > 0.28 && dist(x, y) <= 0.4;
const shapes = {
  // Кольцо с точкой: «ждём эфир»
  idle: (x, y) => ring(x, y) || dist(x, y) <= 0.12,
  // Сплошной круг: эфир идёт
  live: (x, y) => dist(x, y) <= 0.4,
  // Кольцо с восклицательным знаком: тестовый режим или ошибка площадки
  warning: (x, y) =>
    ring(x, y) || (Math.abs(x - 0.5) <= 0.045 && y >= 0.27 && y <= 0.55) || Math.hypot(x - 0.5, y - 0.68) <= 0.06,
  // Кольцо, перечёркнутое по диагонали: бот не запущен
  stopped: (x, y) => ring(x, y) || (dist(x, y) <= 0.4 && Math.abs(x + y - 1) <= 0.07),
};
const colors = {
  idle: [138, 138, 142],
  live: [229, 50, 45],
  warning: [240, 160, 32],
  stopped: [110, 110, 114],
};

function render(size, shape, color) {
  const rgba = Buffer.alloc(size * size * 4);
  const grid = 4; // суперсэмплинг для гладких краёв
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let hit = 0;
      for (let sy = 0; sy < grid; sy++) {
        for (let sx = 0; sx < grid; sx++) {
          if (shape((px + (sx + 0.5) / grid) / size, (py + (sy + 0.5) / grid) / size)) hit++;
        }
      }
      const o = (py * size + px) * 4;
      rgba.set([...color, Math.round((hit / (grid * grid)) * 255)], o);
    }
  }
  return png(size, rgba);
}

for (const [name, shape] of Object.entries(shapes)) {
  // macOS: чёрный шаблон — система сама красит под светлую/тёмную строку меню.
  writeFileSync(new URL(`${name}Template.png`, OUT), render(18, shape, [0, 0, 0]));
  writeFileSync(new URL(`${name}Template@2x.png`, OUT), render(36, shape, [0, 0, 0]));
  // Windows и Linux: цветные.
  writeFileSync(new URL(`${name}.png`, OUT), render(32, shape, colors[name]));
}

// Иконка приложения: красный диск на тёмной плитке со скруглением и «волнами» эфира.
const appShape = (x, y) => {
  // Скруглённый квадрат: расстояние до прямоугольника с радиусом 0.14.
  const qx = Math.abs(x - 0.5) - 0.32;
  const qy = Math.abs(y - 0.5) - 0.32;
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) <= 0.14;
};
const size = 512;
const app = Buffer.alloc(size * size * 4);
for (let py = 0; py < size; py++) {
  for (let px = 0; px < size; px++) {
    const x = (px + 0.5) / size;
    const y = (py + 0.5) / size;
    const o = (py * size + px) * 4;
    if (!appShape(x, y)) continue;
    const d = dist(x, y);
    const red = d <= 0.14 || (d > 0.22 && d <= 0.27) || (d > 0.33 && d <= 0.38);
    app.set(red ? [229, 50, 45, 255] : [30, 32, 38, 255], o);
  }
}
writeFileSync(new URL('icon.png', OUT), png(size, app));
console.log('Иконки записаны в desktop/assets/');
