import { createElement, Fragment } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { CheckLadder, GenerationBinding, PaymentLifecycle, SystemOverview } from "../src/components/diagrams/index.ts";

const svgFigures = { SystemOverview, PaymentLifecycle, GenerationBinding };

describe("docs diagrams", () => {
  for (const [name, Figure] of Object.entries(svgFigures)) {
    it(`${name} is labelled for screen readers`, () => {
      const html = renderToStaticMarkup(createElement(Figure));
      const svgs = html.match(/<svg[^>]*>/g) ?? [];
      expect(svgs.length).toBeGreaterThan(0);
      for (const svg of svgs) expect(svg).toMatch(/role="img"/);
      expect((html.match(/<title /g) ?? []).length).toBe(svgs.length);
      expect((html.match(/<desc /g) ?? []).length).toBe(svgs.length);
      // Every aria-labelledby id points at an element on the page.
      for (const [, ids] of html.matchAll(/aria-labelledby="([^"]+)"/g)) {
        for (const id of ids!.split(" ")) expect(html).toContain(`id="${id}"`);
      }
    });
  }

  it("marker ids stay unique when figures share a page", () => {
    const html = renderToStaticMarkup(createElement(Fragment, null, createElement(SystemOverview), createElement(SystemOverview), createElement(GenerationBinding)));
    const ids = [...html.matchAll(/<marker[^>]* id="([^"]+)"/g)].map((m) => m[1]);
    expect(ids.length).toBeGreaterThan(0);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("the check ladder lists both contracts' checks", () => {
    const html = renderToStaticMarkup(createElement(CheckLadder));
    expect(html).toContain("In the registry");
    expect(html).toContain("In your account");
    expect(html).toContain("PAYER_NOT_AUTHORIZED");
  });
});
