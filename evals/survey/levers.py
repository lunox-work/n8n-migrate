import json, sys, glob, collections, os, itertools
PURE = set("stickyNote set code if merge switch splitOut splitInBatches aggregate filter markdown html noOp limit htmlExtract itemLists removeDuplicates summarize stopAndError dateTime sort function functionItem executionData debugHelper n8nTrainingCustomerDatastore manualTrigger scheduleTrigger respondToWebhook form wait".split())
MODEL = set("lmChatOpenAi lmChatGoogleGemini lmChatOllama lmOpenAi lmOllama lmChatAnthropic lmChatOpenRouter lmOpenHuggingFaceInference chainLlm chainSummarization informationExtractor textClassifier outputParserStructured outputParserAutofixing".split())
CONNECTOR = set("gmail googleDrive notion slack googleDocs googleSheets microsoftOutlook github microsoftExcel microsoftOneDrive".split())
AGENT = set("agent memoryBufferWindow toolCalculator toolThink toolCode".split())
AGENT_CONN = set("googleCalendarTool gmailTool googleDocsTool googleSheetsTool mcpClientTool".split())
HTTP = set("httpRequest telegram whatsApp facebookGraphApi twitter linkedIn wordpress youTube discord uproc blotato googleAnalytics dropbox s3 n8n rssFeedRead hackerNews".split())
AGENT_HTTP = set("toolHttpRequest httpRequestTool toolSerpApi toolWikipedia rssFeedReadTool baserowTool".split())
DB = set("postgres supabase mongoDb mySql redis".split()); AGENT_DB = set("postgresTool memoryPostgresChat".split())
VECTOR = set("vectorStorePinecone vectorStoreInMemory vectorStoreQdrant vectorStoreSupabase vectorStorePGVector vectorStoreMongoDBAtlas embeddingsOpenAi embeddingsGoogleGemini documentDefaultDataLoader textSplitterRecursiveCharacterTextSplitter textSplitterTokenSplitter toolVectorStore".split())
FILES = set("extractFromFile readBinaryFile writeBinaryFile convertToFile spreadsheetFile readWriteFile readPDF executeCommand".split())
POLL = set("gmailTrigger googleDriveTrigger googleSheetsTrigger".split())
RELAY = set("telegramTrigger whatsAppTrigger".split())
BLOCK = {"mcpTrigger": "n8n as MCP server", "errorTrigger": "error workflow", "emailSend": "SMTP", "youtubeTranscripter": "community node"}
def need(wf):
    L = set(); B = set(); unk = set()
    for n in wf.get("nodes") or []:
        t = n.get("type", ""); s = t.split(".")[-1]; p = n.get("parameters") or {}
        if n.get("disabled"): continue
        if s in PURE or s in MODEL or s in CONNECTOR: continue
        if s in AGENT: L.add("agent")
        elif s in AGENT_CONN: L.add("agent")
        elif s in HTTP: L.add("http")
        elif s in AGENT_HTTP: L |= {"agent", "http"}
        elif s in DB: L.add("db")
        elif s in AGENT_DB: L |= {"agent", "db"}
        elif s in VECTOR: L.add("vector")
        elif s in FILES: L.add("files")
        elif s in POLL: L.add("poll")
        elif s in RELAY: L.add("relay")
        elif s == "chatTrigger": L.add("chat")
        elif s == "formTrigger": L.add("form")
        elif s == "webhook":
            if p.get("responseMode", "onReceived") == "onReceived": L.add("relay")
            else: B.add("sync webhook reply")
        elif s == "openAi":
            r = p.get("resource", "text"); o = p.get("operation", "")
            if r in ("text", "chat") or (r == "image" and o == "analyze"): pass
            elif r == "assistant": L.add("agent")
            else: L.add("http"); L.add("media")
        elif s in ("executeWorkflow", "toolWorkflow", "executeWorkflowTrigger"):
            if s == "toolWorkflow": L.add("agent")
            if s == "executeWorkflowTrigger": L.add("subwf"); continue
            w = p.get("workflowId"); v = w.get("value") if isinstance(w, dict) else w
            if (isinstance(v, str) and "$workflow" in v) or p.get("source") == "parameter": L.add("subwf")
            else: B.add("external sub-workflow")
        elif s in BLOCK: B.add(BLOCK[s])
        else: unk.add(s)
    return L, B, unk
rows = []; unk_all = collections.Counter(); blocked = collections.Counter()
for f in sorted(glob.glob(os.path.join(sys.argv[1], "*.json"))):
    w = json.load(open(f))["workflow"]; L, B, U = need(w.get("workflow") or {})
    rows.append((w["id"], w["name"][:50], L, B))
    for u in U: unk_all[u] += 1
    for b in B: blocked[b] += 1
print("unclassified:", dict(unk_all))
ok = [r for r in rows if not r[3]]
print("hard-blocked:", len(rows) - len(ok), dict(blocked))
print("baseline (no lever):", sum(1 for r in ok if not r[2]))
levers = sorted({l for r in rows for l in r[2]})
print("templates needing each lever (of 100):", {l: sum(1 for r in rows if l in r[2]) for l in levers})
print("-- greedy cumulative")
have = set(); 
while True:
    best = None
    for l in levers:
        if l in have: continue
        c = sum(1 for r in ok if r[2] <= have | {l})
        if best is None or c > best[1]: best = (l, c)
    if best is None: break
    have.add(best[0]); print(f"  +{best[0]:7s} -> {best[1]}")
print("-- fixed order by build cost")
have = set()
for l in ["agent", "subwf", "http", "media", "files", "poll", "chat", "form", "db", "vector", "relay"]:
    have.add(l); print(f"  +{l:7s} -> {sum(1 for r in ok if r[2] <= have)}")
print("-- without one lever (all others on)")
for l in levers: print(f"  no {l:7s} -> {sum(1 for r in ok if r[2] <= set(levers) - {l})}")
print("-- pairs/sets: no relay & no chat", sum(1 for r in ok if r[2] <= set(levers) - {"relay", "chat"}), "| only agent+subwf+http+media+files", sum(1 for r in ok if r[2] <= {"agent","subwf","http","media","files"}), "| +chat", sum(1 for r in ok if r[2] <= {"agent","subwf","http","media","files","chat"}), "| +chat+db+vector", sum(1 for r in ok if r[2] <= {"agent","subwf","http","media","files","chat","db","vector"}))
print("-- db/vector templates"); [print("  ", r[0], r[1], sorted(r[2]), sorted(r[3])) for r in rows if {"db", "vector"} & r[2]]
