import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { VariantScreen } from "../src/screens/Variant.tsx";
import { VariantsScreen } from "../src/screens/Variants.tsx";
import {
  type ConnectionModelRow,
  listConnectionModels,
  suggestModel,
} from "../src/screens/variants/model-source.ts";
import { ADMIN, VIEWER, renderScreen, stubFetch } from "./harness.tsx";

/**
 * Ajan modelini DEĞİŞTİRMEK: sahada "yok" diye raporlanan, aslında var olan
 * ama keşfedilemeyen akış.
 *
 * Operatörün şikâyeti "model değiştirilemiyor" değildi aslında — kod hep
 * değiştirebiliyordu — "değiştirmenin yolunu bulamıyorum"du: "Düzenle"ye
 * basıyor, orada yalnız ad kutusunu ve modelin nasıl değiştiğini
 * ANLATAN ama oraya GÖTÜRMEYEN bir not buluyordu. Buradaki testler o yolun
 * artık tıklanabilir olduğunu sabitliyor; kaybolursa aynı şikâyet geri gelir.
 */

const DETAIL = {
  variantId: "analyst-web",
  role: "analyst",
  platform: "web",
  model: "qwen2.5-coder-32b-instruct",
  activeVersion: 2,
  persona: "mevcut persona",
  knowledge: [],
  versions: [],
};

/**
 * Bağlantı paneli: İKİ açık model bağlantısı — biri varsayılan.
 *
 * İki satır bilerek: tek satırlık bir sabit, "açılır liste" ile "tek öneri"
 * arasındaki farkı test edemez.
 */
const CONNECTIONS = {
  connections: [
    {
      id: "llm-local",
      kind: "openai_compat",
      displayName: "Kurum vLLM",
      enabled: true,
      isDefault: true,
      config: { model: "qwen2.5-coder-32b-instruct" },
    },
    {
      id: "llm-ikinci",
      kind: "openai_compat",
      displayName: "Yedek sunucu",
      enabled: true,
      isDefault: false,
      config: { model: "llama-3.1-70b" },
    },
  ],
};

function routes(detail: typeof DETAIL = DETAIL) {
  return [
    { path: "/variants/analyst-web", body: detail },
    { path: "/studio/guidance", body: { notes: [] } },
    { path: "/studio/connections", body: CONNECTIONS },
  ];
}

function renderVariant(fetchImpl: typeof fetch, session = ADMIN): void {
  renderScreen(<VariantScreen />, {
    fetchImpl,
    session,
    initialEntries: ["/variants/detail?id=analyst-web"],
  });
}

