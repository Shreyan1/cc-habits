import { build } from 'esbuild';
import { readFileSync, writeFileSync, unlinkSync } from 'fs';

// Build step for the cc-habits marketing site.
//
// The site was previously transpiled in the browser with @babel/standalone and
// loaded development React from a CDN. This script replaces that with a single
// minified, self-contained bundle (React compiled in, no third-party runtime
// call), produced ahead of time. The component sources stay in global-scope
// .jsx form and are concatenated in the same order they were inlined before.

const ORDER = ['tweaks-panel', 'components', 'hero', 'how-it-works', 'sections', 'app'];

function concatSources() {
  return ORDER.map((name) => readFileSync(`${name}.jsx`, 'utf8')).join('\n\n');
}

// The concatenated code references global React and ReactDOM. We provide them by
// importing the real packages at the top of a temporary entry module, so esbuild
// bundles React into the output rather than expecting it on window.
function makeEntry() {
  const appCode = concatSources();
  return [
    "import * as React from 'react';",
    "import { createRoot } from 'react-dom/client';",
    'const ReactDOM = { createRoot };',
    'window.React = React;',
    'window.ReactDOM = ReactDOM;',
    '',
    appCode,
  ].join('\n');
}

async function run() {
  const entryFile = '.app.entry.jsx';
  writeFileSync(entryFile, makeEntry());
  try {
    const result = await build({
      entryPoints: [entryFile],
      bundle: true,
      minify: true,
      format: 'iife',
      target: 'es2019',
      jsx: 'transform',
      jsxFactory: 'React.createElement',
      jsxFragment: 'React.Fragment',
      loader: { '.jsx': 'jsx' },
      outfile: 'app.js',
      metafile: true,
      legalComments: 'none',
    });
    const bytes = readFileSync('app.js').length;
    console.log(`build: app.js (${(bytes / 1024).toFixed(1)} KB minified, React bundled)`);
    return result;
  } finally {
    unlinkSync(entryFile);
  }
}

run().catch((e) => { console.error(e); process.exit(1); });
