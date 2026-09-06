import type { Plugin } from 'vite';
import { defineConfig } from 'vite';

/**
 * Inline the stylesheet into index.html.
 *
 * On nsite a file is served by whichever blossom server the gateway picks, and they disagree
 * about MIME types: the same bytes come back as `text/css` from one and `text/plain` from
 * another. A browser refuses to apply a stylesheet served as `text/plain` (strict MIME
 * checking), so the page renders unstyled — and which server answers is not ours to choose.
 *
 * A `<style>` tag has no MIME to get wrong. The CSS is a few kB, so this also saves a round
 * trip and removes the unstyled flash. The scripts stay external: they are far too large to
 * inline, and a wrong MIME on those is loud rather than silent.
 */
function inlineCss(): Plugin {
  return {
    name: 'inline-css',
    apply: 'build',
    enforce: 'post',
    generateBundle(_options, bundle) {
      for (const [file, asset] of Object.entries(bundle)) {
        if (!file.endsWith('.css') || asset.type !== 'asset') continue;
        const css = String(asset.source);
        const html = bundle['index.html'];
        if (html?.type !== 'asset') continue;

        const link = new RegExp(`<link[^>]+href="[^"]*${file.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"[^>]*>`);
        const source = String(html.source);
        if (!link.test(source)) {
          // Fail loudly: silently shipping without styles is exactly the bug this prevents.
          this.error(`could not find the <link> for ${file} in index.html`);
        }
        html.source = source.replace(link, `<style>${css}</style>`);
        delete bundle[file];
      }
    },
  };
}

// nsite(NIP-5A) 배포용 — 경로를 상대로 두고 산출물을 한 디렉토리에 모은다.
export default defineConfig({
  base: './',
  build: { outDir: 'dist', assetsDir: 'assets', target: 'es2022' },
  plugins: [inlineCss()],
});
