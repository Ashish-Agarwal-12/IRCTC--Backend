// Teach TypeScript that `req.user` exists. Express's Request type is declared in a global
// namespace, so we "merge" an extra property into it instead of editing the library.

import type { Role } from "../generated/prisma/client.js";

declare global {
    namespace Express {
        interface Request {
            // Set by the `authenticate` middleware; undefined on public routes.
            user?: { id: string; role: Role };
        }
    }
}

export {};
