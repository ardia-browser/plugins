declare const ARDIA_CLI_VERSION: string | undefined;

export function cliVersion(): string {
  return typeof ARDIA_CLI_VERSION === "string" ? ARDIA_CLI_VERSION : "0.0.0.dev0";
}

export function isDevBuild(): boolean {
  const version = cliVersion();
  return version.includes(".dev") || version.startsWith("0.0.0");
}