describe("varyant detayı — modeli değiştirme yolu keşfedilebilir", () => {
  it("'Düzenle' penceresindeki not artık sürüm yayınlama penceresini AÇIYOR", async () => {
    const { fetchImpl } = stubFetch(routes());
    renderVariant(fetchImpl);

    // Operatörün gerçekte bastığı düğme.
    await userEvent.click(await screen.findByRole("button", { name: "Adı düzenle" }));
    // Çıkmaz sokağın kendisi: not burada duruyordu, yanında hiçbir şey yoktu.
    const go = await screen.findByRole("button", { name: "Modeli değiştir →" });
    await userEvent.click(go);

    // Düzenleme kapandı, sürüm yayınlama açıldı — ve model kutusu orada.
    await waitFor(() => {
      expect(screen.getByRole("heading", { name: /Sürüm v3 yayınla/ })).toBeInTheDocument();
    });
    expect(screen.queryByRole("button", { name: "Modeli değiştir →" })).not.toBeInTheDocument();
    expect(screen.getByLabelText("Model")).toHaveValue("qwen2.5-coder-32b-instruct");
  });

  it("modelin YAZDIĞI yerde de bir 'Değiştir' bağlantısı var", async () => {
    const { fetchImpl } = stubFetch(routes());
    renderVariant(fetchImpl);

    expect(await screen.findByText("qwen2.5-coder-32b-instruct")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Değiştir" }));

    await waitFor(() => {
      expect(screen.getByRole("heading", { name: /Sürüm v3 yayınla/ })).toBeInTheDocument();
    });
  });

  it("admin olmayan için değiştirme bağlantısı YOK — kapı sunucuda, ama UI de yalan söylemiyor", async () => {
    const { fetchImpl } = stubFetch(routes());
    renderVariant(fetchImpl, VIEWER);

    expect(await screen.findByText("qwen2.5-coder-32b-instruct")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Değiştir" })).not.toBeInTheDocument();
  });

  it("model 'secilmedi' ise satır bunu rozetle söylüyor", async () => {
    const { fetchImpl } = stubFetch(routes({ ...DETAIL, model: "secilmedi" }));
    renderVariant(fetchImpl);

    expect(await screen.findByText("model seçilmedi")).toBeInTheDocument();
  });

  it("hiçbir bağlantının sunmadığı bulut modeli KIRMIZI olarak işaretleniyor", async () => {
    const { fetchImpl } = stubFetch(routes({ ...DETAIL, model: "anthropic/claude-sonnet-4.5" }));
    renderVariant(fetchImpl);

    expect(await screen.findByText("erişilemez model")).toBeInTheDocument();
  });

  it("bir bağlantının SUNDUĞU model, adı bulutu andırsa da erişilebilir sayılır (rozet yok)", async () => {
    const { fetchImpl } = stubFetch([
      { path: "/variants/analyst-web", body: { ...DETAIL, model: "anthropic/claude-sonnet-4.5" } },
      { path: "/studio/guidance", body: { notes: [] } },
      {
        path: "/studio/connections",
        body: {
          connections: [
            { id: "openrouter", kind: "openrouter", displayName: "OpenRouter", enabled: true, isDefault: true, config: { model: "anthropic/claude-sonnet-4.5" } },
          ],
        },
      },
    ]);
    renderVariant(fetchImpl);

    expect(await screen.findByText("anthropic/claude-sonnet-4.5")).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByText("erişilemez model")).not.toBeInTheDocument());
  });
});

