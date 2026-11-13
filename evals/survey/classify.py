import json, sys, glob, collections, os, re
files = sorted(glob.glob(os.path.join(sys.argv[1], "*.json")))
trig = collections.Counter(); wake = collections.Counter(); blockers = collections.Counter()
nodefreq = collections.Counter(); verdict = collections.Counter()
stats = dict(pin=0, expr=0, code=0, http=0, lc=0, agent=0, sticky=0, community=0, inlinekey=0, creds=collections.Counter())
SCHED = {"scheduleTrigger", "cron", "interval"}
MANUAL = {"manualTrigger", "start"}
LISTEN_SYNC = {"webhook", "chatTrigger", "formTrigger", "mcpTrigger"}
sizes = []; elig_ids = []; tv = collections.Counter()
SECRET = re.compile(r"(sk-[A-Za-z0-9]{20,}|Bearer [A-Za-z0-9_\-\.]{20,}|xox[bp]-[A-Za-z0-9-]{10,}|AIza[0-9A-Za-z_\-]{30,})")
for f in files:
    try: w = json.load(open(f))["workflow"]
    except Exception as e: print("ERR", f, e); continue
    wf = w.get("workflow") or {}
    nodes = wf.get("nodes") or []
    sizes.append(len(nodes))
    types = [n.get("type", "") for n in nodes]
    short = [t.split(".")[-1] for t in types]
    for s in set(short): nodefreq[s] += 1
    ts = {s for s in short if s.lower().endswith("trigger") or s in ("webhook", "cron", "interval", "start")}
    for t in ts: trig[t] += 1
    raw = json.dumps(wf)
    if wf.get("pinData"): stats["pin"] += 1
    if "={{" in raw: stats["expr"] += 1
    if "code" in short or "function" in short or "functionItem" in short: stats["code"] += 1
    if "httpRequest" in short: stats["http"] += 1
    if any("langchain" in t for t in types): stats["lc"] += 1
    if "agent" in short: stats["agent"] += 1
    if any(not (t.startswith("n8n-nodes-base.") or t.startswith("@n8n/")) for t in types if t): stats["community"] += 1
    if SECRET.search(raw): stats["inlinekey"] += 1
    for n in nodes:
        for k in (n.get("credentials") or {}): stats["creds"][k] += 1
        tv[(n.get("type","").split(".")[-1], n.get("typeVersion"))] += 1
    b = set()
    if "respondToWebhook" in short or "chatTrigger" in short: b.add("sync reply / chat")
    if "wait" in short: b.add("wait")
    if "executeWorkflow" in short or "toolWorkflow" in short or "executeWorkflowTrigger" in short: b.add("sub-workflow")
    if any(s.startswith("vectorStore") or s.startswith("embeddings") for s in short): b.add("vector store")
    if any(s.startswith("memory") for s in short): b.add("chat memory")
    if any(s in ("readBinaryFile","writeBinaryFile","readWriteFile","extractFromFile","convertToFile","googleDrive","s3") for s in short) or '"binary' in raw: b.add("binary/files")
    for x in b: blockers[x] += 1
    non_manual = ts - MANUAL
    if not ts: k = "no trigger node"
    elif not non_manual: k = "manual only"
    elif non_manual <= SCHED: k = "schedule (+manual)"
    elif non_manual & LISTEN_SYNC: k = "webhook/chat/form listener"
    else: k = "app event listener (telegram, gmail, ...)"
    wake[k] += 1
    hard = b - {"binary/files"}
    if k in ("manual only", "schedule (+manual)"):
        verdict["manual/schedule, no hard blocker" if not hard else "manual/schedule but blocked: " + ",".join(sorted(hard))] += 1
        if not hard: elig_ids.append((w["id"], w["name"][:60], k, len(nodes)))
    else: verdict["needs a listener"] += 1
n = len(files)
print("templates", n, "median nodes", sorted(sizes)[n//2], "max", max(sizes))
print("-- wake-up"); [print(f"  {c:3d} {k}") for k, c in wake.most_common()]
print("-- triggers"); [print(f"  {c:3d} {k}") for k, c in trig.most_common(20)]
print("-- blockers (templates with)"); [print(f"  {c:3d} {k}") for k, c in blockers.most_common()]
print("-- rough v1 fit"); [print(f"  {c:3d} {k}") for k, c in verdict.most_common()]
print("-- stats", {k: v for k, v in stats.items() if k != "creds"})
print("-- top creds", stats["creds"].most_common(12))
vers = collections.defaultdict(set)
for (t, v), c in tv.items(): vers[t].add(v)
print("-- nodes with >2 typeVersions in corpus", sorted(((t, sorted(map(str, v))) for t, v in vers.items() if len(v) > 2), key=lambda x: -len(x[1]))[:10])
print("-- eligible"); [print("  ", e) for e in elig_ids]
