// Teach TypeScript that `req.user` exists. Express's Request type is declared in a global
// namespace, so we "merge" an extra property into it instead of editing the library.

import type { Role } from "../generated/prisma/client.js";

declare global {
    namespace Express {
        interface Request {
            // Set by the `authenticate` middleware; undefined on public routes.
            user?: { id: string; role: Role };
            // The unparsed body, kept only for POST /payments/webhook (see app.ts): webhook
            // signatures are computed over the exact bytes Razorpay sent.
            rawBody?: Buffer;
        }
    }
}

export {};
