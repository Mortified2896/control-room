import { test, expect } from "@playwright/test";

test.describe("MiniMax chat without router A/B", () => {
  test("selecting MiniMax + routerAb on does not surface unsupported-router-ab error", async ({
    page,
    request,
  }) => {
    const envCheck = await request.get("/api/models");
    expect(envCheck.ok()).toBeTruthy();
    const envPayload = await envCheck.json();
    const minimax = (
      envPayload.models as Array<{
        providerId: string;
        modelId: string;
        enabled: boolean;
      }>
    ).find((m) => m.providerId === "minimax");
    test.skip(!minimax, "MiniMax provider not configured in env.");
    expect(minimax!.enabled).toBeTruthy();

    await page.goto("/");
    const trigger = page.locator('button[aria-label*="Select model"]').first();
    await trigger.click();
    await page
      .getByRole("button", { name: /MiniMax/i })
      .first()
      .click();

    const input = page.locator('textarea[aria-label="Message input (press C to focus)"]').first();
    await input.fill("ping");
    await page.keyboard.press("Enter");

    await expect(page.getByText(/unsupported_router_ab_provider/i)).toHaveCount(0, {
      timeout: 15_000,
    });
    await expect(page.getByText(/deterministic stub response/i)).toHaveCount(1, {
      timeout: 30_000,
    });

    const apiResp = await request.post("/api/chat", {
      data: {
        modelId: minimax!.modelId,
        routerAb: true,
        messages: [{ id: "p1", role: "user", parts: [{ type: "text", text: "ping" }] }],
      },
    });
    expect(apiResp.status()).not.toBe(400);
    const body = await apiResp.json().catch(() => null);
    expect(JSON.stringify(body ?? {})).not.toMatch(/unsupported_router_ab_provider/);
  });
});
