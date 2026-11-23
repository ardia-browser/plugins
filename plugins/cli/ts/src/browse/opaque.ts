const SECRET_SUBCOMMANDS = ["credentials", "auth"];
const TYPED_TEXT = ["type", "inserttext"];

export function opaqueSlot(command: string | undefined, positionals: readonly string[]): boolean {
  const [first, second] = positionals;
  switch (command) {
    case "set":
      return SECRET_SUBCOMMANDS.includes(first ?? "") && (positionals.length === 1 || positionals.length === 2);
    case "fill":
    case "type":
      return positionals.length === 1;
    case "keyboard":
      return TYPED_TEXT.includes(first ?? "") && positionals.length === 1;
    case "cookies":
      return first === "set" && positionals.length === 2;
    case "storage":
      return second === "set" && positionals.length === 3;
    default:
      return false;
  }
}
