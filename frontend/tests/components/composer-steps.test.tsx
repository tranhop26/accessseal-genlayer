import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { CaseComposer, type CaseAuthority } from "@/components/case-composer";

const authority: CaseAuthority = {
  buyer: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  chainId: 4221,
  network: "testnet_bradbury",
  contractAddress: "0x814726d7a3a2cbc52c8ea622b49af1d6fda300a7",
};

function fillParties() {
  fireEvent.change(screen.getByLabelText(/vendor wallet/i), {
    target: { value: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" },
  });
}

function fillTerms(origin = "https://product.example") {
  const currentOrigin = screen.getByLabelText(/website origin/i);
  if (currentOrigin && !(currentOrigin as HTMLInputElement).value)
    fireEvent.change(currentOrigin, { target: { value: origin } });
  fireEvent.change(screen.getByLabelText(/accessibility profile hash/i), {
    target: { value: `0x${"c".repeat(64)}` },
  });
  for (const input of screen.getAllByLabelText(/critical flow/i))
    fireEvent.change(input, { target: { value: "Locked accessible flow" } });
  fireEvent.change(screen.getByLabelText(/simulated escrow/i), {
    target: { value: "1000" },
  });
}

async function moveToReview(user: ReturnType<typeof userEvent.setup>) {
  fillParties();
  await user.click(screen.getByRole("button", { name: "Continue to terms" }));
  fillTerms();
  await user.click(screen.getByRole("button", { name: "Review locked terms" }));
  await screen.findByText(/ready for wallet signature/i);
}

describe("case composer steps", () => {
  it("defaults to Standard and binds the selected Live proof deadlines", async () => {
    const user = userEvent.setup();
    const onCreate = vi.fn();
    render(<CaseComposer authority={authority} onCreate={onCreate} />);

    fillParties();
    await user.click(screen.getByRole("button", { name: "Continue to terms" }));
    expect(
      screen.getByRole("radio", { name: /Standard — 24 hours \/ 7 days/i }),
    ).toBeChecked();
    fillTerms();
    await user.click(
      screen.getByRole("radio", {
        name: /Live proof — 4 hours \/ 12 hours/i,
      }),
    );
    expect(
      screen.getByText(/delayed consensus can prevent completion/i),
    ).toBeVisible();
    await user.click(
      screen.getByRole("button", { name: "Review locked terms" }),
    );
    await user.click(
      screen.getByRole("button", { name: "Create case on GenLayer" }),
    );

    expect(onCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        evidenceDeadline: 14_400,
        hardDeadline: 43_200,
        maxUnresolvedRetries: 2,
      }),
    );
  });

  it("invalidates a canonical preview when its deadline preset changes", async () => {
    const user = userEvent.setup();
    render(<CaseComposer authority={authority} onCreate={vi.fn()} />);
    await moveToReview(user);
    expect(screen.getByText("Canonical bindings generated")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Back to terms" }));
    await user.click(
      screen.getByRole("radio", {
        name: /Live proof — 4 hours \/ 12 hours/i,
      }),
    );
    expect(
      screen.queryByText("Canonical bindings generated"),
    ).not.toBeInTheDocument();
    expect(
      screen.getByText("Complete review to generate canonical bindings"),
    ).toBeVisible();
    expect(
      screen.queryByText(/ready for wallet signature/i),
    ).not.toBeInTheDocument();
  });

  it("moves Parties → Terms → Review and only signs a live authority-bound preview", async () => {
    const user = userEvent.setup();
    const onCreate = vi.fn();
    render(<CaseComposer authority={authority} onCreate={onCreate} />);

    expect(screen.getByText("Parties")).toHaveAttribute("aria-current", "step");
    expect(
      screen.queryByText(/ready for wallet signature/i),
    ).not.toBeInTheDocument();

    fillParties();
    await user.click(screen.getByRole("button", { name: "Continue to terms" }));
    expect(screen.getByText("Acceptance terms")).toHaveAttribute(
      "aria-current",
      "step",
    );
    expect(
      screen.queryByText(/ready for wallet signature/i),
    ).not.toBeInTheDocument();

    fillTerms();
    await user.click(
      screen.getByRole("button", { name: "Review locked terms" }),
    );

    expect(screen.getByText("Review and sign")).toHaveAttribute(
      "aria-current",
      "step",
    );
    expect(screen.getByText(authority.contractAddress)).toBeVisible();
    expect(screen.getByText("Bradbury Testnet")).toBeVisible();
    expect(
      screen.getByRole("button", { name: "Create case on GenLayer" }),
    ).toBeEnabled();
    const summary = screen.getByRole("complementary", {
      name: "Case signature scope",
    });
    const signButton = screen.getByRole("button", {
      name: "Create case on GenLayer",
    });
    expect(
      summary.compareDocumentPosition(signButton) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(within(summary).getByText("Buyer")).toBeVisible();
    expect(within(summary).getByText("Vendor")).toBeVisible();
    expect(within(summary).getByText("Amount")).toBeVisible();
    expect(within(summary).getByText("Network")).toBeVisible();
    expect(within(summary).getByText("Chain ID")).toBeVisible();
    expect(within(summary).getByText("Contract")).toBeVisible();
    expect(summary).not.toHaveAttribute("aria-live");
    expect(within(summary).getByRole("status")).toHaveAttribute(
      "aria-live",
      "polite",
    );
    expect(screen.getByText("Advanced contract details")).toBeVisible();
    expect(screen.getByText("Case ID")).toBeInTheDocument();
    expect(screen.getByText("Terms hash")).toBeInTheDocument();
    expect(screen.getByText("Flows hash")).toBeInTheDocument();
    expect(screen.getByText("Profile hash")).toBeInTheDocument();
    const advancedDetails = screen
      .getByText("Advanced contract details")
      .closest("details")!;
    expect(within(advancedDetails).getByText("Chain ID")).toBeInTheDocument();
    expect(
      within(advancedDetails).getByText("24 hours (86400 seconds)"),
    ).toBeInTheDocument();
    expect(
      within(advancedDetails).getByText("7 days (604800 seconds)"),
    ).toBeInTheDocument();
    expect(
      within(advancedDetails).getByText(
        /contract's authoritative createdAt establishes the absolute cutoff timestamps/i,
      ),
    ).toBeInTheDocument();

    await user.click(
      screen.getByRole("button", { name: "Create case on GenLayer" }),
    );
    expect(onCreate).toHaveBeenCalledTimes(1);
    expect(onCreate).toHaveBeenCalledWith(
      expect.objectContaining({ authority, escrowAmount: 1000n }),
    );
  });

  it("preserves controlled party and term values when moving back", async () => {
    const user = userEvent.setup();
    render(<CaseComposer authority={authority} onCreate={vi.fn()} />);

    fillParties();
    await user.click(screen.getByRole("button", { name: "Continue to terms" }));
    fillTerms();
    await user.click(screen.getByRole("button", { name: "Back to parties" }));

    expect(screen.getByLabelText(/vendor wallet/i)).toHaveValue(
      "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    );
    await user.click(screen.getByRole("button", { name: "Continue to terms" }));
    expect(screen.getByLabelText(/website origin/i)).toHaveValue(
      "https://product.example",
    );
    expect(screen.getByLabelText(/accessibility profile hash/i)).toHaveValue(
      `0x${"c".repeat(64)}`,
    );
    expect(screen.getByLabelText(/simulated escrow/i)).toHaveValue("1000");
  });

  it("does not validate or derive bindings from an implicit Parties submit", () => {
    render(<CaseComposer authority={authority} onCreate={vi.fn()} />);
    fillParties();

    fireEvent.submit(
      screen
        .getByRole("region", { name: "Confirm the signing parties" })
        .closest("form")!,
    );

    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.getByText("Parties")).toHaveAttribute("aria-current", "step");
    expect(
      screen.queryByText(/ready for wallet signature/i),
    ).not.toBeInTheDocument();
  });

  it.each([
    ["origin", /website origin/i, "http://product.example"],
    ["profile", /accessibility profile hash/i, ""],
    ["critical flow", /critical flow 1/i, ""],
    ["escrow", /simulated escrow/i, ""],
  ])(
    "keeps an invalid %s on Terms and focuses the described field",
    async (_, fieldName, invalidValue) => {
      const user = userEvent.setup();
      render(<CaseComposer authority={authority} onCreate={vi.fn()} />);
      fillParties();
      await user.click(
        screen.getByRole("button", { name: "Continue to terms" }),
      );
      fillTerms();
      const field = screen.getByLabelText(fieldName);
      await user.clear(field);
      if (invalidValue) await user.type(field, invalidValue);

      await user.click(
        screen.getByRole("button", { name: "Review locked terms" }),
      );

      expect(screen.getByText("Acceptance terms")).toHaveAttribute(
        "aria-current",
        "step",
      );
      expect(field).toHaveAttribute("aria-invalid", "true");
      expect(field).toHaveAttribute("aria-describedby", "form-error");
      await waitFor(() => expect(field).toHaveFocus());
    },
  );

  it.each([
    ["buyer wallet", { buyer: "0xcccccccccccccccccccccccccccccccccccccccc" }],
    ["chain", { chainId: 61999 }],
    ["network", { network: "studionet" as const }],
    [
      "contract",
      { contractAddress: "0x1234567890abcdef1234567890abcdef12345678" },
    ],
  ])(
    "removes the signable preview when the %s authority changes",
    async (_, change) => {
      const user = userEvent.setup();
      const onCreate = vi.fn();
      const { rerender } = render(
        <CaseComposer authority={authority} onCreate={onCreate} />,
      );
      await moveToReview(user);

      rerender(
        <CaseComposer
          authority={{ ...authority, ...change }}
          onCreate={onCreate}
        />,
      );

      expect(
        screen.queryByRole("button", { name: "Create case on GenLayer" }),
      ).not.toBeInTheDocument();
      rerender(<CaseComposer authority={authority} onCreate={onCreate} />);
      expect(
        screen.queryByRole("button", { name: "Create case on GenLayer" }),
      ).not.toBeInTheDocument();
      expect(onCreate).not.toHaveBeenCalled();
    },
  );

  it.each([
    [
      "a disconnected buyer authority",
      null,
      "https://product.example",
      /connect the signing buyer wallet/i,
    ],
    ["a non-restricted origin", authority, "http://product.example", /HTTPS/i],
  ])(
    "rejects %s before producing a signable review",
    async (_, activeAuthority, origin, message) => {
      const user = userEvent.setup();
      render(<CaseComposer authority={activeAuthority} onCreate={vi.fn()} />);
      await user.type(
        screen.getByLabelText(/vendor wallet/i),
        "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      );
      await user.click(
        screen.getByRole("button", { name: "Continue to terms" }),
      );
      fillTerms(origin);
      await user.click(
        screen.getByRole("button", { name: "Review locked terms" }),
      );

      expect(screen.getByRole("alert")).toHaveTextContent(message);
      expect(
        screen.queryByRole("button", { name: "Create case on GenLayer" }),
      ).not.toBeInTheDocument();
    },
  );
});
