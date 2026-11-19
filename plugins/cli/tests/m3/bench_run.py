import argparse
import json
import os
import statistics
import subprocess
import sys
import tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
CLI = HERE.parents[1]


def build(out: Path, bun: str) -> tuple[Path, Path]:
    out.mkdir(parents=True, exist_ok=True)
    hardened, jit = out / "bench-nojit", out / "bench-jit"
    subprocess.run([bun, "build", "--compile", "--no-compile-autoload-dotenv", "--no-compile-autoload-bunfig", str(CLI / "ts" / "tests" / "m3" / "bench.ts"),
                    "--outfile", str(hardened)], check=True, capture_output=True, cwd=CLI / "ts")
    jit.write_bytes(hardened.read_bytes())
    jit.chmod(0o755)
    subprocess.run(["codesign", "--force", "-s", "-", "--options", "runtime", str(hardened)], check=True, capture_output=True)
    subprocess.run(["codesign", "--force", "-s", "-", str(jit)], check=True, capture_output=True)
    return hardened, jit


def sample(command: list[str]) -> dict:
    done = subprocess.run(command, capture_output=True, text=True, timeout=600)
    if done.returncode != 0:
        raise SystemExit(f"{command[0]} failed:\n{done.stderr[-3000:]}")
    return json.loads(done.stdout.strip().splitlines()[-1])["ms"]


def main() -> int:
    parser = argparse.ArgumentParser(description="Times the M3 pure hot paths: the TypeScript bench compiled and signed with the hardened runtime "
                                     "(JIT off, as shipped) against the Python originals, interleaved round by round.")
    parser.add_argument("--rounds", type=int, default=30)
    parser.add_argument("--data", default="/Users/barreloflube/ardia-scratch/ts-port/m3-spikes/data")
    parser.add_argument("--python", default=sys.executable)
    parser.add_argument("--bun", default=os.environ.get("BUN", "bun"))
    parser.add_argument("--only", default="")
    parser.add_argument("--jit", action="store_true", help="also time the JIT build each round")
    parser.add_argument("--json", help="write every sample here")
    args = parser.parse_args()
    hardened, jit = build(Path(tempfile.gettempdir()) / "ardia-m3p-bench", args.bun)
    runs = {"ts": [hardened], "python": [args.python, str(HERE / "bench.py")]}
    if args.jit:
        runs["ts-jit"] = [jit]
    samples: dict[str, dict[str, list[float]]] = {name: {} for name in runs}
    for round_number in range(args.rounds):
        order = list(runs) if round_number % 2 == 0 else list(reversed(runs))
        for name in order:
            for label, value in sample(runs[name] + [args.data, args.only]).items():
                samples[name].setdefault(label, []).append(value)
        print(f"round {round_number + 1}/{args.rounds} done", file=sys.stderr, flush=True)
    if args.json:
        Path(args.json).write_text(json.dumps(samples, indent=1))
    labels = sorted({label for values in samples.values() for label in values})
    print(f"{'hot path':28} " + "  ".join(f"{name + ' median/p90':>22}" for name in runs) + "  ts/python")
    for label in labels:
        cells, medians = [], {}
        for name in runs:
            values = sorted(samples[name].get(label, []))
            if values:
                medians[name] = statistics.median(values)
                cells.append(f"{medians[name]:>10.2f} / {values[int(len(values) * 0.9) - 1 if len(values) > 1 else 0]:>9.2f}")
            else:
                cells.append(f"{'-':>22}")
        ratio = f"{medians['ts'] / medians['python']:.2f}x" if medians.get("python") and "ts" in medians else ""
        print(f"{label:28} " + "  ".join(cells) + f"  {ratio}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
