export const EXACT_EXITS: readonly number[] = [...Array.from({ length: 15 }, (_, index) => index + 1), ...Array.from({ length: 15 }, (_, index) => index + 64)];

export const COMPUTER_ERROR_CODES: readonly string[] = [
  "unsupported_platform",
  "driver_not_installed",
  "driver_unverified",
  "driver_check_failed",
  "driver_install_failed",
  "download_failed",
  "setup_busy",
  "applications_not_writable",
  "launcher_missing",
  "driver_command_refused",
  "driver_spawn_failed",
  "daemon_start_failed",
  "daemon_timeout",
  "daemon_not_running",
  "permission_accessibility_missing",
  "permission_screen_recording_missing",
  "permission_both_missing",
  "bad_arguments",
  "tool_failed",
  "doctor_probe_failed",
  "driver_signal",
  "driver_exit_other",
  ...EXACT_EXITS.map((code) => `driver_exit_${code}`),
];

export type Grants = { accessibility: boolean; screenRecording: boolean };

export function driverExitCode(status: number): string {
  return EXACT_EXITS.includes(status) ? `driver_exit_${status}` : "driver_exit_other";
}

export function permissionCode(grants: Grants): string | undefined {
  if (!grants.accessibility && !grants.screenRecording) return "permission_both_missing";
  if (!grants.accessibility) return "permission_accessibility_missing";
  if (!grants.screenRecording) return "permission_screen_recording_missing";
  return undefined;
}

const ACCESSIBILITY_MISSING = [/^Accessibility permission not granted\b/, /^Accessibility is NOT granted for this process\b/];
const SCREEN_RECORDING_MISSING = [/^Screen Recording permission not granted\b/, /^Screen Recording is NOT granted for this process\b/];
const DAEMON_DOWN = /^Cua Driver daemon is not running\b/;
const ECHOED_INPUT = /^\s*received:/;

export function diagnosticLines(stderr: string): string[] {
  const lines: string[] = [];
  for (const line of stderr.split("\n")) {
    if (ECHOED_INPUT.test(line)) break;
    if (line !== "" && !/^\s/.test(line)) lines.push(line.replace(/\r$/, ""));
  }
  return lines;
}

export function missingGrantsIn(stderr: string): Grants | undefined {
  const lines = diagnosticLines(stderr);
  const accessibility = !lines.some((line) => ACCESSIBILITY_MISSING.some((shape) => shape.test(line)));
  const screenRecording = !lines.some((line) => SCREEN_RECORDING_MISSING.some((shape) => shape.test(line)));
  return accessibility && screenRecording ? undefined : { accessibility, screenRecording };
}

export function daemonDownIn(stderr: string): boolean {
  return diagnosticLines(stderr).some((line) => DAEMON_DOWN.test(line));
}

export function classifyDriverExit(command: string, status: number, stderr: string, signal?: string): string {
  if (signal !== undefined) return "driver_signal";
  if (status === 2 || status === 64) return "bad_arguments";
  const grants = missingGrantsIn(stderr);
  if (grants !== undefined) return permissionCode(grants) as string;
  if (daemonDownIn(stderr)) return "daemon_not_running";
  if (command === "call" && status === 1) return "tool_failed";
  if (command === "doctor" || command === "diagnose") return "doctor_probe_failed";
  return driverExitCode(status);
}

export function grantsOf(payload: unknown): { running: boolean; grants?: Grants } | undefined {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return undefined;
  const fields = payload as Record<string, unknown>;
  if (fields.daemon_running === false) return { running: false };
  if (typeof fields.accessibility !== "boolean" || typeof fields.screen_recording !== "boolean") return undefined;
  return { running: true, grants: { accessibility: fields.accessibility, screenRecording: fields.screen_recording } };
}
