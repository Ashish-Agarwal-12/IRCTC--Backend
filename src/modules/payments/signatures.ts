// How we know a payment message really came from Razorpay: an HMAC-SHA256 that only someone with
// our secret could compute. Anyone can POST to our endpoints; without the secret they can't forge this.

import { createHmac, timingSafeEqual } from "node:crypto";

const hmacHex = (secret: string, data: string | Buffer) => createHmac("sha256", secret).update(data).digest("hex");

// Compares in constant time: `===` stops at the first differing character, and the time that takes
// leaks how much of a guessed signature was right.
function sameHex(expected: string, received: string): boolean {
    const a = Buffer.from(expected, "hex");
    const b = Buffer.from(received, "hex");
    return a.length === b.length && a.length > 0 && timingSafeEqual(a, b);
}

// Checkout: after the user pays, Razorpay's checkout hands the browser
// razorpay_signature = HMAC(key_secret, order_id + "|" + payment_id).
export function checkoutSignature(keySecret: string, orderId: string, paymentId: string): string {
    return hmacHex(keySecret, `${orderId}|${paymentId}`);
}
export function isValidCheckoutSignature(keySecret: string, orderId: string, paymentId: string, signature: string): boolean {
    return sameHex(checkoutSignature(keySecret, orderId, paymentId), signature);
}

// Webhooks: header X-Razorpay-Signature = HMAC(webhook_secret, raw request body).
// Must be the raw bytes as sent: re-serialising parsed JSON can reorder keys or change spacing.
export function webhookSignature(webhookSecret: string, rawBody: Buffer | string): string {
    return hmacHex(webhookSecret, rawBody);
}
export function isValidWebhookSignature(webhookSecret: string, rawBody: Buffer, signature: string): boolean {
    return sameHex(webhookSignature(webhookSecret, rawBody), signature);
}
