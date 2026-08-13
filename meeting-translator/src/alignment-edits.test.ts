import { describe, expect, it } from "vitest";
import {
  applyAlignmentEdits,
  chunkRanges,
  parseAlignmentEdits,
  type AlignedLine,
} from "./alignment-edits";

function lines(list: Array<[number, string, string]>): AlignedLine[] {
  return list.map(([id, o, t]) => ({ id, o, t }));
}

function apply(source: AlignedLine[], edits: Parameters<typeof applyAlignmentEdits>[1]) {
  return applyAlignmentEdits(source, edits).lines;
}

describe("chunkRanges", () => {
  it("returns a single chunk when the list fits", () => {
    expect(chunkRanges(10, 25, 2)).toEqual([{ start: 0, end: 10 }]);
  });

  it("splits long lists with overlap", () => {
    expect(chunkRanges(60, 25, 2)).toEqual([
      { start: 0, end: 25 },
      { start: 23, end: 48 },
      { start: 46, end: 60 },
    ]);
  });

  it("returns empty for empty input", () => {
    expect(chunkRanges(0, 25, 2)).toEqual([]);
  });
});

describe("parseAlignmentEdits", () => {
  it("parses the simplified rows format as a remap", () => {
    const edits = parseAlignmentEdits('{"rows":[{"o":1,"t":2},{"o":2,"t":0}]}');
    expect(edits).toEqual([{ op: "remap", pairs: [{ o: 1, t: 2 }, { o: 2, t: null }] }]);
  });

  it("parses rows wrapped in prose and code fences", () => {
    const edits = parseAlignmentEdits(
      'Here is the mapping:\n```json\n{"rows":[{"o":5,"t":5},{"o":6,"t":0}]}\n```',
    );
    expect(edits).toEqual([{ op: "remap", pairs: [{ o: 5, t: 5 }, { o: 6, t: null }] }]);
  });

  it("drops invalid rows entries but keeps valid ones", () => {
    const edits = parseAlignmentEdits(
      '{"rows":[{"o":1,"t":2},{"o":"x","t":3},{"o":4},{"t":5}]}',
    );
    expect(edits).toEqual([
      { op: "remap", pairs: [{ o: 1, t: 2 }, { o: 4, t: null }] },
    ]);
  });

  it("treats an empty rows list as no change", () => {
    expect(parseAlignmentEdits('{"rows":[]}')).toEqual([]);
  });

  it("parses an object with an edits array", () => {
    const edits = parseAlignmentEdits(
      '{"edits":[{"op":"move","id":3,"offset":1},{"op":"update","id":5,"t":"新译"}]}',
    );
    expect(edits).toEqual([
      { op: "move", id: 3, offset: 1 },
      { op: "update", id: 5, t: "新译" },
    ]);
  });

  it("parses a bare array wrapped in prose and code fences", () => {
    const edits = parseAlignmentEdits(
      'Here you go:\n```json\n[{"op":"insert","after":2,"o":"a","t":"甲"}]\n```',
    );
    expect(edits).toEqual([{ op: "insert", after: 2, o: "a", t: "甲" }]);
  });

  it("parses a replace op with items", () => {
    const edits = parseAlignmentEdits(
      '{"edits":[{"op":"replace","start":1,"end":2,"items":[{"o":"x","t":"乙"}]}]}',
    );
    expect(edits).toEqual([{ op: "replace", start: 1, end: 2, items: [{ o: "x", t: "乙" }] }]);
  });

  it("drops invalid entries but keeps valid ones", () => {
    const edits = parseAlignmentEdits(
      '{"edits":[{"op":"nope","id":1},{"op":"move","id":2,"offset":-1},{"op":"update","id":3}]}',
    );
    expect(edits).toEqual([{ op: "move", id: 2, offset: -1 }]);
  });

  it("throws when nothing valid is found", () => {
    expect(() => parseAlignmentEdits('{"edits":[{"op":"nope"}]}')).toThrow(/格式无效/);
    expect(() => parseAlignmentEdits("not json at all")).toThrow(/格式无效/);
  });
});

