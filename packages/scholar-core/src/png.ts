/**
 * SVG → PNG for the diagrams this package draws.
 *
 * Kept out of the main entry (`@pho/scholar-core/png`) because it loads a
 * native module (@resvg/resvg-js); the MCP server and the web tools import it
 * only where they actually rasterise.
 *
 * Text is drawn with Be Vietnam Pro (SIL OFL 1.1, `assets/fonts/OFL.txt`),
 * loaded from the package itself so the output does not depend on which fonts
 * the server happens to have installed. A server that bundles this package
 * must ship `assets/fonts/` next to it, or pass its own `fontFiles`.
 */

import { Resvg } from '@resvg/resvg-js';
import { fileURLToPath } from 'node:url';

const FONT_DIR = new URL('../assets/fonts/', import.meta.url);

export const DEFAULT_FONT_FILES = ['BeVietnamPro-Regular.ttf', 'BeVietnamPro-SemiBold.ttf'].map((f) =>
  fileURLToPath(new URL(f, FONT_DIR)),
);

export interface PngOptions {
  /** Pixel density multiplier. Default 2 (sharp on slides and retina screens). */
  scale?: number;
  fontFiles?: string[];
}

export function svgToPng(svg: string, opts: PngOptions = {}): Uint8Array {
  const scale = Math.min(4, Math.max(0.5, opts.scale ?? 2));
  const resvg = new Resvg(svg, {
    fitTo: { mode: 'zoom', value: scale },
    font: {
      fontFiles: opts.fontFiles ?? DEFAULT_FONT_FILES,
      loadSystemFonts: false,
      defaultFontFamily: 'Be Vietnam Pro',
      sansSerifFamily: 'Be Vietnam Pro',
    },
    background: '#ffffff',
  });
  return resvg.render().asPng();
}
