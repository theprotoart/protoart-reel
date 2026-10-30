#!/usr/bin/env python3
# Repairs a Reel project imported from ScreenFlow before the sped-up-clip fix: those clips were made
# speed× too long and pushed onto extra "(overlap)" tracks. Keeps a backup (project.json.before-repair).
import json, sys, os, shutil

def repair(path):
    pj = os.path.join(path, 'project.json')
    d = json.load(open(pj))
    if d.get('_sfSpeedRepaired'):
        print(f'{os.path.basename(path)}: already repaired'); return
    media = {m['id']: m for m in d['media']}
    fixed = 0
    for c in d['clips']:
        m = media.get(c.get('media'))
        sp = c.get('speed') or 1
        if m and m.get('convertedFrom') == 'screenflow' and abs(sp - 1) > 1e-6:
            c['duration'] = c['duration'] / sp
            fixed += 1
    # put clips from the "(overlap)" tracks back on the track below them when they now fit
    tracks = d['tracks']
    def free(tid, c):
        return all(not (o['track'] == tid and o is not c and o['start'] < c['start'] + c['duration'] - 0.03 and o['start'] + o['duration'] > c['start'] + 0.03) for o in d['clips'])
    moved = 0
    for i, t in enumerate(tracks):
        if '(overlap)' not in (t.get('name') or ''):
            continue
        base = next((b for b in tracks[i + 1:] if '(overlap)' not in (b.get('name') or '')), None)
        if not base: continue
        for c in sorted([c for c in d['clips'] if c['track'] == t['id']], key=lambda c: c['start']):
            if free(base['id'], c):
                c['track'] = base['id']; moved += 1
    used = {c['track'] for c in d['clips']}
    before = len(tracks)
    d['tracks'] = [t for t in tracks if '(overlap)' not in (t.get('name') or '') or t['id'] in used]
    d['_sfSpeedRepaired'] = True
    shutil.copy2(pj, pj + '.before-repair')
    tmp = pj + '.tmp'
    json.dump(d, open(tmp, 'w'))
    os.replace(tmp, pj)
    print(f'{os.path.basename(path)}: {fixed} sped-up clips shortened, {moved} clips moved back, {before - len(d["tracks"])} empty overlap tracks removed. Backup: project.json.before-repair')

for p in sys.argv[1:]:
    repair(p)
