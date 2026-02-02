/**
 * server.js
 * Author: Herrscher of Void
 * Updated by: Gemini
 *
 * EN: Fastify + Nodemailer mail API (Multi-account + Bulk Delay Support).
 * JP: Fastify と Nodemailer を使ったメール API（複数アカウント + 遅延送信対応）。
 * ID: API email menggunakan Fastify + Nodemailer (Multi-akun + Dukungan Jeda Kirim).
 */

require("dotenv").config();

const fastify = require("fastify");
const cors = require("@fastify/cors");
const nodemailer = require("nodemailer");
const hbs =
  require("nodemailer-express-handlebars").default ||
  require("nodemailer-express-handlebars");
const path = require("path");
const swagger = require("@fastify/swagger");
const swaggerUI = require("@fastify/swagger-ui");

const isProd = process.env.NODE_ENV === "production";
const app = fastify({
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
app.register(cors, {
  origin: "*",
  methods: ["GET", "POST", "OPTIONS"],
  allowedHeaders: ["*"],
});

// -----------------------------------------------------------------------------
// Swagger / OpenAPI
// -----------------------------------------------------------------------------
app.register(swagger, {
  openapi: {
    openapi: "3.1.0",
    info: {
      title: "Atlaz Mail Service",
      description: "Atlaz mailer API - Multi-channel support with Bulk Delay.",
      version: "1.1.0",
    },
    servers: [
      {
        url: process.env.PUBLIC_BASE_URL || "http://localhost:3000",
        description: "Current server",
      },
    ],
    tags: [
      { name: "General", description: "Default SMTP Account" },
      { name: "Partnership", description: "Partnership SMTP Account" },
      { name: "Marketing", description: "Marketing SMTP Account" },
    ],
  },
});

app.register(swaggerUI, {
  routePrefix: "/docs",
  uiConfig: { docExpansion: "list", deepLinking: false },
  staticCSP: true,
  transformStaticCSP: (header) => header,
});

// -----------------------------------------------------------------------------
// Helper: Sleep for Delay
// -----------------------------------------------------------------------------
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// -----------------------------------------------------------------------------
// JSON Schemas
// -----------------------------------------------------------------------------
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

app.addSchema({
  $id: "SendEmailRequest",
  type: "object",
  required: ["recipients", "subject"],
  additionalProperties: true,
  properties: {
    recipients: {
      type: "array",
      minItems: 1,
      items: { $ref: "Recipient#" },
    },
    template: { type: "string", description: "Template in /views" },
    context: { type: "object", description: "Variables for Handlebars" },
    html: { type: "string", description: "Raw HTML" },
    subject: { type: "string", minLength: 1, maxLength: 255 },
    from: { type: "string", description: "Display name override" },
    individual: {
      type: "boolean",
      default: false,
      description: "true: send one-by-one; false: single BCC email",
    },
    // EN: New feature: Delay between emails
    // ID: Fitur baru: Jeda antar email (detik)
    delaySeconds: {
      type: "integer",
      minimum: 0,
      default: 0,
      description:
        "Delay in seconds between each email (Forces individual=true)",
    },
  },
  anyOf: [{ required: ["template"] }, { required: ["html"] }],
  examples: [
    {
      recipients: [
        { email: "user1@example.com" },
        { email: "user2@example.com" },
      ],
      html: "<p>Promo content</p>",
      subject: "Marketing Blast",
      individual: true,
      delaySeconds: 3, // ID: Contoh jeda 3 detik
    },
  ],
});

// Response Schemas (Re-used)
app.addSchema({
  $id: "SendEmailResponseBcc",
  type: "object",
  properties: {
    mode: { type: "string", const: "bcc" },
    messageId: { type: "string" },
    accepted: { type: "array", items: { type: "string" } },
    rejected: { type: "array", items: { type: "string" } },
  },
});

app.addSchema({
  $id: "SendEmailResponseIndividual",
  type: "object",
  properties: {
    mode: { type: "string", enum: ["individual", "individual_delayed"] },
    totalSent: { type: "integer" },
    durationSeconds: { type: "number" },
    ok: { type: "array" },
    fail: { type: "array" },
  },
});

app.addSchema({
  $id: "ErrorResponse",
  type: "object",
  properties: {
    error: { type: "string" },
    message: { type: "string" },
  },
});

// -----------------------------------------------------------------------------
// Transporter Factory
// -----------------------------------------------------------------------------
// EN: Function to create and configure a transporter
// ID: Fungsi untuk membuat dan mengonfigurasi transporter
const createTransporter = (label, user, pass) => {
  if (!user || !pass) {
    app.log.warn(
      `[${label}] Missing credentials. This transporter will fail if used.`,
    );
    return null;
  }

  const t = nodemailer.createTransport({
    service: "gmail",
    port: Number(process.env.SMTP_PORT || 587),
    secure: false,
    auth: { user, pass },
  });

  // Attach Handlebars
  t.use(
    "compile",
    hbs({
      viewEngine: {
        partialsDir: path.resolve("./views/"),
        defaultLayout: false,
      },
      viewPath: path.resolve("./views/"),
    }),
  );

  return t;
};

// 1. Main Transporter
const mainTransporter = createTransporter(
  "MAIN",
  process.env.SMTP_USER,
  process.env.SMTP_PASS,
);

// 2. Partnership Transporter
const partnershipTransporter = createTransporter(
  "PARTNERSHIP",
  process.env.SMTP_USER_PARTNERSHIP,
  process.env.SMTP_PASS_PARTNERSHIP,
);

// 3. Marketing Transporter
const marketingTransporter = createTransporter(
  "MARKETING",
  process.env.SMTP_USER_MARKETING,
  process.env.SMTP_PASS_MARKETING,
);

// -----------------------------------------------------------------------------
// Shared Route Logic
// -----------------------------------------------------------------------------
/**
 * Generic handler for sending emails
 * @param {Object} transporterInstance - The nodemailer transporter to use
 * @param {String} defaultFromEmail - The default sender email for this account
 * @param {String} defaultFromName - The default sender name
 */
const createSendHandler = (
  transporterInstance,
  defaultFromEmail,
  defaultFromName,
) => {
  return async (req, reply) => {
    // Safety check if transporter failed to initialize
    if (!transporterInstance) {
      return reply.code(500).send({
        error: "CONFIGURATION_ERROR",
        message:
          "This email channel is not configured on the server (missing ENV).",
      });
    }

    const {
      recipients,
      subject,
      template,
      context = {},
      html,
      from: userFromName,
      individual = false,
      delaySeconds = 0,
    } = req.body;

    const fmt = (r) => (r.name ? `"${r.name}" <${r.email}>` : r.email);

    try {
      // Logic for Sender Name
      const displayName = userFromName || defaultFromName || "No-Reply";
      const from = `"${displayName}" <${defaultFromEmail}>`;

      if (!template && !html) {
        return reply.code(400).send({
          error: "BAD_REQUEST",
          message: "Provide either 'template' or 'html'.",
        });
      }

      // EN: Logic for Individual Sending (Parallel OR Delayed)
      // ID: Logika Pengiriman Individual (Paralel ATAU Jeda/Delay)
      // Note: If delaySeconds > 0, we force individual mode.
      if (individual || delaySeconds > 0) {
        const ok = [];
        const fail = [];
        const startTime = Date.now();

        let htmlTemplate = null;
        if (html) {
          htmlTemplate = hbs.compile(html);
        }

        // Mode A: Delayed Sequence (Looping)
        // ID: Mode A: Urutan dengan Jeda
        if (delaySeconds > 0) {
          req.log.info(
            `Starting delayed sending. Delay: ${delaySeconds}s per email.`,
          );

          for (const [index, r] of recipients.entries()) {
            // Apply delay ONLY if it's not the very first email
            if (index > 0) {
              await sleep(delaySeconds * 1000);
            }

            try {
              const finalHtml = htmlTemplate ? htmlTemplate(r) : undefined;

              // Jika user pakai template file (.handlebars di folder views), context digabung dengan r
              const finalContext = template ? { ...context, ...r } : {};

              const res = await transporterInstance.sendMail({
                from,
                to: fmt(r),
                subject, // Subjek juga bisa dibuat dinamis jika mau: handlebars.compile(subject)(r)
                ...(template
                  ? { template, context: finalContext }
                  : { html: finalHtml }),
              });

              ok.push({
                recipient: r.email,
                messageId: res.messageId,
                accepted: res.accepted,
              });
            } catch (err) {
              fail.push({
                recipient: r.email,
                error: err.message,
              });
            }
          }

          const duration = (Date.now() - startTime) / 1000;
          return reply.code(207).send({
            mode: "individual_delayed",
            totalSent: ok.length,
            durationSeconds: duration,
            ok,
            fail,
          });
        } else {
          // Mode B: Parallel (Promise.all) - Original fast method
          // ID: Mode B: Paralel (Cepat)
          const results = await Promise.allSettled(
            recipients.map((r) =>
              transporterInstance.sendMail({
                from,
                to: fmt(r),
                subject,
                ...(template ? { template, context } : { html }),
              }),
            ),
          );

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
        }
      } else {
        // EN: BCC Mode (Single email, multiple hidden recipients)
        // ID: Mode BCC (Satu email, banyak penerima tersembunyi)
        const bccList = recipients.map(fmt).join(", ");
        const info = await transporterInstance.sendMail({
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
      req.log.error({ err }, "Failed to send email");
      return reply
        .code(500)
        .send({ error: "EMAIL_SEND_FAILED", message: err.message });
    }
  };
};

// -----------------------------------------------------------------------------
// Routes
// -----------------------------------------------------------------------------

app.get("/health", async () => ({ ok: true }));

// 1. General Endpoint
app.post(
  "/send-email",
  {
    schema: {
      tags: ["General"],
      summary: "Send via General Account",
      body: { $ref: "SendEmailRequest#" },
      response: {
        200: { $ref: "SendEmailResponseBcc#" },
        207: { $ref: "SendEmailResponseIndividual#" },
        500: { $ref: "ErrorResponse#" },
      },
    },
  },
  createSendHandler(
    mainTransporter,
    process.env.FROM_EMAIL,
    process.env.FROM_NAME,
  ),
);

// 2. Partnership Endpoint
app.post(
  "/send-email/partnership",
  {
    schema: {
      tags: ["Partnership"],
      summary: "Send via Partnership Account",
      body: { $ref: "SendEmailRequest#" },
      response: {
        200: { $ref: "SendEmailResponseBcc#" },
        207: { $ref: "SendEmailResponseIndividual#" },
        500: { $ref: "ErrorResponse#" },
      },
    },
  },
  createSendHandler(
    partnershipTransporter,
    process.env.SMTP_USER_PARTNERSHIP, // Default Sender Email
    "Atlaz Academy", // Default Sender Name
  ),
);

// 3. Marketing Endpoint
app.post(
  "/send-email/marketing",
  {
    schema: {
      tags: ["Marketing"],
      summary: "Send via Marketing Account",
      body: { $ref: "SendEmailRequest#" },
      response: {
        200: { $ref: "SendEmailResponseBcc#" },
        207: { $ref: "SendEmailResponseIndividual#" },
        500: { $ref: "ErrorResponse#" },
      },
    },
  },
  createSendHandler(
    marketingTransporter,
    process.env.SMTP_USER_MARKETING, // Default Sender Email
    "Atlaz Academy", // Default Sender Name
  ),
);

// -----------------------------------------------------------------------------
// Start server
// -----------------------------------------------------------------------------
const port = Number(process.env.PORT || 3000);
app
  .listen({ port, host: "0.0.0.0" })
  .then(() =>
    app.log.info(
      `Server running on http://0.0.0.0:${port} (Swagger UI: /docs)`,
    ),
  )
  .catch((err) => {
    app.log.error({ err }, "Server failed to start");
    process.exit(1);
  });
