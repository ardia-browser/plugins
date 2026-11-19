import base64
import os
import struct
import zlib
from pathlib import Path

from tests.m3.cases import PIECES, generator, many, noise

SPIKE = Path(os.environ.get("ARDIA_M3_SPIKE_DATA", "/Users/barreloflube/ardia-scratch/ts-port/m3-spikes/data"))


def paeth(a, b, c):
    p = a + b - c
    pa, pb, pc = abs(p - a), abs(p - b), abs(p - c)
    return a if pa <= pb and pa <= pc else b if pb <= pc else c


def filtered(rows: list[bytes], channels: int, kinds: list[int]) -> bytes:
    out = bytearray()
    previous = bytes(len(rows[0])) if rows else b""
    for row, kind in zip(rows, kinds):
        out.append(kind)
        for i, value in enumerate(row):
            left = row[i - channels] if i >= channels else 0
            up = previous[i]
            corner = previous[i - channels] if i >= channels else 0
            predictor = {0: 0, 1: left, 2: up, 3: (left + up) >> 1, 4: paeth(left, up, corner)}.get(kind, 0)
            out.append((value - predictor) & 255)
        previous = row
    return bytes(out)


def chunk(kind: bytes, body: bytes) -> bytes:
    return struct.pack(">I", len(body)) + kind + body + struct.pack(">I", zlib.crc32(kind + body) & 0xFFFFFFFF)


