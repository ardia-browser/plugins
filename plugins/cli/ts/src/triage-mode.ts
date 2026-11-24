const SHARED_VALUE_FLAGS = ["--data-dir", "--timeout", "--port", "--ws"];
const SHARED_BOOL_FLAGS = ["--json"];
const HELP = ["--help", "-h"];
const ALLOWED: Readonly<Record<string, readonly string[] | undefined>> = {
  commands: undefined,
  methods: undefined,
  plugins: ["list"],
  triage: ["file"],
};

export const TRIAGE_MODE_REFUSAL =
  "ardia: this is a triage session (ARDIA_TRIAGE=1), so only triage file, plugins list, commands, methods, --version and --help run here\n";

export function inTriageMode(): boolean {
  return process.env.ARDIA_TRIAGE === "1";
}

function afterSharedFlags(argv: readonly string[]): readonly string[] {
  let index = 0;
  while (index < argv.length) {
    const token = argv[index] as string;
    const name = token.split("=")[0] as string;
    if (SHARED_VALUE_FLAGS.includes(name)) index += token.includes("=") ? 1 : 2;
    else if (SHARED_BOOL_FLAGS.includes(token)) index += 1;
    else break;
  }
  return argv.slice(index);
}

export function allowedInTriage(argv: readonly string[]): boolean {
  const words = afterSharedFlags(argv);
  const [first, second] = words;
  if (first === undefined) return true;
  if (words.length === 1 && (first === "--version" || HELP.includes(first))) return true;
  if (!Object.hasOwn(ALLOWED, first)) return false;
  const verbs = ALLOWED[first];
  if (verbs === undefined) return true;
  if (words.length === 2 && HELP.includes(second as string)) return true;
  return second !== undefined && verbs.includes(second);
}
