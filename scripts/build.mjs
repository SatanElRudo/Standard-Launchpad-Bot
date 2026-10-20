import { build } from 'esbuild';
import { mkdir, copyFile } from 'node:fs/promises';
await mkdir('dist', { recursive: true });
await build({ entryPoints: ['web/app.js'], bundle: true, format: 'esm', outfile: 'dist/app.js', sourcemap: true, target: 'es2022' });
await Promise.all(['index.html', 'style.css', 'favicon.svg'].map(file => copyFile(`web/${file}`, `dist/${file}`)));
console.log('Frontend gebaut: dist/');
