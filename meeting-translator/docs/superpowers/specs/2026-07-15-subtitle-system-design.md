# 字幕系统设计文档

**日期：** 2026-07-15
**状态：** 草稿
**范围：** meeting-translator 悬浮字幕窗口

---

## 1. 问题陈述

当前字幕系统在双语模式（`bilingual=true, historyRows=0`）下，翻译行和原文行的水平滚动位置不一致，导致内容视觉上被"推"到右侧。

**根因：** `updateLineOverflow()` 中，两行独立计算滚动偏移 `rawTarget`，使用相同的 `SCROLL_ANCHOR_RATIO = 0.68`，但两行的 `text.scrollWidth` 差异大（字体大小不同），导致偏移量不同。

---

## 2. 设计约束

以下方面**保持不变**：

| 方面 | 当前行为 | 理由 |
|---|---|---|
| 显示模式 | `bilingual × historyRows` 组合出 5 种模式 | 已覆盖所有使用场景 |
| 句子检测逻辑 | 终止符切句、逗号阈值、短尾合并、自适应超时 | 当前逻辑已成熟 |
| 双语到达时序 | 原文和翻译独立到达，各自渲染 | 符合实时翻译的实际流程 |
| 字号体系 | 单语58px、双语翻译44px/原文24px、历史25px/21px | 当前视觉效果良好 |
| 设置 UI | "中英对照"开关 + "历史行数"子菜单 | 用户已熟悉 |
| 断行策略 | 当前行nowrap+滚动，历史行截断 | 字幕标准行为 |

---

## 3. 模式定义

| 模式 | bilingual | historyRows | 行数 | 内容 |
|---|---|---|---|---|
| `single` | off | 0 | 1 | 当前翻译 |
| `single-bilingual` | on | 0 | 2 | 当前翻译 + 当前原文 |
| `history` | off | 1 | 2 | 历史翻译 + 当前翻译 |
| `history-bilingual` | on | 1 | 3 | 历史翻译 + 当前翻译 + 当前原文 |
| `history2` | off | 2 | 3 | 2条历史翻译 + 当前翻译 |

约束：`bilingual=true` 时，`historyRows` 强制 ≤ 1。

---

## 4. 字号体系

| 元素 | single | single-bilingual | history | history-bilingual | history2 |
|---|---|---|---|---|---|
| 当前翻译 | 58px | 44px | 44px | 44px | 44px |
| 当前原文 | — | 24px | — | 24px | — |
| 历史 age-1 | — | — | 25px | 25px | 25px |
| 历史 age-2 | — | — | — | — | 21px |

所有字号乘以 `--scale` 变量（基于窗口高度，范围 0.72–1.85）。

---

## 5. 滚动系统

### 5.1 修复方案

**统一左锚点 + 双语同步滚动。**

修改 `updateLineOverflow()` 函数：

```typescript
function updateLineOverflow(line: HTMLElement, text: HTMLElement) {
  const shouldTrack = line.classList.contains("cur") && text.scrollWidth > 0;
  const hasReadableText = Boolean(text.textContent?.trim());

  // 统一左锚点：从左侧开始，超出时向左滚动
  const rawTarget = shouldTrack
    ? Math.min(0, line.clientWidth - text.scrollWidth)
    : 0;

  // 双语同步：如果当前行在双语组中，用 max 偏移驱动
  if (shouldTrack && settings.bilingual) {
    const parent = line.closest(".current-group");
    if (parent) {
      const siblings = parent.querySelectorAll(".line.cur");
      let maxTarget = rawTarget;
      siblings.forEach((sibling) => {
        if (sibling === line) return;
        const siblingText = sibling.querySelector<HTMLElement>(".line-text");
        if (!siblingText) return;
        const siblingTarget = Math.min(0, sibling.clientWidth - siblingText.scrollWidth);
        if (siblingTarget < maxTarget) maxTarget = siblingTarget;
      });
      // 用 maxTarget 作为所有行的偏移
      applyScrollState(line, text, maxTarget, hasReadableText);
      return;
    }
  }

  applyScrollState(line, text, rawTarget, hasReadableText);
}
```

