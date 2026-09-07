const esbuild = require('esbuild');
const fs = require('fs');
const path = require('path');

const isWatch = process.argv.includes('--watch');

function copyDirSync(src, dest) {
  if (!fs.existsSync(dest)) {
    fs.mkdirSync(dest, { recursive: true });
  }
  const entries = fs.readdirSync(src, { withFileTypes: true });
  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDirSync(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

async function build() {
  const commonConfig = {
    bundle: true,
    platform: 'node',
    target: 'node20',
    sourcemap: true,
    minify: false,
    logLevel: 'info',
    banner: {
      js: '#!/usr/bin/env node',
    },
  };

  // Build Standalone CLI
  const cliCtx = await esbuild.context({
    ...commonConfig,
    entryPoints: ['src/cli.ts'],
    outfile: 'dist/cli.js',
    format: 'cjs',
  });

  // Copy web assets to dist/web
  const webSrc = path.join(__dirname, 'web');
  const webDest = path.join(__dirname, 'dist', 'web');
  if (fs.existsSync(webSrc)) {
    copyDirSync(webSrc, webDest);
    console.log(`[build] Copied web assets to ${webDest}`);
  }

  if (isWatch) {
    console.log('[build] Watching for changes...');
    await cliCtx.watch();
  } else {
    await cliCtx.rebuild();
    await cliCtx.dispose();

    // Make dist/cli.js executable on POSIX
    try {
      const cliDist = path.join(__dirname, 'dist', 'cli.js');
      if (fs.existsSync(cliDist)) {
        fs.chmodSync(cliDist, 0o755);
      }
    } catch {
      // Ignore chmod errors on Windows
    }

    console.log('[build] Build completed successfully.');
  }
}

build().catch((err) => {
  console.error(err);
  process.exit(1);
});

