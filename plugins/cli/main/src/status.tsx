import { Action, ActionPanel, Detail, ardia, useEffect, useState, type DetailMetadata, type ProgramsStatus, type ViewProps } from "@ardia/plugin-sdk";

export const PROGRAM = "ardia";
export const EXAMPLE = "ardia tabs";
const LINKING_POLL_MS = 500;
const LINKING_POLL_LIMIT = 40;

type Shown = { kind: "loading" } | { kind: "status"; status: ProgramsStatus; problem?: string } | { kind: "unreachable"; problem: string };

type HostTimers = { setTimeout?: (callback: () => void, ms: number) => unknown; clearTimeout?: (timer: unknown) => void };

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));

const linkedPath = (status: ProgramsStatus) => (status.binDir ? `${status.binDir.replace(/\/+$/, "")}/${PROGRAM}` : null);

const failureReason = (status: ProgramsStatus) => status.failed.find((entry) => entry.name === PROGRAM)?.reason ?? status.failed[0]?.reason;

export const isLinked = (status: ProgramsStatus) => status.state === "linked" && status.linked.includes(PROGRAM);

export const canRetry = (status: ProgramsStatus) => status.state === "failed" || (status.state !== "linking" && !isLinked(status));

export function statusMarkdown(status: ProgramsStatus, problem?: string): string {
  const tryIt = ["Open a new terminal window and try:", "", "```sh", EXAMPLE, "```"];
  const lines: string[] = [];
  if (isLinked(status)) {
    const path = linkedPath(status);
    lines.push(`# \`${PROGRAM}\` is on your PATH`, "", path ? `It's linked at \`${path}\`.` : "It's linked.", "", ...tryIt);
  } else if (status.state === "linking") {
    lines.push(`# Putting \`${PROGRAM}\` on your PATH…`, "", "This takes a moment.");
  } else if (status.state === "failed") {
    lines.push(`# \`${PROGRAM}\` isn't on your PATH`, "", failureReason(status) ?? "Ardia couldn't link it.", "", "Fix that, then choose **Try Again**.");
  } else {
    lines.push(`# \`${PROGRAM}\` isn't on your PATH yet`, "", "Ardia links it while the Command Line plugin is on. Choose **Try Again** to link it now.");
  }
  if (problem) lines.push("", `**Try Again didn't work:** ${problem}`);
  return lines.join("\n");
}

export function statusMetadata(status: ProgramsStatus): DetailMetadata[] {
  const path = linkedPath(status);
  const state: DetailMetadata = isLinked(status)
    ? { label: "Status", text: "Linked", icon: "checkmark.circle.fill", tone: "success" }
    : status.state === "linking"
      ? { label: "Status", text: "Linking…", icon: "clock" }
      : status.state === "failed"
        ? { label: "Status", text: "Failed", icon: "exclamationmark.triangle.fill", tone: "destructive" }
        : { label: "Status", text: "Not linked", icon: "minus.circle" };
  return [
    { label: "Command", text: PROGRAM, icon: "terminal" },
    state,
    ...(isLinked(status) && path ? [{ label: "Location", text: path, icon: "folder" }] : []),
    { label: "Try", text: EXAMPLE },
  ];
}

export function CommandLineStatus(_props: ViewProps) {
  const [shown, setShown] = useState<Shown>({ kind: "loading" });
  const [retrying, setRetrying] = useState(false);
  const [polls, setPolls] = useState(0);
  const [requests] = useState(() => ({ latest: 0 }));

  const load = async (problem?: string) => {
    const mine = ++requests.latest;
    try {
      const status = await ardia.programs.status();
      if (mine === requests.latest) setShown({ kind: "status", status, problem });
    } catch (error) {
      if (mine === requests.latest) setShown({ kind: "unreachable", problem: messageOf(error) });
    }
  };

  useEffect(() => {
    void load();
  }, []);

  const linking = shown.kind === "status" && shown.status.state === "linking";

  useEffect(() => {
    if (!linking || polls >= LINKING_POLL_LIMIT) return;
    const timers = globalThis as HostTimers;
    if (typeof timers.setTimeout !== "function") return;
    const timer = timers.setTimeout(() => {
      void load().finally(() => setPolls((count) => count + 1));
    }, LINKING_POLL_MS);
    return () => timers.clearTimeout?.(timer);
  }, [linking, polls]);

  const tryAgain = async () => {
    if (retrying) return;
    setRetrying(true);
    setPolls(0);
    try {
      await ardia.programs.relink();
      await load();
    } catch (error) {
      await load(messageOf(error));
    } finally {
      setRetrying(false);
    }
  };

  if (shown.kind === "loading") return <Detail isLoading markdown={`# \`${PROGRAM}\``} />;

  if (shown.kind === "unreachable") {
    return (
      <Detail
        markdown={[`# Couldn't ask Ardia about \`${PROGRAM}\``, "", shown.problem].join("\n")}
        actions={
          <ActionPanel>
            <Action title="Check Again" icon="arrow.clockwise" onAction={() => load()} />
            <Action.CopyToClipboard title="Copy Example" content={EXAMPLE} />
          </ActionPanel>
        }
      />
    );
  }

  const { status, problem } = shown;
  const path = linkedPath(status);
  return (
    <Detail
      isLoading={retrying || linking}
      markdown={statusMarkdown(status, problem)}
      metadata={statusMetadata(status)}
      actions={
        <ActionPanel>
          {canRetry(status) ? <Action title="Try Again" icon="arrow.clockwise" onAction={tryAgain} /> : null}
          <Action.CopyToClipboard title="Copy Example" content={EXAMPLE} />
          {isLinked(status) && path ? <Action.CopyToClipboard title="Copy Location" content={path} /> : null}
          {canRetry(status) ? null : <Action title="Check Again" icon="arrow.clockwise" onAction={() => load()} />}
        </ActionPanel>
      }
    />
  );
}
