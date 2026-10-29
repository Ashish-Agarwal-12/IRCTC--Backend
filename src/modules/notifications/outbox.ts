// Transactional outbox: how "send the ticket email" survives crashes, SMTP outages and restarts.
//
// The problem: confirming a booking (a database commit) and sending an email (an SMTP call) can't
// be one atomic step. Send first and the commit might fail (email for a booking that isn't
// confirmed); commit first and the server might crash before sending (a paid booking, no ticket).
//
// The fix: the email is *written down* as an OutboxMessage row inside the same transaction that
// confirms the booking (enqueueNotification in enqueue.ts). Both commit, or neither does. This worker then reads
// the rows and sends them, retrying with backoff until SMTP accepts.
//
// Delivery is at-least-once: if the server dies after SMTP accepted but before the row is marked
// SENT, the email goes again. A duplicate ticket email is a far smaller problem than a missing one.

import type { NotificationType } from "../../generated/prisma/client.js";
import { logger } from "../../shared/logger.js";
import { prisma } from "../../shared/prisma.js";
import { sendMail, type Attachment } from "../../shared/mailer.js";
import { startIntervalJob } from "../../shared/interval-job.js";
import { bookingInclude, ticketPdfFor, toBookingView } from "../bookings/bookings.service.js";
import { passengerStatus, rupees } from "../bookings/ticket.js";

const BATCH = 20;
export const MAX_ATTEMPTS = 8;
// While a worker is sending, the row's nextAttemptAt is pushed this far ahead, so no other worker
// picks it up. If the worker dies mid-send, the lease runs out and someone else retries it.
const LEASE_MS = 5 * 60_000;

// 30 s, 1 min, 2 min, ... capped at 1 hour.
export const backoffMs = (attempts: number) => Math.min(30_000 * 2 ** (attempts - 1), 60 * 60_000);

// Sends what's due. Returns how many emails went out.
export async function deliverOutbox(now = new Date()): Promise<number> {
    // Claim a batch in one statement. FOR UPDATE SKIP LOCKED: if another instance is claiming at
    // the same moment, each skips the rows the other has locked instead of waiting, so no row is
    // claimed twice. The claim itself (attempts + 1, lease) commits immediately: no transaction
    // stays open while we talk to the SMTP server.
    const claimed = await prisma.$queryRaw<{ id: string; type: NotificationType; bookingId: string; attempts: number; payload: unknown }[]>`
        UPDATE "OutboxMessage"
        SET attempts = attempts + 1, "nextAttemptAt" = ${new Date(now.getTime() + LEASE_MS)}
        WHERE id IN (
            SELECT id FROM "OutboxMessage"
            WHERE status = 'PENDING' AND "nextAttemptAt" <= ${now}
            ORDER BY "createdAt"
            LIMIT ${BATCH}
            FOR UPDATE SKIP LOCKED
        )
        RETURNING id, type, "bookingId", attempts, payload`;

    let sent = 0;
    for (const message of claimed) {
        try {
            const email = await compose(message.type, message.bookingId, message.payload);
            if (email) await sendMail(email.to, email.subject, email.text, email.attachments);
            await prisma.outboxMessage.update({
                where: { id: message.id },
                data: { status: "SENT", sentAt: new Date(), lastError: email ? null : "Skipped: no longer applies" },
            });
            if (email) sent += 1;
        } catch (err) {
            const giveUp = message.attempts >= MAX_ATTEMPTS;
            await prisma.outboxMessage.update({
                where: { id: message.id },
                data: {
                    status: giveUp ? "FAILED" : "PENDING",
                    nextAttemptAt: new Date(now.getTime() + backoffMs(message.attempts)),
                    lastError: err instanceof Error ? err.message.slice(0, 500) : String(err),
                },
            });
            // The error and ids only: the recipient's address is PII and stays out of the logs.
            logger[giveUp ? "error" : "warn"]({ err, messageId: message.id, attempts: message.attempts }, giveUp ? "Gave up sending email" : "Email failed; will retry");
        }
    }
    return sent;
}

interface Email { to: string; subject: string; text: string; attachments: Attachment[] }

