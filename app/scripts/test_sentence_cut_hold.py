#!/usr/bin/env python3
"""Deterministic tests for sentence-cut hold after current-line readable.

Mirrors the cut state machine in main.ts:
  break -> await readable -> hold 500ms -> commit
  chained tail must wait for its own readable before another 500ms hold

Exit 0 = all green, Exit 1 = at least one red case.
"""

from __future__ import annotations

import re
import sys
from dataclasses import dataclass, field

MIN_COMMA = 5
MIN_TAIL = 3
MIN_CUT = 500
FALLBACK = max(MIN_CUT * 4, 2000)
SPEECH_WINDOW = 30_000
DEFAULT_SHORT_TAIL = 1000


@dataclass
class Engine:
    now: int = 0
    timers: dict = field(default_factory=dict)
    tid: int = 1
    curO: str = ""
    curT: str = ""
    hist: list = field(default_factory=list)
    next_id: int = 1
    pending_timer: int | None = None
    pending_action: object | None = None
    pending_tail: dict | None = None
    awaiting_readable: bool = False
    cut_hold_active: bool = False
    pending_cut_text: str = ""
    pkt: list = field(default_factory=list)
    events: list = field(default_factory=list)
    commits: list = field(default_factory=list)

    def log(self, typ: str, **kw):
        self.events.append({"type": typ, "t": self.now, **kw})

    def set_to(self, fn, delay: float):
        i = self.tid
        self.tid += 1
        self.timers[i] = {"fn": fn, "at": self.now + max(0, int(delay))}
        return i

    def clr(self, i: int | None):
        if i is None:
            return
        self.timers.pop(i, None)

    def advance(self, ms: int):
        target = self.now + ms
        while True:
            nxt = None
            for i, t in list(self.timers.items()):
                if t["at"] <= target and (nxt is None or t["at"] < nxt[1]["at"] or (t["at"] == nxt[1]["at"] and i < nxt[0])):
                    nxt = (i, t)
            if not nxt:
                break
            i, t = nxt
            self.now = t["at"]
            del self.timers[i]
            t["fn"]()
        self.now = target

    def flush_zero(self, steps: int = 20):
        """Run ready timers at current time, including setTimeout(0) chains."""
        for _ in range(steps):
            ready = [(i, t) for i, t in self.timers.items() if t["at"] <= self.now]
            if not ready:
                return
            ready.sort(key=lambda x: (x[1]["at"], x[0]))
            i, t = ready[0]
            self.now = t["at"]
            del self.timers[i]
            t["fn"]()


def has_term(s: str) -> bool:
    return bool(re.search(r"[。！？!?；;：:\n—]", s))


def has_comma(s: str) -> bool:
    return bool(re.search(r"[，,、]", s))


def has_bound(s: str) -> bool:
    return has_term(s) or has_comma(s)


def clen(s: str) -> int:
    return len([c for c in s if not re.match(r"[\s。！？!?；;，,、：:\n—]", c)])


def find_break(engine: Engine, text: str) -> int:
    for i, ch in enumerate(text):
        if has_term(ch):
            return i
        if has_comma(ch) and clen(engine.curT + text[: i + 1]) >= MIN_COMMA:
            return i
    return -1


def extend_break(text: str, i: int) -> int:
    end = i
    while end + 1 < len(text) and has_bound(text[end + 1]):
        end += 1
    return end


def track(engine: Engine):
    engine.pkt.append(engine.now)
    engine.pkt = [t for t in engine.pkt if engine.now - t <= SPEECH_WINDOW]


def short_ms(engine: Engine) -> float:
    if len(engine.pkt) < 2:
        return DEFAULT_SHORT_TAIL
    total = sum(engine.pkt[i] - engine.pkt[i - 1] for i in range(1, len(engine.pkt)))
    return max(MIN_CUT, (total / (len(engine.pkt) - 1)) * 1.5)


