import asyncio
import base64
import hashlib
import os
import random
import struct
import tempfile
import zlib

from ardia_cli.browse import human, inputs, media
from ardia_cli.browse.errors import BrowseError


def png_shape(data: bytes) -> dict:
    chunks, offset = [], 8
    idat = b""
    while offset < len(data):
        length, kind = struct.unpack(">I4s", data[offset:offset + 8])
        body = data[offset + 8:offset + 8 + length]
        crc = data[offset + 8 + length:offset + 12 + length]
        offset += 12 + length
        if kind == b"IDAT":
            idat += body
            chunks.append(["IDAT", (zlib.crc32(kind + body) & 0xFFFFFFFF) == int.from_bytes(crc, "big")])
        else:
            chunks.append([kind.decode("latin-1"), (data[offset - 12 - length:offset]).hex()])
    return {"signature": data[:8].hex(), "chunks": chunks, "raw": hashlib.sha256(zlib.decompress(idat)).hexdigest()}


def image_fields(image) -> dict:
    return {"width": image.width, "height": image.height, "pixels": hashlib.sha256(bytes(image.pixels)).hexdigest(), "size": len(image.pixels)}


def decoded(text: str):
    try:
        return image_fields(media.decode_png(base64.b64decode(text)))
    except BrowseError:
        raise
    except Exception:
        return {"corrupt": True}


def compare(a: str, b: str, threshold: float):
    folder = tempfile.mkdtemp()
    target = os.path.join(folder, "diff.png")
    try:
        result = media.compare_pngs(base64.b64decode(a), base64.b64decode(b), threshold, target)
    except BrowseError:
        raise
    except Exception:
        return {"corrupt": True}
    if result.pop("diffPath", None):
        result["diff"] = image_fields(media.decode_png(open(target, "rb").read()))
        os.unlink(target)
    os.rmdir(folder)
    return result


def encode(width: int, height: int, pixels: str):
    return png_shape(media.encode_png(media.Image(width, height, bytearray(base64.b64decode(pixels)))))


def annotate(png: str, rows: list, viewport: dict, offset):
    out = media.draw_annotations(base64.b64decode(png), rows, viewport, tuple(offset) if offset else None)
    return {"shape": png_shape(out), "image": image_fields(media.decode_png(out))}


def random_ops(seed: int, ops: list):
    source = random.Random(seed)
    out = []
    for op in ops:
        name, args = op[0], op[1:]
        out.append({"random": source.random, "uniform": source.uniform, "randint": source.randint, "choice": source.choice, "gauss": source.gauss,
                    "getrandbits": source.getrandbits, "randbelow": source._randbelow}[name](*args))
    return out


def seeded(seed: int, run):
    random.seed(seed)
    return run()


def register(oracle):
    oracle("media.decode")(decoded)
    oracle("media.compare")(compare)
    oracle("media.encode")(encode)
    oracle("media.annotate")(annotate)
    oracle("media.threshold")(media.threshold_of)
    oracle("random.ops")(random_ops)
    oracle("human.control_points")(lambda seed, start, end: seeded(seed, lambda: human.control_points(tuple(start), tuple(end), human.MouseTiming())))
    oracle("human.pause")(lambda seed, chars: seeded(seed, lambda: [pause_delay(char) for char in chars]))
    oracle("human.solve")(lambda points, xs: [human.CubicBezier(*points).solve(x) for x in xs])
    oracle("human.bezier_point")(lambda t, p0, p1, p2, p3: human.bezier_point(t, p0, p1, p2, p3))
    oracle("human.minimum_jerk")(human.minimum_jerk)
    oracle("human.fitts")(human.fitts_duration)
    oracle("human.duration")(lambda distance: human.Mouse(None)._duration(distance))
    oracle("human.tremor")(lambda x, y, now, previous: human.Mouse(None)._tremor(x, y, now, previous))
    oracle("human.key_events")(human.Keyboard.key_events)
    oracle("human.round")(lambda value: int(round(value)))
    oracle("keys.parse_key")(inputs.parse_key)
    oracle("keys.parse_combo")(inputs.parse_combo)
    oracle("keys.humanize_default")(inputs.humanize_default)


def pause_delay(char: str) -> float:
    captured: list[float] = []

    async def record(delay):
        captured.append(delay)

    original = asyncio.sleep
    asyncio.sleep = record
    try:
        asyncio.run(human.Keyboard(None).pause_after(char))
    finally:
        asyncio.sleep = original
    return captured[0]
