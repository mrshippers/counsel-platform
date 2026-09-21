import { describe, it, expect } from "vitest";
import html from "../public/index.html?raw";

// Regression: at 375px the 1fr grid track and its items grew to max-content and pushed the
// page wider than the viewport. The mobile block must keep the track and items shrinkable.
const mobile = html.slice(html.indexOf("@media (max-width: 768px)"));

describe("375px layout guards", () => {
  it("app grid track is minmax(0,1fr)", () => {
    expect(mobile).toMatch(/#app\.active\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)/);
  });
  it("grid items can shrink (min-width:0)", () => {
    expect(mobile).toMatch(/\.main-content[^{]*\{\s*min-width:\s*0/);
  });
  it("wide tables scroll inside themselves", () => {
    expect(mobile).toMatch(/\.data-table\s*\{[^}]*overflow-x:\s*auto/);
  });
  it("calendar 7-col grid cannot widen", () => {
    expect(mobile).toContain("repeat(7, minmax(0, 1fr))");
  });
});
