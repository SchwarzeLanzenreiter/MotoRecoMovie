"""Inspect a MotoReco .dat (raw CAN log data).

Records are fixed at 16 bytes: [0:6] value that looks like a timestamp / [6:8] CAN ID (LE) / [8:16] 8 data bytes.
"""
import sys
import numpy as np

REC = np.dtype([('t', '<u4'), ('t2', '<u2'), ('id', '<u2'), ('d', 'u1', (8,))])


def read_dat(path):
    return np.fromfile(path, dtype=REC)


if __name__ == '__main__':
    r = read_dat(sys.argv[1])
    print('Record count', len(r))
    ids, cnt = np.unique(r['id'], return_counts=True)
    for i, c in zip(ids, cnt):
        print(f'  ID {i:03X}: {c} records')
    print('First t, t2:', [(int(a), int(b)) for a, b in zip(r['t'][:12], r['t2'][:12])])
    # Relation of t and t2: a 48-bit timestamp, or t2 in ms with t as the upper part
    for k in [100000, 500000, 1000000, len(r) - 1]:
        print(f'  #{k}: t={int(r["t"][k])} t2={int(r["t2"][k])}')
    # Example of the contents of GPS (7FE, 7FF)
    for gid in (0x7FE, 0x7FF):
        sel = r[r['id'] == gid][:3]
        for x in sel:
            print(f'  {gid:03X} t={int(x["t"])} t2={int(x["t2"])} d=' + ' '.join(f'{b:02X}' for b in x['d']))
