export const WIDGET_BASE_STYLES = `
    :root {
      color-scheme: light dark;
      font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      --muted: color-mix(in srgb, CanvasText 62%, transparent);
      --subtle: color-mix(in srgb, CanvasText 7%, transparent);
      --border: color-mix(in srgb, CanvasText 14%, transparent);
      --danger: #b42318;
    }
    :root[data-theme="light"] { color-scheme: light; }
    :root[data-theme="dark"] { color-scheme: dark; --danger: #ff8a80; }
    * { box-sizing: border-box; }
    body { margin: 0; color: CanvasText; background: transparent; }
    .card { padding: 16px; }
    header { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; }
    h1 { margin: 0; font-size: 17px; line-height: 1.3; font-weight: 650; letter-spacing: -.01em; }
    .subtitle { margin: 4px 0 0; color: var(--muted); font-size: 12px; line-height: 1.4; overflow-wrap: anywhere; }
    .badge { display: inline-flex; align-items: center; gap: 7px; min-height: 26px; padding: 4px 9px; border-radius: 999px; background: var(--subtle); font-size: 12px; font-weight: 600; white-space: nowrap; }
    .dot { width: 7px; height: 7px; border-radius: 50%; background: color-mix(in srgb, CanvasText 45%, transparent); }
    .description { margin: 14px 0 0; color: var(--muted); font-size: 14px; line-height: 1.5; }
    .actions { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 16px; }
    button { min-height: 38px; padding: 8px 13px; border: 1px solid transparent; border-radius: 10px; font: inherit; font-size: 13px; font-weight: 600; cursor: pointer; }
    button:focus-visible, select:focus-visible, input:focus-visible { outline: 2px solid CanvasText; outline-offset: 2px; }
    button:disabled { cursor: wait; opacity: .55; }
    .primary { color: Canvas; background: CanvasText; }
    .secondary { color: CanvasText; border-color: var(--border); background: transparent; }
    button[data-intent="danger"] { color: var(--danger); }
    .message { min-height: 18px; margin: 10px 0 0; color: var(--muted); font-size: 12px; line-height: 1.4; }
    [hidden] { display: none !important; }
    @media (max-width: 440px) {
      .card { padding: 14px; }
      header { display: block; }
      .badge { margin-top: 10px; }
      .actions { display: grid; grid-template-columns: 1fr; }
      button { width: 100%; }
    }
`;

export const WIDGET_HOST_CONTEXT_SCRIPT = `
    function applyHostGlobals(globals) {
      const theme = globals?.theme;
      if ((theme === "light" || theme === "dark") && document.documentElement) {
        document.documentElement.dataset.theme = theme;
      }
    }
    applyHostGlobals(window.openai);
    window.addEventListener("openai:set_globals", event => {
      applyHostGlobals(event.detail?.globals);
    }, { passive: true });
`;
