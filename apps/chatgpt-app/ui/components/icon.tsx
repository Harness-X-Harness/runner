/** Small, integer-grid icons. Names and interaction hints belong to their controls. */
export function Icon({ name }: { name: "refresh" | "list" | "power" | "send" | "stop" | "check" | "cross" | "clock" }) {
  const paths = {
    refresh: "M4 2h7v2H4v2H2V4h2zM11 4h2v3h2v2H9V3h2zM2 9h2v3h2v2H4v-2H2zM6 12h6v-2h2v2h-2v2H6z",
    list: "M2 2h5v5H2zM9 2h5v5H9zM2 9h5v5H2zM9 9h5v5H9z",
    power: "M7 1h2v7H7zM3 3h2v2H3v6h2v2h6v-2h2V5h-2V3h2v2h2v6h-2v2h-2v2H5v-2H3v-2H1V5h2z",
    send: "M7 2h2v2h2v2h2v2h-2V6H9v8H7V6H5v2H3V6h2V4h2z",
    stop: "M3 3h10v10H3z",
    check: "M2 8h2v2h2v2H4v-2H2zM6 10h2V8h2V6h2V4h2v2h-2v2h-2v2H8v2H6z",
    cross: "M3 3h2v2h2v2h2V5h2V3h2v2h-2v2H9v2h2v2h2v2h-2v-2H9V9H7v2H5v2H3v-2h2V9h2V7H5V5H3z",
    clock: "M4 1h8v2h2v2h1v7h-2v2h-2v1H4v-2H2v-2H1V5h2V3h1zM5 3v2H3v6h2v2h6v-2h2V5h-2V3zM7 4h2v4h3v2H7z",
  };
  return <svg className="pixel-icon" viewBox="0 0 16 16" aria-hidden="true" focusable="false" shapeRendering="crispEdges"><path d={paths[name]} fill="currentColor" /></svg>;
}
