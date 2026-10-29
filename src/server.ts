import { buildApp } from "./app.js";
import { env } from "./config/env.js";
import { logger } from "./shared/logger.js";
import { prisma } from "./shared/prisma.js";

const app = buildApp();

const server = app.listen(env.PORT, () => {
    logger.info(`Server is running on port ${env.PORT}`);
});

// Graceful shutdown: on deploy/restart the platform sends SIGTERM. Stop accepting new connections,
// let in-flight requests (e.g. a booking mid-transaction) finish, then close the DB pool.
let shuttingDown = false;

function shutdown(signal: string) {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, "Shutting down");

    // If something hangs (e.g. a stuck keep-alive connection), don't wait forever.
    const forceExit = setTimeout(() => {
        logger.error("Shutdown timed out, forcing exit");
        process.exit(1);
    }, 10_000);
    forceExit.unref();

    server.close(async (err) => {
        await prisma.$disconnect();
        if (err) {
            logger.error({ err }, "Error while closing server");
            process.exit(1);
        }
        process.exit(0);
    });
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
