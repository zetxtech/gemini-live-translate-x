MIN_COMMA=5
MIN_TAIL=3
MIN_CUT=500
now = 0
timers = {}
tid = 1

def set_to(fn, delay):
    global tid
    i = tid
    tid += 1
    timers[i] = {"fn": fn, "at": now + max(0, delay)}
    return i

def clr(i):
    timers.pop(i, None)

def advance(ms):
    global now
    target = now + ms
    while True:
        nxt = None
        for i, t in list(timers.items()):
            if t["at"] <= target and (nxt is None or t["at"] < nxt[1]["at"] or (t["at"] == nxt[1]["at"] and i < nxt[0])):
                nxt = (i, t)
        if not nxt:
            break
        i, t = nxt
        now = t["at"]
        del timers[i]
        t["fn"]()
    now = target

curO = ""
curT = ""
hist = []
next_id = 1
pending_timer = None
pending_action = None
pending_ready = False
pending_tail = None
boundary = 0
pkt = []
events = []
anims = []
hkey = None
htext = ""

def log(typ, **kw):
    events.append({"type": typ, "time": now, **kw})

def has_term(s):
    import re
    return bool(re.search(r"[。！？!?；;：:\n—]", s))

def has_comma(s):
    import re
    return bool(re.search(r"[，,、]", s))

def has_bound(s):
    return has_term(s) or has_comma(s)

def clen(s):
    import re
    return len([c for c in s if not re.match(r"[\s。！？!?；;，,、：:\n—]", c)])

def find_break(text):
    for i, ch in enumerate(text):
        if has_term(ch):
            return i
        if has_comma(ch) and clen(curT + text[: i + 1]) >= MIN_COMMA:
            return i
    return -1

def extend_break(text, i):
    end = i
    while end + 1 < len(text) and has_bound(text[end + 1]):
        end += 1
    return end

def track():
    global pkt
    pkt.append(now)
    pkt = [t for t in pkt if now - t <= 30000]

def short_ms():
    if len(pkt) < 2:
        return 1000
    total = sum(pkt[i] - pkt[i - 1] for i in range(1, len(pkt)))
    return max(MIN_CUT, (total / (len(pkt) - 1)) * 1.5)

def emit_render():
    global hkey, htext
    visible = hist[-1:]
    v = visible[0] if visible else None
    nkey = (str(v["id"]) + ":t") if v else None
    ntext = v["t"] if v else ""
    if hkey and hkey != nkey:
        anims.append({"time": now, "kind": "exit_up", "key": hkey, "text": htext})
        log("anim_exit", key=hkey, text=htext)
    if nkey and nkey != hkey:
        anims.append({"time": now, "kind": "enter_up", "key": nkey, "text": ntext})
        log("anim_enter", key=nkey, text=ntext)
    hkey, htext = nkey, ntext
    log("render", histTop=ntext, curT=curT)

def commit():
    global curO, curT, next_id
    if not curO and not curT:
        return
    idv = next_id
    next_id += 1
    text = curT
    hist.append({"id": idv, "o": curO, "t": curT})
    curO = curT = ""
    log("commit", id=idv, text=text, commitTime=now)

def append_merged(text):
    global curT
    curT += text
    log("append_merged", curT=curT, hasTerminal=has_term(curT))
    emit_render()

def request_cut(after=None):
    global pending_ready, pending_action, pending_timer
    pending_ready = False
    if after is not None:
        pending_action = after
    delay = max(0, boundary + MIN_CUT - now)
    log("schedule_cut", delay=delay, hasAction=after is not None)
    if pending_timer:
        clr(pending_timer)

    def fire():
        global pending_timer, pending_action, pending_ready
        pending_timer = None
        action = pending_action
        pending_action = None
        if not action:
            pending_ready = True
            return
        log("execute_cut")
        commit()
        action()

    pending_timer = set_to(fire, delay)

def queue_short(tail):
    global pending_tail
    if pending_tail and pending_tail.get("timer"):
        clr(pending_tail["timer"])
    delay = short_ms()
    log("queue_short_tail", tail=tail, delay=delay)

    def fire():
        global pending_tail
        pending_tail = None
        request_cut(lambda: process(tail))

    timer = set_to(fire, delay)
    pending_tail = {"tail": tail, "timer": timer}

