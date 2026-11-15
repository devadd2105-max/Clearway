"""Small GeoTIFF writer used only by the tests: it produces files in every layout tools/geotiff.py
claims to read (strips/tiles, classic/BigTIFF, both byte orders, none/LZW/Deflate/PackBits,
predictors 2 and 3), so the reader is exercised without GDAL."""
from __future__ import annotations

import array
import struct
import sys
import zlib


def lzw_encode(data: bytes) -> bytes:
    out = bytearray()
    acc, nacc = 0, 0

    def emit(code, width):
        nonlocal acc, nacc
        acc = (acc << width) | code
        nacc += width
        while nacc >= 8:
            nacc -= 8
            out.append((acc >> nacc) & 0xFF)
        acc &= (1 << nacc) - 1

    # mirrors libtiff's LZWEncode / LZWPostEncode
    table = {bytes([i]): i for i in range(256)}
    nxt, width = 258, 9
    emit(256, width)
    w = b""
    for byte in data:
        wc = w + bytes([byte])
        if not w or wc in table:
            w = wc
            continue
        emit(table[w], width)
        table[wc] = nxt
        nxt += 1
        if nxt == 4094:
            emit(256, width)
            table = {bytes([i]): i for i in range(256)}
            nxt, width = 258, 9
        elif nxt > (1 << width) - 1:
            width += 1
        w = bytes([byte])
    if w:
        emit(table[w], width)
        nxt += 1
        if nxt == 4094:
            emit(256, width)
            width = 9
        elif nxt > (1 << width) - 1:
            width += 1
    emit(257, width)
    if nacc:
        out.append((acc << (8 - nacc)) & 0xFF)
    return bytes(out)


def packbits_encode(data: bytes) -> bytes:
    out, i = bytearray(), 0
    while i < len(data):
        j = i
        while j + 1 < len(data) and data[j + 1] == data[i] and j - i < 126:
            j += 1
        if j > i:
            out += bytes([257 - (j - i + 1)]) + data[i:i + 1]
            i = j + 1
        else:
            k = i
            while k + 1 < len(data) and data[k + 1] != data[k] and k - i < 127:
                k += 1
            out += bytes([k - i]) + data[i:k + 1]
            i = k + 1
    return bytes(out)


CODES = {"f4": ("f", 3, 32), "f8": ("d", 3, 64), "i2": ("h", 2, 16), "u2": ("H", 1, 16), "i4": ("i", 2, 32), "u1": ("B", 1, 8)}