describe("applyAlignmentEdits", () => {
  it("updates a line, keeping unspecified fields", () => {
    const result = apply(lines([[1, "a", "甲"], [2, "b", "乙"]]), [
      { op: "update", id: 2, t: "乙新" },
    ]);
    expect(result).toEqual(lines([[1, "a", "甲"], [2, "b", "乙新"]]));
  });

  it("moves a line by swapping with its neighbor", () => {
    const result = apply(lines([[1, "a", "甲"], [2, "b", "乙"], [3, "c", "丙"]]), [
      { op: "move", id: 2, offset: 1 },
    ]);
    expect(result).toEqual(lines([[1, "a", "甲"], [3, "c", "丙"], [2, "b", "乙"]]));
  });

  it("ignores out-of-range moves", () => {
    const result = apply(lines([[1, "a", "甲"]]), [{ op: "move", id: 1, offset: -1 }]);
    expect(result).toEqual(lines([[1, "a", "甲"]]));
  });

  it("inserts a new line with a fresh id after the target", () => {
    const result = apply(lines([[1, "a", "甲"], [3, "c", "丙"]]), [
      { op: "insert", after: 1, o: "b", t: "乙" },
    ]);
    expect(result).toEqual(lines([[1, "a", "甲"], [4, "b", "乙"], [3, "c", "丙"]]));
  });

  it("replaces a range while conserving both language contents", () => {
    const source = lines([[1, "a", "甲"], [2, "b", "乙"], [3, "c", "丙"]]);
    const replaced = apply(source, [
      { op: "replace", start: 1, end: 2, items: [{ o: "ab", t: "甲乙" }] },
    ]);
    expect(replaced).toEqual(lines([[4, "ab", "甲乙"], [3, "c", "丙"]]));
  });

  it("rejects a replacement that drops unmatched original or translation text", () => {
    const source = lines([[1, "first", "第一句"], [2, "second", "第二句"]]);
    const report = applyAlignmentEdits(source, [{
      op: "replace",
      start: 1,
      end: 2,
      items: [{ o: "first", t: "第一句" }],
    }]);

    expect(report.lines).toEqual(source);
    expect(report.applied).toBe(0);
    expect(report.invalid[0]?.reason).toContain("不能丢失");
  });

  it("rejects an empty replacement instead of deleting non-empty lines", () => {
    const source = lines([[1, "first", "第一句"]]);
    const report = applyAlignmentEdits(source, [{ op: "replace", start: 1, end: 1, items: [] }]);

    expect(report.lines).toEqual(source);
    expect(report.invalid[0]?.reason).toContain("不能丢失");
  });

  it("rejects an update that clears a non-empty language side", () => {
    const source = lines([[1, "first", "第一句"]]);
    const report = applyAlignmentEdits(source, [{ op: "update", id: 1, t: "" }]);

    expect(report.lines).toEqual(source);
    expect(report.applied).toBe(0);
    expect(report.invalid[0]?.reason).toContain("不能清空");
  });

  it("allows unmatched content to remain as a one-sided line", () => {
    const source = lines([[1, "first", "第一句"], [2, "second", "第二句"]]);
    const report = applyAlignmentEdits(source, [{
      op: "replace",
      start: 1,
      end: 2,
      items: [
        { o: "first", t: "第一句" },
        { o: "second", t: "" },
        { o: "", t: "第二句" },
      ],
    }]);

    expect(report.invalid).toEqual([]);
    expect(report.lines.map(({ o, t }) => ({ o, t }))).toEqual([
      { o: "first", t: "第一句" },
      { o: "second", t: "" },
      { o: "", t: "第二句" },
    ]);
  });

  it("rejects an insert that duplicates existing sentence content", () => {
    const source = lines([[1, "first", "第一句"], [2, "second", "第二句"]]);
    const report = applyAlignmentEdits(source, [{
      op: "insert",
      after: 1,
      o: "second",
      t: "第二句",
    }]);

    expect(report.lines).toEqual(source);
    expect(report.applied).toBe(0);
    expect(report.invalid[0]?.reason).toMatch(/不能丢失|重复/);
  });

  it("rejects an update that duplicates another line", () => {
    const source = lines([[1, "first", "第一句"], [2, "second", "第二句"]]);
    const report = applyAlignmentEdits(source, [{ op: "update", id: 2, o: "first", t: "第一句" }]);

    expect(report.lines).toEqual(source);
    expect(report.applied).toBe(0);
    expect(report.invalid[0]?.reason).toContain("重复");
  });

  it("rejects a replacement that duplicates content outside its range", () => {
    const source = lines([[1, "first", "第一句"], [2, "second", "第二句"], [3, "third", "第三句"]]);
    const report = applyAlignmentEdits(source, [{
      op: "replace",
      start: 1,
      end: 1,
      items: [{ o: "second", t: "第二句" }],
    }]);

    expect(report.lines).toEqual(source);
    expect(report.applied).toBe(0);
    expect(report.invalid[0]?.reason).toMatch(/不能丢失|重复/);
  });

  it("allows splitting a repeated tail while rejecting a newly duplicated tail", () => {
    const source = lines([
      [1, "The connection is a bit laggy today. We still need more details though.", "今天网络有点卡。"],
      [2, "We still need more details though.", "不过还需要更多细节。"],
    ]);
    const split = applyAlignmentEdits(source, [{
      op: "update",
      id: 1,
      o: "The connection is a bit laggy today.",
    }]);
    expect(split.invalid).toEqual([]);
    expect(split.lines[0].o).toBe("The connection is a bit laggy today.");

    const duplicate = applyAlignmentEdits(source, [{
      op: "insert",
      after: 1,
      o: "We still need more details though.",
      t: "不过还需要更多细节。",
    }]);
    expect(duplicate.lines).toEqual(source);
    expect(duplicate.invalid[0]?.reason).toContain("重复");
  });

  it("applies edits in order", () => {
    const result = apply(lines([[1, "a", "甲"], [2, "b", "乙"], [3, "c", "丙"]]), [
      { op: "move", id: 3, offset: -1 },
      { op: "update", id: 2, t: "乙改" },
    ]);
    expect(result).toEqual(lines([[1, "a", "甲"], [3, "c", "丙"], [2, "b", "乙改"]]));
  });

  it("reports invalid edits with reasons instead of silently skipping", () => {
    const report = applyAlignmentEdits(lines([[1, "a", "甲"], [3, "c", "丙"]]), [
      { op: "update", id: 99, t: "幽灵" },
      { op: "move", id: 1, offset: 5 },
      { op: "insert", after: 42, o: "x", t: "y" },
      { op: "replace", start: 3, end: 2, items: [] },
      { op: "replace", start: 3, end: 1, items: [{ o: "x", t: "y" }] },
    ]);
    expect(report.lines).toEqual(lines([[1, "a", "甲"], [3, "c", "丙"]]));
    expect(report.invalid.map((item) => item.reason)).toEqual([
      "id 99 不存在",
      "偏移 5 越界（id 1 当前在第 1 位，共 2 行）",
      "锚点 id 42 不存在",
      "结束 id 2 不存在",
      "结束 id 1 在起始 id 3 之前",
    ]);
    expect(report.invalid.map((item) => item.edit.op)).toEqual(["update", "move", "insert", "replace", "replace"]);
  });

  it("reports same-content updates as invalid and unchanged", () => {
    const report = applyAlignmentEdits(lines([[1, "a", "甲"]]), [
      { op: "update", id: 1, o: "a", t: "甲" },
    ]);

    expect(report.applied).toBe(0);
    expect(report.changed).toBe(false);
    expect(report.invalid[0]?.reason).toContain("当前内容相同");
  });

  it("does not treat a move cycle as a visible change", () => {
    const report = applyAlignmentEdits(lines([[1, "a", "甲"], [2, "b", "乙"]]), [
      { op: "move", id: 1, offset: 1 },
      { op: "move", id: 1, offset: -1 },
    ]);

    expect(report.applied).toBe(2);
    expect(report.changed).toBe(false);
  });

  it("parses a remap op with pairs", () => {
    const edits = parseAlignmentEdits(
      '{"edits":[{"op":"remap","pairs":[{"o":1,"t":2},{"o":2,"t":0}]}]}',
    );
    expect(edits).toEqual([{ op: "remap", pairs: [{ o: 1, t: 2 }, { o: 2, t: null }] }]);
  });

  it("remaps the translation column to fix a delayed translation", () => {
    const source = lines([
      [1, "Hello everyone.", "我们开始吧。"],
      [2, "Let us start.", "大家好。"],
    ]);
    const result = apply(source, [
      { op: "remap", pairs: [{ o: 1, t: 2 }, { o: 2, t: 1 }] },
    ]);
    expect(result).toEqual(lines([
      [1, "Hello everyone.", "大家好。"],
      [2, "Let us start.", "我们开始吧。"],
    ]));
  });

  it("remap keeps ids with their original lines", () => {
    const source = lines([[7, "a", "甲"], [8, "b", "乙"], [9, "c", "丙"]]);
    const result = apply(source, [
      { op: "remap", pairs: [{ o: 7, t: 9 }, { o: 8, t: 7 }, { o: 9, t: 8 }] },
    ]);
    expect(result).toEqual(lines([[7, "a", "丙"], [8, "b", "甲"], [9, "c", "乙"]]));
  });

  it("remap allows a line without a translation", () => {
    const source = lines([[1, "a", "丙"], [2, "b", "甲"], [3, "c", "乙"], [4, "d", ""]]);
    const result = apply(source, [
      { op: "remap", pairs: [{ o: 1, t: 2 }, { o: 2, t: 3 }, { o: 3, t: 1 }, { o: 4, t: null }] },
    ]);
    expect(result).toEqual(lines([[1, "a", "甲"], [2, "b", "乙"], [3, "c", "丙"], [4, "d", ""]]));
  });

  it("remap absorbs a one-sided line's translation", () => {
    const source = lines([[1, "a", "甲"], [2, "b", ""], [3, "", "乙"]]);
    const result = apply(source, [
      { op: "remap", pairs: [{ o: 2, t: 3 }] },
    ]);
    expect(result).toEqual(lines([[1, "a", "甲"], [2, "b", "乙"], [3, "", ""]]));
  });

  it("remap rejects clearing a non-empty translation explicitly", () => {
    const source = lines([[1, "a", "甲"], [2, "b", "乙"]]);
    const report = applyAlignmentEdits(source, [
      { op: "remap", pairs: [{ o: 1, t: 1 }, { o: 2, t: null }] },
    ]);
    expect(report.lines).toEqual(source);
    expect(report.applied).toBe(0);
    expect(report.invalid[0]?.reason).toContain("不能置空");
  });

  it("remap rejects moving a translation from an empty line", () => {
    const source = lines([[1, "a", "甲"], [2, "b", ""]]);
    const report = applyAlignmentEdits(source, [
      { op: "remap", pairs: [{ o: 1, t: 2 }] },
    ]);
    expect(report.lines).toEqual(source);
    expect(report.applied).toBe(0);
    expect(report.invalid[0]?.reason).toContain("没有可移动");
  });

  it("remap rejects reusing a translation twice", () => {
    const source = lines([[1, "a", "甲"], [2, "b", "乙"]]);
    const report = applyAlignmentEdits(source, [
      { op: "remap", pairs: [{ o: 1, t: 2 }, { o: 2, t: 2 }] },
    ]);
    expect(report.lines).toEqual(source);
    expect(report.applied).toBe(0);
    expect(report.invalid[0]?.reason).toContain("重复使用");
  });

  it("remap rejects unknown ids", () => {
    const source = lines([[1, "a", "甲"], [2, "b", "乙"]]);
    const report = applyAlignmentEdits(source, [
      { op: "remap", pairs: [{ o: 1, t: 99 }, { o: 2, t: 1 }] },
    ]);
    expect(report.invalid[0]?.reason).toContain("不存在");
  });

  it("remap supports partial coverage: untouched lines stay as-is", () => {
    const source = lines([
      [1, "a", "甲"],
      [2, "b", "乙"],
      [3, "c", "丙"],
    ]);
    const result = apply(source, [{ op: "remap", pairs: [{ o: 1, t: 3 }] }]);
    expect(result).toEqual(lines([[1, "a", "丙"], [2, "b", "乙"], [3, "c", ""]]));
  });

  it("remap chains translation moves without losing content", () => {
    const source = lines([
      [1, "a", "甲"],
      [2, "b", "乙"],
      [3, "c", "丙"],
    ]);
    const result = apply(source, [
      { op: "remap", pairs: [{ o: 1, t: 2 }, { o: 2, t: 3 }] },
    ]);
    expect(result).toEqual(lines([[1, "a", "乙"], [2, "b", "丙"], [3, "c", ""]]));
  });

  it("remap with identical mapping is not a visible change", () => {
    const report = applyAlignmentEdits(lines([[1, "a", "甲"], [2, "b", "乙"]]), [
      { op: "remap", pairs: [{ o: 1, t: 1 }, { o: 2, t: 2 }] },
    ]);
    expect(report.applied).toBe(1);
    expect(report.changed).toBe(false);
  });

  it("realigns sentences across rows without losing or duplicating content", () => {
    const source = lines([
      [1, "A.", "甲。"],
      [2, "B. C.", "丙。"],
      [3, "D.", "乙。丁。"],
    ]);
    const edits = parseAlignmentEdits(JSON.stringify({
      pairs: [
        { o: "O1-1", t: "T1-1" },
        { o: "O2-1", t: "T3-1" },
        { o: "O2-2", t: "T2-1" },
        { o: "O3-1", t: "T3-2" },
      ],
    }));
    const report = applyAlignmentEdits(source, edits);

    expect(report.invalid).toEqual([]);
    expect(report.lines.map(({ o, t }) => ({ o, t }))).toEqual([
      { o: "A.", t: "甲。" },
      { o: "B.", t: "乙。" },
      { o: "C.", t: "丙。" },
      { o: "D.", t: "丁。" },
    ]);
    expect(report.lines.map(({ id }) => id)).toEqual([1, 2, 4, 3]);
  });

  it("keeps an unmatched sentence at its source position", () => {
    const source = lines([
      [1, "A.", "甲。"],
      [2, "B.", ""],
      [3, "C.", "乙。"],
    ]);
    const edits = parseAlignmentEdits(JSON.stringify({
      pairs: [
        { o: "O1-1", t: "T1-1" },
        { o: "O3-1", t: "T3-1" },
        { o: "O2-1", t: null },
      ],
    }));
    const report = applyAlignmentEdits(source, edits);

    expect(report.lines.map(({ o, t }) => ({ o, t }))).toEqual([
      { o: "A.", t: "甲。" },
      { o: "B.", t: "" },
      { o: "C.", t: "乙。" },
    ]);
  });
});
