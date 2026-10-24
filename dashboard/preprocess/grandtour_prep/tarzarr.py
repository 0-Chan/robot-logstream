"""Read Zarr v2 arrays stored inside an uncompressed tar, without extracting it.

Every GrandTour topic is `data/<topic>.tar` containing `<topic>/<field>/{.zarray, <chunk keys>}`.
All arrays in a sequence are chunked along axis 0 only, which this module relies on.
"""

from __future__ import annotations

import json
import tarfile
from dataclasses import dataclass
from pathlib import Path

import numcodecs
import numpy as np


@dataclass
class ArrayInfo:
    shape: tuple[int, ...]
    chunks: tuple[int, ...]
    dtype: np.dtype
    codec: object
    members: dict[int, tarfile.TarInfo]  # chunk index along axis 0 -> tar member


class TarZarrGroup:
    def __init__(self, tar_path: Path):
        self.path = Path(tar_path)
        self.tar = tarfile.open(self.path)
        self.topic = self.path.stem
        self.attrs: dict = {}
        self.arrays: dict[str, ArrayInfo] = {}
        chunk_members: dict[str, dict[int, tarfile.TarInfo]] = {}
        metas: dict[str, dict] = {}
        for m in self.tar.getmembers():
            parts = m.name.split("/")
            if len(parts) == 2 and parts[1] == ".zattrs":
                self.attrs = json.load(self.tar.extractfile(m))
            elif len(parts) == 3 and parts[2] == ".zarray":
                metas[parts[1]] = json.load(self.tar.extractfile(m))
            elif len(parts) == 3 and m.isfile() and not parts[2].startswith("."):
                key = [int(x) for x in parts[2].split(".")]
                if any(k != 0 for k in key[1:]):
                    raise ValueError(f"{m.name}: chunked along a non-first axis, unsupported")
                chunk_members.setdefault(parts[1], {})[key[0]] = m
        for name, meta in metas.items():
            if meta.get("filters") or meta.get("order", "C") != "C":
                raise ValueError(f"{self.topic}/{name}: filters/order {meta.get('order')} unsupported")
            self.arrays[name] = ArrayInfo(
                shape=tuple(meta["shape"]),
                chunks=tuple(meta["chunks"]),
                dtype=np.dtype(meta["dtype"]),
                codec=numcodecs.get_codec(meta["compressor"]) if meta["compressor"] else None,
                members=chunk_members.get(name, {}),
            )

    def close(self):
        self.tar.close()

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        self.close()

    def _decode_chunk(self, info: ArrayInfo, ci: int) -> np.ndarray:
        rows = info.chunks[0]
        chunk_shape = (rows, *info.shape[1:])
        m = info.members.get(ci)
        if m is None:  # missing chunk = fill value (0 for these datasets)
            return np.zeros(chunk_shape, dtype=info.dtype)
        raw = self.tar.extractfile(m).read()
        buf = info.codec.decode(raw) if info.codec else raw
        arr = np.frombuffer(buf, dtype=info.dtype)
        return arr[: int(np.prod(chunk_shape))].reshape(chunk_shape)

    def read(self, field: str) -> np.ndarray:
        """Whole array (use for small/series arrays)."""
        info = self.arrays[field]
        n = info.shape[0]
        if n == 0:
            return np.zeros(info.shape, dtype=info.dtype)
        nchunks = -(-n // info.chunks[0])
        out = np.concatenate([self._decode_chunk(info, ci) for ci in range(nchunks)])
        return out[:n]

    def row_reader(self, field: str) -> "RowReader":
        return RowReader(self, field)


class RowReader:
    """Random/sequential row access that keeps only the current chunk decoded."""

    def __init__(self, group: TarZarrGroup, field: str):
        self.group = group
        self.info = group.arrays[field]
        self._ci = -1
        self._block: np.ndarray | None = None

    def __len__(self):
        return self.info.shape[0]

    def __getitem__(self, i: int) -> np.ndarray:
        rows = self.info.chunks[0]
        ci = i // rows
        if ci != self._ci:
            self._block = self.group._decode_chunk(self.info, ci)
            self._ci = ci
        return self._block[i - ci * rows]