### 5.2 滚动规则

| 规则 | 说明 |
|---|---|
| 左锚点 | 所有模式从左侧（0%）开始显示 |
| 双语同步 | 双语模式中，翻译行和原文行共享同一个滚动偏移 |
| 只滚动当前行 | 历史行不滚动，截断显示 |
| 滚动动画 | 保持当前的物理弹簧动画（hold 530ms + 平滑追踪） |
| 遮罩 | `.rolling` 时左侧渐变遮罩保持不变 |

---

## 6. 切行逻辑

### 6.1 当前行更新

| 场景 | 行为 |
|---|---|
| 文本延续（正在输入） | 平滑更新，滚动追踪 |
| 文本不延续（新句子） | 重置滚动 + `currentFadeIn` 动画 (320ms) |

### 6.2 句子完成 → 历史

1. `captureCurrentLineOffsets()` 保存当前行的滚动偏移
2. `commitCurrentSentenceNow()` 将当前行移入历史
3. 历史行通过 `staticOffset` 保持滚动位置连续性
4. 新当前行出现

### 6.3 历史行动画

| 动画 | 时长 | 效果 |
|---|---|---|
| 进入 `shrinkUp` | 360ms | 从下方升起，带缩放 |
| 退出 `fadeHistoryOut` | 340ms | 向上淡出+缩放 |
| 当前行进入 `currentFadeIn` | 320ms | 淡入 |

### 6.4 双语到达时序

原文和翻译独立到达，各自渲染：
- 原文先到 → 原文行单独出现
- 翻译到达 → 翻译行出现，原文行变为第二行
- 两行独立动画，不强制同步

---

## 7. 布局结构

```
.lyrics (flex column, left-aligned)
├── .history-group (flex column)
│   ├── .line.trans.age-2  (history2 only)
│   └── .line.trans.age-1
├── .current-group (flex column)
│   ├── .line.trans.cur  (当前翻译)
│   └── .line.orig.cur   (当前原文, bilingual only)
└── .empty-group (等待音频占位)
```

---

## 8. 设置系统

### 8.1 设置项

```typescript
type SubtitleSettings = {
  alwaysOnTop: boolean;       // 总在最前
  bilingual: boolean;         // 双语模式
  historyRows: 0 | 1 | 2;    // 历史行数
  palette: Palette;           // 配色方案
  customColor: string;        // 自定义颜色
  align: Align;               // 对齐方式（强制 left）
  bgStyle: BgStyle;           // 背景风格
  bgOpacity: number;          // 背景透明度
};
```

### 8.2 设置 UI

保持现有结构：
- "总在最前" 开关
- "中英对照" 开关
- "历史行数" 子菜单（0/1/2 行）
- "更换配色" 子菜单（6 种配色）
- "字幕背景风格" 子菜单（无/玻璃/黑色/白色 + 透明度滑块）

---

## 9. 修改文件清单

| 文件 | 修改内容 |
|---|---|
| `src/subtitles.ts` | 修改 `updateLineOverflow()` 实现统一左锚点 + 双语同步滚动 |
| `src/subtitles.css` | 无需修改（字号、布局保持不变） |
| `src/subtitle-settings-shared.ts` | 无需修改 |
| `subtitle-settings.html` | 无需修改 |

---

## 10. 验证标准

1. **single 模式：** 1行显示，文本左对齐，超出时向左滚动
2. **single-bilingual 模式：** 2行显示，翻译行和原文行同步滚动，无右推问题
3. **history 模式：** 2行显示，历史行截断，当前行滚动
4. **history-bilingual 模式：** 3行显示，历史行截断，当前双语行同步滚动
5. **history2 模式：** 3行显示，历史行截断，当前行滚动
6. **切换模式：** 设置变更后平滑过渡，无跳动
7. **窗口缩放：** 字号和间距按 `--scale` 正确缩放
