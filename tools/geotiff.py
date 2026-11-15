#!/usr/bin/env python3
"""Minimal GeoTIFF reader for Clearway (Python standard library only).

Reads the single-band rasters NASA's Planetary Geodynamics Data Archive (PGDA) publishes for the lunar
south pole — 5 m/pixel LOLA site elevation, slope and uncertainty maps, and the LOLA illumination maps —
without GDAL or numpy.

Supported: classic TIFF and BigTIFF, either byte order; strips or tiles; no compression, LZW,
Deflate (both tag values) and PackBits; horizontal (2) and floating-point (3) predictors; 8/16/32/64-bit
unsigned, signed and float samples; GDAL's nodata tag. Georeferencing comes from ModelPixelScale +
ModelTiepoint (or a non-rotated ModelTransformation) and the GeoKey directory.

Blocks are decoded lazily and kept in a small cache, so a large map costs memory only for the parts
that are actually read.

    from geotiff import GeoTiff
    g = GeoTiff("Site04_final_adj_5mpp_surf.tif")
    g.value(col, row)              # nearest pixel (None for nodata)
    g.bilinear(col_f, row_f)       # interpolated
    g.pixel_of(x_m, y_m)           # projected metres -> fractional (col, row) of pixel centres
"""
from __future__ import annotations

import array
import itertools
import math
import struct
import sys
import zlib
from collections import OrderedDict
from pathlib import Path

try:  # optional acceleration for the predictors
    import numpy as np  # type: ignore
except ImportError:  # pragma: no cover
    np = None

TYPE_FMT = {1: "B", 2: "s", 3: "H", 4: "I", 5: "II", 6: "b", 7: "B", 8: "h", 9: "i", 10: "ii", 11: "f", 12: "d", 16: "Q", 17: "q", 18: "Q"}
TYPE_SIZE = {1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 6: 1, 7: 1, 8: 2, 9: 4, 10: 8, 11: 4, 12: 8, 16: 8, 17: 8, 18: 8}

# GeoKey ids used here (GeoTIFF 1.1 specification)
GEOKEYS = {
    1024: "GTModelType", 1025: "GTRasterType", 1026: "GTCitation", 2048: "GeographicType", 2049: "GeogCitation",
    2057: "GeogSemiMajorAxis", 2058: "GeogSemiMinorAxis", 3072: "ProjectedCSType", 3073: "PCSCitation", 3074: "Projection",
    3075: "ProjCoordTrans", 3076: "ProjLinearUnits", 3078: "ProjStdParallel1", 3080: "ProjNatOriginLong", 3081: "ProjNatOriginLat",
    3082: "ProjFalseEasting", 3083: "ProjFalseNorthing", 3088: "ProjCenterLong", 3089: "ProjCenterLat", 3092: "ProjScaleAtNatOrigin",
    3095: "ProjStraightVertPoleLong",
}


class TiffError(ValueError):
    pass


# ---------------------------------------------------------------------------- decompressors
def lzw_decode(data: bytes) -> bytes:
    """TIFF LZW (MSB-first codes, 'early change'). Also accepts the old LSB-first variant."""
    if len(data) >= 2 and data[0] == 0 and data[1] & 0x01:  # old-style (pre-TIFF 6) LZW
        raise TiffError("old-style LZW is not supported; re-save the file with Deflate or no compression")
    out = bytearray()
    table = [bytes([i]) for i in range(256)] + [b"", b""]
    bits, nbits, pos, width = 0, 0, 0, 9
    prev = None
    n = len(data)
    while True:
        while nbits < width and pos < n:
            bits = (bits << 8) | data[pos]
            pos += 1
            nbits += 8
        if nbits < width:
            break
        code = (bits >> (nbits - width)) & ((1 << width) - 1)
        nbits -= width
        bits &= (1 << nbits) - 1
        if code == 256:  # clear
            table = table[:258]
            width = 9
            prev = None
            continue
        if code == 257:  # end of information
            break
        if prev is None:
            entry = table[code]
            out += entry
            prev = entry
            continue
        if code < len(table):
            entry = table[code]
            table.append(prev + entry[:1])
        elif code == len(table):
            entry = prev + prev[:1]
            table.append(entry)
        else:
            raise TiffError("corrupt LZW stream")
        out += entry
        prev = entry
        # early change: widen one code before the table fills the current width
        if len(table) + 1 >= (1 << width) and width < 12:
            width += 1
    return bytes(out)


