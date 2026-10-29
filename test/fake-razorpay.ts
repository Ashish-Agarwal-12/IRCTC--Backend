import {
    GatewayRejectedError, GatewayUnavailableError, type GatewayPayment, type PaymentGateway,
} from "../src/modules/payments/gateway.js";
import { checkoutSignature } from "../src/modules/payments/signatures.js";
import { testEnv } from "./test-env.js";

// An in-memory Razorpay. Behaves like the real API for the calls we make, and can be switched "down".
export class FakeRazorpay implements PaymentGateway {
    keyId = testEnv.RAZORPAY_KEY_ID;
    down = false;
    orders = new Map<string, { amount: number }>();
    payments = new Map<string, GatewayPayment>();
    refunds = 0;
    private counter = 0;

    private check() { if (this.down) throw new GatewayUnavailableError(); }

    async createOrder({ amount }: { amount: number }) {
        this.check();
        const id = `order_fake${++this.counter}`;
        this.orders.set(id, { amount });
        return { id };
    }
    async fetchPayment(id: string) {
        this.check();
        const p = this.payments.get(id);
        if (!p) throw new GatewayRejectedError("The id provided does not exist");
        return { ...p };
    }
    async listOrderPayments(orderId: string) {
        this.check();
        return [...this.payments.values()].filter((p) => p.orderId === orderId).map((p) => ({ ...p }));
    }
    async capturePayment(id: string) {
        this.check();
        const p = this.payments.get(id)!;
        if (p.status !== "authorized") throw new GatewayRejectedError("This payment has already been captured");
        p.status = "captured";
        return { ...p };
    }
    async refundPayment(id: string) {
        this.check();
        const p = this.payments.get(id)!;
        if (p.amountRefunded >= p.amount) throw new GatewayRejectedError("The payment has been fully refunded already");
        p.amountRefunded = p.amount;
        p.status = "refunded";
        this.refunds += 1;
        return { id: `rfnd_fake${++this.counter}` };
    }

    // What the user does in checkout. Returns what checkout hands the browser on success.
    pay(orderId: string, status: GatewayPayment["status"] = "captured", amount = this.orders.get(orderId)!.amount) {
        const id = `pay_fake${++this.counter}`;
        this.payments.set(id, {
            id, orderId, amount, currency: "INR", status, amountRefunded: 0,
            errorDescription: status === "failed" ? "Card declined by bank" : null,
        });
        return {
            razorpay_order_id: orderId,
            razorpay_payment_id: id,
            razorpay_signature: checkoutSignature(testEnv.RAZORPAY_KEY_SECRET, orderId, id),
        };
    }
}
