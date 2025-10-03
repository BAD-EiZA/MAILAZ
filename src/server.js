/**
 * server.js
 * Author: Herrscher of Void
 *
 * EN: Fastify + Nodemailer mail API with Swagger docs and Handlebars templates.
 * JP: Fastify と Nodemailer を使ったメール API。Swagger ドキュメントと Handlebars テンプレート対応。
 * ID: API email menggunakan Fastify + Nodemailer dengan Swagger dan dukungan template Handlebars.
 */

require("dotenv").config();

const fastify = require("fastify");
const cors = require("@fastify/cors");
const nodemailer = require("nodemailer");
// EN: Support both CJS/ESM exports for the handlebars plugin
// JP: handlebars プラグインの CJS/ESM 両対応
// ID: Dukungan ekspor CJS/ESM untuk plugin handlebars
const hbs =
  require("nodemailer-express-handlebars").default ||
  require("nodemailer-express-handlebars");
const path = require("path");

// EN: Swagger plugins for OpenAPI spec + UI
// JP: OpenAPI 仕様と UI を提供する Swagger プラグイン
// ID: Plugin Swagger untuk spesifikasi OpenAPI + UI
const swagger = require("@fastify/swagger");
const swaggerUI = require("@fastify/swagger-ui");

const isProd = process.env.NODE_ENV === "production";
const app = fastify({
  // EN: Pretty logger in dev; default logger in prod
  // JP: 開発では見やすいロガー、本番では標準ロガー
  // ID: Logger rapi di dev; logger standar di produksi
  logger: isProd
    ? true
    : {
        transport: {
          target: "pino-pretty",
          options: { colorize: true, translateTime: "SYS:standard" },
        },
      },
});

// -----------------------------------------------------------------------------
// CORS
// -----------------------------------------------------------------------------
// EN: Allow all origins/methods for simplicity (tighten in production)
// JP: 簡単化のため全て許可（本番では制限すべき）
// ID: Izinkan semua origin/metode untuk sederhana (perketat di produksi)
app.register(cors, {
  origin: "*",
  methods: ["GET", "POST", "OPTIONS"],
  allowedHeaders: ["*"],
});

// -----------------------------------------------------------------------------
// Swagger / OpenAPI
// -----------------------------------------------------------------------------
// EN: Register Swagger with OpenAPI 3.1. Route schemas below will be collected.
// JP: OpenAPI 3.1 で Swagger を登録。後述のルートスキーマが自動収集される。
// ID: Daftarkan Swagger dengan OpenAPI 3.1. Skema rute di bawah akan dikumpulkan.
app.register(swagger, {
  openapi: {
    openapi: "3.1.0",
    info: {
      title: "Mail Service",
      description:
        "Simple mailer API using Fastify + Nodemailer (+ Handlebars templates).",
      version: "1.0.0",
    },
    servers: [
      {
        url: process.env.PUBLIC_BASE_URL || "http://localhost:3000",
        description: "Current server",
      },
    ],
    tags: [{ name: "Email", description: "Email sending endpoints" }],
  },
});

// EN: Serve Swagger UI at /docs (the plugin also exposes JSON at /docs/json)
// JP: Swagger UI を /docs で提供（JSON は /docs/json で自動公開）
// ID: Swagger UI tersedia di /docs (JSON juga otomatis di /docs/json)
app.register(swaggerUI, {
  routePrefix: "/docs",
  uiConfig: {
    docExpansion: "list",
    deepLinking: false,
  },
  staticCSP: true,
  transformStaticCSP: (header) => header,
});

// 🚫 REMOVED: Custom /docs/json route to avoid duplication
// ❌ app.get("/docs/json", ...)  // ← This caused "FST_ERR_DUPLICATED_ROUTE"

// -----------------------------------------------------------------------------
// JSON Schemas for validation ($ref by $id) + EXAMPLES
// -----------------------------------------------------------------------------
// EN: Base recipient object
// JP: 送信先（受信者）オブジェクトの基本形
// ID: Objek penerima (recipient) dasar
app.addSchema({
  $id: "Recipient",
  type: "object",
  required: ["email"],
  additionalProperties: false,
  properties: {
    email: { type: "string", format: "email" },
    name: { type: "string" },
  },
});