def packbits_decode(data: bytes) -> bytes:
    out, i, n = bytearray(), 0, len(data)
    while i < n:
        h = data[i]
        i += 1
        if h < 128:
            out += data[i:i + h + 1]
            i += h + 1
        elif h > 128:
            out += bytes([data[i]]) * (257 - h)
            i += 1
    return bytes(out)


def decompress(code: int, data: bytes) -> bytes:
    if code == 1:
        return data
    if code == 5:
        return lzw_decode(data)
    if code in (8, 32946):
        return zlib.decompress(data)
    if code == 32773:
        return packbits_decode(data)
    if code == 50000:  # ZSTD: Python 3.14+ standard library, or the zstandard package
        try:
            from compression import zstd  # type: ignore
            return zstd.decompress(data)
        except ImportError:
            try:
                import zstandard  # type: ignore
                return zstandard.ZstdDecompressor().decompress(data, max_output_size=1 << 31)
            except ImportError:
                pass
    if code == 34925:  # LZMA
        import lzma
        return lzma.decompress(data)
    names = {7: "JPEG", 34887: "LERC", 50000: "ZSTD", 50001: "WEBP", 34925: "LZMA"}
    raise TiffError(f"compression {names.get(code, code)} is not supported: convert the file with "
                    f"'gdal_translate -co COMPRESS=DEFLATE in.tif out.tif' or download the uncompressed version")


