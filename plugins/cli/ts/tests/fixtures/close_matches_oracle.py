import difflib
import json
import random
import sys

random.seed(int(sys.argv[1]))
WORDS = ["history.search", "history.delete", "tabs.close", "tabs.list", "windows", "Windows", "newTab", "selectTab", "toggleSidebar",
         "éé", "😀tab", "a", "ab", "abc", "x" * 210, "x" * 205 + "y" * 5, "tab.opened", "tab.closed", "tab.idle"]
rows = []
for _ in range(400):
    pool = random.sample(WORDS, random.randint(0, len(WORDS)))
    name = random.choice(WORDS + ["histroy.search", "tabs.clsoe", "WINDOWS", "newtab", "zzz", "tab.opend", "x" * 208, ""])
    values = [random.random() * 600, random.random() / 1000, random.choice([30.0, 2.5, 600.0, 1e-5]), round(random.random() * 600, random.randint(0, 7))]
    rows.append({"name": name, "pool": pool, "found": difflib.get_close_matches(name, pool, n=3, cutoff=0.6), "values": values, "g": [f"{v:g}" for v in values]})
print(json.dumps(rows))
