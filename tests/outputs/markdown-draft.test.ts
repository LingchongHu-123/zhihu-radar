// Tests for the markdown-draft renderer. Pure function under test, so
// every case is constructed inline. No network, no clock reads, no fs
// writes outside tests/.
//
// Snapshot strategy mirrors markdown-report's: we commit a real
// `.expected.md` file alongside the test and check plain string
// equality. The committed file IS the snapshot.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { renderDraft } from "../../src/outputs/markdown-draft.js";
import type { GeneratedDraft } from "../../src/types/draft.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const EXPECTED_MD_PATH = resolve(
  HERE,
  "..",
  "fixtures",
  "drafts",
  "sample-draft.expected.md",
);

const sampleDraft: GeneratedDraft = {
  questionId: "q-1001",
  questionTitle: "去英国留学，怎么挑选靠谱的中介？",
  title: "选中介前先想清楚这几件事",
  body: [
    "申请这件事最容易踩的坑，是把选中介当成挑商品。",
    "",
    "我去年陪着几个朋友走了一轮，最后发现真正决定结果的不是中介机构的名气，而是直接对接你的那位顾问的经验和时间投入。",
    "",
    "几个判断标准供参考：一看顾问最近一年带过的相似背景案例；二看合同里关于服务节点的细则；三找到至少一位过往学生交叉验证。这些都需要时间，但比看广告靠谱得多。",
  ].join("\n"),
  ctaLine: "如果你想就具体院校组合或顾问选择聊一下，可以私信我说一下你的背景。",
  modelId: "claude-opus-4-6",
  generatedAt: "2026-04-25T09:00:00.000Z",
};

describe("renderDraft — snapshot against committed .md file", () => {
  it("matches the bytes in sample-draft.expected.md", () => {
    const rendered = renderDraft(sampleDraft);

    if (!existsSync(EXPECTED_MD_PATH)) {
      mkdirSync(dirname(EXPECTED_MD_PATH), { recursive: true });
      writeFileSync(EXPECTED_MD_PATH, rendered, "utf8");
      throw new Error(
        `sample-draft.expected.md did not exist; wrote it from current ` +
          `renderer output to ${EXPECTED_MD_PATH}. Inspect it, commit it, ` +
          `and re-run.`,
      );
    }

    const expected = readFileSync(EXPECTED_MD_PATH, "utf8");
    expect(rendered === expected).toBe(true);
  });
});

describe("renderDraft — determinism", () => {
  it("produces byte-identical output on repeated calls", () => {
    expect(renderDraft(sampleDraft)).toBe(renderDraft(sampleDraft));
  });
});

describe("renderDraft — structural invariants", () => {
  it("ends with exactly one trailing newline", () => {
    const out = renderDraft(sampleDraft);
    expect(out.endsWith("\n")).toBe(true);
    expect(out.endsWith("\n\n")).toBe(false);
  });

  it("includes the title as a top-level heading", () => {
    const out = renderDraft(sampleDraft);
    expect(out.startsWith(`# ${sampleDraft.title}`)).toBe(true);
  });

  it("renders the CTA in its own block under a horizontal rule", () => {
    const out = renderDraft(sampleDraft);
    expect(out).toContain("---");
    expect(out).toContain(sampleDraft.ctaLine);
    // The CTA must come after the rule, not before.
    expect(out.indexOf("---")).toBeLessThan(out.indexOf(sampleDraft.ctaLine));
  });

  it("includes question id and model id in the metadata block", () => {
    const out = renderDraft(sampleDraft);
    expect(out).toContain(sampleDraft.questionId);
    expect(out).toContain(sampleDraft.modelId);
  });
});