// EN: Request body for POST /send-email
// JP: POST /send-email のリクエストボディ
// ID: Body permintaan untuk POST /send-email
app.addSchema({
  $id: "SendEmailRequest",
  type: "object",
  required: ["recipients", "subject"],
  additionalProperties: false,
  properties: {
    recipients: {
      type: "array",
      minItems: 1,
      items: { $ref: "Recipient#" },
    },
    // EN: Choose one: template+context OR html
    // JP: 次のいずれか一方：template+context または html
    // ID: Pilih salah satu: template+context ATAU html
    template: { type: "string", description: "Template in /views (without .handlebars)" },
    context: { type: "object", description: "Variables for Handlebars template" },
    html: { type: "string", description: "Raw HTML when not using template" },
    subject: { type: "string", minLength: 1, maxLength: 255 },
    // EN: Display name only; actual sender email from FROM_EMAIL
    // JP: 表示名のみ。実際の差出人メールは FROM_EMAIL を使用
    // ID: Hanya nama tampilan; email pengirim dari FROM_EMAIL
    from: { type: "string", description: "Display name; sender email comes from FROM_EMAIL" },
    // EN: true = send one-by-one (TO), false = single send using BCC
    // JP: true = 個別送信（TO）、false = 一括送信（BCC）
    // ID: true = kirim satu-satu (TO), false = sekali kirim via BCC
    individual: {
      type: "boolean",
      default: false,
      description: "true: per-recipient; false: single email via BCC",
    },
  },
  // EN: Require at least one of template or html
  // JP: template または html の少なくとも一方を必須
  // ID: Wajib minimal salah satu: template atau html
  anyOf: [{ required: ["template"] }, { required: ["html"] }],
  // EN/JP/ID: Swagger UI Examples
  examples: [
    // EN: (1) Template + BCC / JP: テンプレート + BCC / ID: Template + BCC
    {
      recipients: [
        { email: "alice@example.com", name: "Alice" },
        { email: "bob@example.com", name: "Bob" }
      ],
      template: "welcome",
      context: {
        firstName: "there",
        productName: "Atlaz English Test",
        ctaText: "Start now",
        ctaUrl: "https://test.hiatlaz.com/ielts"
      },
      subject: "Welcome to Atlaz!",
      from: "Atlaz Team",
      individual: false
    },
    // EN: (2) Template + individual / JP: テンプレート + 個別送信 / ID: Template + individual
    {
      recipients: [
        { email: "teacher1@school.id", name: "Bu Sari" },
        { email: "teacher2@school.id", name: "Pak Dimas" }
      ],
      template: "teacher-invite",
      context: {
        eventTitle: "Workshop: Staging & Scaffolding",
        eventDate: "Thu, Oct 10, 2025",
        eventTime: "14:00 WIB",
        joinUrl: "https://hiatlaz.com/workshop"
      },
      subject: "Invitation: Teacher Workshop (Oct 10)",
      from: "Atlaz Education",
      individual: true
    },
    // EN: (3) Raw HTML + BCC / JP: 生 HTML + BCC / ID: HTML mentah + BCC
    {
      recipients: [
        { email: "marketing@partner.com" },
        { email: "ops@partner.com" }
      ],
      html: "<h1>Partnership Update</h1><p>We’re excited to share our latest releases.</p><p><a href=\"https://hiatlaz.com/product\">See details</a></p>",
      subject: "Atlaz — Product Updates",
      from: "Atlaz Partnerships",
      individual: false
    },
    // EN: (4) Raw HTML + individual / JP: 生 HTML + 個別送信 / ID: HTML mentah + individual
    {
      recipients: [
        { email: "qorina@hiatlaz.com", name: "Qorina" },
        { email: "team@hiatlaz.com", name: "Atlaz Team" }
      ],
      html: "<p>Hi {{name}},</p><p>Your monthly report is ready.</p>",
      subject: "Monthly Report",
      from: "Reports Bot",
      individual: true
    }
  ]
});

// EN: Response example for BCC mode
// JP: BCC モードのレスポンス例
// ID: Contoh respons untuk mode BCC
app.addSchema({
  $id: "SendEmailResponseBcc",
  type: "object",
  required: ["mode", "messageId"],
  properties: {
    mode: { type: "string", enum: ["bcc"] },
    messageId: { type: "string" },
    accepted: { type: "array", items: { type: "string" } },
    rejected: { type: "array", items: { type: "string" } },
  },
  example: {
    mode: "bcc",
    messageId: "<20251001.123456.abcdef@mail.example>",
    accepted: ["alice@example.com", "bob@example.com"],
    rejected: []
  }
});

