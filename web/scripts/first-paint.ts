// The page's first paint, written into index.html at build time: the story's first line (src/app/narration.ts
// WEIR_LINE) where the narration sets it, on the night ground, before any script but this one runs. The live story
// takes the line over in place; the first paint fades once the first chapter's scene is drawing (src/main.ts).
import { WEIR_LINE } from '../src/app/narration';

const esc = (v: string): string => v.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** The markup, for index.html. A link to anything but the story's top (or its first beat) removes it at once. */
export function firstPaintHtml(_dataDir: string): string {
  return `<div id="first">
      <div class="story-say fp-say"><p class="say-main">${esc(WEIR_LINE)}</p></div>
      <button class="fp-retry retry" type="button" hidden>Retry</button>
    </div>
    <script>
      (function () {
        var f = document.getElementById('first');
        var h = location.hash;
        if (h && h !== '#/story' && h !== '#/story/bath' && h !== '#/story/weir') f.remove();
      })();
    </script>`;
}

/** The inline styles of the first paint: the night ground and the narration's place and size (styles.css .story-say). */
export const FIRST_PAINT_CSS = `
      html, body { margin: 0; height: 100%; background: #04090a; color: #e7eeea; overflow: hidden; }
      #first { position: fixed; inset: 0; z-index: 3; pointer-events: none; font-family: 'Archivo', 'Helvetica Neue', Helvetica, sans-serif; }
      body:has(#first) :is(.mark, .place, .elsewhere) { visibility: hidden; }
      #first .fp-say { position: fixed; left: clamp(20px, 8.5vw, 160px); top: clamp(84px, 13vh, 132px); width: min(860px, calc(100vw - 2 * clamp(20px, 8.5vw, 160px))); margin: 0; }
      #first .say-main { margin: 0; font-weight: 700; font-size: clamp(26px, 2.9vw, 44px); line-height: 1.12; letter-spacing: -0.018em; text-shadow: 0 0 10px #04090a, 0 0 24px #04090a; }
      @media (max-width: 699px) { #first .fp-say { top: 64px; } #first .say-main { font-size: 24px; } }
      #first .fp-retry { position: absolute; left: clamp(20px, 8.5vw, 160px); top: 50vh; pointer-events: auto; min-height: 44px; padding: 0; border: 0; background: none; color: #e7eeea; font: 500 20px/44px 'Archivo', 'Helvetica Neue', Helvetica, sans-serif; text-decoration: underline; cursor: pointer; }`;