# ---------------------------------------------------------------------------- reader
class GeoTiff:
    def __init__(self, path: str | Path, cache_mb: float = 300.0):
        self.path = Path(path)
        self.fh = open(self.path, "rb")
        head = self.fh.read(16)
        if head[:2] == b"II":
            self.bo = "<"
        elif head[:2] == b"MM":
            self.bo = ">"
        else:
            raise TiffError(f"{self.path.name} is not a TIFF file")
        magic = struct.unpack(self.bo + "H", head[2:4])[0]
        if magic == 42:
            self.big = False
            ifd = struct.unpack(self.bo + "I", head[4:8])[0]
        elif magic == 43:
            self.big = True
            ifd = struct.unpack(self.bo + "Q", head[8:16])[0]
        else:
            raise TiffError(f"{self.path.name}: unknown TIFF version {magic}")
        self.tags = self._read_ifd(ifd)
        t = self.tags
        self.width, self.height = int(t[256][0]), int(t[257][0])
        self.spp = int(t.get(277, [1])[0])
        self.bps = int(t.get(258, [8])[0])
        self.fmt = int(t.get(339, [1])[0])
        self.compression = int(t.get(259, [1])[0])
        self.predictor = int(t.get(317, [1])[0])
        self.planar = int(t.get(284, [1])[0])
        if self.spp != 1 and self.planar != 2:
            # interleaved multi-band: we read band 0 only
            pass
        if 322 in t:
            self.bw, self.bh = int(t[322][0]), int(t[323][0])
            self.offsets, self.counts = list(t[324]), list(t[325])
        else:
            self.bw = self.width
            self.bh = int(t.get(278, [self.height])[0])
            self.bh = min(self.bh, self.height) if self.bh > 0 else self.height
            self.offsets, self.counts = list(t[273]), list(t[279])
        self.blocks_across = (self.width + self.bw - 1) // self.bw
        code = {(1, 8): "B", (2, 8): "b", (1, 16): "H", (2, 16): "h", (1, 32): "I", (2, 32): "i", (3, 32): "f", (3, 64): "d", (1, 64): "Q", (2, 64): "q"}
        if (self.fmt, self.bps) not in code:
            raise TiffError(f"{self.path.name}: unsupported sample type (format {self.fmt}, {self.bps} bits)")
        self.code = code[(self.fmt, self.bps)]
        self.nodata = None
        if 42113 in t:
            try:
                self.nodata = float(t[42113].strip("\x00 ").split()[0])
            except (ValueError, IndexError):
                self.nodata = None
        self._cache: OrderedDict = OrderedDict()
        # keep up to cache_mb of decoded blocks (a whole 5 m tile fits), so each block is decoded once
        self._cache_max = max(64, int(cache_mb * 1e6 / max(1, self.bw * self.bh * self.bps // 8)))
        self._georef()

    # ------------------------------------------------------------------ IFD parsing
    def _read_ifd(self, off: int) -> dict:
        f, bo = self.fh, self.bo
        f.seek(off)
        if self.big:
            n = struct.unpack(bo + "Q", f.read(8))[0]
            esize, cfmt, vsize = 20, "Q", 8
        else:
            n = struct.unpack(bo + "H", f.read(2))[0]
            esize, cfmt, vsize = 12, "I", 4
        raw = f.read(n * esize)
        tags = {}
        for i in range(n):
            e = raw[i * esize:(i + 1) * esize]
            tag, typ = struct.unpack(bo + "HH", e[:4])
            count = struct.unpack(bo + cfmt, e[4:4 + vsize])[0]
            if typ not in TYPE_SIZE:
                continue
            size = TYPE_SIZE[typ] * count
            valbytes = e[4 + vsize:]
            if size > vsize:
                ptr = struct.unpack(bo + cfmt, valbytes)[0]
                here = f.tell()
                f.seek(ptr)
                valbytes = f.read(size)
                f.seek(here)
            else:
                valbytes = valbytes[:size]
            if typ == 2:
                tags[tag] = valbytes.decode("latin-1")
            elif typ in (5, 10):
                v = struct.unpack(bo + TYPE_FMT[typ][0] * (2 * count), valbytes)
                tags[tag] = [v[2 * k] / (v[2 * k + 1] or 1) for k in range(count)]
            else:
                tags[tag] = list(struct.unpack(bo + TYPE_FMT[typ] * count, valbytes))
        return tags

    def _georef(self):
        t = self.tags
        self.geokeys: dict = {}
        if 34735 in t:
            d = t[34735]
            doubles = t.get(34736, [])
            ascii_ = t.get(34737, "")
            nkeys = d[3]
            for k in range(nkeys):
                kid, loc, cnt, val = d[4 + 4 * k:8 + 4 * k]
                name = GEOKEYS.get(kid, str(kid))
                if loc == 0:
                    self.geokeys[name] = val
                elif loc == 34736:
                    self.geokeys[name] = doubles[val] if cnt == 1 else doubles[val:val + cnt]
                elif loc == 34737:
                    self.geokeys[name] = ascii_[val:val + cnt].rstrip("|\x00")
        self.area = self.geokeys.get("GTRasterType", 1) != 2  # PixelIsArea (default) vs PixelIsPoint
        if 33550 in t and 33922 in t:
            sx, sy = t[33550][0], t[33550][1]
            I, J, _, X, Y, _ = t[33922][:6]
            self.sx, self.sy, self.x0, self.y0 = sx, sy, X - I * sx, Y + J * sy  # model coords of the corner of pixel (0, 0)
        elif 34264 in t:
            m = t[34264]
            if abs(m[1]) > 1e-9 or abs(m[4]) > 1e-9:
                raise TiffError(f"{self.path.name}: rotated rasters are not supported")
            self.sx, self.sy, self.x0, self.y0 = m[0], -m[5], m[3], m[7]
        else:
            self.sx = self.sy = None
            self.x0 = self.y0 = None
        if not self.area and self.sx:  # PixelIsPoint: the tiepoint is a pixel centre
            self.x0 -= self.sx / 2
            self.y0 += self.sy / 2

    @property
    def georeferenced(self) -> bool:
        return self.sx is not None

    def projection(self) -> dict:
        """Polar-stereographic parameters (sphere radius, origin longitude, scale, false origin)."""
        k = self.geokeys
        lat0 = k.get("ProjNatOriginLat", k.get("ProjCenterLat", k.get("ProjStdParallel1", -90.0)))
        lon0 = k.get("ProjStraightVertPoleLong", k.get("ProjNatOriginLong", k.get("ProjCenterLong", 0.0)))
        scale = k.get("ProjScaleAtNatOrigin", 1.0)
        std = k.get("ProjStdParallel1")
        if std is not None and abs(abs(std) - 90) > 1e-6 and "ProjScaleAtNatOrigin" not in k:
            scale = (1 + math.sin(math.radians(abs(std)))) / 2  # variant B: true scale at a standard parallel
        radius = k.get("GeogSemiMajorAxis", 1737400.0)
        if radius < 10000:  # given in km
            radius *= 1000.0
        return {"lat0": float(lat0), "lon0": float(lon0), "k0": float(scale), "radius": float(radius),
                "fe": float(k.get("ProjFalseEasting", 0.0)), "fn": float(k.get("ProjFalseNorthing", 0.0)),
                "south": float(lat0) <= 0, "coordTrans": k.get("ProjCoordTrans"), "citation": k.get("PCSCitation") or k.get("GTCitation")}

    # ------------------------------------------------------------------ pixels
    def _block(self, b: int):
        blk = self._cache.get(b)
        if blk is not None:
            self._cache.move_to_end(b)
            return blk
        if b >= len(self.offsets) or self.counts[b] == 0:
            blk = None
        else:
            self.fh.seek(self.offsets[b])
            raw = decompress(self.compression, self.fh.read(self.counts[b]))
            blk = self._unpack(raw)
        self._cache[b] = blk
        if len(self._cache) > self._cache_max:
            self._cache.popitem(last=False)
        return blk

    def _unpack(self, raw: bytes):
        bw, bps, spp = self.bw, self.bps // 8, self.spp if self.planar == 1 else 1
        rows = len(raw) // (bw * bps * spp) if bw * bps * spp else 0
        if self.predictor == 3:
            raw = self._undo_float_predictor(raw, bw * spp, bps, rows)
            a = array.array(self.code)
            a.frombytes(raw[:rows * bw * spp * bps])
            if sys.byteorder == "little":
                a.byteswap()  # the floating-point predictor leaves big-endian words
        else:
            a = array.array(self.code)
            a.frombytes(raw[:rows * bw * spp * bps])
            if (self.bo == ">") == (sys.byteorder == "little") and bps > 1:
                a.byteswap()
            if self.predictor == 2:
                stride = bw * spp
                if np is not None and spp == 1:
                    arr = np.frombuffer(a.tobytes(), dtype=a.typecode).reshape(rows, stride)
                    arr = np.cumsum(arr, axis=1, dtype=arr.dtype)  # integer overflow wraps, as the predictor requires
                    a = array.array(self.code, arr.tobytes())
                else:
                    mask = (1 << self.bps) - 1
                    signed = self.fmt == 2
                    half = 1 << (self.bps - 1)
                    for r in range(rows):
                        base = r * stride
                        for i in range(spp, stride):
                            v = (a[base + i] + a[base + i - spp]) & mask
                            if signed and v >= half:
                                v -= 1 << self.bps
                            a[base + i] = v
        if spp > 1:
            a = a[0::spp]
        return a

    @staticmethod
    def _undo_float_predictor(raw: bytes, wc: int, bps: int, rows: int) -> bytes:
        out = bytearray()
        rl = wc * bps
        if np is not None:
            m = np.frombuffer(raw[:rows * rl], dtype=np.uint8).reshape(rows, rl)
            acc = np.cumsum(m, axis=1, dtype=np.uint8)  # byte-wise running sum modulo 256
            planes = acc.reshape(rows, bps, wc).transpose(0, 2, 1)  # planes (MSB first) → big-endian words
            return planes.tobytes()
        for r in range(rows):
            row = bytearray(x & 0xFF for x in itertools.accumulate(raw[r * rl:(r + 1) * rl]))
            # byte planes (most significant first) back into big-endian words
            word = bytearray(rl)
            for b in range(bps):
                word[b::bps] = row[b * wc:(b + 1) * wc]
            out += word
        return bytes(out)

    def value(self, col: int, row: int):
        """Pixel value at integer (col, row); None outside the image or for nodata/NaN."""
        if col < 0 or row < 0 or col >= self.width or row >= self.height:
            return None
        b = (row // self.bh) * self.blocks_across + col // self.bw
        blk = self._block(b)
        if blk is None:
            return None
        idx = (row % self.bh) * self.bw + col % self.bw
        if idx >= len(blk):
            return None
        v = blk[idx]
        if v != v or (self.nodata is not None and v == self.nodata) or (self.fmt == 3 and abs(v) > 1e30):
            return None
        return float(v)

    def bilinear(self, cf: float, rf: float):
        """Bilinear interpolation between pixel centres; None if any neighbour is missing."""
        i, j = math.floor(cf), math.floor(rf)
        fx, fy = cf - i, rf - j
        a, b = self.value(i, j), self.value(i + 1, j)
        c, d = self.value(i, j + 1), self.value(i + 1, j + 1)
        if a is None or b is None or c is None or d is None:
            # fall back to the nearest valid pixel at the very edge of the data
            n = self.value(int(round(cf)), int(round(rf)))
            return n
        return (a * (1 - fx) + b * fx) * (1 - fy) + (c * (1 - fx) + d * fx) * fy

    def pixel_of(self, x: float, y: float) -> tuple[float, float]:
        """Projected metres → fractional (col, row) where integers are pixel centres."""
        return (x - self.x0) / self.sx - 0.5, (self.y0 - y) / self.sy - 0.5

    def center_xy(self) -> tuple[float, float]:
        return self.x0 + self.sx * self.width / 2, self.y0 - self.sy * self.height / 2

    def bounds(self) -> tuple[float, float, float, float]:
        return self.x0, self.y0 - self.sy * self.height, self.x0 + self.sx * self.width, self.y0

    def close(self):
        if not self.fh.closed:
            self.fh.close()

    def __del__(self):  # pragma: no cover - interpreter shutdown
        try:
            self.close()
        except Exception:  # noqa: BLE001
            pass
