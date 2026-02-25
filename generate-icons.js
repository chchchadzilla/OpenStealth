// OpenStealth Icon Generator
// Run: node generate-icons.js  (requires canvas: npm install canvas)
// Or simply replace assets/icons/*.png with your own icons.

const fs = require('fs');
const path = require('path');

function generateSVGIcon(size) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
  <defs>
    <linearGradient id="bg" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" style="stop-color:#1a1a2e;stop-opacity:1" />
      <stop offset="100%" style="stop-color:#16213e;stop-opacity:1" />
    </linearGradient>
  </defs>
  <rect width="${size}" height="${size}" rx="${size * 0.15}" fill="url(#bg)"/>
  <text x="50%" y="55%" dominant-baseline="middle" text-anchor="middle" 
        font-family="monospace" font-size="${size * 0.5}" font-weight="bold" fill="#0f0">
    S
  </text>
</svg>`;
}

const sizes = [16, 48, 128];
const dir = path.join(__dirname, 'assets', 'icons');

if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

sizes.forEach(size => {
  const svg = generateSVGIcon(size);
  fs.writeFileSync(path.join(dir, `icon${size}.svg`), svg);
  console.log(`Generated icon${size}.svg`);
});

console.log('\nSVG icons generated. For PNG conversion, use an image editor or online converter.');
console.log('Chrome extensions work best with PNG icons.');