describe("model alanı — bağlantılardan gelen AÇILIR LİSTE", () => {
  it("liste bağlantılardaki TÜM modelleri, kaynağıyla birlikte gösterir", async () => {
    const { fetchImpl } = stubFetch(routes());
    renderVariant(fetchImpl);

    await userEvent.click(await screen.findByRole("button", { name: "Yeni sürüm yayınla" }));
    // Alan bir <select>: serbest metin kutusu DEĞİL.
    const field = await screen.findByLabelText("Model");
    expect(field.tagName).toBe("SELECT");

    // İki bağlantı, iki seçenek — her biri hangi bağlantıdan geldiğini söylüyor.
    expect(
      screen.getByRole("option", { name: "qwen2.5-coder-32b-instruct (Kurum vLLM)" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "llama-3.1-70b (Yedek sunucu)" })).toBeInTheDocument();
  });

  it("listeden seçilen ad kutuya geçer — hiç yazılmadan", async () => {
    const { fetchImpl } = stubFetch(routes());
    renderVariant(fetchImpl);

    await userEvent.click(await screen.findByRole("button", { name: "Yeni sürüm yayınla" }));
    const field = await screen.findByLabelText("Model");
    await userEvent.selectOptions(field, "llama-3.1-70b");
    expect(field).toHaveValue("llama-3.1-70b");
  });

  it("bağlantılarda OLMAYAN mevcut değer seçili KALIR ve uyarılır — sessizce kaydırılmaz", async () => {
    const { fetchImpl } = stubFetch(routes({ ...DETAIL, model: "anthropic/claude-sonnet-4.5" }));
    renderVariant(fetchImpl);

    await userEvent.click(await screen.findByRole("button", { name: "Yeni sürüm yayınla" }));
    // Değer duruyor: yayınla düğmesi operatörün görmediği bir modeli yazmaz.
    await waitFor(() => {
      expect(screen.getByLabelText("Model")).toHaveValue("anthropic/claude-sonnet-4.5");
    });
    // Ve tanımsız olduğu söyleniyor.
    expect(
      screen.getByText(/"anthropic\/claude-sonnet-4.5" hiçbir bağlantıda tanımlı değil/),
    ).toBeInTheDocument();
  });

  it("serbest metin kaçışı var ama İKİNCİL: 'elle gir' seçilince kutu gelir, listeye dönülebilir", async () => {
    const { fetchImpl } = stubFetch(routes());
    renderVariant(fetchImpl);

    await userEvent.click(await screen.findByRole("button", { name: "Yeni sürüm yayınla" }));
    await userEvent.selectOptions(
      await screen.findByLabelText("Model"),
      screen.getByRole("option", { name: /Listede yok/ }),
    );

    const box = screen.getByLabelText("Model");
    expect(box.tagName).toBe("INPUT");
    await userEvent.clear(box);
    await userEvent.type(box, "proxy-uzerindeki-model");
    expect(box).toHaveValue("proxy-uzerindeki-model");

    // Ve geri dönüş yolu kapalı değil.
    await userEvent.click(screen.getByRole("button", { name: /Bağlantılardaki modellerden seç/ }));
    expect(screen.getByLabelText("Model").tagName).toBe("SELECT");
  });

  it("hiç bağlantı yoksa alan doğrudan serbest metin — tek seçeneği olan bir liste çizilmez", async () => {
    // `/studio/connections` route tablosunda YOK: stub 404 döner.
    const { fetchImpl } = stubFetch([
      { path: "/variants/analyst-web", body: DETAIL },
      { path: "/studio/guidance", body: { notes: [] } },
    ]);
    renderVariant(fetchImpl);

    await userEvent.click(await screen.findByRole("button", { name: "Yeni sürüm yayınla" }));
    const field = await screen.findByLabelText("Model");
    expect(field.tagName).toBe("INPUT");
    expect(field).toHaveValue("qwen2.5-coder-32b-instruct");
    // Hiçbir hata gösterilmiyor: liste bir kolaylık, form çalışmaya devam eder.
    expect(screen.queryByRole("button", { name: /Bağlantılardaki modellerden seç/ })).not.toBeInTheDocument();
  });
});

/**
 * Liste SIRASI ve ilk satırı, sunucudaki `pickModelRow` ile aynı olmak
, sunucudaki `pickModelRow` ile birebir aynı olmak
 * zorunda: listenin ilk satırı, model seçilmediğinde koşunun gerçekten
 * dialayacağı ad değilse liste bir yalandır.
 */
