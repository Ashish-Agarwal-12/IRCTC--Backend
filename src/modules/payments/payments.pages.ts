// A bare page that opens Razorpay checkout, standing in for a real frontend so the payment flow
// can be tried end to end in TEST MODE. Open the `checkoutUrl` from POST /payments/orders.
//
// The order details come after "#" in the URL, so they stay in the browser. Razorpay's script
// shows its payment form; on success it gives us order id + payment id + signature, and the page
// forwards them to POST /payments/verify, which is what actually confirms the booking.

import type { RequestHandler } from "express";
import { env } from "../../config/env.js";

export const checkoutPage: RequestHandler = (_req, res) => {
    // The key id is public (it's meant for browsers) and env.ts allows only rzp_test_... values.
    // JSON.stringify + escaping "<" keeps it a plain string even inside a <script> block.
    const keyId = JSON.stringify(env.RAZORPAY_KEY_ID ?? "").replace(/</g, "\\u003c");
    res.set({ "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" });
    res.type("html").send(`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Pay for your booking · IRCTC (test mode)</title>
<style>
    body { font-family: system-ui, sans-serif; max-width: 30rem; margin: 4rem auto; padding: 0 1rem; color: #1a1a1a; }
    .test { background: #fff4e5; padding: .5rem .75rem; border-radius: 6px; font-size: .9rem; }
    button { padding: .6rem 1.2rem; font-size: 1rem; cursor: pointer; }
    #msg { margin-top: 1rem; padding: .75rem; border-radius: 6px; }
    #msg.ok { background: #e6f4ea; } #msg.err { background: #fce8e6; }
    #msg:empty { display: none; }
</style>
</head>
<body>
<h1>Pay for PNR <span id="pnr">…</span></h1>
<p class="test"><strong>Test mode:</strong> no real money moves. Choose Netbanking, any bank, then <strong>Success</strong>
on the page that opens (allow pop-ups for this site). UPI <code>success@razorpay</code> works where the account has UPI.</p>
<p>Amount: <strong id="amount">…</strong></p>
<button id="pay" disabled>Pay now</button>
<p id="msg" role="status"></p>
<script src="https://checkout.razorpay.com/v1/checkout.js"></script>
<script>
    const keyId = ${keyId};
    const params = new URLSearchParams(location.hash.slice(1));
    const orderId = params.get("orderId"), pnr = params.get("pnr"), amount = Number(params.get("amount"));
    const prefill = { contact: params.get("contact") ?? undefined, email: params.get("email") ?? undefined };
    // Keep the order in the address bar (so a reload still works) but drop the phone and email,
    // so they aren't left in browser history or copied along with the link.
    params.delete("contact");
    params.delete("email");
    history.replaceState(null, "", location.pathname + "#" + params);

    function show(text, isError) {
        const el = document.getElementById("msg");
        el.textContent = text;
        el.className = isError ? "err" : "ok";
    }

    document.getElementById("pnr").textContent = pnr ?? "?";
    document.getElementById("amount").textContent = "₹" + (amount / 100).toFixed(2);

    async function verify(response) {
        show("Confirming your booking…", false);
        try {
            const res = await fetch("/payments/verify", {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify(response), // razorpay_order_id, razorpay_payment_id, razorpay_signature
            });
            const data = await res.json().catch(() => null);
            if (!res.ok) return show(data?.error?.message ?? "Something went wrong (" + res.status + ")", true);
            if (data.result === "CONFIRMED") return show("Paid. Booking " + data.booking.pnr + " is CONFIRMED.", false);
            show("Payment received, but the seat hold had already expired, so it is being refunded (" + data.result + ").", true);
        } catch {
            show("Couldn't reach the server. If you were charged, the booking is confirmed or refunded automatically within a few minutes.", true);
        }
    }

    if (!keyId) {
        show("Payments are not set up on this server (RAZORPAY_KEY_ID is empty).", true);
    } else if (!orderId) {
        show("This link is missing its order. Open checkoutUrl from POST /payments/orders.", true);
    } else if (typeof Razorpay === "undefined") {
        show("Couldn't load Razorpay checkout. Check your connection.", true);
    } else {
        const checkout = new Razorpay({
            key: keyId,
            order_id: orderId,
            amount,
            currency: "INR",
            name: "IRCTC (test mode)",
            description: "PNR " + pnr,
            prefill,
            handler: verify,
        });
        checkout.on("payment.failed", (e) => show("Payment failed: " + e.error.description + ". You can try again.", true));
        const button = document.getElementById("pay");
        button.disabled = false;
        button.onclick = () => checkout.open();
    }
</script>
</body>
</html>`);
};
