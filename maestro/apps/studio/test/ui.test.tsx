import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router";
import {
  Badge,
  Button,
  ButtonLink,
  Card,
  EmptyState,
  FieldGroup,
  Input,
  ListRow,
  Modal,
  Section,
  Select,
  Skeleton,
  TabPanel,
  Table,
  Tabs,
  TextArea,
  ToastProvider,
  riskTone,
  runStatusTone,
  useToast,
} from "../src/ui/index.ts";

describe("Button", () => {
  it("calls onClick", async () => {
    const onClick = vi.fn();
    render(<Button onClick={onClick}>Kaydet</Button>);
    await userEvent.click(screen.getByRole("button", { name: "Kaydet" }));
    expect(onClick).toHaveBeenCalledOnce();
  });

  it("is inert and marked busy while working", async () => {
    const onClick = vi.fn();
    render(
      <Button busy onClick={onClick}>
        Kaydet
      </Button>,
    );
    const button = screen.getByRole("button");
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute("aria-busy", "true");
    await userEvent.click(button).catch(() => undefined);
    expect(onClick).not.toHaveBeenCalled();
  });

  it("defaults to type=button so it never submits a form by accident", () => {
    render(<Button>x</Button>);
    expect(screen.getByRole("button")).toHaveAttribute("type", "button");
  });

  it("offers ghost and link variants that are still real buttons", () => {
    render(
      <>
        <Button variant="ghost">sessiz</Button>
        <Button variant="link">bağlantı gibi</Button>
      </>,
    );
    expect(screen.getByRole("button", { name: "sessiz" })).toHaveClass("ui-btn--ghost");
    expect(screen.getByRole("button", { name: "bağlantı gibi" })).toHaveClass("ui-btn--link");
  });

  it("ButtonLink is an anchor dressed as a button", () => {
    render(
      <MemoryRouter>
        <ButtonLink to="/setup" variant="primary" size="sm">
          Sihirbazı aç
        </ButtonLink>
      </MemoryRouter>,
    );
    const link = screen.getByRole("link", { name: "Sihirbazı aç" });
    expect(link).toHaveAttribute("href", "/setup");
    expect(link).toHaveClass("ui-btn", "ui-btn--primary", "ui-btn--sm");
  });
});

describe("Input", () => {
  it("links label, error and control for assistive tech", () => {
    render(<Input label="Parola" error="Zorunlu alan" />);
    const input = screen.getByLabelText("Parola");
    expect(input).toHaveAttribute("aria-invalid", "true");
    expect(input).toHaveAccessibleDescription("Zorunlu alan");
  });

  it("shows the hint when there is no error", () => {
    render(<Input label="Kullanıcı adı" hint="kurum hesabın" />);
    expect(screen.getByLabelText("Kullanıcı adı")).toHaveAccessibleDescription("kurum hesabın");
  });
});

describe("Select", () => {
  it("renders options and reports changes", async () => {
    const onChange = vi.fn();
    render(
      <Select
        label="Dil"
        value="tr"
        onChange={onChange}
        options={[
          { value: "tr", label: "Türkçe" },
          { value: "en", label: "İngilizce" },
        ]}
      />,
    );
    await userEvent.selectOptions(screen.getByLabelText("Dil"), "en");
    expect(onChange).toHaveBeenCalled();
  });
});

describe("Select placeholder", () => {
  it("renders a 'choose' row with an empty value so nothing is pre-picked", () => {
    render(
      <Select
        label="Bağlantı"
        placeholder="Seçin…"
        value=""
        onChange={() => undefined}
        options={[{ value: "a", label: "A" }]}
      />,
    );
    const select = screen.getByLabelText("Bağlantı") as HTMLSelectElement;
    expect(select.value).toBe("");
    expect(screen.getByRole("option", { name: "Seçin…" })).toHaveValue("");
  });
});