def commit(engine: Engine):
    if not engine.curO and not engine.curT:
        engine.log("skip_commit")
        return
    idv = engine.next_id
    engine.next_id += 1
    text = engine.curT
    engine.hist.append({"id": idv, "t": text, "o": engine.curO})
    engine.commits.append({"t": engine.now, "id": idv, "text": text})
    engine.curO = ""
    engine.curT = ""
    engine.log("commit", id=idv, text=text)


def clear_pending_cut(engine: Engine):
    engine.clr(engine.pending_timer)
    engine.pending_timer = None
    engine.pending_action = None
    engine.awaiting_readable = False
    engine.pending_cut_text = ""
    engine.cut_hold_active = False


def begin_cut_hold(engine: Engine, text: str):
    if engine.cut_hold_active:
        return
    engine.awaiting_readable = False
    engine.cut_hold_active = True
    engine.pending_cut_text = text
    engine.log("schedule_cut_after_readable", delay=MIN_CUT, text=text, hasAction=bool(engine.pending_action))
    engine.clr(engine.pending_timer)

    def fire():
        engine.pending_timer = None
        action = engine.pending_action
        engine.pending_action = None
        engine.awaiting_readable = False
        engine.cut_hold_active = False
        engine.pending_cut_text = ""
        engine.log("execute_cut", hasQueued=bool(action), curT=engine.curT)
        commit(engine)
        if action:
            def run_action():
                action()
                engine.log("render")
            engine.set_to(run_action, 0)
        else:
            engine.log("render")

    engine.pending_timer = engine.set_to(fire, MIN_CUT)


def on_readable(engine: Engine, text: str):
    engine.log("readable", text=text)
    if not engine.awaiting_readable or engine.cut_hold_active:
        engine.log("readable_ignored", reason="not awaiting or hold active")
        return
    if engine.pending_cut_text and text and text != engine.pending_cut_text:
        engine.log("readable_mismatch", got=text, want=engine.pending_cut_text)
        return
    begin_cut_hold(engine, engine.pending_cut_text or text or engine.curT)


def request_cut(engine: Engine, after=None):
    if after is not None:
        engine.pending_action = after
    if engine.cut_hold_active:
        engine.log("cut_hold_already_active", hasAction=after is not None)
        return
    engine.awaiting_readable = True
    engine.cut_hold_active = False
    engine.pending_cut_text = engine.curT
    engine.log("await_readable", text=engine.curT, hasAction=after is not None)
    engine.clr(engine.pending_timer)

    def fallback():
        if not engine.awaiting_readable:
            return
        engine.log("readable_timeout")
        begin_cut_hold(engine, engine.pending_cut_text or engine.curT)

    engine.pending_timer = engine.set_to(fallback, FALLBACK)


def queue_short(engine: Engine, tail: str):
    if engine.pending_tail and engine.pending_tail.get("timer") is not None:
        engine.clr(engine.pending_tail["timer"])
    delay = short_ms(engine)
    engine.log("queue_short_tail", tail=tail, delay=delay)

    def fire():
        engine.pending_tail = None
        request_cut(engine, lambda: process(engine, tail))

    timer = engine.set_to(fire, delay)
    engine.pending_tail = {"tail": tail, "timer": timer}


def process(engine: Engine, text: str):
    if not text:
        return
    if engine.pending_tail:
        p = engine.pending_tail
        if p.get("timer") is not None:
            engine.clr(p["timer"])
        engine.pending_tail = None
        engine.log("merge_short_tail", tail=p["tail"], next=text)
        request_cut(engine, lambda: process(engine, p["tail"] + text))
        return
    if engine.pending_timer is not None:
        # Only queue if a cut is actually pending (awaiting or holding).
        if engine.awaiting_readable or engine.cut_hold_active:
            prev = engine.pending_action

            def chained():
                if prev:
                    prev()
                process(engine, text)

            engine.pending_action = chained
            engine.log("queue_after_pending_cut", text=text)
            return
    bi = find_break(engine, text)
    if bi < 0:
        engine.curT += text
        engine.log("append", curT=engine.curT)
        return
    end = extend_break(text, bi)
    head = text[: end + 1]
    tail = text[end + 1 :]
    engine.curT += head
    engine.log("break", head=head, tail=tail, curT=engine.curT)
    if not tail:
        if clen(engine.curT) < MIN_TAIL:
            engine.log("hold_short")
            return
        request_cut(engine)
        return
    if clen(tail) >= MIN_TAIL:
        request_cut(engine, lambda: process(engine, tail))
        return
    queue_short(engine, tail)


