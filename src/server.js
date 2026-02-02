/**
 * server.js
 * Author: Herrscher of Void (Updated by Gemini)
 *
 * Features:
 * - Multi-SMTP Support (General, Partnership, Marketing)
 * - Dynamic HTML Rendering (Handlebars)
 * - Bulk Sending with Delay
 * - Swagger Documentation
 */

require("dotenv").config();

const fastify = require("fastify");
const cors = require("@fastify/cors");
const nodemailer = require("nodemailer");
const hbs = require("nodemailer-express-handlebars");
const handlebars = require("handlebars"); // Engine core untuk compile raw HTML
const path = require("path");
const swagger = require("@fastify/swagger");
const swaggerUI = require("@fastify/swagger-ui");

const isProd = process.env.NODE_ENV === "production";

// Inisialisasi Fastify
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
// 1. MIDDLEWARE & PLUGINS
// -----------------------------------------------------------------------------

// CORS (Izinkan akses dari Frontend)
app.register(cors, {
  origin: "*",
  methods: ["GET", "POST", "OPTIONS"],
  allowedHeaders: ["*"],
});

// Swagger (Dokumentasi API)
app.register(swagger, {
  openapi: {
    openapi: "3.1.0",
    info: {
      title: "Atlaz Mail Service",
      description:
        "API Email Multi-Channel dengan dukungan Dynamic Template & Delay.",
      version: "2.0.0",
    },
    servers: [
      {
        url: process.env.PUBLIC_BASE_URL || "http://localhost:3000",
        description: "Local Server",
      },
    ],
    tags: [
      { name: "General", description: "Default SMTP" },
      { name: "Partnership", description: "Partnership SMTP" },
      { name: "Marketing", description: "Marketing SMTP" },
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
// 2. HELPER FUNCTIONS
// -----------------------------------------------------------------------------

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Factory untuk membuat Transporter Nodemailer
const createTransporter = (label, user, pass) => {
  if (!user || !pass) {
    app.log.warn(
      `[${label}] Credentials missing in .env. This channel will fail if used.`,
    );
    return null;
  }

  const t = nodemailer.createTransport({
    service: "gmail",
    port: Number(process.env.SMTP_PORT || 587),
    secure: false,
    auth: { user, pass },
  });

  // Attach Plugin Handlebars (untuk mode file template .handlebars)
  // Pastikan folder 'views' ada di root project Anda
  try {
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
  } catch (e) {
    app.log.warn(
      `[${label}] Failed to attach handlebars plugin (folder views missing?). Raw HTML still works.`,
    );
  }

  return t;
};

// -----------------------------------------------------------------------------
// 3. INITIALIZE TRANSPORTERS
// -----------------------------------------------------------------------------

const mainTransporter = createTransporter(
  "MAIN",
  process.env.SMTP_USER,
  process.env.SMTP_PASS,
);
const partnershipTransporter = createTransporter(
  "PARTNERSHIP",
  process.env.SMTP_USER_PARTNERSHIP,
  process.env.SMTP_PASS_PARTNERSHIP,
);
const marketingTransporter = createTransporter(
  "MARKETING",
  process.env.SMTP_USER_MARKETING,
  process.env.SMTP_PASS_MARKETING,
);

// -----------------------------------------------------------------------------
// 4. JSON SCHEMAS
// -----------------------------------------------------------------------------

// Schema Penerima (Allow extra properties like city, company, etc.)
app.addSchema({
  $id: "Recipient",
  type: "object",
  required: ["email"],
  additionalProperties: true, // PENTING: Agar bisa terima kolom dinamis dari Excel
  properties: {
    email: { type: "string", format: "email" },
    name: { type: "string" },
  },
});

// Schema Request Body
app.addSchema({
  $id: "SendEmailRequest",
  type: "object",
  required: ["recipients", "subject"],
  properties: {
    recipients: {
      type: "array",
      minItems: 1,
      items: { $ref: "Recipient#" },
    },
    subject: { type: "string" },
    html: {
      type: "string",
      description: "Raw HTML string (support handlebars syntax)",
    },
    template: {
      type: "string",
      description: "Filename in /views (without extension)",
    },
    context: {
      type: "object",
      description: "Global context for all recipients",
    },
    delaySeconds: {
      type: "integer",
      default: 0,
      description: "Delay per email in seconds",
    },
    from: { type: "string", description: "Override sender name" },
    individual: { type: "boolean", default: true },
  },
});

// Schema Responses
app.addSchema({
  $id: "SendEmailResponse",
  type: "object",
  properties: {
    mode: { type: "string" },
    totalSent: { type: "integer" },
    durationSeconds: { type: "number" },
    ok: { type: "array" },
    fail: { type: "array" },
  },
});

// -----------------------------------------------------------------------------
// 5. SHARED LOGIC (THE CORE)
// -----------------------------------------------------------------------------

const createSendHandler = (
  transporterInstance,
  defaultFromEmail,
  defaultFromName,
) => {
  return async (req, reply) => {
    if (!transporterInstance) {
      return reply
        .code(500)
        .send({
          error: "CONFIG_ERROR",
          message: "Channel ini belum dikonfigurasi di .env",
        });
    }

    const {
      recipients,
      subject,
      html,
      template,
      context = {},
      delaySeconds = 0,
      from: senderNameOverride,
      individual = true,
    } = req.body;

    // Helper format "Name <email>"
    const fmt = (r) => (r.name ? `"${r.name}" <${r.email}>` : r.email);

    // Tentukan Pengirim
    const finalSenderName = senderNameOverride || defaultFromName || "Atlaz";
    const fromAddress = `"${finalSenderName}" <${defaultFromEmail}>`;

    // Persiapkan Template Compiler (Jika pakai Raw HTML)
    let htmlCompiler = null;
    if (html) {
      try {
        htmlCompiler = handlebars.compile(html);
      } catch (e) {
        return reply
          .code(400)
          .send({
            error: "HTML_ERROR",
            message: "Syntax Handlebars di HTML salah.",
          });
      }
    }

    const ok = [];
    const fail = [];
    const startTime = Date.now();

    // MODE INDIVIDUAL (Looping dengan Delay)
    // Wajib digunakan jika ingin Variabel Dinamis per user
    if (individual || delaySeconds > 0 || htmlCompiler) {
      req.log.info(
        `Starting sending to ${recipients.length} recipients. Delay: ${delaySeconds}s`,
      );

      for (const [idx, recipient] of recipients.entries()) {
        // Apply Delay (kecuali email pertama)
        if (idx > 0 && delaySeconds > 0) {
          await sleep(delaySeconds * 1000);
        }

        try {
          // Gabungkan Data: Global Context + Data Spesifik User (Excel)
          // Data user (recipient) akan menimpa Global Context jika key-nya sama
          const combinedContext = { ...context, ...recipient };

          let mailOptions = {
            from: fromAddress,
            to: fmt(recipient),
            subject: subject, // Bisa dibuat dinamis juga: handlebars.compile(subject)(combinedContext)
          };

          if (template) {
            // Mode A: File Template Server
            mailOptions.template = template;
            mailOptions.context = combinedContext;
          } else if (htmlCompiler) {
            // Mode B: Raw HTML dari Frontend (Compiled)
            mailOptions.html = htmlCompiler(combinedContext);
          } else {
            // Mode C: Plain Text fallback (jarang dipakai)
            mailOptions.text = "No content provided.";
          }

          const info = await transporterInstance.sendMail(mailOptions);

          ok.push({
            recipient: recipient.email,
            messageId: info.messageId,
            status: "sent",
          });
        } catch (err) {
          req.log.error({ recipient: recipient.email, err }, "Send failed");
          fail.push({
            recipient: recipient.email,
            error: err.message,
          });
        }
      }

      const duration = (Date.now() - startTime) / 1000;
      return reply.code(200).send({
        mode: "individual_dynamic",
        totalSent: ok.length,
        durationSeconds: duration,
        ok,
        fail,
      });
    } else {
      // MODE BCC (Sekali kirim ke banyak orang - Tidak support variabel dinamis per user)
      // Hanya dipakai jika individual=false DAN tidak ada delay
      try {
        const bccList = recipients.map(fmt).join(", ");
        const info = await transporterInstance.sendMail({
          from: fromAddress,
          bcc: bccList,
          subject,
          html: html, // Raw HTML static
          template: template,
          context: context, // Global context only
        });

        return reply.send({
          mode: "bcc_bulk",
          messageId: info.messageId,
          ok: recipients.map((r) => ({
            recipient: r.email,
            status: "bcc_sent",
          })),
          fail: [],
        });
      } catch (err) {
        return reply
          .code(500)
          .send({ error: "BCC_FAILED", message: err.message });
      }
    }
  };
};

// -----------------------------------------------------------------------------
// 6. ROUTES
// -----------------------------------------------------------------------------

app.get("/health", async () => ({ status: "ok", uptime: process.uptime() }));

// Endpoint General
app.post(
  "/send-email",
  {
    schema: {
      tags: ["General"],
      body: { $ref: "SendEmailRequest#" },
      response: { 200: { $ref: "SendEmailResponse#" } },
    },
  },
  createSendHandler(
    mainTransporter,
    process.env.FROM_EMAIL,
    process.env.FROM_NAME,
  ),
);

// Endpoint Partnership
app.post(
  "/send-email/partnership",
  {
    schema: {
      tags: ["Partnership"],
      body: { $ref: "SendEmailRequest#" },
      response: { 200: { $ref: "SendEmailResponse#" } },
    },
  },
  createSendHandler(
    partnershipTransporter,
    process.env.SMTP_USER_PARTNERSHIP,
    "Atlaz Partnership",
  ),
);

// Endpoint Marketing
app.post(
  "/send-email/marketing",
  {
    schema: {
      tags: ["Marketing"],
      body: { $ref: "SendEmailRequest#" },
      response: { 200: { $ref: "SendEmailResponse#" } },
    },
  },
  createSendHandler(
    marketingTransporter,
    process.env.SMTP_USER_MARKETING,
    "Atlaz Marketing",
  ),
);

// -----------------------------------------------------------------------------
// 7. START SERVER
// -----------------------------------------------------------------------------

const start = async () => {
  try {
    const port = Number(process.env.PORT || 3000);
    await app.listen({ port, host: "0.0.0.0" });
    app.log.info(`Server running at http://localhost:${port}`);
    app.log.info(`Swagger UI available at http://localhost:${port}/docs`);
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
};

start();