describe("TextArea", () => {
  it("wires label, hint and error like Input", () => {
    render(<TextArea label="Gerekçe" error="Zorunlu alan" />);
    const area = screen.getByLabelText("Gerekçe");
    expect(area.tagName).toBe("TEXTAREA");
    expect(area).toHaveAttribute("aria-invalid", "true");
    expect(area).toHaveAccessibleDescription("Zorunlu alan");
  });
});

describe("Table", () => {
  const columns = [
    { key: "k", header: "Ticket", cell: (r: { k: string }) => r.k },
  ];

  it("renders rows", () => {
    render(
      <Table
        columns={columns}
        rows={[{ k: "UGURPAY-1" }, { k: "UGURPAY-2" }]}
        rowKey={(r) => r.k}
        emptyLabel="kayıt yok"
      />,
    );
    expect(screen.getByText("UGURPAY-1")).toBeInTheDocument();
    expect(screen.getAllByRole("row")).toHaveLength(3); // header + 2
  });

  it("shows the empty label instead of an empty grid", () => {
    render(<Table columns={columns} rows={[]} rowKey={(r) => r.k} emptyLabel="kayıt yok" />);
    expect(screen.getByText("kayıt yok")).toBeInTheDocument();
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
  });

  it("shows a skeleton while loading", () => {
    render(
      <Table columns={columns} rows={[]} rowKey={(r) => r.k} emptyLabel="kayıt yok" loading />,
    );
    expect(screen.queryByText("kayıt yok")).not.toBeInTheDocument();
  });

  it("activates a row by keyboard, not only by mouse", async () => {
    const onRowClick = vi.fn();
    render(
      <Table
        columns={columns}
        rows={[{ k: "UGURPAY-1" }]}
        rowKey={(r) => r.k}
        emptyLabel="kayıt yok"
        onRowClick={onRowClick}
      />,
    );
    // The row is a ROW (focusable), not a button: a button may not contain the
    // cells' own buttons and links.
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
    const row = screen.getAllByRole("row")[1];
    row?.focus();
    await userEvent.keyboard("{Enter}");
    expect(onRowClick).toHaveBeenCalledWith({ k: "UGURPAY-1" });
  });
});

describe("Badge tones", () => {
  it("keeps one colour per domain meaning across screens", () => {
    expect(runStatusTone("gate")).toBe("amber");
    expect(runStatusTone("fail")).toBe("red");
    expect(runStatusTone("failed")).toBe("red");
    expect(runStatusTone("done")).toBe("green");
    expect(runStatusTone("completed")).toBe("green");
    expect(riskTone("kritik")).toBe("red");
    expect(riskTone("dusuk")).toBe("green");
  });

  it("renders its label", () => {
    render(<Badge tone="blue">çalışıyor</Badge>);
    expect(screen.getByText("çalışıyor")).toBeInTheDocument();
  });
});

describe("Tabs", () => {
  function Harness() {
    const [active, setActive] = useState("a");
    return (
      <>
        <Tabs
          label="Sekmeler"
          active={active}
          onChange={setActive}
          items={[
            { id: "a", label: "Analiz" },
            { id: "b", label: "Kanıt" },
          ]}
        />
        <TabPanel id="a" active={active}>
          analiz içeriği
        </TabPanel>
        <TabPanel id="b" active={active}>
          kanıt içeriği
        </TabPanel>
      </>
    );
  }

  it("switches panels and tracks aria-selected", async () => {
    render(<Harness />);
    expect(screen.getByText("analiz içeriği")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("tab", { name: "Kanıt" }));
    expect(screen.getByText("kanıt içeriği")).toBeInTheDocument();
    expect(screen.queryByText("analiz içeriği")).not.toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Kanıt" })).toHaveAttribute("aria-selected", "true");
  });

  it("moves between tabs with the arrow keys and keeps one tab stop", async () => {
    render(<Harness />);
    const first = screen.getByRole("tab", { name: "Analiz" });
    const second = screen.getByRole("tab", { name: "Kanıt" });
    expect(first).toHaveAttribute("tabindex", "0");
    expect(second).toHaveAttribute("tabindex", "-1");
    first.focus();
    await userEvent.keyboard("{ArrowRight}");
    expect(second).toHaveAttribute("aria-selected", "true");
    expect(second).toHaveFocus();
    await userEvent.keyboard("{ArrowRight}");
    // Wraps around.
    expect(first).toHaveAttribute("aria-selected", "true");
    await userEvent.keyboard("{End}");
    expect(second).toHaveAttribute("aria-selected", "true");
  });
});