def append_t(engine: Engine, text: str):
    track(engine)
    process(engine, text)


def gap_ok(commits: list, min_gap: int) -> bool:
    for i in range(1, len(commits)):
        if commits[i]["t"] - commits[i - 1]["t"] < min_gap:
            return False
    return True


def run_case(name: str, fn) -> bool:
    engine = Engine()
    try:
        ok, detail = fn(engine)
    except Exception as exc:  # noqa: BLE001
        print(f"[RED] {name}: exception {exc}")
        return False
    status = "GREEN" if ok else "RED"
    print(f"[{status}] {name}: {detail}")
    if not ok:
        print("  commits:", engine.commits)
        interesting = [e for e in engine.events if e["type"] in {
            "break", "await_readable", "readable", "schedule_cut_after_readable",
            "execute_cut", "commit", "readable_timeout", "merge_short_tail",
        }]
        for e in interesting[-20:]:
            print("   ", e)
    return ok


def case_short_line_needs_readable_then_500(engine: Engine):
    """Short line: no cut until readable, then exactly ~500ms later."""
    append_t(engine, "确认问题切换。")
    # Before readable: no commit
    engine.advance(400)
    if engine.commits:
        return False, f"committed before readable at t={engine.commits[0]['t']}"
    on_readable(engine, "确认问题切换。")
    engine.advance(499)
    if engine.commits:
        return False, f"committed before 500ms hold, t={engine.commits[0]['t']}"
    engine.advance(1)
    engine.flush_zero()
    if len(engine.commits) != 1:
        return False, f"expected 1 commit, got {len(engine.commits)}"
    # readable was at 400, commit at 900
    if engine.commits[0]["t"] != 900:
        return False, f"commit at {engine.commits[0]['t']}, expected 900"
    if engine.commits[0]["text"] != "确认问题切换。":
        return False, f"bad text {engine.commits[0]['text']}"
    return True, "readable@400 -> commit@900"


def case_no_readable_no_fast_cut(engine: Engine):
    """Without readable, must not commit within first 500ms after break."""
    append_t(engine, "现在上浮。")
    engine.advance(500)
    if engine.commits:
        return False, f"committed without readable at t={engine.commits[0]['t']}"
    engine.advance(1499)  # total 1999 from break
    if engine.commits:
        return False, f"committed before fallback at t={engine.commits[0]['t']}"
    engine.advance(1)  # 2000: readable timeout -> start 500ms hold
    engine.flush_zero()
    if engine.commits:
        return False, f"committed at timeout without hold, t={engine.commits[0]['t']}"
    engine.advance(500)  # 2500: hold completes
    engine.flush_zero()
    if len(engine.commits) != 1:
        return False, f"expected fallback commit, got {len(engine.commits)}"
    if engine.commits[0]["t"] != 2500:
        return False, f"fallback commit at {engine.commits[0]['t']}, expected 2500"
    return True, "fallback path: timeout@2000 + hold 500 -> commit@2500"