// What each notification says. Built at send time from the current booking, so a retry an hour
// later still sends correct details. Returns null if the email no longer applies.
async function compose(type: NotificationType, bookingId: string, payload: unknown): Promise<Email | null> {
    const booking = await prisma.booking.findUniqueOrThrow({
        where: { id: bookingId },
        include: { ...bookingInclude, payments: { where: { status: { in: ["CAPTURED", "REFUND_PENDING", "REFUNDED"] } } } },
    });
    const train = `${booking.schedule.train.number} ${booking.schedule.train.name}`;
    const route = `${booking.fromStop.station.code} → ${booking.toStop.station.code}`;

    if (type === "BOOKING_CONFIRMED") {
        if (booking.status !== "CONFIRMED") return null; // cancelled before we got to it
        const captured = booking.payments.filter((p) => p.status === "CAPTURED");
        return {
            to: booking.contactEmail,
            subject: `Booking confirmed · PNR ${booking.pnr}`,
            text: [
                `Your booking is confirmed.`,
                ``,
                `PNR: ${booking.pnr}`,
                `Train: ${train}, ${route}, class ${booking.class}`,
                `Passengers: ${booking.passengers.length}`,
                `Paid: ${rupees(booking.totalFare)}`,
                ``,
                `Your e-ticket is attached. You can download it again any time from GET /bookings/${booking.pnr}/ticket.pdf.`,
                `(Test mode: no real money moved and this ticket is not valid for travel.)`,
            ].join("\n"),
            attachments: [{
                filename: `ticket-${booking.pnr}.pdf`,
                content: await ticketPdfFor({ ...booking, payments: captured }),
                contentType: "application/pdf",
            }],
        };
    }

    if (type === "BOOKING_CANCELLED") {
        const details = payload as { reason: string; refund: number; passengers: { position: number; name: string; refund: number; rule: string }[] };
        return {
            to: booking.contactEmail,
            subject: `Cancellation · PNR ${booking.pnr}`,
            text: [
                `${details.reason} on PNR ${booking.pnr} (${train}, ${route}).`,
                ``,
                ...details.passengers.map((p) => `  ${p.position}. ${p.name}: refund ${rupees(p.refund)} (${p.rule})`),
                ``,
                details.refund > 0
                    ? `Total refund: ${rupees(details.refund)}, to your original payment method.`
                    : `No refund is due under the cancellation rules.`,
                booking.status === "CANCELLED" ? `The booking is now fully cancelled.` : `The other passengers on this booking are unaffected.`,
                `(Test mode: no real money moved.)`,
            ].join("\n"),
            attachments: [],
        };
    }

    if (type === "STATUS_CHANGED") {
        if (booking.status !== "CONFIRMED") return null;
        const captured = booking.payments.filter((p) => p.status === "CAPTURED");
        const view = toBookingView(booking);
        return {
            to: booking.contactEmail,
            subject: `Status update · PNR ${booking.pnr}`,
            text: [
                `Good news: passengers on PNR ${booking.pnr} (${train}, ${route}) have moved up after cancellations.`,
                ``,
                ...view.passengers.map((p) => `  ${p.position}. ${p.name}: ${passengerStatus(p)}`),
                ``,
                `Your updated e-ticket is attached.`,
            ].join("\n"),
            attachments: [{
                filename: `ticket-${booking.pnr}.pdf`,
                content: await ticketPdfFor({ ...booking, payments: captured }),
                contentType: "application/pdf",
            }],
        };
    }

    // REFUND_INITIATED: paid after the hold had already been released (or the unpaid booking was cancelled).
    return {
        to: booking.contactEmail,
        subject: `Refund initiated · PNR ${booking.pnr}`,
        text: [
            `We received your payment of ${rupees(booking.totalFare)} for PNR ${booking.pnr} (${train}, ${route}),`,
            `but it arrived after your seat hold had ended (or the booking was cancelled), so the seats are no longer yours.`,
            ``,
            `The full amount is being refunded to your original payment method. No booking was made.`,
            `(Test mode: no real money moved.)`,
        ].join("\n"),
        attachments: [],
    };
}

// Every 10 s. Started in server.ts.
export function startOutboxWorker(intervalMs = 10_000): () => void {
    return startIntervalJob("email-outbox", intervalMs, () => deliverOutbox());
}
