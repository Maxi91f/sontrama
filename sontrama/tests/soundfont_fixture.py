"""Create an original tiny looping sine SoundFont for cross-target audio tests."""

import struct

import numpy as np


def sine_soundfont(path):
    def chunk(name, data):
        data += b"\0" if len(data) % 2 else b""
        return name + struct.pack("<I", len(data)) + data

    def listing(kind, data):
        return chunk(b"LIST", kind + data)

    def generator(kind, value):
        return struct.pack("<HH", kind, value & 0xFFFF)

    count = 4000
    samples = (
        np.r_[np.sin(np.arange(count) * 2 * np.pi / 100) * 12000, np.zeros(46)]
        .astype("<i2")
        .tobytes()
    )
    info = listing(
        b"INFO",
        chunk(b"ifil", struct.pack("<HH", 2, 1))
        + chunk(b"isng", b"EMU8000\0")
        + chunk(b"INAM", b"Sontrama test sine\0"),
    )
    sdta = listing(b"sdta", chunk(b"smpl", samples))
    phdr = struct.pack("<20sHHHIII", b"Sine", 0, 0, 0, 0, 0, 0) + struct.pack(
        "<20sHHHIII", b"EOP", 0, 0, 1, 0, 0, 0
    )
    pbag = struct.pack("<HHHH", 0, 0, 1, 0)
    pgen = generator(41, 0) + generator(0, 0)
    inst = struct.pack("<20sH20sH", b"Sine", 0, b"EOI", 1)
    ibag = struct.pack("<HHHH", 0, 0, 4, 0)
    igen = (
        generator(34, -6000)
        + generator(38, -3600)
        + generator(54, 1)
        + generator(53, 0)
        + generator(0, 0)
    )
    shdr = struct.pack(
        "<20sIIIIIBbHH", b"Sine", 0, count, 0, count, 44000, 69, 0, 0, 1
    ) + struct.pack(
        "<20sIIIIIBbHH", b"EOS", count + 46, count + 46, count + 46, count + 46, 44000, 0, 0, 0, 1
    )
    pdta = listing(
        b"pdta",
        b"".join(
            chunk(name, data)
            for name, data in [
                (b"phdr", phdr),
                (b"pbag", pbag),
                (b"pmod", bytes(10)),
                (b"pgen", pgen),
                (b"inst", inst),
                (b"ibag", ibag),
                (b"imod", bytes(10)),
                (b"igen", igen),
                (b"shdr", shdr),
            ]
        ),
    )
    path.write_bytes(chunk(b"RIFF", b"sfbk" + info + sdta + pdta))
    return path
