// Minimal, safe Markdown renderer: HTML is escaped first, then only
// whitelisted tags are emitted, so model output can never inject markup.

const ESCAPE_MAP: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

function escapeHtml(text: string) {
  return text.replace(/[&<>"']/g, (char) => ESCAPE_MAP[char]);
}

const CODE_RE = /`([^`]+)`/g;
const BOLD_RE = /\*\*([^*]+)\*\*/g;
const ITALIC_RE = /\*([^*]+)\*/g;
const LINK_RE = /\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/gi;

// 行内语法：先转义，再依次解析行内代码、链接、粗体、斜体。
function inline(text: string) {
  const escaped = escapeHtml(text);
  const withCode = escaped.replace(CODE_RE, (_, code: string) => `<code>${code}</code>`);
  const withLinks = withCode.replace(LINK_RE, (_, label: string, url: string) =>
    `<a href="${url}" target="_blank" rel="noopener noreferrer">${label}</a>`);
  return withLinks.replace(BOLD_RE, "<strong>$1</strong>").replace(ITALIC_RE, "<em>$1</em>");
}

const FENCE_RE = /^```(\w*)/;
const HEADING_RE = /^(#{1,3})\s+(.*)$/;
const BULLET_RE = /^[-*]\s+(.*)$/;
const ORDERED_RE = /^\d+\.\s+(.*)$/;
const QUOTE_RE = /^>\s?(.*)$/;

export function renderMarkdown(text: string) {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const out: string[] = [];
  let paragraph: string[] = [];
  const flushParagraph = () => {
    if (paragraph.length) {
      out.push(`<p>${paragraph.map(inline).join("<br>")}</p>`);
      paragraph = [];
    }
  };

  let index = 0;
  while (index < lines.length) {
    const line = lines[index];
    const trimmed = line.trim();

    const fence = FENCE_RE.exec(trimmed);
    if (fence) {
      flushParagraph();
      const language = fence[1];
      const code: string[] = [];
      index++;
      while (index < lines.length && !/^\s*```/.test(lines[index])) {
        code.push(lines[index]);
        index++;
      }
      index++;
      const langAttr = language ? ` class="language-${escapeHtml(language)}"` : "";
      out.push(`<pre><code${langAttr}>${escapeHtml(code.join("\n"))}</code></pre>`);
      continue;
    }

    const heading = HEADING_RE.exec(trimmed);
    if (heading) {
      flushParagraph();
      const level = heading[1].length;
      out.push(`<h${level}>${inline(heading[2])}</h${level}>`);
      index++;
      continue;
    }

    const bullet = BULLET_RE.exec(trimmed);
    if (bullet) {
      flushParagraph();
      const items = [bullet[1]];
      index++;
      while (index < lines.length) {
        const next = BULLET_RE.exec(lines[index].trim());
        if (!next) break;
        items.push(next[1]);
        index++;
      }
      out.push(`<ul>${items.map((item) => `<li>${inline(item)}</li>`).join("")}</ul>`);
      continue;
    }

    const ordered = ORDERED_RE.exec(trimmed);
    if (ordered) {
      flushParagraph();
      const items = [ordered[1]];
      index++;
      while (index < lines.length) {
        const next = ORDERED_RE.exec(lines[index].trim());
        if (!next) break;
        items.push(next[1]);
        index++;
      }
      out.push(`<ol>${items.map((item) => `<li>${inline(item)}</li>`).join("")}</ol>`);
      continue;
    }

    const quote = QUOTE_RE.exec(trimmed);
    if (quote) {
      flushParagraph();
      const quotes = [quote[1]];
      index++;
      while (index < lines.length) {
        const next = QUOTE_RE.exec(lines[index].trim());
        if (!next) break;
        quotes.push(next[1]);
        index++;
      }
      out.push(`<blockquote>${quotes.map(inline).join("<br>")}</blockquote>`);
      continue;
    }

    if (!trimmed) {
      flushParagraph();
      index++;
      continue;
    }

    paragraph.push(line);
    index++;
  }
  flushParagraph();
  return out.join("");
}