// EN: Response example for individual mode
// JP: 個別送信モードのレスポンス例
// ID: Contoh respons untuk mode individual
app.addSchema({
  $id: "SendEmailResponseIndividual",
  type: "object",
  required: ["mode", "ok", "fail"],
  properties: {
    mode: { type: "string", enum: ["individual"] },
    ok: {
      type: "array",
      items: {
        type: "object",
        properties: {
          recipient: { type: "string", format: "email" },
          messageId: { type: "string" },
          accepted: { type: "array", items: { type: "string" } },
        },
        required: ["recipient"],
      },
    },
    fail: {
      type: "array",
      items: {
        type: "object",
        properties: {
          recipient: { type: "string", format: "email" },
          error: { type: "string" },
        },
        required: ["recipient", "error"],
      },
    },
  },
  example: {
    mode: "individual",
    ok: [
      {
        recipient: "teacher1@school.id",
        messageId: "<20251001.a1b2c3@mail.example>",
        accepted: ["teacher1@school.id"]
      }
    ],
    fail: [
      {
        recipient: "teacher2@school.id",
        error: "Invalid recipient"
      }
    ]
  }
});

// EN: Generic error example
// JP: 汎用エラー例
// ID: Contoh error umum
app.addSchema({
  $id: "ErrorResponse",
  type: "object",
  properties: {
    error: { type: "string" },
    message: { type: "string" },
  },
  example: {
    error: "EMAIL_SEND_FAILED",
    message: "Invalid login: 535-5.7.8 Username and Password not accepted."
  }
});

// -----------------------------------------------------------------------------
// ENV validation
// -----------------------------------------------------------------------------
// EN: Warn if required env vars are missing
// JP: 必須環境変数が欠けていれば警告
// ID: Peringatkan jika variabel lingkungan wajib tidak tersedia
const requiredEnv = ["SMTP_PORT", "SMTP_USER", "SMTP_PASS", "FROM_EMAIL", "FROM_NAME"];
const missing = requiredEnv.filter((k) => !process.env[k]);
if (missing.length) {
  app.log.warn(`Missing ENV vars: ${missing.join(", ")}`);
}

// -----------------------------------------------------------------------------
// Nodemailer transporter
// -----------------------------------------------------------------------------
// EN: Gmail example. If 2FA is enabled, use an App Password.
// JP: Gmail の例。2 要素認証が有効ならアプリパスワードを使用。
// ID: Contoh Gmail. Jika 2FA aktif, gunakan App Password.
const transporter = nodemailer.createTransport({
  service: "gmail",
  port: Number(process.env.SMTP_PORT || 587),
  secure: false,
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
  },
});

// EN: Attach Handlebars templating to Nodemailer
// JP: Nodemailer に Handlebars テンプレートエンジンを追加
// ID: Tambahkan templating Handlebars ke Nodemailer
transporter.use(
  "compile",
  hbs({
    viewEngine: {
      partialsDir: path.resolve("./views/"),
      defaultLayout: false,
    },
    viewPath: path.resolve("./views/"),
  })
);

// EN: Optional SMTP verification on boot (non-blocking)
// JP: 起動時の SMTP 確認（非ブロッキング・任意）
// ID: Verifikasi SMTP opsional saat boot (non-blocking)
transporter
  .verify()
  .then(() => app.log.info("SMTP connection verified."))
  .catch((err) => app.log.error({ err }, "SMTP verify failed (server still starting)."));

// -----------------------------------------------------------------------------
// Routes
// -----------------------------------------------------------------------------
// EN: Health check
// JP: ヘルスチェック
// ID: Pemeriksaan kesehatan (health check)
app.get(
  "/health",
  {
    schema: {
      tags: ["Email"],
      summary: "Health check",
      response: {
        200: {
          type: "object",
          properties: { ok: { type: "boolean" } },
        },
      },
    },
  },
  async () => ({ ok: true })
);