def make_png(rng, width: int, height: int, color_type: int = 6, corrupt: str = "") -> bytes:
    channels = 4 if color_type == 6 else 3
    smooth = rng.random() < 0.5
    rows = []
    for y in range(height):
        if smooth:
            rows.append(bytes(((x * 7 + y * 3 + c * 50) & 255) for x in range(width) for c in range(channels)))
        else:
            rows.append(bytes(rng.getrandbits(8) for _ in range(width * channels)))
    kinds = [rng.choice([0, 1, 2, 3, 4, 4, 2, 7]) for _ in range(height)]
    raw = filtered(rows, channels, kinds)
    data = zlib.compress(raw, rng.choice([0, 1, 6, 9]))
    header = struct.pack(">IIBBBBB", width, height, 16 if corrupt == "depth" else 8, color_type, 0, 0, 1 if corrupt == "interlace" else 0)
    parts = [b"\x89PNG\r\n\x1a\n" if corrupt != "signature" else b"\x89PNG\r\n\x1a\x00"]
    if corrupt != "no-header":
        parts.append(chunk(b"IHDR", header))
    parts.append(chunk(b"tEXt", b"Comment\x00made by the oracle"))
    if corrupt == "zlib":
        data = data[: len(data) // 2]
    cut = rng.randint(1, max(1, len(data) - 1)) if len(data) > 2 and rng.random() < 0.5 else len(data)
    parts.append(chunk(b"IDAT", data[:cut]))
    if cut < len(data):
        parts.append(chunk(b"IDAT", data[cut:]))
    parts.append(chunk(b"IEND", b""))
    return b"".join(parts)


def b64(data: bytes) -> str:
    return base64.b64encode(data).decode()


def spike_shots() -> list[str]:
    return [(SPIKE / name).read_text().strip() for name in ("shot-a.b64", "shot-b.b64") if (SPIKE / name).exists()]


def random_png(rng, size=None, color_type=None, corrupt=""):
    width, height = size or (rng.randint(1, 24), rng.randint(1, 16))
    return make_png(rng, width, height, color_type or rng.choice([2, 6]), corrupt)


@generator("media.decode")
def gen_decode(rng, count, corpus):
    fixed = [[shot] for shot in spike_shots()] + [[b64(random_png(rng, corrupt=kind))] for kind in ("signature", "depth", "interlace", "no-header")]
    return many(rng, count, fixed, lambda: [b64(random_png(rng))])


@generator("media.compare")
def gen_compare(rng, count, corpus):
    shots = spike_shots()
    fixed = [[shots[0], shots[1], 0.1], [shots[0], shots[0], 0.0]] if len(shots) == 2 else []

    def make():
        size = (rng.randint(1, 20), rng.randint(1, 12))
        a = random_png(rng, size)
        b = random_png(rng, size if rng.random() < 0.85 else None)
        return [b64(a), b64(b), rng.choice([0.0, 0.1, 0.05, 0.5, 1.0])]
    return many(rng, count, fixed, make)


@generator("media.encode")
def gen_encode(rng, count, corpus):
    def make():
        width, height = rng.randint(0, 20), rng.randint(0, 12)
        return [width, height, b64(bytes(rng.getrandbits(8) for _ in range(width * height * 4)))]
    return many(rng, count, [], make)


@generator("media.annotate")
def gen_annotate(rng, count, corpus):
    def make():
        width, height = rng.randint(20, 120), rng.randint(20, 90)
        rows = [{"number": rng.randint(1, 120), "box": {"x": rng.randint(-20, width), "y": rng.randint(-20, height), "width": rng.randint(0, 60),
                                                         "height": rng.randint(0, 40)}} for _ in range(rng.randint(0, 6))]
        viewport = rng.choice([{}, {"clientWidth": width}, {"clientWidth": width / 2}, {"clientWidth": width * 2}, {"clientWidth": 0}])
        offset = rng.choice([None, [0, 0], [5, -10], [-3.5, 2.25]])
        return [b64(random_png(rng, (width, height))), rows, viewport, offset]
    return many(rng, min(count, 300), [], make)


@generator("media.threshold")
def gen_threshold(rng, count, corpus):
    values = [None, "0.5", "5%", "5%%", "100", "100.5", "-1", "x", "nan", "inf", " 3 ", "1_0", "٣", 7, 0.25, "", "%"]
    return many(rng, count, [], lambda: [rng.choice(values) if rng.random() < 0.7 else noise(rng, ["1", ".", "%", "e", "-", " "], 5)])


@generator("random.ops")
def gen_random(rng, count, corpus):
    def op():
        kind = rng.choice(["random", "uniform", "randint", "choice", "gauss", "getrandbits", "randbelow"])
        if kind == "uniform":
            return [kind, rng.uniform(-100, 100), rng.uniform(-100, 100)]
        if kind == "randint":
            low = rng.randint(-50, 50)
            return [kind, low, low + rng.choice([0, 1, 2, 7, 1000, 2**31, 2**40])]
        if kind == "choice":
            return [kind, [rng.randint(0, 9) for _ in range(rng.randint(1, 7))]]
        if kind == "gauss":
            return [kind, rng.uniform(-5, 5), rng.uniform(0, 3)]
        if kind == "getrandbits":
            return [kind, rng.choice([0, 1, 5, 31, 32, 33, 64, 100])]
        if kind == "randbelow":
            return [kind, rng.choice([1, 2, 3, 10, 2**31 - 1, 2**32, 2**32 + 1, 2**52])]
        return [kind]
    return many(rng, count, [[0, [["random"]] * 5], [2**80, [["random"]] * 3]], lambda: [rng.choice([0, 1, 42, rng.getrandbits(32), rng.getrandbits(70)]),
                                                                                       [op() for _ in range(rng.randint(1, 30))]])


def coord(rng):
    return [rng.uniform(-50, 1500), rng.uniform(-50, 900)]


@generator("human.control_points")
def gen_points(rng, count, corpus):
    def make():
        start = coord(rng)
        end = [start[0] + rng.choice([0, 0.5, 3, 40, 300]) * rng.uniform(-1, 1), start[1] + rng.uniform(-200, 200)] if rng.random() < 0.5 else coord(rng)
        return [rng.getrandbits(32), start, end]
    return many(rng, count, [], make)


@generator("human.pause")
def gen_pause(rng, count, corpus):
    return many(rng, count, [], lambda: [rng.getrandbits(32), [rng.choice(list("ab .,!?;:\n\tx")) for _ in range(rng.randint(1, 30))]])


@generator("human.solve")
def gen_solve(rng, count, corpus):
    def make():
        points = [0.645, 0.045, 0.355, 1.0] if rng.random() < 0.5 else [rng.uniform(0, 1), rng.uniform(-1, 2), rng.uniform(0, 1), rng.uniform(-1, 2)]
        return [points, [rng.choice([0.0, 1.0, 0.5, rng.random(), -0.1, 1.2]) for _ in range(8)]]
    return many(rng, count, [], make)


@generator("human.bezier_point")
def gen_bezier(rng, count, corpus):
    return many(rng, count, [], lambda: [rng.random(), coord(rng), coord(rng), coord(rng), coord(rng)])


@generator("human.minimum_jerk")
def gen_jerk(rng, count, corpus):
    return many(rng, count, [[0.0], [1.0]], lambda: [rng.random()])


@generator("human.fitts")
def gen_fitts(rng, count, corpus):
    return many(rng, count, [], lambda: [rng.choice([0.0, -1.0, rng.uniform(0, 3000)]), rng.choice([20.0, 1.0, 7.5]), 0.07, 0.15])


@generator("human.duration")
def gen_duration(rng, count, corpus):
    return many(rng, count, [], lambda: [rng.choice([0.0, 0.5, rng.uniform(0, 5000), 1e9])])


@generator("human.tremor")
def gen_tremor(rng, count, corpus):
    return many(rng, count, [], lambda: [rng.uniform(0, 1000), rng.uniform(0, 1000), rng.uniform(0, 10),
                                         [rng.uniform(0, 1000), rng.uniform(0, 1000), rng.choice([rng.uniform(0, 10), 5.0])]])


@generator("human.key_events")
def gen_key_events(rng, count, corpus):
    return many(rng, count, [], lambda: [rng.choice(list("aZ09)!@ \n\t-_+=[]{}|;:'\",.<>/?`~é😀ß") + ["\ud800"])])


@generator("human.round")
def gen_round(rng, count, corpus):
    return many(rng, count, [[0.5], [1.5], [2.5], [-0.5], [-1.5]], lambda: [rng.choice([rng.uniform(-2000, 2000), round(rng.uniform(-100, 100)) + 0.5])])


KEYS = ["Enter", "enter", "RETURN", "esc", "Tab", "space", " ", "Spacebar", "a", "A", "1", "!", "ArrowUp", "up", "pgdn", "F1", "f12", "F13", "Control",
        "ctrl", "cmd", "Option", "ControlOrMeta", "é", "😀", "ab", "", "+", "Delete", "del", "İ", "ß", "Ω"]


@generator("keys.parse_key")
def gen_parse_key(rng, count, corpus):
    return many(rng, count, [], lambda: [rng.choice(KEYS)])


@generator("keys.parse_combo")
def gen_parse_combo(rng, count, corpus):
    pieces = KEYS + ["Shift", "shift", "Meta", "Alt", "x", "z", "Z"]
    return many(rng, count, [["+"], ["++"], ["Control++"], ["a++"], ["Control+"], ["+a"], ["Shift"], [""], ["Control+Shift+z"], ["Meta+a"]],
                lambda: ["+".join(rng.choice(pieces) for _ in range(rng.randint(1, 4))) + rng.choice(["", "", "+", "++"])])


@generator("keys.humanize_default")
def gen_humanize(rng, count, corpus):
    values = [None, "", "1", "0", "true", "FALSE", " off ", "no", "yes", "　", "\x1c0"]
    return many(rng, count, [], lambda: [{name: rng.choice(values) for name in ("AGENT_BROWSER_HUMANIZE", "AGENT_BROWSER_NO_HUMANIZE") if rng.random() < 0.8}])