def write_tiff(path, width, height, values, dtype="f4", compression=1, predictor=1, tile=None, rows_per_strip=None,
               byteorder="<", big=False, pixel_scale=None, tiepoint=None, geokeys=None, nodata=None, point=False):
    code, fmt, bits = CODES[dtype]
    bps = bits // 8
    bw, bh = (tile if tile else (width, rows_per_strip or height))
    across = (width + bw - 1) // bw
    down = (height + bh - 1) // bh
    blocks = []
    for by in range(down):
        for bx in range(across if tile else 1):
            rows = []
            for r in range(bh):
                y = by * bh + r
                if not tile and y >= height:
                    break
                row = []
                for c in range(bw):
                    x = bx * bw + c
                    row.append(values[y * width + x] if (x < width and y < height) else 0)
                rows.append(row)
            raw = bytearray()
            for row in rows:
                a = array.array(code, row)
                if predictor == 2:
                    mask = (1 << bits) - 1
                    d = [row[0]] + [((row[i] - row[i - 1]) & mask) for i in range(1, len(row))]
                    if fmt == 2:
                        d = [v - (1 << bits) if v >= (1 << (bits - 1)) else v for v in d]
                    a = array.array(code, d)
                if predictor == 3:
                    be = array.array(code, row)
                    if sys.byteorder == "little":
                        be.byteswap()
                    b = be.tobytes()
                    planes = bytearray()
                    for k in range(bps):
                        planes += b[k::bps]
                    diff = bytearray(len(planes))
                    prev = 0
                    for i, v in enumerate(planes):
                        diff[i] = (v - prev) & 0xFF
                        prev = v
                    raw += diff
                    continue
                if (byteorder == ">") == (sys.byteorder == "little") and bps > 1:
                    a.byteswap()
                raw += a.tobytes()
            data = bytes(raw)
            if compression == 5:
                data = lzw_encode(data)
            elif compression in (8, 32946):
                data = zlib.compress(data)
            elif compression == 32773:
                data = packbits_encode(data)
            blocks.append(data)
    tags = {256: (4, [width]), 257: (4, [height]), 258: (3, [bits]), 259: (3, [compression]), 262: (3, [1]), 277: (3, [1]), 339: (3, [fmt]), 284: (3, [1])}
    if predictor != 1:
        tags[317] = (3, [predictor])
    if pixel_scale:
        tags[33550] = (12, list(pixel_scale) + [0.0])
        tags[33922] = (12, list(tiepoint))
    if geokeys:
        shorts, doubles = [1, 1, 0, 0], []
        entries = []
        for kid, val in sorted(geokeys.items()):
            if isinstance(val, float):
                entries.append([kid, 34736, 1, len(doubles)])
                doubles.append(val)
            else:
                entries.append([kid, 0, 1, val])
        if point:
            entries.append([1025, 0, 1, 2])
            entries.sort()
        shorts[3] = len(entries)
        for e in entries:
            shorts += e
        tags[34735] = (3, shorts)
        if doubles:
            tags[34736] = (12, doubles)
    if nodata is not None:
        tags[42113] = (2, (str(nodata) + "\x00").encode())
    off_type = 16 if big else 4
    if tile:
        tags[322] = (3, [bw]); tags[323] = (3, [bh])
        tags[324] = (off_type, [0] * len(blocks)); tags[325] = (off_type, [len(b) for b in blocks])
    else:
        tags[278] = (4, [bh])
        tags[273] = (off_type, [0] * len(blocks)); tags[279] = (off_type, [len(b) for b in blocks])
    bo = byteorder
    tsz = {2: 1, 3: 2, 4: 4, 12: 8, 16: 8}
    tfmt = {3: "H", 4: "I", 12: "d", 16: "Q"}
    head_len = 16 if big else 8
    esize = 20 if big else 12
    ifd_len = (8 if big else 2) + esize * len(tags) + (8 if big else 4)
    data_start = head_len + ifd_len
    # lay out external tag values, then image blocks
    ext = bytearray()
    def val_bytes(typ, v):
        if typ == 2:
            return bytes(v)
        return struct.pack(bo + tfmt[typ] * len(v), *v)
    inline = 8 if big else 4
    # first pass to size external area (block offsets depend on it)
    sizes = {t: len(val_bytes(typ, v)) for t, (typ, v) in tags.items()}
    ext_len = sum(s for s in sizes.values() if s > inline)
    blk_start = data_start + ext_len
    offs, p = [], blk_start
    for b in blocks:
        offs.append(p)
        p += len(b)
    key = 324 if tile else 273
    tags[key] = (tags[key][0], offs)
    out = bytearray(b"II" if bo == "<" else b"MM")
    out += struct.pack(bo + "H", 43 if big else 42)
    if big:
        out += struct.pack(bo + "HHQ", 8, 0, 16)
        out += struct.pack(bo + "Q", len(tags))
    else:
        out += struct.pack(bo + "I", 8)
        out += struct.pack(bo + "H", len(tags))
    ext_ptr = data_start
    for t in sorted(tags):
        typ, v = tags[t]
        vb = val_bytes(typ, v)
        cnt = len(v)
        out += struct.pack(bo + "HH", t, typ) + struct.pack(bo + ("Q" if big else "I"), cnt)
        if len(vb) <= inline:
            out += vb + b"\x00" * (inline - len(vb))
        else:
            out += struct.pack(bo + ("Q" if big else "I"), ext_ptr)
            ext += vb
            ext_ptr += len(vb)
    out += struct.pack(bo + ("Q" if big else "I"), 0)
    out += ext
    for b in blocks:
        out += b
    with open(path, "wb") as fh:
        fh.write(out)
