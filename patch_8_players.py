#!/usr/bin/env python3
"""Usage: python3 patch_8_players.py index.html
Edits the file in place (writes index.html.bak first)."""
import sys, shutil

path = sys.argv[1] if len(sys.argv) > 1 else 'index.html'
src = open(path, encoding='utf-8').read()

edits = [
 ("const PLAYER_COLORS = ['#d62839', '#1f6fd1', '#16803a', '#8e4bd0']; // one per player",
  "const MAX_ONLINE_PLAYERS = 8;\n"
  "const PLAYER_COLORS = ['#d62839', '#1f6fd1', '#16803a', '#8e4bd0',\n"
  "                       '#f28c1b', '#0fa3a3', '#d6479b', '#6b4f2a']; // one per player"),
 ("for (let pid = 1; pid < 4; pid++) if (!h.roster[pid]) return pid;",
  "for (let pid = 1; pid < MAX_ONLINE_PLAYERS; pid++) if (!h.roster[pid]) return pid;"),
 ("message: 'This lobby already has 4 players.'",
  "message: 'This lobby already has ' + MAX_ONLINE_PLAYERS + ' players.'"),
 ("if (n > 1) { const ang = (k / n) * Math.PI * 2 - Math.PI / 2; dx = Math.cos(ang) * 1.7; dy = Math.sin(ang) * 1.7; }",
  "if (n > 1) { const r = n > 4 ? 2.7 : 1.7; const ang = (k / n) * Math.PI * 2 - Math.PI / 2; dx = Math.cos(ang) * r; dy = Math.sin(ang) * r; }"),
 ("</style>",
  "@media (min-width: 1100px) {\n"
  "  .hud-pills { gap: var(--sp2); }\n"
  "  .pill .avatar { width: 34px; height: 34px; font-size: 1rem; }\n"
  "  .pill .pmoney { font-size: 1.15rem; }\n"
  "}\n</style>"),
]

for old, new in edits:
    n = src.count(old)
    if n != 1:
        sys.exit(f"Expected exactly 1 match, found {n} for:\n{old[:80]}...")
    src = src.replace(old, new)

shutil.copyfile(path, path + '.bak')
open(path, 'w', encoding='utf-8').write(src)
print('Patched. Backup at', path + '.bak')
