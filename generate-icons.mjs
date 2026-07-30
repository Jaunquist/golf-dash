import sharp from 'sharp';
import { readFileSync, mkdirSync } from 'fs';

// Create a larger 512x512 version of the SVG
const svgContent = `<svg viewBox="0 0 512 512" width="512" height="512" fill="none" xmlns="http://www.w3.org/2000/svg">
  <!-- Background circle -->
  <circle cx="256" cy="256" r="256" fill="#1d5c3a"/>
  <!-- Flag pin staff -->
  <line x1="208" y1="112" x2="208" y2="384" stroke="#f5f2ea" stroke-width="28" stroke-linecap="round"/>
  <!-- Flag triangle -->
  <path d="M208 112 L352 168 L208 224 Z" fill="#d4a017"/>
  <!-- Golf ball -->
  <circle cx="208" cy="408" r="40" fill="#f5f2ea"/>
  <circle cx="195" cy="398" r="8" fill="#c8c0b0"/>
  <circle cx="221" cy="403" r="6.4" fill="#c8c0b0"/>
  <circle cx="205" cy="419" r="6.4" fill="#c8c0b0"/>
</svg>`;

const svgBuffer = Buffer.from(svgContent);

mkdirSync('/home/user/workspace/golf-dash/client/public/icons', { recursive: true });

// Generate 192x192
await sharp(svgBuffer)
  .resize(192, 192)
  .png()
  .toFile('/home/user/workspace/golf-dash/client/public/icons/icon-192.png');

// Generate 512x512
await sharp(svgBuffer)
  .resize(512, 512)
  .png()
  .toFile('/home/user/workspace/golf-dash/client/public/icons/icon-512.png');

// Generate 180x180 Apple touch icon
await sharp(svgBuffer)
  .resize(180, 180)
  .png()
  .toFile('/home/user/workspace/golf-dash/client/public/apple-touch-icon.png');

console.log('Icons generated successfully');
