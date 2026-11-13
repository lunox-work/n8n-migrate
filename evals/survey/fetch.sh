#!/bin/sh
# Downloads the 100 most-viewed n8n templates into evals/survey/data/ (git-ignored).
# Then: python3 -I evals/survey/classify.py evals/survey/data/wf   (same for levers.py, blocked.py, nodes.py)
set -eu
D="$(cd "$(dirname "$0")" && pwd)/data"
mkdir -p "$D/wf"
curl -sS -m 30 -A "template-survey/0.1" -o "$D/top100.json" \
  "https://api.n8n.io/api/templates/search?rows=100&page=1&sort=views:desc"
python3 -I -c "
import json, sys
for w in json.load(open(sys.argv[1]))['workflows']: print(w['id'])" "$D/top100.json" > "$D/ids.txt"
cd "$D/wf"
xargs -P 4 -I{} curl -sS -m 30 -A "template-survey/0.1" -o {}.json \
  "https://api.n8n.io/api/templates/workflows/{}" < "$D/ids.txt"
ls | wc -l
