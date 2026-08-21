import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { DataTable, MobileDataRow } from "@/components/ui/data-table";
import { InlineNotice, Metric, Panel } from "@/components/ui/panel";
import { Timeline } from "@/components/ui/timeline";
import { CaseSkeleton, ErrorState } from "@/components/skeletons";

const globalStyles = readFileSync(
  resolve(import.meta.dirname, "../../src/app/globals.css"),
  "utf8",
);

describe("shared operational primitives", () => {
  it("renders status with text and exposes labeled mobile data", () => {
    render(
      <>
        <Badge tone="success">APPROVED</Badge>
        <MobileDataRow label="Case ID" value="sha256:abc" />
        <Timeline
          label="Transaction progress"
          current="ACCEPTED"
          items={["SUBMITTED", "ACCEPTED", "FINALIZED", "READBACK_CONFIRMED"]}
        />
      </>,
    );

    expect(screen.getByText("APPROVED")).toHaveAttribute(
      "data-tone",
      "success",
    );
    expect(screen.getByText("Case ID")).toBeVisible();
    expect(screen.getByText("ACCEPTED")).toHaveAttribute(
      "aria-current",
      "step",
    );
  });

  it("uses links for navigation and buttons for actions", async () => {
    const user = userEvent.setup();
    let actionCount = 0;

    render(
      <>
        <Button href="/cases/new">Create case</Button>
        <Button onClick={() => actionCount++}>Refresh readback</Button>
      </>,
    );

    expect(screen.getByRole("link", { name: "Create case" })).toHaveAttribute(
      "href",
      "/cases/new",
    );
    await user.click(screen.getByRole("button", { name: "Refresh readback" }));
    expect(actionCount).toBe(1);
  });

  it("uses semantic wrappers for metrics, notices, and tabular readbacks", () => {
    render(
      <>
        <Panel title="Case summary">
          <Metric label="Escrow" value="2 GEN" />
        </Panel>
        <InlineNotice tone="warning">Awaiting finality</InlineNotice>
        <DataTable
          columns={[
            { key: "id", label: "Case ID" },
            { key: "state", label: "State" },
          ]}
          rows={[{ id: "sha256:abc", state: "ACCEPTED" }]}
        />
      </>,
    );

    expect(screen.getByRole("region", { name: "Case summary" })).toHaveTextContent(
      "Escrow2 GEN",
    );
    expect(screen.getByRole("note")).toHaveTextContent("Awaiting finality");
    expect(screen.getByRole("columnheader", { name: "Case ID" })).toHaveAttribute(
      "scope",
      "col",
    );
    expect(screen.getByRole("table")).toHaveTextContent("sha256:abc");
  });

  it("keeps loading and error states named for assistive technology", () => {
    render(
      <>
        <CaseSkeleton />
        <ErrorState message="Readback request timed out" />
      </>,
    );

    expect(
      screen.getByRole("status", { name: "Loading case" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Readback request timed out",
    );
  });

  it("applies the system UI font and an opaque focus indicator globally", () => {
    const style = document.createElement("style");
    style.textContent = globalStyles;
    document.head.append(style);

    try {
      const focusRule = Array.from(style.sheet?.cssRules ?? []).find(
        (rule): rule is CSSStyleRule =>
          rule instanceof CSSStyleRule && rule.selectorText === ":focus-visible",
      );

      expect(getComputedStyle(document.body).fontFamily).toContain(
        "ui-sans-serif",
      );
      expect(getComputedStyle(document.body).fontFamily).not.toContain("Inter");
      expect(focusRule?.style.outline).toBe("3px solid rgb(81, 71, 229)");
    } finally {
      style.remove();
    }
  });
});
