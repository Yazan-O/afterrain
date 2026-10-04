// Words drawn on a canvas are invisible to the DOM, so drawing code registers them here while they are on
// screen. The e2e word budget and number provenance checks read window.__sayrCanvasWords.

export interface CanvasText {
  /** Exactly the text drawn. */
  readonly text: string;
  /** The numbers.json key when the text is a number (same rule as data-num in the DOM). */
  readonly num?: string;
  /** The format for num (same rule as data-fmt). */
  readonly fmt?: string;
  /** True when the text is a time or date (same rule as data-time). */
  readonly time?: boolean;
  /** A `<file>#<json pointer>` reference to the data value the text shows (same rule as data-src). */
  readonly src?: string;
}

declare global {
  interface Window {
    __sayrCanvasWords?: Record<string, CanvasText>;
  }
}

const registry = (): Record<string, CanvasText> => (window.__sayrCanvasWords ??= {});

/** Call when the text is drawn; the id is the drawing's own handle (redrawing with the same id replaces it). */
export const registerCanvasText = (id: string, entry: CanvasText): void => {
  registry()[id] = entry;
};

/** Call when the text leaves the screen or fades below 0.1 opacity. */
export const clearCanvasText = (id: string): void => {
  delete registry()[id];
};
