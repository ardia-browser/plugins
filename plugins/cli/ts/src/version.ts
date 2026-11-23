declare const ARDIA_CLI_VERSION: string | undefined;
declare const ARDIA_CLI_BUILD: string | undefined;

export function cliVersion(): string {
  return typeof ARDIA_CLI_VERSION === "string" ? ARDIA_CLI_VERSION : "0.0.0.dev0";
}

export function isDevBuild(): boolean {
  const version = cliVersion();
  return version.includes(".dev") || version.startsWith("0.0.0");
}

export const BUILD_OVERRIDE = "ARDIA_BROWSE_BUILD";

export function buildStamp(): string {
  const override = process.env[BUILD_OVERRIDE];
  if (override) return override;
  return typeof ARDIA_CLI_BUILD === "string" ? ARDIA_CLI_BUILD : `${cliVersion()}+source`;
}
