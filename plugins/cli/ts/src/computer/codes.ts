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
  if (status > 128 && status < 160) return "driver_signal";
  return EXACT_EXITS.includes(status) ? `driver_exit_${status}` : "driver_exit_other";
}

export function permissionCode(grants: Grants): string | undefined {
  if (!grants.accessibility && !grants.screenRecording) return "permission_both_missing";
  if (!grants.accessibility) return "permission_accessibility_missing";
  if (!grants.screenRecording) return "permission_screen_recording_missing";
  return undefined;
}

const ACCESSIBILITY_MISSING = /\baccessibility\b[^\n]{0,40}?\bnot granted\b/i;
const SCREEN_RECORDING_MISSING = /\bscreen recording\b[^\n]{0,40}?\bnot granted\b/i;
const DAEMON_DOWN = /\bdaemon is not running\b/i;

export function missingGrantsIn(text: string): Grants | undefined {
  const accessibility = !ACCESSIBILITY_MISSING.test(text);
  const screenRecording = !SCREEN_RECORDING_MISSING.test(text);
  return accessibility && screenRecording ? undefined : { accessibility, screenRecording };
}

export function classifyDriverExit(command: string, status: number, text: string): string {
  if (status > 128 && status < 160) return "driver_signal";
  const grants = missingGrantsIn(text);
  if (grants !== undefined) return permissionCode(grants) as string;
  if (DAEMON_DOWN.test(text)) return "daemon_not_running";
  if (status === 2 || status === 64) return "bad_arguments";
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
