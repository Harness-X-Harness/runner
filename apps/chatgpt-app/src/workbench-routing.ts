/** Advertised launchers only; the host owns actual iframe identity and lifecycle. */
export function launchesWorkbench(toolName: string): boolean {
  return toolName === "list_environments" || toolName === "open_environment" || toolName === "show_workbench";
}
