import { clampScore, parseScore, gradeSystemPrompt } from "./grade";

describe("clampScore", () => {
  it("clamps values above 1 down to 1", () => {
    expect(clampScore(1.5)).toBe(1);
    expect(clampScore(100)).toBe(1);
  });

  it("clamps negative values up to 0", () => {
    expect(clampScore(-0.3)).toBe(0);
    expect(clampScore(-100)).toBe(0);
  });

  it("passes through values already in [0, 1]", () => {
    expect(clampScore(0.7)).toBe(0.7);
    expect(clampScore(0.42)).toBe(0.42);
  });

  it("keeps exact boundaries", () => {
    expect(clampScore(0)).toBe(0);
    expect(clampScore(1)).toBe(1);
  });

  it("returns 0 for non-finite values (NaN, Infinity, -Infinity)", () => {
    expect(clampScore(NaN)).toBe(0);
    expect(clampScore(Infinity)).toBe(0);
    expect(clampScore(-Infinity)).toBe(0);
  });
});

describe("parseScore", () => {
  it("extracts and clamps a numeric score field", () => {
    expect(parseScore({ score: 0.8 })).toBe(0.8);
    expect(parseScore({ score: 2 })).toBe(1);
    expect(parseScore({ score: -1 })).toBe(0);
  });

  it("parses a numeric string score", () => {
    expect(parseScore({ score: "0.6" })).toBe(0.6);
    expect(parseScore({ score: "1.9" })).toBe(1);
  });

  it("defaults to 0 for missing, null, or malformed score", () => {
    expect(parseScore({})).toBe(0);
    expect(parseScore(null)).toBe(0);
    expect(parseScore(undefined)).toBe(0);
    expect(parseScore({ score: "not a number" })).toBe(0);
    expect(parseScore({ score: null })).toBe(0);
    expect(parseScore({ score: {} })).toBe(0);
  });
});

describe("gradeSystemPrompt", () => {
  it("instructs the model to output the {\"score\": X} contract", () => {
    const prompt = gradeSystemPrompt();
    expect(prompt).toContain('"score"');
    expect(prompt.toLowerCase()).toContain("grading");
  });
});
