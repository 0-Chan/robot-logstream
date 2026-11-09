import { describe, expect, it, vi } from "vitest";
import { Notifier, formatAlert, notifyConfigFromEnv } from "./notify.ts";
import type { TransferAlert, TransferUsage } from "./transfer.ts";

const usage: TransferUsage = {
  month: "2026-11",
  sentGB: 2400,
  allowanceGB: 3000,
  percent: 80,
  lastHourGB: 42,
  projectedGB: 3350,
  projectedOverageUsd: 45.5,
  resetsAt: "2026-12-01T00:00:00.000Z",
};
const alert: TransferAlert = { kind: "monthly", level: 80, usage };

function fakeFetch(status = 200) {
  return vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => new Response("", { status }));
}
const body = (call: unknown[]) => JSON.parse((call[1] as RequestInit).body as string);

describe("formatAlert", () => {
  it("puts the level, usage, projection and reset time into the message", () => {
    const f = formatAlert(alert, "example.sslip.io");
    expect(f.level).toBe("warning");
    expect(f.title).toContain("80%");
    expect(f.body).toContain("2,400 / 3,000 GB");
    expect(f.body).toContain("$45.50");
    expect(f.body).toContain("2026-12-01 00:00 UTC");
  });

  it("marks levels at or above the allowance as critical", () => {
    expect(formatAlert({ ...alert, level: 100 }, "s").level).toBe("critical");
    expect(formatAlert({ ...alert, level: 110 }, "s").title).toContain("110%");
  });
});

describe("Notifier", () => {
  it("sends only to configured channels, each in its own format", async () => {
    const fetch = fakeFetch();
    const sendMail = vi.fn(async () => ({}));
    const n = new Notifier(
      {
        site: "site",
        slackWebhookUrl: "https://hooks.slack.test/a",
        discordWebhookUrl: "https://discord.test/b",
        ntfyTopicUrl: "https://ntfy.test/secret-topic",
        webhookUrl: "https://hook.test/c",
        smtpUrl: "smtps://alerts%40example.com:pw@smtp.test:465",
        emailTo: ["ops@example.com"],
      },
      { fetch, sendMail },
    );
    expect(n.channels()).toEqual(["log", "slack", "discord", "ntfy", "webhook", "email"]);
    const results = await n.send(alert);
    expect(results.every((r) => r.ok)).toBe(true);

    const byUrl = Object.fromEntries(fetch.mock.calls.map((c) => [String(c[0]), body(c)]));
    expect(byUrl["https://hooks.slack.test/a"].text).toContain("80%");
    expect(byUrl["https://discord.test/b"].content).toContain("80%");
    expect(byUrl["https://ntfy.test/"]).toMatchObject({ topic: "secret-topic", priority: 4 });
    expect(byUrl["https://hook.test/c"]).toMatchObject({ kind: "monthly", threshold: 80, level: "warning", usage });
    expect(sendMail).toHaveBeenCalledWith(
      "smtps://alerts%40example.com:pw@smtp.test:465",
      expect.objectContaining({ to: ["ops@example.com"], from: "robot-logstream <alerts@example.com>", subject: expect.stringContaining("80%") }),
    );
  });

  it("with nothing configured only logs", async () => {
    const fetch = fakeFetch();
    const n = new Notifier({ site: "s" }, { fetch });
    expect(n.channels()).toEqual(["log"]);
    expect(await n.send(alert)).toEqual([{ channel: "log", ok: true }]);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("reports failures per channel without throwing", async () => {
    const n = new Notifier(
      { site: "s", slackWebhookUrl: "https://x.test", smtpUrl: "smtp://h", emailTo: ["a@b.c"] },
      { fetch: fakeFetch(500), sendMail: async () => Promise.reject(new Error("refused")) },
    );
    vi.spyOn(console, "error").mockImplementation(() => {});
    const results = await n.send(alert);
    expect(results).toContainEqual({ channel: "slack", ok: false, error: "HTTP 500" });
    expect(results).toContainEqual({ channel: "email", ok: false, error: "refused" });
  });
});

describe("notifyConfigFromEnv", () => {
  it("reads channels from the environment and splits recipients", () => {
    const cfg = notifyConfigFromEnv({ SITE_ADDRESS: "a.sslip.io", ALERT_EMAIL_TO: "x@y.z, w@v.u", SLACK_WEBHOOK_URL: " " });
    expect(cfg).toMatchObject({ site: "a.sslip.io", emailTo: ["x@y.z", "w@v.u"], slackWebhookUrl: undefined });
  });
});
