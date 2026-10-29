// The only file that talks to Razorpay. Everything else uses the PaymentGateway interface, so the
// tests can swap in a fake (setPaymentGateway) and never make a network call.
//
// Plain fetch against Razorpay's REST API rather than their SDK: five calls, no extra dependency,
// and every request and response shape is visible here. Docs: https://razorpay.com/docs/api/
//
// TEST MODE ONLY: env.ts refuses any key that isn't rzp_test_..., so no real money can move.

import { env } from "../../config/env.js";
import { AppError } from "../../shared/error.js";

// The fields of a Razorpay payment we use. Amounts are in paise, like ours.
export interface GatewayPayment {
    id: string;          // pay_...
    orderId: string;     // order_...
    amount: number;
    currency: string;
    // created → authorized (bank approved) → captured (money is ours). Or failed / refunded.
    status: "created" | "authorized" | "captured" | "refunded" | "failed";
    amountRefunded: number;
    errorDescription: string | null;
}

export interface PaymentGateway {
    keyId: string; // public: the checkout page needs it
    createOrder(input: { amount: number; receipt: string; notes: Record<string, string> }): Promise<{ id: string }>;
    fetchPayment(paymentId: string): Promise<GatewayPayment>;
    listOrderPayments(orderId: string): Promise<GatewayPayment[]>;
    capturePayment(paymentId: string, amount: number): Promise<GatewayPayment>;
    refundPayment(paymentId: string): Promise<{ id: string }>;
}

// 503: the gateway is down or slow. Booking and payment rows are left untouched, so the user can retry.
export class GatewayUnavailableError extends AppError {
    constructor() {
        super(503, "PAYMENT_GATEWAY_UNAVAILABLE", "The payment gateway is not responding. Your seats are still held; try again shortly.");
    }
}

// 502: the gateway answered, but refused the request (bad id, already refunded, ...).
export class GatewayRejectedError extends AppError {
    constructor(message: string) {
        super(502, "PAYMENT_GATEWAY_ERROR", `The payment gateway refused the request: ${message}`);
    }
}

// Razorpay's JSON, snake_case, to ours.
interface RazorpayPayment {
    id: string; order_id: string; amount: number; currency: string; status: GatewayPayment["status"];
    amount_refunded: number; error_description: string | null;
}
export const fromRazorpay = (p: RazorpayPayment): GatewayPayment => ({
    id: p.id, orderId: p.order_id, amount: p.amount, currency: p.currency, status: p.status,
    amountRefunded: p.amount_refunded ?? 0, errorDescription: p.error_description ?? null,
});

function razorpayGateway(keyId: string, keySecret: string): PaymentGateway {
    // HTTP Basic auth: "key_id:key_secret", base64. Sent only to api.razorpay.com over HTTPS.
    const authorization = "Basic " + Buffer.from(`${keyId}:${keySecret}`).toString("base64");

    async function call<T>(method: "GET" | "POST", path: string, body?: object): Promise<T> {
        let res: Response;
        try {
            res = await fetch(`https://api.razorpay.com/v1${path}`, {
                method,
                headers: { authorization, "content-type": "application/json" },
                body: body && JSON.stringify(body),
                // Never let a hanging gateway hold a request (or the reconciliation job) forever.
                signal: AbortSignal.timeout(10_000),
            });
        } catch {
            throw new GatewayUnavailableError(); // DNS failure, connection refused, timeout
        }
        if (res.status >= 500) throw new GatewayUnavailableError();
        const data = await res.json().catch(() => null);
        if (!res.ok) throw new GatewayRejectedError(data?.error?.description ?? `HTTP ${res.status}`);
        return data as T;
    }

    return {
        keyId,
        createOrder: ({ amount, receipt, notes }) =>
            call<{ id: string }>("POST", "/orders", { amount, currency: "INR", receipt, notes }),
        fetchPayment: async (id) => fromRazorpay(await call<RazorpayPayment>("GET", `/payments/${encodeURIComponent(id)}`)),
        listOrderPayments: async (orderId) =>
            (await call<{ items: RazorpayPayment[] }>("GET", `/orders/${encodeURIComponent(orderId)}/payments`)).items.map(fromRazorpay),
        capturePayment: async (id, amount) =>
            fromRazorpay(await call<RazorpayPayment>("POST", `/payments/${encodeURIComponent(id)}/capture`, { amount, currency: "INR" })),
        // No amount: refund in full.
        refundPayment: (id) => call<{ id: string }>("POST", `/payments/${encodeURIComponent(id)}/refund`, {}),
    };
}

let active: PaymentGateway | null =
    env.RAZORPAY_KEY_ID && env.RAZORPAY_KEY_SECRET ? razorpayGateway(env.RAZORPAY_KEY_ID, env.RAZORPAY_KEY_SECRET) : null;

export function paymentGateway(): PaymentGateway {
    if (!active) {
        throw new AppError(503, "PAYMENTS_NOT_CONFIGURED", "Payments are not set up on this server (RAZORPAY_KEY_ID is empty)");
    }
    return active;
}

// Tests only: replace the real gateway with a fake.
export function setPaymentGateway(gateway: PaymentGateway | null): void {
    active = gateway;
}
