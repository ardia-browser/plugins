const CODE_BOOL_FLAGS: Readonly<Record<string, readonly string[]>> = {
  eval: ["--stdin", "--main-world"],
  script: [],
};

const CODE_COMMANDS: Readonly<Record<string, readonly string[]>> = {
  eval: ["--out", "--timeout", "--max-output", "-b"],
  script: ["--out", "--timeout"],
};

type Word = { value: string; start: number; end: number; quotedWhole: boolean };

function words(line: string): Word[] | null {
  const found: Word[] = [];
  let at = 0;
  while (at < line.length) {
    while (at < line.length && /\s/u.test(line[at] as string)) at += 1;
    if (at >= line.length) break;
    const start = at;
    let value = "";
    let quotes = 0;
    while (at < line.length && !/\s/u.test(line[at] as string)) {
      const char = line[at] as string;
      if (char === "'") {
        const close = line.indexOf("'", at + 1);
        if (close < 0) return null;
        value += line.slice(at + 1, close);
        at = close + 1;
        quotes += 1;
      } else if (char === '"') {
        at += 1;
        while (at < line.length && line[at] !== '"') {
          if (line[at] === "\\" && at + 1 < line.length && '\\"$`\n'.includes(line[at + 1] as string)) at += 1;
          value += line[at];
          at += 1;
        }
        if (at >= line.length) return null;
        at += 1;
        quotes += 1;
      } else if (char === "\\" && at + 1 < line.length) {
        value += line[at + 1];
        at += 2;
      } else {
        value += char;
        at += 1;
      }
    }
    const quotedWhole = quotes === 1 && (line[start] === "'" || line[start] === '"') && line[at - 1] === line[start];
    found.push({ value, start, end: at, quotedWhole });
  }
  return found;
}

export function codeLine(line: string): string[] | null {
  const split = words(line);
  const first = line.trimStart().split(/\s/u, 1)[0] ?? "";
  const valueFlags = CODE_COMMANDS[first];
  if (valueFlags === undefined) return null;
  const start = line.indexOf(first) + first.length;
  const argv = [first];
  if (split === null) {
    const raw = line.slice(start).trim();
    return raw ? [first, raw] : argv;
  }
  let index = 1;
  while (index < split.length && (split[index] as Word).value.startsWith("-") && !(split[index] as Word).quotedWhole) {
    const flag = split[index] as Word;
    argv.push(flag.value);
    index += 1;
    if (valueFlags.includes(flag.value) && index < split.length) {
      argv.push((split[index] as Word).value);
      index += 1;
    }
  }
  if (index >= split.length) return argv;
  const code = split[index] as Word;
  if (code.quotedWhole) {
    argv.push(code.value);
    for (const rest of split.slice(index + 1)) argv.push(rest.value);
    return argv;
  }
  let end = split.length;
  const trailing: string[] = [];
  const bools = CODE_BOOL_FLAGS[first] ?? [];
  for (;;) {
    const last = split[end - 1] as Word;
    const before = split[end - 2] as Word | undefined;
    if (end - 2 > index && before !== undefined && valueFlags.includes(before.value) && !before.quotedWhole) {
      trailing.unshift(before.value, last.value);
      end -= 2;
    } else if (end - 1 > index && bools.includes(last.value) && !last.quotedWhole) {
      trailing.unshift(last.value);
      end -= 1;
    } else break;
  }
  argv.push(line.slice(code.start, (split[end - 1] as Word).end).trim(), ...trailing);
  return argv;
}