describe("Toast", () => {
  function Trigger(): ReactNode {
    const toast = useToast();
    return <Button onClick={() => toast.show("error", "Kaydedilemedi")}>göster</Button>;
  }

  it("gives the close affordance an accessible name", async () => {
    render(
      <ToastProvider>
        <Trigger />
      </ToastProvider>,
    );
    await userEvent.click(screen.getByRole("button", { name: "göster" }));
    expect(screen.getByText("Kaydedilemedi")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Kapat" }));
    expect(screen.queryByText("Kaydedilemedi")).not.toBeInTheDocument();
  });
});

describe("Section / ListRow / FieldGroup", () => {
  it("renders a section heading without a card box", () => {
    render(<Section title="Bağlantılar">içerik</Section>);
    expect(screen.getByRole("heading", { name: "Bağlantılar" })).toBeInTheDocument();
    expect(screen.getByText("içerik").closest(".ui-card")).toBeNull();
  });

  it("ListRow: a click on an action inside the row is the action's, not the row's", async () => {
    const onRow = vi.fn();
    const onAction = vi.fn();
    render(
      <ListRow
        status={<Badge tone="green">açık</Badge>}
        title="UgurBank Jira"
        kind="Jira Cloud"
        meta={<span>son test 2 dk önce</span>}
        actions={<Button size="sm" onClick={onAction}>Test et</Button>}
        onClick={onRow}
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: "Test et" }));
    expect(onAction).toHaveBeenCalledOnce();
    expect(onRow).not.toHaveBeenCalled();
    await userEvent.click(screen.getByText("UgurBank Jira"));
    expect(onRow).toHaveBeenCalledOnce();
  });

  it("FieldGroup is a real fieldset with a legend", () => {
    render(
      <FieldGroup legend="Kimlik doğrulama" hint="Jira'nın kabul ettiği yöntem" columns={2}>
        <Input label="Kullanıcı" />
        <Input label="Token" />
      </FieldGroup>,
    );
    expect(screen.getByRole("group", { name: "Kimlik doğrulama" })).toBeInTheDocument();
    expect(screen.getByLabelText("Kullanıcı")).toBeInTheDocument();
  });
});

describe("Modal", () => {
  it("renders nothing while closed", () => {
    render(
      <Modal open={false} onClose={vi.fn()} title="Onay" closeLabel="Kapat">
        gövde
      </Modal>,
    );
    expect(screen.queryByText("gövde")).not.toBeInTheDocument();
  });

  it("closes from the close affordance", async () => {
    const onClose = vi.fn();
    render(
      <Modal open onClose={onClose} title="Onay" closeLabel="Kapat">
        gövde
      </Modal>,
    );
    expect(screen.getByText("gövde")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Kapat" }));
    expect(onClose).toHaveBeenCalledOnce();
  });
});

describe("EmptyState / Skeleton / Card", () => {
  it("shows the empty headline and description", () => {
    render(<EmptyState title="Kayıt yok" description="Henüz akış başlamadı" />);
    expect(screen.getByText("Kayıt yok")).toBeInTheDocument();
    expect(screen.getByText("Henüz akış başlamadı")).toBeInTheDocument();
  });

  it("marks the skeleton busy", () => {
    const { container } = render(<Skeleton rows={2} />);
    expect(container.querySelector('[aria-busy="true"]')).not.toBeNull();
  });

  it("renders a card heading and body", () => {
    render(
      <Card title="Dikkat isteyenler" subtitle="son 24 saat">
        içerik
      </Card>,
    );
    expect(screen.getByRole("heading", { name: "Dikkat isteyenler" })).toBeInTheDocument();
    expect(screen.getByText("içerik")).toBeInTheDocument();
  });
});
