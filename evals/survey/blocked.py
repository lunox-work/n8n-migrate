import json, sys, glob, os
BL = {"mcpTrigger", "errorTrigger", "emailSend", "youtubeTranscripter"}
for f in sorted(glob.glob(os.path.join(sys.argv[1], "*.json")), key=lambda p: int(os.path.basename(p)[:-5])):
    w = json.load(open(f))["workflow"]; wf = w.get("workflow") or {}; nodes = wf.get("nodes") or []
    out = []
    trig = sorted({n["type"].split(".")[-1] for n in nodes if n["type"].split(".")[-1].lower().endswith("trigger") or n["type"].endswith(".webhook")})
    for n in nodes:
        if n.get("disabled"): continue
        t = n.get("type", ""); s = t.split(".")[-1]; p = n.get("parameters") or {}
        if s == "webhook" and p.get("responseMode", "onReceived") != "onReceived":
            out.append(f"webhook[{p.get('httpMethod','GET')} {p.get('path','')[:30]} mode={p.get('responseMode')}]")
        elif s in ("executeWorkflow", "toolWorkflow"):
            wid = p.get("workflowId"); v = wid.get("value") if isinstance(wid, dict) else wid
            nm = wid.get("cachedResultName") if isinstance(wid, dict) else None
            if not ((isinstance(v, str) and "$workflow" in v) or p.get("source") == "parameter"):
                out.append(f"{s}[{n.get('name','')[:28]} -> id={str(v)[:22]} name={str(nm)[:40]}]")
        elif s in BL:
            extra = ""
            if s == "emailSend": extra = f" to={str(p.get('toEmail',''))[:30]} v{n.get('typeVersion')}"
            out.append(f"{s}[{n.get('name','')[:28]}{extra}] type={t}")
    if out:
        print(f"{w['id']} | {w['name'][:62]} | views {w.get('totalViews')} | nodes {len(nodes)} | triggers {trig}")
        for o in out: print("     ", o)
