require("dotenv").config();
const fastify = require("fastify");
const cors = require("@fastify/cors");
const nodemailer = require("nodemailer");

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

// CORS: allow all (*)
app.register(cors, {
  origin: "*",
  methods: ["GET", "POST", "OPTIONS"],
  allowedHeaders: ["*"],
});

// Validate env
const requiredEnv = [
  "SMTP_PORT",
  "SMTP_USER",
  "SMTP_PASS",
  "FROM_EMAIL",
  "FROM_NAME",
];
const missing = requiredEnv.filter((k) => !process.env[k]);
if (missing.length) {
  app.log.warn(`Missing ENV vars: ${missing.join(", ")}`);
}

// Create transporter once
const transporter = nodemailer.createTransport({
  service: "gmail",
  port: Number(process.env.SMTP_PORT || 587),
  secure: false,
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
  },
});

// Optional: verify SMTP on startup (non-blocking)
transporter
  .verify()
  .then(() => {
    app.log.info("SMTP connection verified.");
  })
  .catch((err) => {
    app.log.error({ err }, "SMTP verify failed (server still starting).");
  });

app.get("/health", async () => ({ ok: true }));

/**
 * POST /send-email
 * Body:
 * {
 *   "recipients": [{"email":"a@x.com","name":"A"}, {"email":"b@x.com"}],
 *   "subject": "Your Subject",
 *   "html": "<h1>Hello</h1>",
 *   "individual": false   // optional, default false (pakai BCC); true = kirim satu-per-satu
 * }
 */
app.post(
  "/send-email",
  {
    schema: {
      body: {
        type: "object",
        required: ["recipients", "subject", "html"],
        properties: {
          recipients: {
            type: "array",
            minItems: 1,
            items: {
              type: "object",
              required: ["email"],
              properties: {
                email: { type: "string", format: "email" },
                name: { type: "string" },
              },
              additionalProperties: false,
            },
          },
          subject: { type: "string", minLength: 1, maxLength: 255 },
          html: { type: "string", minLength: 1 },
          from: {type: "string", minLength: 1},
          individual: { type: "boolean", default: false },
        },
        additionalProperties: false,
      },
    },
  },
  async (req, reply) => {
    const { recipients, subject, html, from:userFrom, individual = false } = req.body;

    // Helper to format "Name <email>"
    const fmt = (r) => (r.name ? `"${r.name}" <${r.email}>` : r.email);

    try {
      const from = `"${userFrom}" <${process.env.FROM_EMAIL}>`;

      if (individual) {
        // Kirim satu-per-satu (aman untuk list panjang, tidak expose alamat lain)
        const results = await Promise.allSettled(
          recipients.map((r) =>
            transporter.sendMail({
              from,
              to: fmt(r),
              subject,
              html,
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
        // Kirim sekali dengan BCC (tidak expose alamat, lebih cepat untuk list kecil-sedang)
        const bccList = recipients.map(fmt).join(", ");
        const info = await transporter.sendMail({
          from,
          // memakai BCC agar alamat tidak terlihat satu sama lain
          bcc: bccList,
          subject,
          html,
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
  }
);

const port = Number(process.env.PORT || 3000);
app
  .listen({ port, host: "0.0.0.0" })
  .then(() => app.log.info(`Server running on http://0.0.0.0:${port}`))
  .catch((err) => {
    app.log.error({ err }, "Server failed to start");
    process.exit(1);
  });
