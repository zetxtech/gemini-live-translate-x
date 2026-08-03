"""Regression: cut-ready deferral caused two float-ups ~500ms apart."""
from __future__ import annotations
import re
import sys

MIN_COMMA = 5
MIN_TAIL = 3
MIN_CUT = 500

now = 0
timers = {}
tid = 1
curO = ""
curT = ""
hist = []
next_id = 1
pending_timer = None
pending_action = None
boundary = 0
pkt = []
events = []

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

def log(typ, **kw):
    events.append({"type": typ, "time": now, **kw})

def has_term(s):
    return bool(re.search(r"[。！？!?；;：:\n—]", s))

def has_comma(s):
    return bool(re.search(r"[，,、]", s))

def has_bound(s):
    return has_term(s) or has_comma(s)

def clen(s):
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

def request_cut(after=None):
    global pending_action, pending_timer
    if after is not None:
        pending_action = after
    delay = max(0, boundary + MIN_CUT - now)
    log("schedule_cut", delay=delay, hasAction=after is not None)
    if pending_timer:
        clr(pending_timer)

    def fire():
        global pending_timer, pending_action
        pending_timer = None
        action = pending_action
        pending_action = None
        log("execute_cut", hasQueued=bool(action))
        commit()
        if action:
            action()
        log("render_after_cut")

    pending_timer = set_to(fire, delay)

def process(text):
    global curT, boundary, pending_action
    if not text:
        return
    if pending_timer is not None:
        prev = pending_action

        def chained():
            if prev:
                prev()
            process(text)

        pending_action = chained
        log("queue_after_pending_cut", text=text)
        return
    bi = find_break(text)
    if bi < 0:
        curT += text
        log("append", curT=curT)
        return
    end = extend_break(text, bi)
    head = text[: end + 1]
    tail = text[end + 1 :]
    curT += head
    boundary = now
    log("break", head=head, tail=tail, curT=curT)
    if not tail:
        if clen(curT) < MIN_TAIL:
            return
        request_cut()
        return
    if clen(tail) >= MIN_TAIL:
        request_cut(lambda: process(tail))
        return
    curT += tail
    log("append_short_tail", curT=curT)

def append_t(text):
    track()
    process(text)

def main():
    global curT, next_id, hist
    hist = [{"id": 12, "o": "", "t": "prev"}]
    next_id = 13
    curT = ""
    append_t("确认问题切换。")
    advance(600)
    append_t("记录问题？。这个上浮")
    advance(600)

    commits = [e for e in events if e["type"] == "commit"]
    print("COMMITS:")
    for c in commits:
        print("  t=%s id=%s text=%s" % (c["commitTime"], c["id"], c["text"]))

    next_break = next((e for e in events if e["type"] == "break" and "记录问题" in e.get("head", "")), None)
    prev_commit = next((c for c in commits if c["text"] == "确认问题切换。"), None)
    next_commit = next((c for c in commits if "记录问题" in c["text"]), None)

    if not prev_commit or not next_commit or not next_break:
        print("Missing expected commits/break")
        print("RESULT: RED")
        return 1

    paired = prev_commit["commitTime"] == next_break["time"]
    gap = next_commit["commitTime"] - prev_commit["commitTime"]
    print("prev commit at %s, next break at %s, paired=%s" % (prev_commit["commitTime"], next_break["time"], paired))
    print("gap prev->next commit = %sms" % gap)
    print("next commit text = %s" % next_commit["text"])

    red = paired
    if "这个上浮" in next_commit["text"]:
        red = True
        print("tail swallowed into punctuated commit")

    print("RESULT:", "RED" if red else "GREEN")
    return 1 if red else 0

if __name__ == "__main__":
    sys.exit(main())