describe("listConnectionModels / suggestModel — sunucudaki pickModelRow ile aynı kural", () => {
  const row = (over: Partial<ConnectionModelRow> = {}): ConnectionModelRow => ({
    id: "a",
    kind: "openai_compat",
    displayName: "A",
    enabled: true,
    isDefault: false,
    config: { model: "m" },
    ...over,
  });

  it("VARSAYILAN satır kazanır, id sırası değil", () => {
    const picked = suggestModel([
      row({ id: "a", config: { model: "ilk" } }),
      row({ id: "b", isDefault: true, config: { model: "varsayilan" } }),
    ]);
    expect(picked?.model).toBe("varsayilan");
  });

  it("varsayılan yoksa id sırasına göre ilki", () => {
    const picked = suggestModel([
      row({ id: "z", config: { model: "son" } }),
      row({ id: "a", config: { model: "ilk" } }),
    ]);
    expect(picked?.model).toBe("ilk");
  });

  it("kapalı satır, model servis etmeyen tür ve model adı yazılmamış satır elenir", () => {
    expect(suggestModel([row({ enabled: false })])).toBeNull();
    expect(suggestModel([row({ kind: "jira_dc" })])).toBeNull();
    expect(suggestModel([row({ config: {} })])).toBeNull();
    expect(suggestModel([row({ config: { model: "   " } })])).toBeNull();
  });

  it("hiç satır yoksa (ya da uç cevap vermediyse) null", () => {
    expect(suggestModel([])).toBeNull();
    expect(suggestModel(undefined)).toBeNull();
  });

  it("adı olmayan bağlantı için id gösterilir — seçenek kaynaksız sunulmaz", () => {
    expect(suggestModel([row({ id: "llm-1", displayName: "  " })])?.connectionName).toBe("llm-1");
  });

  it("liste TÜM modelleri verir; varsayılan başta, kalanlar id sırasına göre", () => {
    const models = listConnectionModels([
      row({ id: "z", config: { model: "son" } }),
      row({ id: "b", isDefault: true, config: { model: "varsayilan" } }),
      row({ id: "a", config: { model: "ilk" } }),
    ]).map((option) => option.model);
    expect(models).toEqual(["varsayilan", "ilk", "son"]);
  });

  it("aynı model adını iki bağlantı servis ediyorsa ad TEK KEZ listelenir", () => {
    const models = listConnectionModels([
      row({ id: "a", displayName: "Birinci", config: { model: "ayni" } }),
      row({ id: "b", displayName: "İkinci", config: { model: "ayni" } }),
    ]);
    expect(models).toHaveLength(1);
    expect(models[0]?.connectionName).toBe("Birinci");
  });

  it("elenen satırlar listeye de girmez", () => {
    expect(listConnectionModels([row({ enabled: false })])).toEqual([]);
    expect(listConnectionModels(undefined)).toEqual([]);
  });
});

describe("ajan tanımları listesi — modeli eksik/erişilemez satırlar görünür", () => {
  it("secilmedi ve bulut modeli taşıyan satırlar işaretlenir, sağlıklı satır işaretlenmez", async () => {
    const { fetchImpl } = stubFetch([
      {
        path: "/variants",
        body: {
          variants: [
            { variantId: "a-ok", role: "analyst", platform: "web", model: "qwen2.5-32b", activeVersion: 1, knowledgeFiles: 0, evalScore: null },
            { variantId: "b-unset", role: "analyst", platform: "web", model: "secilmedi", activeVersion: 1, knowledgeFiles: 0, evalScore: null },
            { variantId: "c-cloud", role: "engineer", platform: "web", model: "anthropic/claude-sonnet-4.5", activeVersion: 1, knowledgeFiles: 0, evalScore: null },
          ],
        },
      },
    ]);
    renderScreen(<VariantsScreen />, { fetchImpl, session: ADMIN });

    expect(await screen.findByText("model seçilmedi")).toBeInTheDocument();
    expect(screen.getByText("erişilemez model")).toBeInTheDocument();
    // Özet satırı hem sayıyı hem DÜZELTME yolunu veriyor.
    expect(screen.getByText(/2 ajan tanımının modeli eksik ya da erişilemez/)).toBeInTheDocument();
    expect(screen.getByText(/Yeni sürüm yayınla/)).toBeInTheDocument();
  });

  it("hepsi sağlıklıysa hiçbir uyarı çizilmez", async () => {
    const { fetchImpl } = stubFetch([
      {
        path: "/variants",
        body: {
          variants: [
            { variantId: "a-ok", role: "analyst", platform: "web", model: "qwen2.5-32b", activeVersion: 1, knowledgeFiles: 0, evalScore: null },
          ],
        },
      },
    ]);
    renderScreen(<VariantsScreen />, { fetchImpl, session: ADMIN });

    expect(await screen.findByText("a-ok")).toBeInTheDocument();
    expect(screen.queryByText("model seçilmedi")).not.toBeInTheDocument();
    expect(screen.queryByText(/modeli eksik ya da erişilemez/)).not.toBeInTheDocument();
  });
});
