// Sends transfer alerts to every configured channel. A channel that is not configured is skipped;
// a channel that fails is logged. Nothing here can throw into the playback path.
import { createTransport } from "nodemailer";
import type { TransferAlert } from "./transfer.ts";

export interface NotifyConfig {
  site: string;
  slackWebhookUrl?: string;
  discordWebhookUrl?: string;
  /** e.g. https://ntfy.sh/<hard-to-guess-topic> */
  ntfyTopicUrl?: string;
  /** Any endpoint that accepts the structured JSON alert. */
  webhookUrl?: string;
  /** e.g. smtps://user:app-password@smtp.gmail.com:465 */
  smtpUrl?: string;
  emailTo?: string[];
  emailFrom?: string;
}

export type Level = "info" | "warning" | "critical";

export interface Formatted {
  title: string;
  body: string;
  level: Level;
}

export interface SendResult {
  channel: string;
  ok: boolean;
  error?: string;
}

interface Deps {
  fetch: typeof fetch;
  sendMail: (smtpUrl: string, mail: { from: string; to: string[]; subject: string; text: string }) => Promise<unknown>;
}

const TIMEOUT_MS = 5000;
const n = (x: number) => x.toLocaleString("en-US", { maximumFractionDigits: 1 });

export function formatAlert(alert: TransferAlert, site: string): Formatted {
  const u = alert.usage;
  const lines = [
    `사이트: ${site}`,
    `이번 달(${u.month}, UTC) 송신: ${n(u.sentGB)} / ${n(u.allowanceGB)} GB (${n(u.percent)}%)`,
    `최근 1시간: ${n(u.lastHourGB)} GB`,
    u.projectedGB === null
      ? "월말 예상: 이번 달 첫날이라 아직 계산하지 않음"
      : `월말 예상: ${n(u.projectedGB)} GB` +
        (u.projectedOverageUsd ? ` (포함량 초과 예상 비용 약 $${u.projectedOverageUsd.toFixed(2)})` : " (포함량 이내)"),
    `초기화: ${u.resetsAt.slice(0, 16).replace("T", " ")} UTC`,
    "",
    "재생은 막지 않습니다. 접근을 제한하려면 deploy/Caddyfile에 basic_auth를 추가하세요.",
  ];
  if (alert.kind === "monthly") {
    const level: Level = alert.level >= 100 ? "critical" : alert.level >= 80 ? "warning" : "info";
    const title =
      alert.level > 100 ? `월 송신량이 포함량의 ${alert.level}%를 넘었습니다` : `월 송신량 ${alert.level}% 도달`;
    return { title, body: lines.join("\n"), level };
  }
  if (alert.kind === "spike") {
    return { title: `송신 급증: 최근 1시간 ${n(u.lastHourGB)} GB`, body: lines.join("\n"), level: "warning" };
  }
  return { title: "알림 설정 시험", body: lines.join("\n"), level: "info" };
}

export class Notifier {
  private readonly deps: Deps;

  constructor(
    private readonly cfg: NotifyConfig,
    deps: Partial<Deps> = {},
  ) {
    this.deps = {
      fetch: deps.fetch ?? fetch,
      sendMail:
        deps.sendMail ??
        ((url, mail) =>
          createTransport({
            url, // nodemailer parses the connection URL (host, port, TLS, credentials) from this option
            connectionTimeout: TIMEOUT_MS,
            greetingTimeout: TIMEOUT_MS,
            socketTimeout: TIMEOUT_MS,
          } as Parameters<typeof createTransport>[0]).sendMail(mail)),
    };
  }

  /** Names of the configured channels (the server log is always on). */
  channels(): string[] {
    const c = this.cfg;
    return [
      "log",
      ...(c.slackWebhookUrl ? ["slack"] : []),
      ...(c.discordWebhookUrl ? ["discord"] : []),
      ...(c.ntfyTopicUrl ? ["ntfy"] : []),
      ...(c.webhookUrl ? ["webhook"] : []),
      ...(c.smtpUrl && c.emailTo?.length ? ["email"] : []),
    ];
  }

  async send(alert: TransferAlert): Promise<SendResult[]> {
    const f = formatAlert(alert, this.cfg.site);
    const prefix = `[${this.cfg.site}] ${f.title}`;
    console.log(`[transfer] ${f.level}: ${f.title} | ${alert.usage.sentGB} GB (${alert.usage.percent}%)`);
    const c = this.cfg;
    const jobs: [string, () => Promise<unknown>][] = [];
    if (c.slackWebhookUrl) jobs.push(["slack", () => this.post(c.slackWebhookUrl!, { text: `*${prefix}*\n${f.body}` })]);
    if (c.discordWebhookUrl) jobs.push(["discord", () => this.post(c.discordWebhookUrl!, { content: `**${prefix}**\n${f.body}` })]);
    if (c.ntfyTopicUrl) {
      // JSON publishing (to the server root) keeps the Korean title intact; header titles must be ASCII.
      const u = new URL(c.ntfyTopicUrl);
      const topic = u.pathname.replace(/^\/+|\/+$/g, "");
      const priority = f.level === "critical" ? 5 : f.level === "warning" ? 4 : 3;
      jobs.push(["ntfy", () => this.post(u.origin + "/", { topic, title: prefix, message: f.body, priority, tags: ["chart_with_upwards_trend"] })]);
    }
    if (c.webhookUrl) {
      jobs.push(["webhook", () => this.post(c.webhookUrl!, { site: c.site, kind: alert.kind, level: f.level, ...(alert.kind === "monthly" ? { threshold: alert.level } : {}), title: f.title, usage: alert.usage })]);
    }
    if (c.smtpUrl && c.emailTo?.length) {
      const from = c.emailFrom || `robot-logstream <${new URL(c.smtpUrl).username ? decodeURIComponent(new URL(c.smtpUrl).username) : "alerts@localhost"}>`;
      jobs.push(["email", () => this.deps.sendMail(c.smtpUrl!, { from, to: c.emailTo!, subject: prefix, text: f.body })]);
    }
    const results = await Promise.all(
      jobs.map(async ([channel, run]): Promise<SendResult> => {
        try {
          await run();
          return { channel, ok: true };
        } catch (err) {
          const error = err instanceof Error ? err.message : String(err);
          console.error(`[transfer] ${channel} notification failed: ${error}`);
          return { channel, ok: false, error };
        }
      }),
    );
    return [{ channel: "log", ok: true }, ...results];
  }

  private async post(url: string, body: unknown) {
    const res = await this.deps.fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
  }
}

/** Channel settings from the environment (see deploy/.env.example). */
export function notifyConfigFromEnv(env: NodeJS.ProcessEnv): NotifyConfig {
  const v = (k: string) => env[k]?.trim() || undefined;
  return {
    site: v("SITE_NAME") ?? v("SITE_ADDRESS") ?? "robot-logstream",
    slackWebhookUrl: v("SLACK_WEBHOOK_URL"),
    discordWebhookUrl: v("DISCORD_WEBHOOK_URL"),
    ntfyTopicUrl: v("NTFY_TOPIC_URL"),
    webhookUrl: v("ALERT_WEBHOOK_URL"),
    smtpUrl: v("SMTP_URL"),
    emailTo: v("ALERT_EMAIL_TO")?.split(",").map((s) => s.trim()).filter(Boolean),
    emailFrom: v("ALERT_EMAIL_FROM"),
  };
}
