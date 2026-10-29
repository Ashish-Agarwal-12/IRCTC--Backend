import nodemailer from "nodemailer";
import { env } from "../config/env.js";

// In development this points at Mailpit, which accepts any email and shows it at http://localhost:8025.
// In production, point SMTP_HOST/SMTP_PORT at a real provider (SES, SendGrid, ...) and add auth + TLS.
const transport = nodemailer.createTransport({
    host: env.SMTP_HOST,
    port: env.SMTP_PORT,
    secure: false,
});

export async function sendMail(to: string, subject: string, text: string): Promise<void> {
    await transport.sendMail({ from: env.MAIL_FROM, to, subject, text });
}