// EN: Main endpoint to send emails (template/context or raw HTML; BCC or individual)
// JP: メール送信のメインエンドポイント（テンプレート/生 HTML、BCC または個別）
// ID: Endpoint utama untuk mengirim email (template/HTML mentah; BCC atau individual)
app.post(
  "/send-email",
  {
    schema: {
      tags: ["Email"],
      summary: "Send an email",
      description:
        "Send emails either one-by-one (TO) or in bulk via BCC. Supports Handlebars templates or raw HTML.",
      body: { $ref: "SendEmailRequest#" },
      response: {
        200: { $ref: "SendEmailResponseBcc#" }, // EN: BCC mode / JP: BCC モード / ID: mode BCC
        207: { $ref: "SendEmailResponseIndividual#" }, // EN: individual mode / JP: 個別モード / ID: mode individual
        500: { $ref: "ErrorResponse#" },
      },
    },
  },
  async (req, reply) => {
    const {
      recipients,
      subject,
      template,
      context = {},
      html,
      from: userFrom,
      individual = false,
    } = req.body;

    // EN: Helper to format "Name <email>"
    // JP: "名前 <メールアドレス>" 形式に整えるヘルパー
    // ID: Helper untuk memformat "Nama <email>"
    const fmt = (r) => (r.name ? `"${r.name}" <${r.email}>` : r.email);

    try {
      // EN: Use provided display name or fallback to FROM_NAME / No-Reply
      // JP: 指定の表示名、なければ FROM_NAME / No-Reply を使用
      // ID: Gunakan display name jika ada; jika tidak, FROM_NAME / No-Reply
      const displayName = userFrom || process.env.FROM_NAME || "No-Reply";
      const from = `"${displayName}" <${process.env.FROM_EMAIL}>`;

      // EN: Must provide either template or html
      // JP: template か html のいずれかが必須
      // ID: Wajib menyertakan template atau html
      if (!template && !html) {
        reply.code(400);
        return {
          error: "BAD_REQUEST",
          message: "Provide either 'template' (with optional 'context') or 'html'.",
        };
      }

      if (individual) {
        // EN: Send one-by-one. Safer for long lists; allows personalization.
        // JP: 個別送信。大規模リストに安全で、パーソナライズ可能。
        // ID: Kirim satu-satu. Aman untuk daftar panjang; bisa personalisasi.
        const results = await Promise.allSettled(
          recipients.map((r) =>
            transporter.sendMail({
              from,
              to: fmt(r),
              subject,
              ...(template ? { template, context } : { html }),
            })
          )
        );

        const ok = [];
        const fail = [];
        results.forEach((res, idx) => {
          const target = recipients[idx];
          if (res.status === "fulfilled") {
            ok.push({
              recipient: target.email,
              messageId: res.value.messageId,
              accepted: res.value.accepted,
            });
          } else {
            fail.push({
              recipient: target.email,
              error: String(res.reason?.message || res.reason),
            });
          }
        });

        return reply.code(207).send({ mode: "individual", ok, fail });
      } else {
        // EN: Send once via BCC. Fast for small–medium lists; hides addresses.
        // JP: BCC による一括送信。小〜中規模に高速で宛先は非公開。
        // ID: Kirim sekali via BCC. Cepat untuk daftar kecil–menengah; alamat tersembunyi.
        const bccList = recipients.map(fmt).join(", ");
        const info = await transporter.sendMail({
          from,
          bcc: bccList,
          subject,
          ...(template ? { template, context } : { html }),
        });

        return reply.send({
          mode: "bcc",
          messageId: info.messageId,
          accepted: info.accepted,
          rejected: info.rejected,
        });
      }
    } catch (err) {
      // EN: Log and return a generic 500 with error message
      // JP: ログ出力後、エラーメッセージ付きの汎用 500 を返却
      // ID: Log lalu kirim 500 umum dengan pesan error
      req.log.error({ err }, "Failed to send email");
      return reply
        .code(500)
        .send({ error: "EMAIL_SEND_FAILED", message: err.message });
    }
  }
);

// -----------------------------------------------------------------------------
// Start server
// -----------------------------------------------------------------------------
// EN: Start Fastify on PORT (default 3000), listen on all interfaces
// JP: PORT（デフォルト 3000）で起動し、全インターフェイスで待受
// ID: Jalankan Fastify pada PORT (default 3000), dengarkan di semua interface
const port = Number(process.env.PORT || 3000);
app
  .listen({ port, host: "0.0.0.0" })
  .then(() =>
    app.log.info(
      `Server running on http://0.0.0.0:${port} (Swagger UI: /docs | JSON: /docs/json)`
    )
  )
  .catch((err) => {
    app.log.error({ err }, "Server failed to start");
    process.exit(1);
  });