def case_chained_tail_requires_two_holds(engine: Engine):
    """In-chunk tail: two commits must each wait readable + 500ms."""
    append_t(engine, "记录问题？。这个上浮继续。")
    # First sentence head committed only after readable#1 + 500
    if engine.commits:
        return False, "committed before any readable"
    # Wrong readable should be ignored
    on_readable(engine, "别的句子")
    engine.advance(100)
    if engine.commits:
        return False, "accepted mismatched readable"
    on_readable(engine, engine.pending_cut_text or "记录问题？。")
    # pending_cut_text should be "记录问题？。"
    engine.advance(500)
    engine.flush_zero()
    if len(engine.commits) < 1:
        return False, "missing first commit"
    # After first commit, action processes tail "这个上浮继续。" which itself breaks
    engine.flush_zero()
    # Second cut should be awaiting readable, not already committed
    if len(engine.commits) >= 2:
        gap = engine.commits[1]["t"] - engine.commits[0]["t"]
        if gap < 500:
            return False, f"second commit too soon gap={gap}ms"
        return False, f"unexpected second commit already present gap={gap}"
    # Provide readable for second sentence after some scroll time
    # Find current awaiting text
    second_text = engine.curT
    if not second_text:
        # tail may not have been processed yet
        engine.flush_zero()
        second_text = engine.curT
    if not engine.awaiting_readable:
        return False, f"not awaiting second readable, curT={engine.curT!r}, events tail={engine.events[-8:]}"
    on_readable(engine, engine.pending_cut_text or second_text)
    engine.advance(499)
    if len(engine.commits) >= 2:
        return False, "second commit before 500ms hold"
    engine.advance(1)
    engine.flush_zero()
    if len(engine.commits) < 2:
        return False, f"missing second commit, commits={engine.commits}"
    gap = engine.commits[1]["t"] - engine.commits[0]["t"]
    if gap < 500:
        return False, f"commit gap {gap}ms < 500"
    return True, f"two commits gap={gap}ms, texts={[c['text'] for c in engine.commits]}"


def case_rapid_punctuated_packets(engine: Engine):
    """Two separate punctuated packets close together still need 500ms each after readable."""
    append_t(engine, "第一句完。")
    on_readable(engine, "第一句完。")
    engine.advance(500)
    engine.flush_zero()
    append_t(engine, "第二句也完。")
    # Immediately try readable for second - should start its own hold
    # But second must wait its own readable after paint; simulate slight delay
    engine.advance(50)
    on_readable(engine, "第二句也完。")
    engine.advance(499)
    if len(engine.commits) >= 2:
        return False, f"second commit early: {engine.commits}"
    engine.advance(1)
    engine.flush_zero()
    if len(engine.commits) != 2:
        return False, f"expected 2 commits, got {engine.commits}"
    gap = engine.commits[1]["t"] - engine.commits[0]["t"]
    if gap < 500:
        return False, f"gap {gap} < 500"
    return True, f"two packets gap={gap}ms"


def case_stale_readable_cannot_fastpath(engine: Engine):
    """A readable from a previous sentence must not start hold for a new cut."""
    # Need >= 3 content chars so punctuation triggers a cut request.
    append_t(engine, "旧句子完。")
    on_readable(engine, "旧句子完。")
    engine.advance(500)
    engine.flush_zero()
    if len(engine.commits) != 1:
        return False, f"first sentence not committed: {engine.commits}"
    # New sentence
    append_t(engine, "新句很长需要滚动。")
    # Stale: emit old readable again - must mismatch and be ignored
    on_readable(engine, "旧句子完。")
    engine.advance(100)
    if len(engine.commits) > 1:
        return False, "stale readable caused commit"
    on_readable(engine, "新句很长需要滚动。")
    engine.advance(499)
    if len(engine.commits) > 1:
        return False, "second commit before hold elapsed"
    engine.advance(1)
    engine.flush_zero()
    if len(engine.commits) != 2:
        return False, f"expected 2 commits got {engine.commits}"
    gap = engine.commits[1]["t"] - engine.commits[0]["t"]
    if gap < 500:
        return False, f"gap {gap} < 500"
    return True, f"stale readable ignored, gap={gap}ms"


def main() -> int:
    cases = [
        ("short line: readable then 500ms", case_short_line_needs_readable_then_500),
        ("no readable: no cut in first 500ms", case_no_readable_no_fast_cut),
        ("chained tail: two holds", case_chained_tail_requires_two_holds),
        ("rapid packets still hold 500ms each", case_rapid_punctuated_packets),
        ("stale readable cannot fast-path", case_stale_readable_cannot_fastpath),
    ]
    results = [run_case(name, fn) for name, fn in cases]
    passed = sum(1 for r in results if r)
    print(f"\n{passed}/{len(results)} passed")
    return 0 if all(results) else 1


if __name__ == "__main__":
    sys.exit(main())