def process(text):
    global curT, boundary, pending_tail, pending_ready, pending_action
    if not text:
        return
    if pending_tail:
        p = pending_tail
        if p.get("timer"):
            clr(p["timer"])
        pending_tail = None
        log("merge_short_tail", tail=p["tail"], next=text)
        # Fixed path: re-run full break detection (mirrors main.ts).
        request_cut(lambda: process(p["tail"] + text))
        return
    if pending_timer is not None:
        prev = pending_action

        def chained():
            if prev:
                prev()
            process(text)

        pending_action = chained
        return
    if pending_ready:
        delay = max(0, boundary + MIN_CUT - now)
        if delay > 0:
            pending_ready = False
            request_cut(lambda: process(text))
            return
        pending_ready = False
        commit()
        process(text)
        return
    bi = find_break(text)
    if bi < 0:
        curT += text
        log("append", curT=curT)
        emit_render()
        return
    end = extend_break(text, bi)
    head = text[: end + 1]
    tail = text[end + 1 :]
    curT += head
    boundary = now
    log("break", head=head, tail=tail, curT=curT)
    emit_render()
    if not tail:
        if clen(curT) < MIN_TAIL:
            return
        request_cut()
        return
    if clen(tail) >= MIN_TAIL:
        request_cut(lambda: process(tail))
        return
    queue_short(tail)

def append_t(text):
    track()
    process(text)

hist = [{"id": 3, "o": "hellohello", "t": "prev-history-line"}]
next_id = 4
curT = "继续需要"
for i in range(12):
    pkt.append(-(12 - i) * 824)
emit_render()
base = len(anims)

steps = [
    (655, lambda: append_t("我们重复")),
    (1487, lambda: append_t("字幕上浮、但是")),
    (2237, lambda: append_t("显示显示问题。")),
    (2719, lambda: append_t("字幕现在字幕：然后")),
    (2781, lambda: append_t("动画确认")),
    (3445, lambda: append_t("如果观察记录")),
]
prev = 0
for at, fn in steps:
    advance(at - prev)
    prev = at
    fn()
advance(2000)

commits = [e for e in events if e["type"] == "commit"]
after = anims[base:]
enters = [a for a in after if a["kind"] == "enter_up"]

print("COMMITS:")
for c in commits:
    print(f"  time={c['commitTime']} id={c['id']} text={c['text']}")
print("ANIMS after baseline:")
for a in after:
    print(f"  time={a['time']} {a['kind']} text={a['text']}")

s1 = False
for c in commits:
    near = [a for a in after if a["time"] == c["commitTime"]]
    dual = any(a["kind"] == "exit_up" for a in near) and any(a["kind"] == "enter_up" for a in near)
    print(f"S1 commit id={c['id']} time={c['commitTime']} dual_up={dual} anims={'+'.join(a['kind'] for a in near)}")
    if dual:
        s1 = True

s2 = False
for i in range(1, len(commits)):
    gap = commits[i]["commitTime"] - commits[i - 1]["commitTime"]
    print(f"S2 gap id{commits[i-1]['id']}->id{commits[i]['id']} = {gap}ms")
    if gap < 1000:
        s2 = True

merges = [e for e in events if e["type"] == "append_merged"]
s4 = False
phrase = "但是显示显示问题"
phrase_commits = [c for c in commits if phrase in c["text"]]
for c in phrase_commits:
    # Bug: phrase is only a prefix of a longer committed history line
    # e.g. "但是显示显示问题。字幕现在字幕："
    if not c["text"].startswith(phrase):
        continue
    rest = c["text"][len(phrase) :]
    # Allow a single trailing terminal mark; any extra content means swallowed.
    if rest in ("", "。", "！", "？", ".", "!", "?"):
        continue
    if rest and rest[0] in "。！？.!?" and clen(rest[1:]) == 0:
        continue
    if clen(rest) > 0:
        s4 = True
        print(f"S4 phrase swallowed into longer commit: {c['text']}")

print("Commits with phrase:", [(c["id"], c["commitTime"], c["text"]) for c in commits if phrase in c["text"]])
print("Enters with phrase:", [(a["time"], a["text"]) for a in enters if phrase in a["text"]])
pc = next((c for c in commits if phrase in c["text"]), None)
if pc:
    print(f"Phrase commit exact text: {pc['text']}")
    clean = pc["text"] in (phrase, phrase + "。", phrase + "！", phrase + "？") or (
        pc["text"].startswith(phrase) and clen(pc["text"][len(phrase) :]) == 0
    )
    print("Phrase commit is clean (own sentence):", clean)
    if not clean:
        s4 = True
else:
    print("Phrase never committed as history (unexpected)")
    s4 = True

print("VERDICT")
print("S1 dual exit+enter:", "RED" if s1 else "GREEN")
print("S2 rapid commits (info):", "yes" if s2 else "no")
print("S4 merge skip rebreak:", "RED" if s4 else "GREEN")
# S1 is structural for historyRows=1. S4 is the bug under fix.
red = s4
print("RESULT:", "RED" if red else "GREEN")
raise SystemExit(1 if red else 0)
