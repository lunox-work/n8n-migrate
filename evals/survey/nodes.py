import json, sys, glob, collections, os
files = sorted(glob.glob(os.path.join(sys.argv[1], "*.json")))
freq = collections.Counter(); waits = collections.Counter(); oai = collections.Counter(); wh = collections.Counter(); subwf = collections.Counter()
for f in files:
    wf = json.load(open(f))["workflow"].get("workflow") or {}
    nodes = wf.get("nodes") or []
    short = set()
    for n in nodes:
        s = n.get("type", "").split(".")[-1]; short.add(s); p = n.get("parameters") or {}
        if s == "wait":
            r = p.get("resume", "timeInterval")
            waits[(r, str(p.get("unit", "s(default)")), str(p.get("amount", ""))[:12])] += 1
        if s == "openAi": oai[(str(p.get("resource", "text(default)")), str(p.get("operation", "")))] += 1
        if s == "webhook": wh[str(p.get("responseMode", "onReceived(default)"))] += 1
        if s in ("executeWorkflow", "toolWorkflow"):
            w = p.get("workflowId"); src = p.get("source", "")
            v = w.get("value") if isinstance(w, dict) else w
            subwf["self-ref expr" if isinstance(v, str) and "$workflow" in v else ("inline json" if src == "parameter" else "other id")] += 1
    for s in short: freq[s] += 1
print(len(freq), "node types")
print(", ".join(f"{t}:{c}" for t, c in freq.most_common()))
print("-- wait", waits.most_common(20))
print("-- openAi ops", oai.most_common(20))
print("-- webhook responseMode", wh.most_common())
print("-- subworkflow refs", subwf.most_common())
