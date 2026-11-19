import base64
import json
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from ardia_cli import redact as redaction
import difflib

from ardia_cli.browse import changes, media, readurl, snapshot

data_dir = Path(sys.argv[1])
wanted = set(sys.argv[2].split(",")) if len(sys.argv) > 2 and sys.argv[2] else None
results = {}


def timed(label, reps, run):
    if wanted and label not in wanted:
        return
    run()
    samples = []
    for _ in range(reps):
        started = time.perf_counter()
        run()
        samples.append((time.perf_counter() - started) * 1000)
    samples.sort()
    results[label] = round(samples[len(samples) // 2], 2)


redaction.add_secret("s3cr3t-token-value-0123456789abcdef")
ax_nodes = json.loads((data_dir / "ax.raw.json").read_text())["result"]["nodes"]
shot_a = base64.b64decode((data_dir / "shot-a.b64").read_text().strip())
shot_b = base64.b64decode((data_dir / "shot-b.b64").read_text().strip())
state = {}


def build():
    tree = snapshot.build_tree(ax_nodes)
    for node in snapshot.walk(tree):
        if node.role in snapshot.REF_ROLES and node.backend is not None:
            node.ref = f"e{node.backend}"
    state["tree"] = tree


build()
text = snapshot.render(state["tree"])
megabyte = text[:1_000_000] + "token=abc&"
plain_megabyte = text[:1_000_000]
timed("snapshot_build_58k", 3, build)
timed("snapshot_render", 3, lambda: snapshot.render(state["tree"]))
timed("snapshot_render_interactive", 3, lambda: snapshot.render(state["tree"], interactive=True))
timed("redact_1MB_hit", 5, lambda: redaction.redact(megabyte))
timed("redact_1MB_nohit", 5, lambda: redaction.redact(plain_megabyte))


def view(loader):
    return changes.View("t", loader, "https://a.example/", "T", changes.entries_of(state["tree"]), changes.containers_of(state["tree"]))


timed("changes_diff_render_58k", 3, lambda: changes.render(changes.diff(view("a"), view("a"))))
timed("changes_new_document_58k", 3, lambda: changes.render(changes.diff(view("a"), view("b"))))
timed("png_decode_1280x800", 3, lambda: media.decode_png(shot_a))
timed("png_compare_total", 3, lambda: media.compare_pngs(shot_a, shot_b, 0.1, None))
image = media.decode_png(shot_a)
timed("png_encode_deflate6", 3, lambda: media.encode_png(image))
big_html = (data_dir.parent / "big.html").read_text()


def extract():
    extractor = readurl.TextExtractor()
    extractor.feed(big_html)
    return extractor.text()


timed("readurl_extract_577KB", 3, extract)
before_lines = text.splitlines()
after_lines = [line + " changed" if index % 997 == 0 else line for index, line in enumerate(before_lines)]
timed("diff_snapshot_unified", 3, lambda: list(difflib.unified_diff(before_lines, after_lines, "before", "after", lineterm="")))
print(json.dumps({"runtime": "python", "ms": results}))
