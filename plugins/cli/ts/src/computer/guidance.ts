import type { Grants } from "./codes.ts";

const ACCESSIBILITY_PANE = "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility";
const SCREEN_RECORDING_PANE = "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture";

function missingNames(grants: Grants): string[] {
  const names: string[] = [];
  if (!grants.accessibility) names.push("Accessibility");
  if (!grants.screenRecording) names.push("Screen Recording");
  return names;
}

export function permissionLines(app: string, grants: Grants): string[] {
  const names = missingNames(grants);
  const what = names.length === 2 ? "the Accessibility and Screen Recording permissions" : `the ${names[0]} permission`;
  const lines = [
    `ardia computer: ${app} doesn't have ${what} yet. macOS ties ${names.length === 2 ? "them" : "it"} to CuaDriver.app (com.trycua.driver), not to your terminal or agent, so granting ${names.length === 2 ? "them" : "it"} to the terminal doesn't help.`,
    `  fix: ardia computer permissions grant   (asks macOS for ${names.length === 2 ? "them" : "it"}, attributed to CuaDriver.app)`,
  ];
  if (!grants.accessibility) lines.push(`   or: turn on CuaDriver in System Settings > Privacy & Security > Accessibility   (open "${ACCESSIBILITY_PANE}")`);
  if (!grants.screenRecording) {
    lines.push(`   or: turn on CuaDriver in System Settings > Privacy & Security > Screen & System Audio Recording   (open "${SCREEN_RECORDING_PANE}")`);
  }
  lines.push("  then run the command again");
  return lines;
}

export function notInstalledLine(applications: string, command: string): string {
  return `ardia computer: Cua Driver isn't set up yet. Run ardia computer setup: it puts CuaDriver.app in ${applications}, which macOS ties the Accessibility and Screen Recording permissions to, and asks for them. \`${command}\` needs it`;
}

export function daemonLines(message: string, code: string): string[] {
  const lines = [`ardia computer: ${message}.`];
  if (code === "daemon_timeout") {
    lines.push("  If macOS is showing CuaDriver's permission prompts, allow Accessibility and Screen Recording for CuaDriver.app and run the command again.");
  }
  lines.push("  fix: ardia computer permissions grant   (starts Cua Driver through macOS and checks its permissions)");
  lines.push("   or: ardia computer doctor              (says what's wrong with the install)");
  return lines;
}

export function daemonDownLines(ownSocket: boolean): string[] {
  return [
    ownSocket
      ? "ardia computer: Cua Driver's background service isn't running on that socket, and ardia doesn't start one for a --socket you chose."
      : "ardia computer: Cua Driver's background service isn't running.",
    "  fix: ardia computer permissions grant   (starts it through macOS so the permissions stay CuaDriver.app's)",
    "   or: ardia computer doctor              (says what's wrong with the install)",
  ];
}
