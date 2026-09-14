import { describe, expect, it } from "vitest";
import { renderMarkdown } from "./markdown";

describe("renderMarkdown", () => {
  it("renders headings, paragraphs and single-line breaks", () => {
    expect(renderMarkdown("# Title\n\nFirst line\nSecond line")).toBe(
      "<h1>Title</h1><p>First line<br>Second line</p>",
    );
  });

  it("renders bold, italic and inline code", () => {
    expect(renderMarkdown("**bold** and *italic* and `code`")).toBe(
      "<p><strong>bold</strong> and <em>italic</em> and <code>code</code></p>",
    );
  });

  it("renders fenced code blocks without parsing inline markup", () => {
    expect(renderMarkdown("```ts\nconst x = **not bold**;\n```")).toBe(
      "<pre><code class=\"language-ts\">const x = **not bold**;</code></pre>",
    );
  });

  it("renders bullet and ordered lists", () => {
    expect(renderMarkdown("- a\n- b\n\n1. one\n2. two")).toBe(
      "<ul><li>a</li><li>b</li></ul><ol><li>one</li><li>two</li></ol>",
    );
  });

  it("renders blockquotes and safe links", () => {
    expect(renderMarkdown("> quoted\n\n[link](https://example.com)")).toBe(
      "<blockquote>quoted</blockquote><p><a href=\"https://example.com\" target=\"_blank\" rel=\"noopener noreferrer\">link</a></p>",
    );
  });

  it("escapes raw HTML and drops unsafe link protocols", () => {
    expect(renderMarkdown("<script>alert(1)</script>")).toBe(
      "<p>&lt;script&gt;alert(1)&lt;/script&gt;</p>",
    );
    expect(renderMarkdown("[x](javascript:alert(1))")).toBe("<p>[x](javascript:alert(1))</p>");
  });

  it("returns empty output for empty input", () => {
    expect(renderMarkdown("")).toBe("");
    expect(renderMarkdown("   \n\n  ")).toBe("");
  });
});
